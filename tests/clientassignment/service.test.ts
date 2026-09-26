// Client ownership (G3.2), against in-memory fakes.
//
// What is worth testing here is not that a row can be created. It is the small
// set of states that would make the record LIE: a handover that leaves two Key
// Managers in force on the same day, an "as of March" answer that comes back
// with today's team, a SPOC assigned to a Dept the firm retired, and an
// assignment given to somebody who does not work here — which the foreign key
// cannot refuse, because a login in this product is global.
import { describe, expect, it } from "vitest";
import { ClientAssignmentService } from "../../src/usecase/clientassignment/service";
import {
  FakeAssignableAxes,
  FakeAssignmentStaff,
  FakeClientAssignmentRepo,
  FakeClientDirectory,
  FakeClientWorkCatchUp,
} from "../../src/testfakes/clientassignment";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { staleAssignments } from "../../src/domain/clientassignment/model";
import {
  AssignmentAlreadyEnded,
  AssignmentAxisNotFound,
  AssignmentAxisRetired,
  AssignmentClientArchived,
  AssignmentClientNotFound,
  AssignmentDuplicate,
  AssignmentHolderNotStaff,
  AssignmentNotFound,
  AssignmentPredatesIncumbent,
  AxisNotAllowedForKeyManager,
  AxisRequiredForSpoc,
  InvalidAssignmentDates,
  InvalidAssignmentRole,
} from "../../src/domain/clientassignment/errors";

// FakeIds hands out sequential uuids from ...000001 upward, so constants in
// that range would collide with a row just created. These sit well clear.
const TENANT = "00000000-0000-4000-8000-0000000000c1";
const CLIENT = "00000000-0000-4000-8000-0000000000c2";
const ARCHIVED_CLIENT = "00000000-0000-4000-8000-0000000000c3";
const ABSENT = "00000000-0000-4000-8000-0000000000cf";
const ANITA = "00000000-0000-4000-8000-0000000000d1";
const BHAVNA = "00000000-0000-4000-8000-0000000000d2";
const STRANGER = "00000000-0000-4000-8000-0000000000d3";
const FRC = "00000000-0000-4000-8000-0000000000e1";
const TRC = "00000000-0000-4000-8000-0000000000e2";
const RETIRED_DEPT = "00000000-0000-4000-8000-0000000000e3";
const ACTOR = SYSTEM_ACTOR;

const TODAY = "2026-08-30";

function svc(clock = new FakeClock(new Date(`${TODAY}T09:00:00.000Z`)), timeZone = "UTC"): {
  service: ClientAssignmentService;
  assignments: FakeClientAssignmentRepo;
  events: RecordingEventSink;
  work: FakeClientWorkCatchUp;
} {
  const assignments = new FakeClientAssignmentRepo()
    .withHolder(ANITA, { email: "anita@10x.test", displayName: "Anita R" })
    .withHolder(BHAVNA, { email: "bhavna@10x.test", displayName: "Bhavna S" })
    .withAxis({ id: FRC, axis: "dept", code: "FRC", name: "FRC", isActive: true })
    .withAxis({ id: TRC, axis: "dept", code: "TRC", name: "TRC", isActive: true });

  const clients = new FakeClientDirectory()
    .with({ id: CLIENT, displayName: "Acme Holdings", archivedAt: null })
    .with({
      id: ARCHIVED_CLIENT,
      displayName: "Dormant Ltd",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });

  const staff = new FakeAssignmentStaff().with(TENANT, ANITA).with(TENANT, BHAVNA);

  const axes = new FakeAssignableAxes()
    .with({ id: FRC, axis: "dept", code: "FRC", name: "FRC", isActive: true })
    .with({ id: TRC, axis: "dept", code: "TRC", name: "TRC", isActive: true })
    .with({
      id: RETIRED_DEPT,
      axis: "dept",
      code: "OLD DEPT",
      name: "Old Dept",
      isActive: false,
    });

  const events = new RecordingEventSink();
  const work = new FakeClientWorkCatchUp();
  return {
    service: new ClientAssignmentService({
      assignments,
      clients,
      staff,
      axes,
      ids: new FakeIds(),
      clock,
      timeZones: { timeZoneFor: () => Promise.resolve(timeZone) },
      events,
      work,
    }),
    assignments,
    events,
    work,
  };
}

describe("putting somebody in charge", () => {
  it("records a Key Manager with no axis, open-ended, from today by default", async () => {
    const { service } = svc();
    const { assignment: row } = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: ANITA },
      ACTOR,
    );
    expect(row.role).toBe("key_manager");
    expect(row.axisId).toBeNull();
    expect(row.validFrom).toBe(TODAY);
    expect(row.validTo).toBeNull();
  });

  it("gives a client two SPOCs on two Depts — the firm's own arrangement", async () => {
    const { service } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: TRC, userId: BHAVNA },
      ACTOR,
    );
    const view = await service.accountTeam(TENANT, CLIENT);
    expect(view.inForce.map((r) => r.axis?.code).sort()).toEqual(["FRC", "TRC"]);
  });

  // The one the board's acceptance line says otherwise about, and the one
  // Shrestha corrected on 2026-08-30. Leave cover, a joint SPOC on a group, a
  // fortnight's parallel handover: all real, and a "one per Dept" constraint
  // would make every one of them unrecordable.
  it("allows a SECOND SPOC on the same Dept — a Dept may have more than one", async () => {
    const { service } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: BHAVNA },
      ACTOR,
    );
    const view = await service.accountTeam(TENANT, CLIENT);
    const frc = view.inForce.filter((r) => r.axis?.code === "FRC");
    expect(frc.map((r) => r.holder.displayName).sort()).toEqual(["Anita R", "Bhavna S"]);
  });

  it("refuses the SAME person twice on the same Dept — that is a duplicate, not a second SPOC", async () => {
    const { service } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentDuplicate);
  });

  it("refuses a SPOC with no Dept — it would quietly be a second Key Manager", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AxisRequiredForSpoc);
  });

  it("refuses a Key Manager given a Dept — they own the relationship, not a part of it", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", axisId: FRC, userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AxisNotAllowedForKeyManager);
  });

  it("refuses an unknown role", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "account_manager", userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(InvalidAssignmentRole);
  });

  it("refuses a Dept the firm retired — a stale picker must not spread it", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        {
          tenantId: TENANT,
          clientPartyId: CLIENT,
          role: "spoc",
          axisId: RETIRED_DEPT,
          userId: ANITA,
        },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentAxisRetired);
  });

  it("refuses a Dept that is not this firm's at all", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: ABSENT, userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentAxisNotFound);
  });

  // The foreign key points at `tenancy.user_account`, which is GLOBAL — one
  // login, many firms — so the database would accept this row with every policy
  // satisfied. Only the roster can refuse it.
  it("refuses somebody who is not active staff at this firm", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: STRANGER },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentHolderNotStaff);
  });

  it("refuses a client that is not there, rather than answering with an empty team", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: ABSENT, role: "key_manager", userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentClientNotFound);
  });

  it("refuses a client the firm has archived", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        { tenantId: TENANT, clientPartyId: ARCHIVED_CLIENT, role: "key_manager", userId: ANITA },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentClientArchived);
  });

  it("refuses a malformed date", async () => {
    const { service } = svc();
    await expect(
      service.assign(
        {
          tenantId: TENANT,
          clientPartyId: CLIENT,
          role: "key_manager",
          userId: ANITA,
          validFrom: "30-08-2026",
        },
        ACTOR,
      ),
    ).rejects.toThrow(InvalidAssignmentDates);
  });

  it("records who decided, and a handover names the row it closed", async () => {
    const { service, events } = svc();
    const { assignment: first } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: BHAVNA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );
    const created = events.recorded.filter((e) => e.verb === "client_assignment.created");
    expect(created).toHaveLength(2);
    // Without this the handover looks like two unrelated events on one day and
    // nothing says they were one act.
    expect(created[1]?.payload).toMatchObject({ handedOverFrom: first.id });
  });
});

describe("a handover is two rows, never an edit", () => {
  it("closes the outgoing Key Manager on the day the new one starts — contiguous, no overlap", async () => {
    const { service } = svc();
    const { assignment: anita } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: BHAVNA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );

    const view = await service.accountTeam(TENANT, CLIENT);
    const closed = view.all.find((r) => r.assignment.id === anita.id);
    // Half-open: the first day NOT in force. Anita was Key Manager up to and
    // including 31 March, Bhavna from 1 April, and neither day has two.
    expect(closed?.assignment.validTo).toBe("2026-04-01");
    expect(view.inForce).toHaveLength(1);
    expect(view.inForce[0]?.holder.displayName).toBe("Bhavna S");
  });

  it("does NOT close the outgoing SPOC — the firm says whether this is a replacement", async () => {
    const { service } = svc();
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: BHAVNA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );
    const view = await service.accountTeam(TENANT, CLIENT);
    expect(view.inForce).toHaveLength(2);
    expect(view.inForce.every((r) => r.assignment.validTo === null)).toBe(true);
  });

  // The incumbent is looked up as of the day the NEW row starts, not "today".
  // Keyed on today, backdating a handover to June would close whoever holds it
  // NOW and leave June's real holder overlapping — which the database would
  // then refuse as an unexplained 500.
  it("closes the person who held it on the BACKDATED day, not today's holder", async () => {
    const { service } = svc();
    const { assignment: priya } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: BHAVNA,
        validFrom: "2026-06-01",
      },
      ACTOR,
    );
    const view = await service.accountTeam(TENANT, CLIENT);
    expect(view.all.find((r) => r.assignment.id === priya.id)?.assignment.validTo).toBe(
      "2026-06-01",
    );
    const may = await service.accountTeam(TENANT, CLIENT, "2026-05-15");
    expect(may.inForce.map((r) => r.holder.displayName)).toEqual(["Anita R"]);
  });

  it("refuses a Key Manager starting on or before the incumbent's own start date", async () => {
    const { service } = svc();
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );
    // The close would produce [2026-04-01, 2026-04-01) — a period in force on
    // no day at all, which the CHECK forbids. Refused with the date in the way
    // rather than surfaced as a constraint violation.
    await expect(
      service.assign(
        {
          tenantId: TENANT,
          clientPartyId: CLIENT,
          role: "key_manager",
          userId: BHAVNA,
          validFrom: "2026-04-01",
        },
        ACTOR,
      ),
    ).rejects.toThrow(AssignmentPredatesIncumbent);
  });
});

describe('"who was the SPOC in March"', () => {
  it("answers with the team of that day, not today's", async () => {
    const { service } = svc();
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    const anitaRows = (await service.accountTeam(TENANT, CLIENT)).all;
    await service.end(
      { tenantId: TENANT, assignmentId: anitaRows[0]!.assignment.id, validTo: "2026-04-01" },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: BHAVNA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );

    const march = await service.accountTeam(TENANT, CLIENT, "2026-03-15");
    expect(march.onDate).toBe("2026-03-15");
    expect(march.inForce.map((r) => r.holder.displayName)).toEqual(["Anita R"]);

    const today = await service.accountTeam(TENANT, CLIENT);
    expect(today.inForce.map((r) => r.holder.displayName)).toEqual(["Bhavna S"]);
  });

  // The changeover day is the one an inclusive upper bound gets wrong, and it
  // is why this product's ranges are half-open everywhere.
  it("shows exactly one person on the changeover day itself", async () => {
    const { service } = svc();
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: BHAVNA,
        validFrom: "2026-04-01",
      },
      ACTOR,
    );

    const dayBefore = await service.accountTeam(TENANT, CLIENT, "2026-03-31");
    const changeover = await service.accountTeam(TENANT, CLIENT, "2026-04-01");
    expect(dayBefore.inForce.map((r) => r.holder.displayName)).toEqual(["Anita R"]);
    expect(changeover.inForce.map((r) => r.holder.displayName)).toEqual(["Bhavna S"]);
  });

  it("refuses an unknown client rather than answering 'nobody is assigned'", async () => {
    const { service } = svc();
    await expect(service.accountTeam(TENANT, ABSENT)).rejects.toThrow(
      AssignmentClientNotFound,
    );
  });

  it("carries the holder's NAME, not just an id — a screen must not fetch per row", async () => {
    const { service } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: TRC, userId: ANITA },
      ACTOR,
    );
    const view = await service.accountTeam(TENANT, CLIENT);
    expect(view.inForce[0]?.holder.email).toBe("anita@10x.test");
    expect(view.inForce[0]?.axis?.code).toBe("TRC");
  });
});

describe("ending an assignment", () => {
  it("closes it and records the date it stopped being in force", async () => {
    const { service, events } = svc();
    const { assignment: row } = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    const ended = await service.end(
      { tenantId: TENANT, assignmentId: row.id, validTo: "2026-09-01" },
      ACTOR,
    );
    expect(ended.validTo).toBe("2026-09-01");
    expect(events.recorded.some((e) => e.verb === "client_assignment.ended")).toBe(true);
  });

  it("refuses to re-end one that already ended — history is not corrected by writing over it", async () => {
    const { service } = svc();
    const { assignment: row } = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    await service.end({ tenantId: TENANT, assignmentId: row.id, validTo: "2026-09-01" }, ACTOR);
    await expect(
      service.end({ tenantId: TENANT, assignmentId: row.id, validTo: "2026-10-01" }, ACTOR),
    ).rejects.toThrow(AssignmentAlreadyEnded);
  });

  it("refuses an end date on or before the start — that period is in force on no day", async () => {
    const { service } = svc();
    const { assignment: row } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: ANITA,
        validFrom: "2026-05-01",
      },
      ACTOR,
    );
    await expect(
      service.end({ tenantId: TENANT, assignmentId: row.id, validTo: "2026-05-01" }, ACTOR),
    ).rejects.toThrow(InvalidAssignmentDates);
  });

  it("refuses an assignment that is not there", async () => {
    const { service } = svc();
    await expect(
      service.end({ tenantId: TENANT, assignmentId: ABSENT }, ACTOR),
    ).rejects.toThrow(AssignmentNotFound);
  });
});

describe("an assignment whose holder has left", () => {
  // Nothing closes an assignment when somebody is deactivated, deliberately —
  // closing it would destroy the record of who owned the client. So the client
  // keeps a Key Manager and a SPOC on paper while the person named has gone,
  // and `staleAssignments` is the only thing that says so.

  it("is still IN FORCE, and reported as stale", async () => {
    const { service, assignments } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: ANITA },
      ACTOR,
    );
    assignments.withHolder(ANITA, {
      email: "anita@10x.test",
      displayName: "Anita R",
      isActiveStaff: false,
    });

    const view = await service.accountTeam(TENANT, CLIENT);
    // The row has NOT been closed — that is the point.
    expect(view.inForce).toHaveLength(1);
    expect(staleAssignments(view.all, TODAY).map((r) => r.holder.displayName)).toEqual([
      "Anita R",
    ]);
  });

  it("is NOT stale once the row itself is closed — leaving is the ordinary end of a job", async () => {
    const { service, assignments } = svc();
    const { assignment: row } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "spoc",
        axisId: FRC,
        userId: ANITA,
        validFrom: "2026-05-01",
      },
      ACTOR,
    );
    await service.end({ tenantId: TENANT, assignmentId: row.id, validTo: "2026-06-01" }, ACTOR);
    assignments.withHolder(ANITA, {
      email: "anita@10x.test",
      displayName: "Anita R",
      isActiveStaff: false,
    });

    const view = await service.accountTeam(TENANT, CLIENT);
    expect(view.inForce).toHaveLength(0);
    expect(staleAssignments(view.all, TODAY)).toHaveLength(0);
  });

  it("names only the holder who left, not the colleague who is still here", async () => {
    const { service, assignments } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: TRC, userId: BHAVNA },
      ACTOR,
    );
    assignments.withHolder(ANITA, {
      email: "anita@10x.test",
      displayName: "Anita R",
      isActiveStaff: false,
    });

    const view = await service.accountTeam(TENANT, CLIENT);
    expect(staleAssignments(view.all, TODAY).map((r) => r.axis?.code)).toEqual(["FRC"]);
  });
});

describe("one person's book", () => {
  it("lists a client ONCE even when they hold two roles over it", async () => {
    const { service } = svc();
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: ANITA },
      ACTOR,
    );
    await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );
    const book = await service.clientsOf(TENANT, ANITA);
    expect(book).toHaveLength(1);
    expect([...(book[0]?.roles ?? [])].sort()).toEqual(["key_manager", "spoc"]);
  });

  // Bug #9, found by opening the page at 04:11 in Delhi: the assignment was
  // made, the account team showed it, and the holder's own book was empty. The
  // server's clock is UTC, so a row starting on the FIRM's today starts
  // "tomorrow" as far as `CURRENT_DATE` and the service's own `today()` are
  // concerned. The calendar day is the caller's fact and cannot be derived on
  // the server, so it is a parameter.
  it("answers for the CALLER's day, not the server's", async () => {
    const { service } = svc();
    // The fake clock is 2026-08-30T09:00Z, so the service's own "today" is the
    // 30th. A caller a day ahead — or a firm whose today the server has not
    // reached — asks for the day they are actually on.
    await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-08-31",
      },
      ACTOR,
    );
    expect(await service.clientsOf(TENANT, ANITA)).toHaveLength(0);
    expect(await service.clientsOf(TENANT, ANITA, "2026-08-31")).toHaveLength(1);
  });

  it("refuses an as-of date that is not a date", async () => {
    const { service } = svc();
    await expect(service.clientsOf(TENANT, ANITA, "31-08-2026")).rejects.toThrow(
      InvalidAssignmentDates,
    );
  });

  it("drops a client once the assignment has ended", async () => {
    const { service } = svc();
    const { assignment: row } = await service.assign(
      {
        tenantId: TENANT,
        clientPartyId: CLIENT,
        role: "key_manager",
        userId: ANITA,
        validFrom: "2026-01-01",
      },
      ACTOR,
    );
    await service.end({ tenantId: TENANT, assignmentId: row.id, validTo: "2026-06-01" }, ACTOR);
    expect(await service.clientsOf(TENANT, ANITA)).toHaveLength(0);
  });
});

describe("'from today' is the firm's day", () => {
  it("starts an assignment on the firm's calendar day, not the server's UTC day", async () => {
    // 20:00 UTC is already tomorrow in India.
    const { service } = svc(new FakeClock(new Date(`${TODAY}T20:00:00.000Z`)), "Asia/Kolkata");
    const { assignment: row } = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: ANITA },
      ACTOR,
    );
    const next = new Date(`${TODAY}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(row.validFrom).toBe(next.toISOString().slice(0, 10));
  });
});

describe("naming the account team catches up the client's waiting work (T6.17)", () => {
  it("asks for the catch-up on the client just assigned, and hands back what moved", async () => {
    const { service, work } = svc();
    work.answer = { moves: [{ userId: ANITA, tasks: 3, steps: 20 }] };

    const out = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", axisId: FRC, userId: ANITA },
      ACTOR,
    );

    expect(work.calls).toEqual([{ tenantId: TENANT, clientPartyId: CLIENT }]);
    expect(out.caughtUp).toEqual({ moves: [{ userId: ANITA, tasks: 3, steps: 20 }] });
    expect(out.assignment.userId).toBe(ANITA);
  });

  it("keeps the assignment, and its event, when moving the old work fails, and says so with null", async () => {
    const { service, work, events, assignments } = svc();
    work.failWith = new Error("the database went away");

    const out = await service.assign(
      { tenantId: TENANT, clientPartyId: CLIENT, role: "key_manager", userId: ANITA },
      ACTOR,
    );

    expect(out.caughtUp).toBeNull();
    expect(await assignments.findById(TENANT, out.assignment.id)).not.toBeNull();
    expect(events.verbs()).toContain("client_assignment.created");
  });

  it("does not ask when the assignment itself is refused", async () => {
    const { service, work } = svc();
    await expect(
      service.assign({ tenantId: TENANT, clientPartyId: CLIENT, role: "spoc", userId: ANITA }, ACTOR),
    ).rejects.toThrow(AxisRequiredForSpoc);
    expect(work.calls).toEqual([]);
  });
});
