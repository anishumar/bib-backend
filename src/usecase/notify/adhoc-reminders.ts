// The monthly reminder of advances still to be adjusted (0363, Q047, Ashish:
// "Yes monthly basis to the person who have generated it and admin").
//
// A month passing is not an act, so no event exists for the outbox to read.
// This sweep asks the advances list which advances are issued with part of
// them mapped nowhere, and on the firm's day of the month, from its daily-email
// hour, in its zone, writes ONE notification per person: each advance's raiser
// (while still active staff) and every administrator, listing how many and,
// per currency, how much (the words are written at read time with the reader's
// fee axis). One a month per person by the dedupe key; the daily email carries
// it. A person with nothing left unmapped has their open reminder resolved.
import type { NotifyCategory } from "../../domain/notify/model";
import { channelEnabled, stageDedupeKey } from "../../domain/notify/model";
import { grants, type Permission } from "../../domain/authz/model";
import { sumAmounts, unmappedReminderDue } from "../../domain/billing/adhoc-advance";
import { compareAmounts } from "../../domain/money/model";
import type { PermissionSource } from "../authz/ports";
import type { AdhocAdvanceRecord } from "../billing/ports";
import type { Clock } from "../../platform/clock";
import type { NewNotification, NotificationOutbox, NotificationSettingsStore, NotifyDirectory, StaffMember } from "./ports";

export interface UnmappedAdvanceSource {
  list(tenantId: string, filters: { readonly status: "open" }): Promise<readonly AdhocAdvanceRecord[]>;
}

/** When a firm is reminded: its day of the month, its zone, its email hour. */
export interface UnmappedReminderTiming {
  dayFor(tenantId: string): Promise<number>;
  timeZoneFor(tenantId: string): Promise<string>;
  digestHour(tenantId: string): Promise<number>;
}

export interface AdhocAdvanceRemindersDeps {
  readonly outbox: NotificationOutbox;
  readonly advances: UnmappedAdvanceSource;
  readonly directory: NotifyDirectory;
  readonly permissions: PermissionSource;
  readonly settings: NotificationSettingsStore;
  readonly timing: UnmappedReminderTiming;
  readonly clock: Clock;
}

export interface AdhocReminderReport {
  readonly tenantId: string;
  /** The month reminded, or null when it is not the day yet. */
  readonly month: string | null;
  readonly created: number;
  readonly resolved: number;
  readonly failure?: string;
}

const CATEGORY: NotifyCategory = "advance_unmapped";

export class AdhocAdvanceReminders {
  constructor(private readonly deps: AdhocAdvanceRemindersDeps) {}

  async sweep(): Promise<readonly AdhocReminderReport[]> {
    const out: AdhocReminderReport[] = [];
    for (const tenantId of await this.deps.outbox.activeTenantIds()) {
      try {
        const r = await this.runForTenant(tenantId);
        if (r.created > 0 || r.resolved > 0) out.push(r);
      } catch (err) {
        out.push({ tenantId, month: null, created: 0, resolved: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  async runForTenant(tenantId: string): Promise<AdhocReminderReport> {
    const [advances, open] = await Promise.all([
      this.deps.advances.list(tenantId, { status: "open" }),
      this.deps.outbox.openReminders(tenantId, CATEGORY),
    ]);
    const unmapped = advances.filter(
      (a) => a.invoice.status === "issued" && a.unmapped !== null && compareAmounts(a.unmapped, "0") > 0,
    );

    const staff = await this.deps.directory.activeStaff(tenantId);
    const onStaff = new Set(staff.map((s) => s.userId));
    const admins = await this.holders(tenantId, staff, "tenant:admin");
    // Each person's advances: the ones they raised, and every one for an admin.
    const byPerson = new Map<string, AdhocAdvanceRecord[]>();
    for (const a of unmapped) {
      const people = new Set([...(a.raisedBy === null ? [] : [a.raisedBy.userId]), ...admins]);
      for (const userId of people) {
        if (!onStaff.has(userId)) continue;
        byPerson.set(userId, [...(byPerson.get(userId) ?? []), a]);
      }
    }

    // Nothing left for somebody: their reminder is done.
    const stale = open.filter((o) => !byPerson.has(o.sourceId));
    const resolved = stale.length === 0 ? 0 : await this.deps.outbox.resolveIds(tenantId, stale.map((o) => o.id));

    const [day, zone, hour] = await Promise.all([
      this.deps.timing.dayFor(tenantId),
      this.deps.timing.timeZoneFor(tenantId),
      this.deps.timing.digestHour(tenantId),
    ]);
    const month = unmappedReminderDue({ now: this.deps.clock.now().toISOString(), timeZone: zone, day, hour });
    if (month === null || byPerson.size === 0) return { tenantId, month, created: 0, resolved };

    const firm = await this.deps.settings.firmDefaults(tenantId);
    const firmBell = firm.find((f) => f.category === CATEGORY && f.channel === "in_app")?.enabled;
    const rows: NewNotification[] = [];
    for (const [userId, theirs] of byPerson) {
      const own = (await this.deps.settings.userPreferences(tenantId, userId)).find(
        (s) => s.category === CATEGORY && s.channel === "in_app",
      )?.enabled;
      if (!channelEnabled(CATEGORY, "in_app", firmBell, own)) continue;
      rows.push({
        tenantId,
        recipientUserId: userId,
        category: CATEGORY,
        // The person is the source: one reminder each, whatever the number of
        // advances, resolved when nothing of theirs is left.
        sourceType: "user_account",
        sourceId: userId,
        payload: {
          stage: month,
          month,
          advances: theirs.length,
          totals: totalsByCurrency(theirs),
          advanceIds: theirs.map((a) => a.id),
        },
        eventId: null,
        actorUserId: null,
        dedupeKey: stageDedupeKey(CATEGORY, userId, month),
      });
    }
    const created = rows.length === 0 ? 0 : await this.deps.outbox.insert(rows);
    return { tenantId, month, created, resolved };
  }

  private async holders(tenantId: string, staff: readonly StaffMember[], permission: Permission): Promise<string[]> {
    const roles = new Map<string, readonly Permission[]>();
    const out: string[] = [];
    for (const m of staff) {
      let held = roles.get(m.role);
      if (held === undefined) {
        held = await this.deps.permissions.permissionsFor(tenantId, m.role);
        roles.set(m.role, held);
      }
      if (grants(held, permission)) out.push(m.userId);
    }
    return out;
  }
}

/** Per currency, what is left unmapped: never added across currencies. */
export function totalsByCurrency(
  advances: readonly AdhocAdvanceRecord[],
): readonly { readonly currency: string; readonly amount: string }[] {
  const by = new Map<string, string[]>();
  for (const a of advances) {
    if (a.unmapped === null) continue;
    by.set(a.currency, [...(by.get(a.currency) ?? []), a.unmapped]);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amounts]) => ({ currency, amount: sumAmounts(amounts) }));
}
