// The firm's delivery structure (G2.4), against in-memory fakes.
//
// What is worth testing here is not that a row can be created — it is the small
// set of states that would make the split silently wrong: two rows for one team
// because somebody typed a different case, a firm splitting work by a list with
// nothing on it, a Dept deleted instead of retired so an old filing stops
// explaining itself.
import { describe, expect, it } from "vitest";
import { ServiceAxisService } from "../../src/usecase/serviceaxis/service";
import {
  FakeServiceAxisRepo,
  FakeTimeZoneSetting,
  FakeWorkSplitSetting,
} from "../../src/testfakes/serviceaxis";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  AxisCodeTaken,
  AxisNotFound,
  InvalidAxisCode,
  InvalidAxisName,
  InvalidWorkSplitAxis,
  WorkSplitAxisEmpty,
} from "../../src/domain/serviceaxis/errors";

// FakeIds hands out sequential uuids from ...000001 upward, so a constant in
// that range would collide with a row just created and a "this does not exist"
// test would quietly find something. These sit well clear of it.
const TENANT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000b2";
const ABSENT = "00000000-0000-4000-8000-0000000000bf";
const ACTOR = SYSTEM_ACTOR;

function svc(): {
  service: ServiceAxisService;
  axes: FakeServiceAxisRepo;
  split: FakeWorkSplitSetting;
  timeZone: FakeTimeZoneSetting;
  events: RecordingEventSink;
} {
  const axes = new FakeServiceAxisRepo();
  const split = new FakeWorkSplitSetting();
  const timeZone = new FakeTimeZoneSetting();
  const events = new RecordingEventSink();
  return {
    service: new ServiceAxisService({ axes, split, timeZone, ids: new FakeIds(), events }),
    axes,
    split,
    timeZone,
    events,
  };
}

describe("defining the firm's lists", () => {
  it("normalises a typed code, so case and stray spacing cannot make a second Dept", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "  frc  ", name: "Financial Reporting", sortOrder: 1 },
      ACTOR,
    );
    expect(row.code).toBe("FRC");
  });

  it("collapses runs of whitespace inside a code — 'VCFO   CONSOLE' is one team", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "vcfo   console", name: "vCFO Console", sortOrder: 0 },
      ACTOR,
    );
    expect(row.code).toBe("VCFO CONSOLE");
  });

  it("refuses a code that is not a code at all", async () => {
    const { service } = svc();
    await expect(
      service.createAxis(
        { tenantId: TENANT, axis: "dept", code: "FRC!!", name: "Nope", sortOrder: 0 },
        ACTOR,
      ),
    ).rejects.toThrow(InvalidAxisCode);
  });

  it("refuses an empty name — the code is the join, the name is what people read", async () => {
    const { service } = svc();
    await expect(
      service.createAxis(
        { tenantId: TENANT, axis: "dept", code: "FRC", name: "   ", sortOrder: 0 },
        ACTOR,
      ),
    ).rejects.toThrow(InvalidAxisName);
  });

  it("refuses a duplicate code on the same list", async () => {
    const { service } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    await expect(
      service.createAxis(
        // Lower case: it normalises to the same code, which is the whole point.
        { tenantId: TENANT, axis: "dept", code: "frc", name: "Again", sortOrder: 1 },
        ACTOR,
      ),
    ).rejects.toThrow(AxisCodeTaken);
  });

  it("ALLOWS the same code on the OTHER list — the two axes are independent", async () => {
    const { service } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    const team = await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    expect(team.axis).toBe("team");
  });

  it("allows the same code at another firm", async () => {
    const { service } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    const other = await service.createAxis(
      { tenantId: OTHER_TENANT, axis: "dept", code: "FRC", name: "Something else", sortOrder: 0 },
      ACTOR,
    );
    expect(other.tenantId).toBe(OTHER_TENANT);
  });

  it("records the code, never the display name — the ledger holds no prose", async () => {
    const { service, events } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "Financial Reporting", sortOrder: 0 },
      ACTOR,
    );
    const [event] = events.recorded;
    expect(event?.verb).toBe("service_axis.created");
    expect(event?.payload).toEqual({ axis: "dept", code: "FRC" });
  });
});

describe("changing a row", () => {
  it("renames without touching the code, because every service body joins on it", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    const renamed = await service.updateAxis(
      { tenantId: TENANT, id: row.id, name: "Financial Reporting & Compliance" },
      ACTOR,
    );
    expect(renamed.name).toBe("Financial Reporting & Compliance");
    expect(renamed.code).toBe("FRC");
  });

  it("leaves an omitted field alone", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 7 },
      ACTOR,
    );
    const renamed = await service.updateAxis({ tenantId: TENANT, id: row.id, name: "New" }, ACTOR);
    expect(renamed.sortOrder).toBe(7);
  });

  it("refuses to touch another firm's row", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    await expect(
      service.updateAxis({ tenantId: OTHER_TENANT, id: row.id, name: "Mine now" }, ACTOR),
    ).rejects.toThrow(AxisNotFound);
  });

  it("answers AxisNotFound for a row nobody has", async () => {
    const { service } = svc();
    await expect(service.getAxis(TENANT, ABSENT)).rejects.toThrow(AxisNotFound);
  });

  it("retires rather than deletes, and the row stays readable", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "RAA", name: "RAA", sortOrder: 0 },
      ACTOR,
    );
    await service.setAxisActive({ tenantId: TENANT, id: row.id, isActive: false }, ACTOR);
    const list = await service.listAxis(TENANT, "dept");
    expect(list.map((r) => [r.code, r.isActive])).toEqual([["RAA", false]]);
  });

  it("is a no-op when the flag already says that, and records nothing", async () => {
    const { service, events } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "RAA", name: "RAA", sortOrder: 0 },
      ACTOR,
    );
    const before = events.recorded.length;
    await service.setAxisActive({ tenantId: TENANT, id: row.id, isActive: true }, ACTOR);
    expect(events.recorded.length).toBe(before);
  });
});

describe("how the firm splits work", () => {
  it("is `none` for a firm nobody has configured", async () => {
    const { service } = svc();
    expect(await service.getWorkSplit(TENANT)).toBe("none");
  });

  it("refuses a value that is not a way of splitting work", async () => {
    const { service } = svc();
    await expect(
      service.setWorkSplit({ tenantId: TENANT, axis: "department" }, ACTOR),
    ).rejects.toThrow(InvalidWorkSplitAxis);
  });

  it("refuses to split by a list with nothing on it — that setting would do nothing", async () => {
    const { service } = svc();
    await expect(
      service.setWorkSplit({ tenantId: TENANT, axis: "dept" }, ACTOR),
    ).rejects.toThrow(WorkSplitAxisEmpty);
  });

  it("refuses to split by a list whose only row is RETIRED", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    await service.setAxisActive({ tenantId: TENANT, id: row.id, isActive: false }, ACTOR);
    await expect(
      service.setWorkSplit({ tenantId: TENANT, axis: "dept" }, ACTOR),
    ).rejects.toThrow(WorkSplitAxisEmpty);
  });

  it("accepts an axis that has an active row", async () => {
    const { service } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    expect(await service.setWorkSplit({ tenantId: TENANT, axis: "team" }, ACTOR)).toBe("team");
    expect(await service.getWorkSplit(TENANT)).toBe("team");
  });

  it("records BOTH sides — 'what did it used to be' is the question actually asked", async () => {
    const { service, events } = svc();
    await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    await service.setWorkSplit({ tenantId: TENANT, axis: "team" }, ACTOR);
    const event = events.recorded.find((e) => e.verb === "work_split_axis.changed");
    expect(event?.payload).toEqual({ from: "none", to: "team" });
  });

  it("records nothing when the setting did not move", async () => {
    const { service, events } = svc();
    await service.setWorkSplit({ tenantId: TENANT, axis: "none" }, ACTOR);
    expect(events.recorded.filter((e) => e.verb === "work_split_axis.changed")).toEqual([]);
  });

  // The mirror of the check above. Closing only one road to the broken state
  // leaves the other open, and this is the one somebody actually walks: a firm
  // restructures by retiring rows one at a time.
  it("refuses to retire the LAST active row on the axis the firm splits by", async () => {
    const { service } = svc();
    const row = await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    await service.setWorkSplit({ tenantId: TENANT, axis: "team" }, ACTOR);
    await expect(
      service.setAxisActive({ tenantId: TENANT, id: row.id, isActive: false }, ACTOR),
    ).rejects.toThrow(WorkSplitAxisEmpty);
  });

  it("allows retiring one row while another stays active", async () => {
    const { service } = svc();
    const first = await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "FINCOMPLIANCE", name: "FinCompliance", sortOrder: 1 },
      ACTOR,
    );
    await service.setWorkSplit({ tenantId: TENANT, axis: "team" }, ACTOR);
    const retired = await service.setAxisActive(
      { tenantId: TENANT, id: first.id, isActive: false },
      ACTOR,
    );
    expect(retired.isActive).toBe(false);
  });

  it("allows retiring the last row on the axis the firm does NOT split by", async () => {
    const { service } = svc();
    const dept = await service.createAxis(
      { tenantId: TENANT, axis: "dept", code: "FRC", name: "FRC", sortOrder: 0 },
      ACTOR,
    );
    await service.createAxis(
      { tenantId: TENANT, axis: "team", code: "PAYROLL", name: "Payroll", sortOrder: 0 },
      ACTOR,
    );
    await service.setWorkSplit({ tenantId: TENANT, axis: "team" }, ACTOR);
    const retired = await service.setAxisActive(
      { tenantId: TENANT, id: dept.id, isActive: false },
      ACTOR,
    );
    expect(retired.isActive).toBe(false);
  });
});

describe("which calendar the firm's months are cut on (0071)", () => {
  it("is UTC until somebody chooses, which is what every firm had before", async () => {
    // The default that made applying 0071 a no-op. Every environment this has
    // run in is UTC, so the column reproduces exactly what the unqualified cast
    // was already doing.
    const { service } = svc();
    expect(await service.getTimeZone(TENANT)).toBe("UTC");
  });

  it("takes an IANA zone and records BOTH sides", async () => {
    // "Why did that filing move into October" is asked afterwards, and the old
    // value is the entire answer — `work_split_axis.changed`'s reasoning.
    const { service, events } = svc();
    expect(await service.setTimeZone({ tenantId: TENANT, timeZone: "Asia/Kolkata" }, ACTOR)).toBe(
      "Asia/Kolkata",
    );
    const event = events.recorded.find((e) => e.verb === "tenant.time_zone_changed");
    expect(event?.payload).toEqual({ from: "UTC", to: "Asia/Kolkata" });
  });

  it("refuses something that is not a zone, with a sentence", async () => {
    // The friendly half. `tenancy.assert_known_time_zone` is the real guard and
    // an import meets that one; this exists so a person on a screen is told
    // what to type instead of meeting a database exception.
    const { service } = svc();
    await expect(
      service.setTimeZone({ tenantId: TENANT, timeZone: "Asia/Bengaluru" }, ACTOR),
    ).rejects.toThrow(/not a time zone/);
    await expect(
      service.setTimeZone({ tenantId: TENANT, timeZone: "+05:30" }, ACTOR),
    ).rejects.toThrow(/not a time zone/);
    expect(await service.getTimeZone(TENANT)).toBe("UTC");
  });

  it("records nothing when the zone is unchanged", async () => {
    // A no-op write is not a decision, and a ledger full of them makes the real
    // change harder to find.
    const { service, events } = svc();
    await service.setTimeZone({ tenantId: TENANT, timeZone: "UTC" }, ACTOR);
    expect(events.recorded.filter((e) => e.verb === "tenant.time_zone_changed")).toEqual([]);
  });
});
