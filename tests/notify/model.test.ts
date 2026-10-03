// The notification domain (0323): who hears what, and what it says.
import { describe, expect, it } from "vitest";
import {
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_KEYS,
  NOTIFY_CHANNELS,
  channelEnabled,
  eventDedupeKey,
  isLocked,
  notificationPath,
  renderNotification,
  stageDedupeKey,
} from "../../src/domain/notify/model";
import type { NotifyCategory, RenderInput } from "../../src/domain/notify/model";

function input(category: NotifyCategory, payload: Record<string, unknown> = {}): RenderInput {
  return { category, payload, actorName: "Priya Shah", clientName: "Kaveri Foods", subjectLabel: "INV-2026-0042" };
}

describe("who hears what", () => {
  it("the person beats the firm, and the firm beats the product", () => {
    expect(channelEnabled("lead_assigned", "email", undefined, undefined)).toBe(false);
    expect(channelEnabled("lead_assigned", "email", true, undefined)).toBe(true);
    expect(channelEnabled("lead_assigned", "email", true, false)).toBe(false);
    expect(channelEnabled("lead_assigned", "email", false, true)).toBe(true);
  });

  it("nobody can switch off a mandatory bell, and its email stays theirs to choose", () => {
    for (const category of ["escalation", "filing_missed"] as const) {
      expect(isLocked(category, "in_app")).toBe(true);
      expect(channelEnabled(category, "in_app", false, false)).toBe(true);
      expect(isLocked(category, "email")).toBe(false);
      expect(channelEnabled(category, "email", undefined, false)).toBe(false);
    }
  });

  it("every category is in the bell by default, and only the two mandatory ones email", () => {
    for (const category of NOTIFY_CATEGORY_KEYS) {
      expect(channelEnabled(category, "in_app", undefined, undefined)).toBe(true);
      expect(channelEnabled(category, "push", undefined, undefined)).toBe(false);
      expect(channelEnabled(category, "email", undefined, undefined)).toBe(
        NOTIFY_CATEGORIES[category].mandatoryInApp,
      );
    }
  });
});

describe("the dedupe keys", () => {
  it("say the same fact the same way, and different facts differently", () => {
    expect(eventDedupeKey("e1", "task_assigned")).toBe(eventDedupeKey("e1", "task_assigned"));
    expect(eventDedupeKey("e1", "task_assigned")).not.toBe(eventDedupeKey("e1", "escalation"));
    expect(stageDedupeKey("advance_reminder", "s1", "draft_overdue")).not.toBe(
      stageDedupeKey("advance_reminder", "s1", "escalated"),
    );
  });
});

describe("the words", () => {
  it("never shows an amount to somebody who may not see fees", () => {
    const money = { amount: "118000.00", currency: "INR" };
    for (const category of ["payment_received", "bill_to_raise", "advance_reminder"] as const) {
      const shown = renderNotification(input(category, money), true);
      const hidden = renderNotification(input(category, money), false);
      expect(`${shown.title} ${shown.detail ?? ""}`).toContain("INR 1,18,000");
      expect(`${hidden.title} ${hidden.detail ?? ""}`).not.toMatch(/INR|118|1,18/);
    }
  });

  it("writes every category without an em dash, a code or an empty line", () => {
    for (const category of NOTIFY_CATEGORY_KEYS) {
      for (const fees of [true, false]) {
        const r = renderNotification(input(category, { amount: "10", currency: "INR", stage: "escalated" }), fees);
        expect(r.title.trim()).not.toBe("");
        expect(`${r.title}${r.detail ?? ""}`).not.toMatch(/[—–]|undefined|null|_/);
      }
    }
  });

  it("names the actor when a person did it and says so plainly when nobody did", () => {
    expect(renderNotification(input("task_assigned"), true).title).toBe("Priya Shah gave you a task");
    expect(renderNotification({ ...input("task_assigned"), actorName: null }, true).title).toBe(
      "A task is on your desk",
    );
  });

  it("says which escalation it is", () => {
    expect(renderNotification(input("escalation", { watch: "work_item_due", daysPast: 3 }), true).title).toBe(
      "Escalated: a task is 3 days overdue",
    );
    expect(renderNotification(input("escalation", { watch: "work_item_unassigned" }), true).title).toBe(
      "Escalated: a task nobody has picked up",
    );
    expect(renderNotification(input("escalation", { watch: "obligation_target" }), true).title).toBe(
      "Escalated: a filing is past its internal date",
    );
  });

  it("leaves out whatever part of the detail line is missing", () => {
    const r = renderNotification({ ...input("task_assigned"), clientName: null }, true);
    expect(r.detail).toBe("INV-2026-0042");
    const none = renderNotification({ ...input("task_assigned"), clientName: null, subjectLabel: null }, true);
    expect(none.detail).toBeNull();
  });
});

describe("where it opens", () => {
  it("opens the thing itself, or the list it sits on", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(notificationPath("task_assigned", "work_item", id, {})).toBe(`/work-items/${id}`);
    expect(notificationPath("proposal_decided", "proposal", id, {})).toBe(`/proposals/${id}`);
    expect(notificationPath("bill_to_raise", "billing_due", id, {})).toBe("/invoices?tab=raise");
    expect(notificationPath("dunning_decision", "invoice", id, {})).toBe("/receivables");
    expect(notificationPath("advance_reminder", "engagement_letter", id, {})).toBe("/invoices?tab=advances");
    expect(notificationPath("advance_reminder", "engagement_letter", id, { invoiceId: "inv-1" })).toBe(
      "/invoices/inv-1",
    );
    expect(notificationPath("filing_missed", "obligation_instance", id, {})).toBe("/calendar");
  });

  it("has a channel list the database CHECK agrees with", () => {
    expect([...NOTIFY_CHANNELS]).toEqual(["in_app", "email", "push"]);
  });
});
