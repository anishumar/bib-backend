// The outbox's map (0323): which event tells whom, and what it closes.
import { describe, expect, it } from "vitest";
import { FANOUT_VERBS, planFor } from "../../src/domain/notify/fanout";
import type { LedgerFact } from "../../src/domain/notify/fanout";
import { isEventVerb } from "../../src/domain/ledger/model";
import { NOTIFY_CATEGORY_KEYS } from "../../src/domain/notify/model";

const OBJ = "11111111-1111-4111-8111-111111111111";
const ASHA = "a5a5a5a5-0000-4000-8000-000000000001";

function fact(verb: string, payload: Record<string, unknown> = {}): LedgerFact {
  return { id: "e1", verb, objectId: OBJ, actorUserId: null, payload };
}

describe("the map", () => {
  it("reads only verbs the ledger can record", () => {
    for (const v of FANOUT_VERBS) expect(isEventVerb(v), v).toBe(true);
  });

  it("writes only categories the registry knows", () => {
    for (const verb of FANOUT_VERBS) {
      const plan = planFor(
        fact(verb, {
          userId: ASHA, assigneeUserId: ASHA, ownerUserId: ASHA, workItemId: OBJ, stepKey: "s", jobId: OBJ,
          awaitingCheck: true, isTerminal: true, closed: true, authorSide: "client", partyId: OBJ, invoiceId: OBJ,
          kind: "period", awaitingApproval: true, advances: 2, landedOn: "person", raisedToUserId: ASHA,
        }),
      );
      for (const a of plan.announce) expect(NOTIFY_CATEGORY_KEYS).toContain(a.category);
      for (const r of plan.resolve) for (const c of r.categories) expect(NOTIFY_CATEGORY_KEYS).toContain(c);
    }
  });

  it("hands a task on: closes the old holder's and tells the new one", () => {
    const plan = planFor(fact("work_item.assigned", { userId: ASHA }));
    expect(plan.resolve).toEqual([
      { sourceType: "work_item", sourceId: OBJ, categories: ["task_assigned"], exceptRecipient: ASHA },
    ]);
    expect(plan.announce[0]?.to).toEqual([{ kind: "user", userId: ASHA }]);
    // Taken off everybody's desk: close, tell nobody.
    expect(planFor(fact("work_item.assigned", { userId: null })).announce).toEqual([]);
  });

  it("reads a hand-raised task's creation, and leaves a spawned one to its own assigned event", () => {
    expect(planFor(fact("work_item.created", { origin: "manual", assigned: true })).announce[0]?.to).toEqual([
      { kind: "work_item_assignee", workItemId: OBJ },
    ]);
    expect(planFor(fact("work_item.created", { origin: "engagement", assigned: true })).announce).toEqual([]);
    expect(planFor(fact("work_item.created", { origin: "manual", assigned: false })).announce).toEqual([]);
  });

  it("leaves an advance to its own reminders, and bills to the bill's manager", () => {
    expect(planFor(fact("billing_due.created", { kind: "advance" })).announce).toEqual([]);
    expect(planFor(fact("billing_due.created", { kind: "period" })).announce[0]?.to).toEqual([
      { kind: "due_manager", dueId: OBJ },
    ]);
  });

  it("follows the escalation ladder: a person, a rank, or nobody", () => {
    expect(planFor(fact("work_item.escalated", { landedOn: "person", raisedToUserId: ASHA })).announce[0]?.to).toEqual([
      { kind: "user", userId: ASHA },
    ]);
    expect(planFor(fact("obligation.escalated", { landedOn: "rank", minGradeRank: 9 })).announce[0]?.to).toEqual([
      { kind: "grade_at_least", rank: 9 },
    ]);
    expect(planFor(fact("work_item.escalated", { landedOn: "nobody", note: "x" })).announce).toEqual([]);
  });

  it("tells a partner only about the dunning rung a machine may not climb", () => {
    expect(planFor(fact("dunning.escalated", { awaitingApproval: false })).announce).toEqual([]);
    expect(planFor(fact("dunning.escalated", { awaitingApproval: true })).announce[0]?.to).toEqual([
      { kind: "permission", permission: "tenant:admin" },
    ]);
  });

  it("does not tell a request's assignee twice: the raise only reaches an unplaced request's Key Manager", () => {
    expect(planFor(fact("client_request.raised")).announce[0]?.to).toEqual([
      { kind: "request_owner", requestId: OBJ, onlyUnplaced: true },
    ]);
    expect(planFor(fact("client_request.replied", { authorSide: "firm" })).announce).toEqual([]);
  });

  it("tells the new lead's owner it is theirs and every admin a lead came in, never the owner twice (Q066)", () => {
    const named = planFor(fact("lead.captured", { ownerUserId: ASHA, ownerAssignedBy: "requested" }));
    expect(named.announce.map((a) => a.category)).toEqual(["lead_assigned", "lead_new"]);
    expect(named.announce[0]?.to).toEqual([{ kind: "user", userId: ASHA }]);
    expect(named.announce[0]?.payload).toEqual({});
    expect(named.announce[1]?.to).toEqual([{ kind: "permission", permission: "tenant:admin" }]);
    expect(named.announce[1]?.except).toEqual([ASHA]);
    expect(named.announce[1]?.payload).toEqual({});

    // The firm's rule chose: the owner is told it was the rule, not a person.
    const byRule = planFor(fact("lead.captured", { ownerUserId: ASHA, ownerAssignedBy: "round_robin" }));
    expect(byRule.announce[0]?.payload).toEqual({ byRule: true });

    // Left unassigned: only the admins hear, and they hear it is unassigned.
    const nobody = planFor(fact("lead.captured", { ownerUserId: null, ownerAssignedBy: null }));
    expect(nobody.announce.map((a) => a.category)).toEqual(["lead_new"]);
    expect(nobody.announce[0]?.payload).toEqual({ unassigned: true });
    expect(nobody.announce[0]?.except).toEqual([]);
  });

  it("closes a lead's notifications, both kinds, when it closes", () => {
    expect(planFor(fact("lead.stage_changed", { closed: true })).resolve).toEqual([
      { sourceType: "lead", sourceId: OBJ, categories: ["lead_assigned", "lead_new"] },
    ]);
  });

  it("closes a step's notifications only for that step", () => {
    const plan = planFor(fact("job.step_advanced", { stepKey: "review", to: "done" }));
    expect(plan.resolve[0]).toMatchObject({ sourceType: "job", sourceId: OBJ, stepKey: "review" });
  });

  it("plans nothing for a verb it does not read", () => {
    expect(planFor(fact("party.created"))).toEqual({ announce: [], resolve: [] });
  });
});
