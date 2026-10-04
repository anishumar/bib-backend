// The monthly reminder of advances still to be adjusted (0363, Q047): ONE
// notification per person a month (each advance's raiser and every admin),
// never on another month's key, totals per currency, resolved when nothing of
// theirs is left. The rows' words and the fee axis are the bell's own
// (`renderNotification`), tested with it.
import { describe, expect, it } from "vitest";
import { AdhocAdvanceReminders, totalsByCurrency } from "../../src/usecase/notify/adhoc-reminders";
import { renderNotification } from "../../src/domain/notify/model";
import type { AdhocAdvanceRecord } from "../../src/usecase/billing/ports";
import type { NewNotification, OpenReminder } from "../../src/usecase/notify/ports";
import { FakeNotificationSettings } from "../../src/testfakes/notify";
import type { Permission } from "../../src/domain/authz/model";

const T = "00000000-0000-4000-8000-0000000000a1";

function advance(id: string, raiser: string, currency: string, unmapped: string): AdhocAdvanceRecord {
  return {
    id,
    party: { id: "c", displayName: "Client" },
    issuer: { id: "f", displayName: "Firm" },
    currency,
    note: null,
    raisedBy: { userId: raiser, displayName: null, email: `${raiser}@firm.test` },
    raisedAt: "2026-10-05T00:00:00.000Z",
    manager: null,
    invoice: { id: `inv-${id}`, number: "INV/1", status: "issued", issuedOn: "2026-10-05" },
    net: unmapped,
    total: unmapped,
    credited: "0",
    mapped: "0",
    unmapped,
    refundAmount: unmapped,
    paid: "0",
    outstanding: unmapped,
    allocations: [],
    namedOn: [],
  };
}

function harness(advances: AdhocAdvanceRecord[], now: string, open: OpenReminder[] = []) {
  const inserted: NewNotification[] = [];
  const resolved: string[] = [];
  const roles: Record<string, readonly Permission[]> = { partner: ["tenant:admin"], manager: ["advance:manage"] };
  const reminders = new AdhocAdvanceReminders({
    outbox: {
      activeTenantIds: () => Promise.resolve([T]),
      insert: (rows: readonly NewNotification[]) => {
        inserted.push(...rows);
        return Promise.resolve(rows.length);
      },
      openReminders: () => Promise.resolve(open),
      resolveIds: (_t: string, ids: readonly string[]) => {
        resolved.push(...ids);
        return Promise.resolve(ids.length);
      },
    } as never,
    advances: { list: () => Promise.resolve(advances) },
    directory: {
      activeStaff: () =>
        Promise.resolve([
          { userId: "admin", role: "partner", gradeRank: null },
          { userId: "raiser-1", role: "manager", gradeRank: null },
          { userId: "raiser-2", role: "manager", gradeRank: null },
        ]),
    } as never,
    permissions: { permissionsFor: (_t: string, role: string) => Promise.resolve(roles[role] ?? []) } as never,
    settings: new FakeNotificationSettings(),
    timing: {
      dayFor: () => Promise.resolve(1),
      timeZoneFor: () => Promise.resolve("Asia/Kolkata"),
      digestHour: () => Promise.resolve(9),
    },
    clock: { now: () => new Date(now) },
  });
  return { reminders, inserted, resolved };
}

describe("the monthly reminder of advances still to be adjusted", () => {
  const advances = [
    advance("a1", "raiser-1", "INR", "50000.00"),
    advance("a2", "raiser-1", "AED", "5000.00"),
    advance("a3", "raiser-2", "INR", "10000.00"),
    // Somebody who has left: the admins still hear of it.
    advance("a4", "gone", "INR", "1.00"),
  ];

  it("writes one per person on the firm's day: each raiser for theirs, every admin for all", async () => {
    const { reminders, inserted } = harness(advances, "2026-11-01T04:00:00Z");
    const r = await reminders.runForTenant(T);
    expect(r).toMatchObject({ month: "2026-11", created: 3 });
    const by = new Map(inserted.map((n) => [n.recipientUserId, n]));
    expect([...by.keys()].sort()).toEqual(["admin", "raiser-1", "raiser-2"]);
    expect(by.get("raiser-1")?.payload).toMatchObject({
      advances: 2,
      totals: [
        { currency: "AED", amount: "5000.00" },
        { currency: "INR", amount: "50000.00" },
      ],
    });
    expect(by.get("admin")?.payload).toMatchObject({ advances: 4 });
    // Once a month per person: the key names the month.
    expect(by.get("admin")?.dedupeKey).toBe("stage:advance_unmapped:admin:2026-11");
  });

  it("writes nothing before the firm's day and hour", async () => {
    const { reminders, inserted } = harness(advances, "2026-11-01T03:00:00Z");
    // 1 Nov 08:30 IST: November's is due at 09:00.
    const early = await reminders.runForTenant(T);
    expect(early).toMatchObject({ month: null, created: 0 });
    expect(inserted).toEqual([]);
  });

  it("resolves the reminder of somebody with nothing left unmapped", async () => {
    const { reminders, resolved } = harness([advance("a1", "raiser-1", "INR", "50000.00")], "2026-11-15T04:00:00Z", [
      { id: "n-raiser-2", sourceId: "raiser-2", stage: "2026-11" },
      { id: "n-raiser-1", sourceId: "raiser-1", stage: "2026-11" },
    ]);
    await reminders.runForTenant(T);
    expect(resolved).toEqual(["n-raiser-2"]);
  });

  it("never adds two currencies, and shows no amount to a reader who cannot see fees", () => {
    const totals = totalsByCurrency([advance("x", "r", "INR", "1.50"), advance("y", "r", "INR", "2"), advance("z", "r", "USD", "3")]);
    expect(totals).toEqual([
      { currency: "INR", amount: "3.50" },
      { currency: "USD", amount: "3" },
    ]);
    const input = {
      category: "advance_unmapped" as const,
      payload: { advances: 3, totals },
      actorName: null,
      clientName: null,
      subjectLabel: null,
    };
    const seen = renderNotification(input, true);
    expect(seen.title).toBe("3 advances are still to be adjusted");
    expect(seen.detail).toMatch(/3\.50/);
    expect(seen.detail).toMatch(/USD|\$/);
    const hidden = renderNotification(input, false);
    expect(hidden.detail).not.toMatch(/\d/);
  });
});
