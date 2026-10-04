// Notifications by email (0324). Worker-only.
//
// The answers for Ashish and Sid (DESIGN.md §J): escalations and missed filings
// go AT ONCE; every other category goes in ONE email a day, at the firm's hour
// in the firm's zone, listing what is still unread. Each person may switch
// their email off per category; the firm sets the defaults.
//
// ── ONCE, AND NEVER LOST SILENTLY ──────────────────────────────────────────
//
// A notification is emailed at most once: `emailed_at` is CLAIMED before the
// send (only rows this run claimed are sent), and given back if the relay
// refuses, so the next run tries again. A daily email is claimed per firm,
// person and day before anything is read (the weekly advance summary's
// pattern, 0322), so a doubled worker sends one. Whatever a refused daily email
// held stays unemailed and goes in the next day's.
//
// ── THE READER'S WORDS ─────────────────────────────────────────────────────
//
// The same renderer and the same read as the bell, with the reader's own fee
// visibility: an associate who may not see fees gets no amount by email either.
import type { NotifyCategory } from "../../domain/notify/model";
import {
  NOTIFY_CATEGORY_KEYS,
  channelEnabled,
  dailyDigestDue,
  emailMode,
  notificationPath,
  renderNotification,
} from "../../domain/notify/model";
import type { Clock } from "../../platform/clock";
import type {
  ChannelSetting,
  NotificationEmailStore,
  NotificationMailer,
  NotificationSettingsStore,
  Unemailed,
} from "./ports";

/** An urgent notification older than this is not emailed: it was missed while
 *  email was off or the worker was down, and a stale "urgent" is noise. */
export const INSTANT_WITHIN_MS = 24 * 60 * 60 * 1000;
/** The daily email reaches back this far for unread notifications. */
export const DIGEST_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const INSTANT = NOTIFY_CATEGORY_KEYS.filter((c) => emailMode(c) === "instant");
const DIGEST = NOTIFY_CATEGORY_KEYS.filter((c) => emailMode(c) === "digest");

export interface NotificationEmailDeps {
  readonly store: NotificationEmailStore;
  readonly settings: NotificationSettingsStore;
  readonly mailer: NotificationMailer;
  readonly timeZones: { timeZoneFor(tenantId: string): Promise<string> };
  readonly clock: Clock;
  /** The web app's origin, for the links in the letter. */
  readonly appBaseUrl: string;
}

export interface EmailReport {
  readonly tenantId: string;
  readonly letters: number;
  readonly notifications: number;
  readonly refused: number;
  readonly failure?: string;
}

export class NotificationEmails {
  constructor(private readonly deps: NotificationEmailDeps) {}

  /** Every firm: the urgent ones, at once. On the outbox's every-minute queue. */
  async sweepInstant(): Promise<readonly EmailReport[]> {
    return this.everyFirm((t) => this.sendInstant(t));
  }

  /** Every firm whose hour has come: the daily email. Hourly. */
  async sweepDigests(): Promise<readonly EmailReport[]> {
    return this.everyFirm((t) => this.sendDigests(t));
  }

  async sendInstant(tenantId: string): Promise<EmailReport> {
    const since = new Date(this.deps.clock.now().getTime() - INSTANT_WITHIN_MS).toISOString();
    const rows = await this.deps.store.unemailed(tenantId, INSTANT, since);
    const byPerson = groupBy(rows);
    let letters = 0;
    let notifications = 0;
    let refused = 0;
    for (const [userId, mine] of byPerson) {
      const r = await this.sendOne(tenantId, userId, mine, "instant");
      letters += r.sent ? 1 : 0;
      notifications += r.sent ? r.count : 0;
      refused += r.refused ? 1 : 0;
    }
    return { tenantId, letters, notifications, refused };
  }

  async sendDigests(tenantId: string): Promise<EmailReport> {
    const [hour, zone] = await Promise.all([
      this.deps.store.digestHour(tenantId),
      this.deps.timeZones.timeZoneFor(tenantId),
    ]);
    const day = dailyDigestDue({ now: this.deps.clock.now().toISOString(), timeZone: zone, hour });
    if (day === null) return { tenantId, letters: 0, notifications: 0, refused: 0 };

    const waiting = await this.deps.store.staffWithoutDigest(tenantId, day);
    if (waiting.length === 0) return { tenantId, letters: 0, notifications: 0, refused: 0 };
    const since = new Date(this.deps.clock.now().getTime() - DIGEST_WITHIN_MS).toISOString();
    const byPerson = groupBy(await this.deps.store.unemailed(tenantId, DIGEST, since));

    let letters = 0;
    let notifications = 0;
    let refused = 0;
    for (const userId of waiting) {
      // Claimed FIRST: a second worker on the same minute finds the row and
      // sends nothing.
      if (!(await this.deps.store.claimDigest(tenantId, userId, day))) continue;
      const r = await this.sendOne(tenantId, userId, byPerson.get(userId) ?? [], "digest");
      await this.deps.store.markDigest(tenantId, userId, day, r.count, r.sent);
      letters += r.sent ? 1 : 0;
      notifications += r.sent ? r.count : 0;
      refused += r.refused ? 1 : 0;
    }
    return { tenantId, letters, notifications, refused };
  }

  /** One person's letter: their email switches applied, claimed, sent or given back. */
  private async sendOne(
    tenantId: string,
    userId: string,
    rows: readonly Unemailed[],
    mode: "instant" | "digest",
  ): Promise<{ sent: boolean; refused: boolean; count: number }> {
    const nothing = { sent: false, refused: false, count: 0 };
    if (rows.length === 0) return nothing;
    const [person] = await this.deps.store.recipients(tenantId, [userId]);
    if (person === undefined) return nothing; // left the firm, or no address
    const wanted = await this.emailOn(tenantId, userId, rows);
    if (wanted.length === 0) return nothing;

    const claimed = await this.deps.store.claimEmailed(tenantId, wanted.map((r) => r.id));
    if (claimed.length === 0) return nothing;
    const records = await this.deps.store.recordsByIds(tenantId, claimed);
    const base = this.deps.appBaseUrl.replace(/\/+$/, "");
    try {
      await this.deps.mailer.sendNotifications({
        to: person.email,
        recipientName: person.displayName,
        firmName: await this.deps.store.firmName(tenantId),
        mode,
        items: records.map((r) => {
          const words = renderNotification(
            { category: r.category, payload: r.payload, actorName: r.actorName, clientName: r.clientName, subjectLabel: r.subjectLabel },
            person.seesFees,
          );
          return { title: words.title, detail: words.detail, url: `${base}${notificationPath(r.category, r.sourceType, r.sourceId, r.payload)}` };
        }),
        inboxUrl: `${base}/notifications`,
        settingsUrl: `${base}/account`,
      });
      return { sent: true, refused: false, count: claimed.length };
    } catch {
      // The adapter logged why. Give the claim back so the next run tries.
      await this.deps.store.releaseEmailed(tenantId, claimed);
      return { sent: false, refused: true, count: claimed.length };
    }
  }

  /** Only the categories this person still wants by email (person > firm > product). */
  private async emailOn(tenantId: string, userId: string, rows: readonly Unemailed[]): Promise<readonly Unemailed[]> {
    const [firm, mine] = await Promise.all([
      this.deps.settings.firmDefaults(tenantId),
      this.deps.settings.userPreferences(tenantId, userId),
    ]);
    const pick = (list: readonly ChannelSetting[], c: NotifyCategory): boolean | undefined =>
      list.find((s) => s.category === c && s.channel === "email")?.enabled;
    return rows.filter((r) => channelEnabled(r.category, "email", pick(firm, r.category), pick(mine, r.category)));
  }

  private async everyFirm(run: (tenantId: string) => Promise<EmailReport>): Promise<readonly EmailReport[]> {
    const out: EmailReport[] = [];
    for (const tenantId of await this.deps.store.activeTenantIds()) {
      try {
        const r = await run(tenantId);
        if (r.letters > 0 || r.refused > 0) out.push(r);
      } catch (err) {
        out.push({ tenantId, letters: 0, notifications: 0, refused: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}

function groupBy(rows: readonly Unemailed[]): Map<string, Unemailed[]> {
  const out = new Map<string, Unemailed[]>();
  for (const r of rows) {
    const list = out.get(r.recipientUserId) ?? [];
    list.push(r);
    out.set(r.recipientUserId, list);
  }
  return out;
}
