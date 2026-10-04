// Notifications by email (0324), against a real database.
//
//   1. URGENT AT ONCE, ONCE. An escalation goes to its reader in one letter; a
//      second run sends nothing; a person who switched that email off gets none.
//   2. A REFUSED SEND IS NOT LOST. The claim is given back and the next run
//      sends it.
//   3. THE DAILY EMAIL is due from the firm's hour in the FIRM's zone, once per
//      person per day, and lists only unread, unresolved, unemailed rows.
//   4. THE FEE AXIS reaches email: no amount for a reader who may not see fees.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import type { Db } from "../../src/db/pool";
import { FakeClock } from "../../src/testfakes/clock";
import { PostgresNotificationEmailStore } from "../../src/infrastructure/postgres/notification-email";
import { PostgresNotificationSettings } from "../../src/infrastructure/postgres/notification-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { NotificationEmails } from "../../src/usecase/notify/email";
import type { NotificationLetter, NotificationMailer } from "../../src/usecase/notify/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const appDb = app as unknown as Db;

const stamp = Date.now().toString(36);
let tenant = "";
let asha = ""; // no fees
let bilal = ""; // sees fees

class Mailbox implements NotificationMailer {
  sent: NotificationLetter[] = [];
  refuse = false;
  sendNotifications(letter: NotificationLetter): Promise<void> {
    if (this.refuse) return Promise.reject(new Error("relay refused"));
    this.sent.push(letter);
    return Promise.resolve();
  }
}

const mailbox = new Mailbox();
const clock = new FakeClock();
const settings = new PostgresNotificationSettings(appDb);
const emails = new NotificationEmails({
  store: new PostgresNotificationEmailStore(appDb),
  settings,
  mailer: mailbox,
  timeZones: new PostgresFirmTimeZone(appDb),
  clock,
  appBaseUrl: "https://app.example/",
});

async function notify(recipient: string, category: string, extra: { payload?: Record<string, unknown>; createdAt?: string } = {}): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO notify.notification (tenant_id, recipient_user_id, category, source_type, source_id, payload, dedupe_key, created_at)
    VALUES (${tenant}, ${recipient}, ${category}, 'invoice', ${randomUUID()},
            ${owner.json((extra.payload ?? {}) as Record<string, never>)}, ${randomUUID()},
            COALESCE(${extra.createdAt ?? null}::timestamptz, now()))
    RETURNING id
  `;
  if (!row) throw new Error("no row");
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`nt-mail-${stamp}`}, 'Kaveri & Co', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  const [a] = await owner<{ id: string }[]>`INSERT INTO tenancy.user_account (email, display_name) VALUES (${`asha-${stamp}@nt.test`}, 'Asha') RETURNING id`;
  const [b] = await owner<{ id: string }[]>`INSERT INTO tenancy.user_account (email, display_name) VALUES (${`bilal-${stamp}@nt.test`}, 'Bilal') RETURNING id`;
  if (!t || !a || !b) throw new Error("could not seed");
  tenant = t.id;
  asha = a.id;
  bilal = b.id;
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active, commercial_visibility)
    VALUES (${tenant}, ${asha}, 'STAFF', 'associate', true, false), (${tenant}, ${bilal}, 'STAFF', 'partner', true, true)
  `;
});

afterAll(async () => {
  await owner`DELETE FROM notify.email_digest WHERE tenant_id = ${tenant}`;
  await owner`DELETE FROM notify.notification WHERE tenant_id = ${tenant}`;
  await owner`DELETE FROM notify.user_preference WHERE tenant_id = ${tenant}`;
  await owner`DELETE FROM notify.firm_setting WHERE tenant_id = ${tenant}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id = ${tenant}`;
  await owner`DELETE FROM tenancy.user_account WHERE id IN ${owner([asha, bilal])}`;
  await owner.end();
  await app.end();
});

describe("urgent notifications, at once", () => {
  it("sends one letter per person, once, with a link to each", async () => {
    clock.set(new Date());
    mailbox.sent = [];
    await notify(asha, "escalation", { payload: { watch: "work_item_unassigned" } });
    await notify(asha, "filing_missed");
    await notify(asha, "task_assigned"); // a daily one: not now
    const r = await emails.sendInstant(tenant);
    expect(r).toMatchObject({ letters: 1, notifications: 2 });
    const [letter] = mailbox.sent;
    expect(letter?.mode).toBe("instant");
    expect(letter?.to).toBe(`asha-${stamp}@nt.test`);
    expect(letter?.items.map((i) => i.title).sort()).toEqual(
      ["A filing deadline was missed", "Escalated: a task nobody has picked up"].sort(),
    );
    expect(letter?.items.every((i) => i.url.startsWith("https://app.example/"))).toBe(true);
    expect(letter?.settingsUrl).toBe("https://app.example/account");

    expect((await emails.sendInstant(tenant)).letters).toBe(0);
  });

  it("sends nothing to a person who switched that email off", async () => {
    mailbox.sent = [];
    await settings.setUserPreferences(tenant, bilal, [{ category: "escalation", channel: "email", enabled: false }]);
    await notify(bilal, "escalation");
    expect((await emails.sendInstant(tenant)).letters).toBe(0);
    await settings.setUserPreferences(tenant, bilal, [{ category: "escalation", channel: "email", enabled: true }]);
  });

  it("gives a refused send back, and the next run sends it", async () => {
    mailbox.sent = [];
    const id = await notify(asha, "escalation");
    mailbox.refuse = true;
    const refused = await emails.sendInstant(tenant);
    mailbox.refuse = false;
    // Asha's letter, and Bilal's (his escalation is waiting since he switched email back on).
    expect(refused.refused).toBe(2);
    const [row] = await owner<{ emailed_at: string | null }[]>`SELECT emailed_at::text FROM notify.notification WHERE id = ${id}`;
    expect(row?.emailed_at).toBeNull();
    // Bilal's switched-off escalation is still waiting; switched on again, it goes now too.
    const again = await emails.sendInstant(tenant);
    expect(again.letters).toBeGreaterThanOrEqual(1);
    expect(mailbox.sent.some((l) => l.to.startsWith("asha"))).toBe(true);
  });
});

describe("the daily email", () => {
  it("is not due before the firm's hour in the firm's zone", async () => {
    mailbox.sent = [];
    // 03:00 UTC = 08:30 in Kolkata.
    clock.set("2026-10-04T03:00:00.000Z");
    expect((await emails.sendDigests(tenant)).letters).toBe(0);
  });

  it("goes once per person per day, unread only, and without an amount for somebody without fees", async () => {
    mailbox.sent = [];
    clock.set("2026-10-04T03:30:00.000Z"); // 09:00 in Kolkata
    const money = { amount: "50000", currency: "INR" };
    await owner`UPDATE notify.notification SET created_at = '2026-10-03T10:00:00Z' WHERE tenant_id = ${tenant} AND category = 'task_assigned'`;
    await notify(asha, "payment_received", { payload: money, createdAt: "2026-10-03T11:00:00Z" });
    await notify(bilal, "payment_received", { payload: money, createdAt: "2026-10-03T11:00:00Z" });
    const read = await notify(bilal, "lead_assigned", { createdAt: "2026-10-03T12:00:00Z" });
    await owner`UPDATE notify.notification SET read_at = now() WHERE id = ${read}`;
    await notify(bilal, "lead_assigned", { createdAt: "2026-09-01T12:00:00Z" }); // older than a week

    const r = await emails.sendDigests(tenant);
    expect(r.letters).toBe(2);
    const toAsha = mailbox.sent.find((l) => l.to.startsWith("asha"));
    const toBilal = mailbox.sent.find((l) => l.to.startsWith("bilal"));
    expect(toAsha?.mode).toBe("digest");
    expect(toAsha?.items).toHaveLength(2); // the task + the payment
    expect(JSON.stringify(toAsha)).not.toMatch(/INR|50,000/);
    expect(toBilal?.items).toHaveLength(1); // the payment only: one read, one too old
    expect(toBilal?.items[0]?.detail).toContain("INR 50,000");

    // The same day again: nothing.
    clock.set("2026-10-04T10:00:00.000Z");
    expect((await emails.sendDigests(tenant)).letters).toBe(0);
    const claims = await owner<{ n: string }[]>`SELECT count(*)::text AS n FROM notify.email_digest WHERE tenant_id = ${tenant} AND digest_day = '2026-10-04'`;
    expect(claims[0]?.n).toBe("2");
  });

  it("goes at the hour the firm chose", async () => {
    mailbox.sent = [];
    await owner`INSERT INTO notify.firm_setting (tenant_id, digest_hour) VALUES (${tenant}, 18)`;
    await notify(asha, "lead_assigned", { createdAt: "2026-10-04T05:00:00Z" });
    clock.set("2026-10-05T03:30:00.000Z"); // 09:00 the next day: too early now
    expect((await emails.sendDigests(tenant)).letters).toBe(0);
    clock.set("2026-10-05T12:30:00.000Z"); // 18:00
    expect((await emails.sendDigests(tenant)).letters).toBe(1);
  });
});
