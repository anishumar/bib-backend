// The pure rules of the work-item domain (T3.1). No database, no fakes, no
// service — just the decisions, asserted against the cases the firm described
// and the ones the schema permits.
import { describe, expect, it } from "vitest";
import type {
  SpocCandidate,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../../src/domain/workitem/model";
import {
  boardOrder,
  defaultPriorityFor,
  dueOnFrom,
  initialState,
  priorityOrder,
  resolveAssignee,
  stateOrder,
  wouldCycle,
} from "../../src/domain/workitem/model";

const FIRM = "00000000-0000-4000-8000-000000000001";

function state(over: Partial<WorkItemState> & { id: string }): WorkItemState {
  return {
    tenantId: FIRM,
    code: over.id,
    name: over.id,
    isInitial: false,
    isTerminal: false,
    isUnderReview: false,
    isBlocked: false,
    isSuccess: false,
    sortOrder: 0,
    isActive: true,
    ...over,
  };
}

function priority(over: Partial<WorkItemPriority> & { id: string }): WorkItemPriority {
  return {
    tenantId: FIRM,
    code: over.id,
    name: over.id,
    rank: 3,
    isDefault: false,
    isStatutoryDefault: false,
    isActive: true,
    ...over,
  };
}

function spoc(userId: string, displayName: string | null = null): SpocCandidate {
  return { userId, displayName, email: `${userId}@example.test`, routed: 0 };
}

describe("the starting state", () => {
  it("is the one flagged initial, never the first in the list", () => {
    // The FLAG and not the order, because a firm reorders its board columns and
    // must not move where new work begins by doing it.
    const states = [state({ id: "done", isTerminal: true }), state({ id: "new", isInitial: true })];
    expect(initialState(states)?.id).toBe("new");
  });

  it("is null when the firm has flagged none — a refusal, never a guess", () => {
    // Returning states[0] here would create every new work item in whatever the
    // query happened to return first, silently. The service turns this null
    // into a sentence naming the screen that fixes it.
    expect(initialState([state({ id: "a" }), state({ id: "b" })])).toBeNull();
  });
});

describe("the priority new work gets", () => {
  const priorities = [
    priority({ id: "critical", rank: 1 }),
    priority({ id: "high", rank: 2, isStatutoryDefault: true }),
    priority({ id: "medium", rank: 3, isDefault: true }),
  ];

  it("is the ordinary default for ordinary work", () => {
    expect(defaultPriorityFor(priorities, false)?.id).toBe("medium");
  });

  it("is the statutory default for statutory work — the firm's own rule", () => {
    // *"due dates that are statutory should anyway be high priority"*. Derived
    // rather than typed, because a field a human sets on every task is a field
    // that is wrong on most of them.
    expect(defaultPriorityFor(priorities, true)?.id).toBe("high");
  });

  it("falls back to the ordinary default when no statutory one is flagged", () => {
    // NOT to the most urgent row. Picking `critical` because it happens to be
    // rank 1 would be inventing an urgency the firm never set — which is
    // exactly what this function exists to avoid.
    const noStatutory = [priority({ id: "critical", rank: 1 }), priority({ id: "medium", rank: 3, isDefault: true })];
    expect(defaultPriorityFor(noStatutory, true)?.id).toBe("medium");
  });

  it("is null when the firm has flagged no default at all", () => {
    expect(defaultPriorityFor([priority({ id: "critical", rank: 1 })], false)).toBeNull();
  });

  it("can be the SAME row for both, which is a real setting", () => {
    // A firm that does not want statutory work treated differently ticks both
    // on one priority. Two partial indexes rather than one, so the schema
    // permits it too.
    const both = [priority({ id: "normal", isDefault: true, isStatutoryDefault: true })];
    expect(defaultPriorityFor(both, true)?.id).toBe("normal");
    expect(defaultPriorityFor(both, false)?.id).toBe("normal");
  });
});

describe("the due date", () => {
  it("is the start date plus whole days", () => {
    // The firm's own rule: *"task is due from signing of EL"*, *"SLA is per
    // service"*.
    expect(dueOnFrom("2026-09-01", 30)).toBe("2026-10-01");
  });

  it("crosses a month, a year and a leap day without a calendar library", () => {
    expect(dueOnFrom("2026-12-20", 20)).toBe("2027-01-09");
    expect(dueOnFrom("2028-02-28", 1)).toBe("2028-02-29");
    expect(dueOnFrom("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("is the start date itself at zero days", () => {
    expect(dueOnFrom("2026-09-01", 0)).toBe("2026-09-01");
  });

  it("is NULL when the firm has not stated an SLA for the service", () => {
    // No deadline rather than one this product invented. `service.slaDays` is
    // optional and has no real numbers in it yet — the firm has not given its
    // internal turnaround times.
    expect(dueOnFrom("2026-09-01", null)).toBeNull();
  });

  it("crosses a DST boundary without dropping or gaining a day", () => {
    // The failure this function is written around. A `Date` is an INSTANT, and
    // adding 86_400_000 ms to a LOCAL midnight lands at 23:00 the same day when
    // the clocks go forward — so a naive implementation running in a DST zone
    // would answer 2026-03-07 here. The arithmetic runs in explicit UTC on both
    // sides (`Date.UTC` in, `toISOString` out), which has no DST at all.
    //
    // The guarantee is structural rather than something a test can vary the
    // process timezone to prove, so these are the boundary DATES that would
    // expose a local-time implementation: US spring forward, US fall back, and
    // the EU changeover.
    expect(dueOnFrom("2026-03-07", 1)).toBe("2026-03-08");
    expect(dueOnFrom("2026-11-01", 1)).toBe("2026-11-02");
    expect(dueOnFrom("2026-03-28", 1)).toBe("2026-03-29");
    expect(dueOnFrom("2026-10-24", 1)).toBe("2026-10-25");
  });

  it("is stable across a long span, so no accumulated drift is possible", () => {
    // 365 days from a fixed date, checked against the calendar rather than
    // against another run of the same arithmetic.
    expect(dueOnFrom("2026-01-01", 365)).toBe("2027-01-01");
    expect(dueOnFrom("2028-01-01", 366)).toBe("2029-01-01");
  });
});

describe("routing a filing to the client's Dept SPOC", () => {
  it("assigns when there is exactly one — the acceptance line", () => {
    const out = resolveAssignee([spoc("priya")], "FRC");
    expect(out.userId).toBe("priya");
    expect(out.note).toBeNull();
  });

  it("leaves it unassigned when the client has no SPOC for that Dept", () => {
    // Falling back to the Key Manager was considered and refused: it is a rule
    // the firm never gave, and it would hide the real problem behind a
    // plausible answer somebody would then have to un-do.
    const out = resolveAssignee([], "FRC");
    expect(out.userId).toBeNull();
    expect(out.note).toContain("FRC");
    expect(out.note).toContain("No SPOC");
  });

  it("takes turns when there are TWO: whoever has had the fewest of this client's tasks", () => {
    // G3.2 deliberately allows more than one per Dept. Until 2026-09-25 this
    // was left unassigned with a note ("take the first" is a rule nobody
    // gave); the firm has since said the work is SHARED. So the rule is
    // turn-taking off the rows: fewest routed so far wins, no state kept.
    const priya = spoc("priya", "Priya");
    const anand = spoc("anand", "Anand");
    expect(resolveAssignee([{ ...priya, routed: 0 }, { ...anand, routed: 0 }], "FRC").userId).toBe("priya");
    expect(resolveAssignee([{ ...priya, routed: 1 }, { ...anand, routed: 0 }], "FRC").userId).toBe("anand");
    expect(resolveAssignee([{ ...priya, routed: 1 }, { ...anand, routed: 1 }], "FRC").userId).toBe("priya");
    expect(resolveAssignee([{ ...priya, routed: 3 }, { ...anand, routed: 1 }], "FRC").userId).toBe("anand");
  });

  it("assigns rather than annotates when it takes a turn", () => {
    // The note is what UNASSIGNED work says about itself, and the schema
    // refuses one beside a name (`work_item_note_only_when_unassigned`).
    const out = resolveAssignee([spoc("priya"), spoc("anand")], "TRC");
    expect(out.userId).not.toBeNull();
    expect(out.note).toBeNull();
  });

  it("breaks a tie by the directory's order, which is the longer-standing assignment", () => {
    // Three rotate: the counter rises on whoever was picked, so the next call
    // lands on the next name, and a fourth task comes back round.
    const a = { ...spoc("a"), routed: 1 };
    const b = { ...spoc("b"), routed: 1 };
    const c = { ...spoc("c"), routed: 0 };
    expect(resolveAssignee([a, b, c], "RAA").userId).toBe("c");
    expect(resolveAssignee([a, b, { ...c, routed: 1 }], "RAA").userId).toBe("a");
  });

  it("says something useful even when the service names no Dept at all", () => {
    const out = resolveAssignee([], null);
    expect(out.userId).toBeNull();
    expect(out.note).not.toBeNull();
  });
});

describe("dependency cycles", () => {
  it("refuses an item waiting on itself", () => {
    expect(wouldCycle([], "a", "a")).toBe(true);
  });

  it("refuses a direct loop", () => {
    expect(wouldCycle([{ workItemId: "b", dependsOnWorkItemId: "a" }], "a", "b")).toBe(true);
  });

  it("refuses a loop through a chain — what a CHECK constraint cannot see", () => {
    // The database catches only the self-edge; reachability is not expressible
    // in a CHECK. A cycle that got in would produce work nothing can ever start
    // with nothing on the screen saying why.
    const edges = [
      { workItemId: "b", dependsOnWorkItemId: "c" },
      { workItemId: "c", dependsOnWorkItemId: "a" },
    ];
    expect(wouldCycle(edges, "a", "b")).toBe(true);
  });

  it("allows a diamond — two items waiting on one, and one waiting on both", () => {
    // Not every re-convergence is a cycle, and a walk that treated it as one
    // would refuse the annual filing that waits on twelve monthly ones.
    const edges = [
      { workItemId: "b", dependsOnWorkItemId: "d" },
      { workItemId: "c", dependsOnWorkItemId: "d" },
      { workItemId: "a", dependsOnWorkItemId: "b" },
    ];
    expect(wouldCycle(edges, "a", "c")).toBe(false);
  });

  it("terminates on a graph that already contains a cycle", () => {
    // Defensive, and worth the line: a cycle could only get in through SQL, but
    // a walk that looped forever on one would hang a request rather than
    // refusing it.
    const edges = [
      { workItemId: "x", dependsOnWorkItemId: "y" },
      { workItemId: "y", dependsOnWorkItemId: "x" },
    ];
    expect(wouldCycle(edges, "a", "x")).toBe(false);
  });
});

describe("the order a board reads in", () => {
  const OPEN = state({ id: "open" });
  const DONE = state({ id: "done", isTerminal: true });
  const P1 = priority({ id: "p1", rank: 1 });
  const P3 = priority({ id: "p3", rank: 3 });

  function row(
    title: string,
    dueOn: string | null,
    p: WorkItemPriority,
    s: WorkItemState = OPEN,
  ): WorkItemRecord {
    return {
      item: {
        id: title,
        tenantId: FIRM,
        clientPartyId: "c",
        entityPartyId: null,
        engagementId: null,
        jobId: null,
        serviceVersionId: null,
        deptAxisId: null,
        title,
        description: null,
        stateId: s.id,
        priorityId: p.id,
        assigneeUserId: null,
        assignmentNote: null,
        dueOn,
        isStatutoryDue: false,
        slaDaysSnapshot: null,
        isClientVisible: true,
        blockedReason: null,
        blockedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      clientName: "Kaveri Foods",
      entityName: null,
      state: s,
      priority: p,
      assignee: null,
      deptName: null,
      checklistDone: 0,
      checklistTotal: 0,
      hasOpenReview: false,
      blockedByOpen: [],
    };
  }

  it("puts overdue work first, whatever its priority", () => {
    // The only thing anybody is actually looking for. A low-priority filing
    // that is late outranks a critical one that is not.
    const rows = [row("critical, not due", "2026-12-01", P1), row("low, overdue", "2026-08-01", P3)];
    expect(boardOrder(rows, "2026-09-01").map((r) => r.item.title)).toEqual([
      "low, overdue",
      "critical, not due",
    ]);
  });

  it("does not call FINISHED work overdue", () => {
    // A completed filing whose date has passed is not late — it is done — and
    // sorting it to the top of a board would bury the work that is.
    const rows = [row("finished late", "2026-08-01", P3, DONE), row("open", "2026-12-01", P1)];
    expect(boardOrder(rows, "2026-09-01").map((r) => r.item.title)).toEqual([
      "open",
      "finished late",
    ]);
  });

  it("then by urgency, then by the date, then by title", () => {
    const rows = [
      row("b", "2026-12-01", P3),
      row("a", "2026-12-01", P3),
      row("sooner", "2026-10-01", P3),
      row("urgent", "2026-12-01", P1),
    ];
    expect(boardOrder(rows, "2026-09-01").map((r) => r.item.title)).toEqual([
      "urgent",
      "sooner",
      "a",
      "b",
    ]);
  });

  it("sorts undated work AFTER dated work of the same urgency", () => {
    // A task with no deadline is not the most urgent thing on the board, and an
    // empty string would have sorted it to the top.
    const rows = [row("no date", null, P3), row("dated", "2026-12-01", P3)];
    expect(boardOrder(rows, "2026-09-01").map((r) => r.item.title)).toEqual(["dated", "no date"]);
  });

  it("uses the CALLER's day, not the server's, to decide what is overdue", () => {
    // The same row is overdue on one day and not on the previous one. A server
    // in UTC is a day behind a firm in India every morning, and this is the
    // question that gets that wrong.
    const rows = [row("due today", "2026-09-01", P3), row("later", "2026-09-05", P1)];
    expect(boardOrder(rows, "2026-09-01").map((r) => r.item.title)).toEqual([
      "later",
      "due today",
    ]);
    expect(boardOrder(rows, "2026-09-02").map((r) => r.item.title)).toEqual([
      "due today",
      "later",
    ]);
  });
});

describe("the vocabulary's own order", () => {
  it("renders states in the order the firm arranged them, then by name", () => {
    const states = [
      state({ id: "z", name: "Zebra", sortOrder: 10 }),
      state({ id: "a", name: "Alpha", sortOrder: 10 }),
      state({ id: "first", name: "First", sortOrder: 1 }),
    ];
    expect(stateOrder(states).map((s) => s.id)).toEqual(["first", "a", "z"]);
  });

  it("renders priorities most urgent first", () => {
    const priorities = [priority({ id: "low", rank: 4 }), priority({ id: "top", rank: 1 })];
    expect(priorityOrder(priorities).map((p) => p.id)).toEqual(["top", "low"]);
  });
});
