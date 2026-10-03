// The notification inbox and settings (0323), over in-memory ports. The SQL is
// proven in `inbox.integration.test.ts`; this is the service's own rules.
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationService, UNREAD_CAP } from "../../src/usecase/notify/service";
import { FakeNotificationInbox, FakeNotificationSettings } from "../../src/testfakes/notify";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { NotificationLocked, NotificationNotFound, NotificationSettingsEmpty } from "../../src/domain/notify/errors";
import { findPiiKey } from "../../src/domain/ledger/model";

const FIRM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_FIRM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASHA = "a5a5a5a5-0000-4000-8000-000000000001";
const BILAL = "b1b1b1b1-0000-4000-8000-000000000002";
const ALL = { unreadOnly: false, category: null, before: null, limit: 50 } as const;

let inbox: FakeNotificationInbox;
let settings: FakeNotificationSettings;
let events: RecordingEventSink;
let service: NotificationService;

beforeEach(() => {
  inbox = new FakeNotificationInbox();
  settings = new FakeNotificationSettings();
  events = new RecordingEventSink();
  service = new NotificationService({ inbox, settings, events });
});

describe("the inbox", () => {
  it("renders for the reader: the amount only for one who may see fees", async () => {
    inbox.add({
      tenantId: FIRM,
      recipientUserId: ASHA,
      category: "payment_received",
      sourceType: "invoice",
      payload: { amount: "50000", currency: "INR" },
      clientName: "Kaveri Foods",
      subjectLabel: "INV-7",
    });
    const [withFees] = await service.list(FIRM, ASHA, true, ALL);
    const [without] = await service.list(FIRM, ASHA, false, ALL);
    expect(withFees?.title).toBe("Payment received from Kaveri Foods");
    expect(withFees?.detail).toBe("INV-7 · INR 50,000");
    expect(without?.detail).toBe("INV-7");
    expect(withFees?.href).toMatch(/^\/invoices\//);
  });

  it("refuses to mark a colleague's notification, as not found", async () => {
    const bilals = inbox.add({ tenantId: FIRM, recipientUserId: BILAL, category: "task_assigned" });
    await expect(service.markRead(FIRM, ASHA, bilals.id)).rejects.toBeInstanceOf(NotificationNotFound);
    await expect(service.markRead(OTHER_FIRM, BILAL, bilals.id)).rejects.toBeInstanceOf(NotificationNotFound);
    expect((await service.markRead(FIRM, BILAL, bilals.id)).readAt).toBeTruthy();
  });

  it("counts unread and unresolved, up to the cap", async () => {
    inbox.add({ tenantId: FIRM, recipientUserId: ASHA, category: "task_assigned" });
    inbox.add({ tenantId: FIRM, recipientUserId: ASHA, category: "task_assigned", resolvedAt: "2026-10-03T10:00:00.000Z" });
    inbox.add({ tenantId: FIRM, recipientUserId: ASHA, category: "task_assigned", readAt: "2026-10-03T10:00:00.000Z" });
    inbox.add({ tenantId: FIRM, recipientUserId: BILAL, category: "task_assigned" });
    expect(await service.unreadCount(FIRM, ASHA)).toBe(1);
    for (let i = 0; i < UNREAD_CAP + 5; i += 1) {
      inbox.add({ tenantId: FIRM, recipientUserId: BILAL, category: "lead_assigned" });
    }
    expect(await service.unreadCount(FIRM, BILAL)).toBe(UNREAD_CAP);
  });
});

describe("a person's own settings", () => {
  it("refuses switching off a mandatory bell, and allows its email", async () => {
    await expect(
      service.setPreferences(FIRM, ASHA, [{ category: "escalation", channel: "in_app", enabled: false }]),
    ).rejects.toBeInstanceOf(NotificationLocked);
    const after = await service.setPreferences(FIRM, ASHA, [
      { category: "escalation", channel: "email", enabled: false },
    ]);
    const esc = after.find((c) => c.category === "escalation");
    expect(esc?.channels.email).toEqual({ enabled: false, firmEnabled: true, overridden: true, locked: false });
    expect(esc?.channels.in_app.locked).toBe(true);
  });

  it("refuses a change that names nothing", async () => {
    await expect(service.setPreferences(FIRM, ASHA, [])).rejects.toBeInstanceOf(NotificationSettingsEmpty);
  });

  it("shows the firm's choice under the person's, and is not recorded in the ledger", async () => {
    await service.setFirmDefaults(FIRM, { type: "human", id: BILAL }, [
      { category: "lead_assigned", channel: "email", enabled: true },
    ]);
    const before = events.recorded.length;
    const mine = await service.setPreferences(FIRM, ASHA, [
      { category: "lead_assigned", channel: "email", enabled: true },
    ]);
    const lead = mine.find((c) => c.category === "lead_assigned");
    // The same as the firm: chosen, but not different.
    expect(lead?.channels.email).toEqual({ enabled: true, firmEnabled: true, overridden: false, locked: false });
    expect(events.recorded.length).toBe(before);
  });
});

describe("the firm's defaults", () => {
  it("records both sides of what moved, and nothing when nothing did", async () => {
    await service.setFirmDefaults(FIRM, { type: "human", id: ASHA }, [
      { category: "escalation", channel: "email", enabled: true },
    ]);
    expect(events.recorded).toHaveLength(0);

    const view = await service.setFirmDefaults(FIRM, { type: "human", id: ASHA }, [
      { category: "escalation", channel: "email", enabled: false },
    ]);
    expect(events.recorded).toHaveLength(1);
    const e = events.recorded[0];
    expect(e?.verb).toBe("tenant.notification_defaults_set");
    expect(e?.objectId).toBe(FIRM);
    expect(e?.payload).toEqual({ changes: [{ category: "escalation", channel: "email", from: true, to: false }] });
    expect(findPiiKey(e?.payload)).toBeNull();
    expect(view.find((c) => c.category === "escalation")?.channels.email.overridden).toBe(true);
  });

  it("refuses switching off a mandatory bell for the whole firm", async () => {
    await expect(
      service.setFirmDefaults(FIRM, { type: "human", id: ASHA }, [
        { category: "filing_missed", channel: "in_app", enabled: false },
      ]),
    ).rejects.toBeInstanceOf(NotificationLocked);
    expect(events.recorded).toHaveLength(0);
  });
});
