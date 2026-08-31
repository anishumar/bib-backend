// T4.5's acceptance, the half the task line actually names:
//
//   "alerts + spawns tasks only, NEVER ACTS ITSELF."
//
// Every rule the sweep applies is here, against fakes and a fixed clock: which
// rungs fire, who they land on, what happens when the answer is nobody, and
// that the second run does nothing. The unique index under two concurrent
// workers is a property of Postgres and lives in
// tests/escalation/notice.integration.test.ts.
//
// The "never acts" half is not asserted with an expectation — it is structural.
// `EscalationService`'s deps are five reads and one write, and there is no port
// on it through which a task could be reassigned or a filing moved. A test
// could only prove the absence by mocking something that does not exist.
import { describe, expect, it } from "vitest";
import { EscalationService } from "../../src/usecase/escalation/service";
import {
  FakeEscalationLadder,
  FakeEscalationNotices,
  FakeEscalationStaff,
  FakeEscalationSubjects,
  FakeEscalationTenants,
} from "../../src/testfakes/escalation";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { EscalationBody } from "../../src/domain/config/model";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ASSOCIATE = "00000000-0000-0000-0000-0000000000b1";
const MANAGER = "00000000-0000-0000-0000-0000000000b2";
const PARTNER = "00000000-0000-0000-0000-0000000000b3";
const ITEM = "00000000-0000-0000-0000-0000000000c1";
const FILING = "00000000-0000-0000-0000-0000000000d1";
const OTHER_FIRM = "00000000-0000-0000-0000-0000000000ab";

/** The clock is fixed; the DUE DATE is what moves, so "three days late" is a
 *  calendar fact rather than something a test has to wait for. */
const TODAY = new Date("2026-08-31T09:00:00Z");

/** A ladder shaped like one a firm would actually write: a nudge to whoever
 *  holds it, then the manager, then anybody senior enough. */
const LADDER: EscalationBody = {
  rungs: [
    {
      key: "nudge",
      watch: "work_item_due",
      afterDays: 1,
      notify: "assignee",
      minGradeRank: null,
      label: "Remind the owner",
    },
    {
      key: "manager",
      watch: "work_item_due",
      afterDays: 3,
      notify: "manager",
      minGradeRank: null,
      label: "Tell their manager",
    },
    {
      key: "partner",
      watch: "work_item_due",
      afterDays: 7,
      notify: "grade_at_least",
      minGradeRank: 40,
      label: "Partners",
    },
    {
      key: "unclaimed",
      watch: "work_item_unassigned",
      afterDays: 2,
      notify: "grade_at_least",
      minGradeRank: 20,
      label: "Nobody has picked this up",
    },
    {
      key: "target",
      watch: "obligation_target",
      afterDays: 0,
      notify: "assignee",
      minGradeRank: null,
      label: "Past our own target",
    },
  ],
};

function setup(ladder: EscalationBody | null = LADDER): {
  service: EscalationService;
  notices: FakeEscalationNotices;
  subjects: FakeEscalationSubjects;
  staff: FakeEscalationStaff;
  events: RecordingEventSink;
} {
  const ladders = new FakeEscalationLadder();
  if (ladder !== null) ladders.ladders.set(TENANT, ladder);
  const notices = new FakeEscalationNotices();
  const subjects = new FakeEscalationSubjects();
  const staff = new FakeEscalationStaff();
  const events = new RecordingEventSink();
  staff.staff.set(TENANT, [
    { userId: ASSOCIATE, gradeRank: 10, reportsToUserId: MANAGER },
    { userId: MANAGER, gradeRank: 20, reportsToUserId: PARTNER },
    { userId: PARTNER, gradeRank: 40, reportsToUserId: null },
  ]);
  const service = new EscalationService({
    ladders,
    notices,
    subjects,
    staff,
    tenants: new FakeEscalationTenants([TENANT]),
    ids: new FakeIds(),
    clock: new FakeClock(TODAY),
    events,
  });
  return { service, notices, subjects, staff, events };
}

/** One task, due `daysLate` days ago, held by `holder`. */
function task(daysLate: number, holder: string | null): {
  workItemId: string;
  assigneeUserId: string | null;
  dueOn: string;
  createdOn: string;
} {
  const due = new Date(TODAY);
  due.setUTCDate(due.getUTCDate() - daysLate);
  return {
    workItemId: ITEM,
    assigneeUserId: holder,
    dueOn: due.toISOString().slice(0, 10),
    createdOn: "2026-01-01",
  };
}

describe("the escalation ladder climbs, and only tells people", () => {
  it("does nothing at a firm that has published no ladder", async () => {
    const { service, subjects, notices } = setup(null);
    subjects.workItems.set(TENANT, [task(90, ASSOCIATE)]);

    const [report] = await service.sweep();

    // The safe direction, and the whole reason nothing is seeded: a firm that
    // never wrote a ladder has not asked to be told anything.
    expect(report?.raised).toBe(0);
    expect(notices.rows).toHaveLength(0);
  });

  it("fires EVERY rung a task is past, not only the next one", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [task(10, ASSOCIATE)]);

    const [report] = await service.sweep();

    // Ten days late clears the 1-, 3- and 7-day rungs. A firm whose worker was
    // down for a week must not need three more nights to catch up.
    expect(report?.raised).toBe(3);
    expect(notices.rows.map((r) => r.rungKey).sort()).toEqual(["manager", "nudge", "partner"]);
  });

  it("lands the rungs on the assignee, then the manager, then a RANK", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [task(10, ASSOCIATE)]);

    await service.sweep();
    const by = (key: string): (typeof notices.rows)[number] | undefined =>
      notices.rows.find((r) => r.rungKey === key);

    expect(by("nudge")?.raisedToUserId).toBe(ASSOCIATE);
    // Through `membership.reports_to_user_id` — the firm's own chart, which
    // G3.3 built. It is NOT blocked on G3.4: that task links a login to a
    // party, a different question from who a login reports to.
    expect(by("manager")?.raisedToUserId).toBe(MANAGER);
    // A rank, and deliberately NOT one of the people holding it: an escalation
    // routed to one partner dies while that partner is on leave.
    expect(by("partner")?.raisedToUserId).toBeNull();
    expect(by("partner")?.minGradeRank).toBe(40);
  });

  it("raises the notice anyway when NOBODY can be named, and says why", async () => {
    const { service, subjects, notices } = setup();
    // The partner is at the top of the chart: the manager rung has nobody to
    // reach. That is a real state of a real firm, not an error.
    subjects.workItems.set(TENANT, [task(5, PARTNER)]);

    const [report] = await service.sweep();
    const manager = notices.rows.find((r) => r.rungKey === "manager");

    expect(report?.unresolved).toBe(1);
    expect(manager?.raisedToUserId).toBeNull();
    expect(manager?.minGradeRank).toBeNull();
    expect(manager?.note).toMatch(/reporting line/i);
  });

  it("escalates work nobody has picked up, counting from its age", async () => {
    const { service, subjects, notices } = setup();
    // No due date at all — the service carried no SLA, so T3.1 gave it none and
    // this product will not invent one. Age is the only honest clock.
    subjects.workItems.set(TENANT, [
      { workItemId: ITEM, assigneeUserId: null, dueOn: null, createdOn: "2026-08-01" },
    ]);

    await service.sweep();

    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]?.rungKey).toBe("unclaimed");
    expect(notices.rows[0]?.watch).toBe("work_item_unassigned");
  });

  it("tells nobody a second time", async () => {
    const { service, subjects, notices, events } = setup();
    subjects.workItems.set(TENANT, [task(10, ASSOCIATE)]);

    await service.sweep();
    const [second] = await service.sweep();

    // Nothing written, nothing logged. The queue's whole value is that a row in
    // it means something happened, and a row that reappears every morning is
    // how a queue stops being read.
    expect(second?.raised).toBe(0);
    expect(notices.rows).toHaveLength(3);
    expect(events.recorded.filter((e) => e.verb === "work_item.escalated")).toHaveLength(3);
  });

  it("warns on a filing past the firm's own target while the statutory date is still ahead", async () => {
    const { service, subjects, notices } = setup();
    subjects.obligations.set(TENANT, [
      {
        obligationId: FILING,
        internalTargetOn: "2026-08-28",
        statutoryDueOn: "2026-09-20",
        workItemId: ITEM,
        assigneeUserId: ASSOCIATE,
      },
    ]);

    await service.sweep();

    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]?.obligationInstanceId).toBe(FILING);
    expect(notices.rows[0]?.raisedToUserId).toBe(ASSOCIATE);
  });

  it("stops once the STATUTORY date has passed, because T3.3 owns it then", async () => {
    const { service, subjects, notices } = setup();
    subjects.obligations.set(TENANT, [
      {
        obligationId: FILING,
        internalTargetOn: "2026-07-01",
        statutoryDueOn: "2026-07-20",
        workItemId: ITEM,
        assigneeUserId: ASSOCIATE,
      },
    ]);

    await service.sweep();

    // It is already in the partner's decision queue with somebody senior
    // looking at it. Two systems shouting about one filing is how both get
    // ignored — which is why these stayed separate sweeps.
    expect(notices.rows).toHaveLength(0);
  });

  it("writes the event with what happened and no prose about a person", async () => {
    const { service, subjects, events } = setup();
    subjects.workItems.set(TENANT, [task(3, ASSOCIATE)]);

    await service.sweep();
    const event = events.recorded.find(
      (e) => e.verb === "work_item.escalated" && e.payload["rungKey"] === "manager",
    );

    expect(event?.objectId).toBe(ITEM);
    expect(event?.payload).toMatchObject({
      rungKey: "manager",
      watch: "work_item_due",
      afterDays: 3,
      daysPast: 3,
      target: "manager",
      landedOn: "person",
      raisedToUserId: MANAGER,
    });
    // The task's TITLE is never here. It is prose about a client's work and
    // this log cannot be erased — `work_item.created` makes the same omission.
    expect(JSON.stringify(event?.payload)).not.toMatch(/title/i);
  });

  it("skips one firm's broken data without stopping the next firm's", async () => {
    const ladders = new FakeEscalationLadder();
    ladders.ladders.set(TENANT, LADDER);
    ladders.ladders.set(OTHER_FIRM, LADDER);
    const subjects = new FakeEscalationSubjects();
    subjects.workItems.set(OTHER_FIRM, [task(10, ASSOCIATE)]);
    const notices = new FakeEscalationNotices();
    const staff = new FakeEscalationStaff();
    staff.staff.set(OTHER_FIRM, [{ userId: ASSOCIATE, gradeRank: 10, reportsToUserId: null }]);
    const service = new EscalationService({
      ladders,
      notices,
      subjects,
      // The FIRST firm's read throws — standing in for whatever one firm's own
      // data does wrong at 6am. T3.1's lesson: one firm with no work states
      // stopped the calendar for every client of every firm after it.
      staff: {
        activeStaff: (tenantId: string) =>
          tenantId === TENANT
            ? Promise.reject(new Error("this firm's roster is broken"))
            : staff.activeStaff(tenantId),
      },
      tenants: new FakeEscalationTenants([TENANT, OTHER_FIRM]),
      ids: new FakeIds(),
      clock: new FakeClock(TODAY),
      events: new RecordingEventSink(),
    });

    const reports = await service.sweep();

    expect(reports[0]?.failure).toMatch(/roster is broken/);
    // REPORTED rather than swallowed, and the second firm's work still ran.
    expect(reports[1]?.raised).toBe(3);
  });
});

describe("the queue a screen reads", () => {
  it("shows the whole firm by default and narrows only when asked", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [task(10, ASSOCIATE)]);
    await service.sweep();
    notices.subjectFacts.set(ITEM, {
      open: true,
      title: "GSTR-3B · Aug 2026",
      clientName: "Kaveri Foods",
      entityName: "Kaveri Logistics Private Limited",
      holderUserId: ASSOCIATE,
      holderName: "Anand",
      holderEmail: "anand@harbour.example",
      dueOn: "2026-08-21",
      stateName: "In Progress",
    });

    const everything = await service.queue(TENANT, null);
    const mine = await service.queue(TENANT, { userId: MANAGER, gradeRank: 20 });

    // Three rungs fired; the manager was addressed by one of them by name and
    // is not senior enough for the partner rung.
    expect(everything).toHaveLength(3);
    expect(mine.map((r) => r.rungKey)).toEqual(["manager"]);
    // A read model carries NAMES, not ids — the rule this codebase has been
    // caught by five times.
    expect(everything[0]?.subjectTitle).toBe("GSTR-3B · Aug 2026");
    expect(everything[0]?.clientName).toBe("Kaveri Foods");
    // WHICH company, beside who pays. G0.1: a group of four files four sets of
    // returns, and a queue naming only the client is four identical rows.
    expect(everything[0]?.entityName).toBe("Kaveri Logistics Private Limited");
  });

  it("names the person it told even when their display name is empty", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [task(2, ASSOCIATE)]);
    await service.sweep();
    notices.subjectFacts.set(ITEM, {
      open: true,
      title: "File GSTR-3B",
      clientName: "Kaveri Foods",
      entityName: "Kaveri Logistics Private Limited",
      holderUserId: ASSOCIATE,
      holderName: null,
      holderEmail: "anand@harbour.example",
      dueOn: "2026-08-29",
      stateName: "Pending",
    });
    // A display name is OPTIONAL on an account and is genuinely empty at real
    // firms — running the sweep against a seeded firm produced fourteen
    // notices, three of them addressed to a partner by name, and the queue
    // rendered a blank space beside "told". The email is the discriminator.
    notices.people.set(ASSOCIATE, { displayName: null, email: "anand@harbour.example" });

    const [row] = await service.queue(TENANT, null);

    expect(row?.raisedTo?.displayName).toBeNull();
    expect(row?.raisedTo?.email).toBe("anand@harbour.example");
    expect(row?.holder?.email).toBe("anand@harbour.example");
  });

  it("drops a notice the moment the work it is about is finished", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [task(10, ASSOCIATE)]);
    await service.sweep();
    notices.subjectFacts.set(ITEM, {
      open: false,
      title: "Done at last",
      clientName: null,
      entityName: null,
      holderUserId: ASSOCIATE,
      holderName: "Anand",
      holderEmail: "anand@harbour.example",
      dueOn: null,
      stateName: "Completed",
    });

    // Migration 0058's join rather than a `cleared_at` column: the escalation
    // is over exactly when the task is, and a column restating that would be
    // free to disagree with it.
    expect(await service.queue(TENANT, null)).toHaveLength(0);
  });

  it("clears an unassigned escalation as soon as somebody picks the work up", async () => {
    const { service, subjects, notices } = setup();
    subjects.workItems.set(TENANT, [
      { workItemId: ITEM, assigneeUserId: null, dueOn: null, createdOn: "2026-08-01" },
    ]);
    await service.sweep();
    notices.subjectFacts.set(ITEM, {
      open: true,
      title: "Nobody's yet",
      clientName: null,
      entityName: null,
      // Somebody took it. The task is still open and still on the board — but
      // the thing the rung was complaining about has been fixed.
      holderUserId: ASSOCIATE,
      holderName: "Anand",
      holderEmail: "anand@harbour.example",
      dueOn: null,
      stateName: "Pending",
    });

    expect(await service.queue(TENANT, null)).toHaveLength(0);
  });
});
