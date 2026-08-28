// The seniority ladder's business rules (G3.3), against in-memory fakes.
//
// The rule the whole table exists for is a single comparison — "Manager or
// above is fine" — so most of what is worth testing here is not the comparison
// itself but the things that would quietly make it wrong: a rung that was
// deleted instead of retired, a rank that stopped being a number, a firm
// getting somebody else's ladder.
import { describe, expect, it } from "vitest";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { FakeStaffGradeRepo } from "../../src/testfakes/staffgrade";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  DEFAULT_GRADES,
  assignableGrades,
  ladderOrder,
  outranks,
} from "../../src/domain/staffgrade/model";
import {
  GradeCodeTaken,
  GradeNotFound,
  InvalidGradeCode,
  InvalidRank,
} from "../../src/domain/staffgrade/errors";

// FakeIds hands out sequential uuids from ...000001 upward, so a constant in
// that range would collide with a row the seeder just created and a "this does
// not exist" test would quietly find something. These sit well clear of it.
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const ABSENT_GRADE = "00000000-0000-4000-8000-0000000000af";
const ACTOR = SYSTEM_ACTOR;

function svc(): { service: StaffGradeService; grades: FakeStaffGradeRepo; events: RecordingEventSink } {
  const grades = new FakeStaffGradeRepo();
  const events = new RecordingEventSink();
  return { service: new StaffGradeService({ grades, ids: new FakeIds(), events }), grades, events };
}

async function seeded(): Promise<ReturnType<typeof svc>> {
  const s = svc();
  await s.service.seedDefaultGrades(TENANT, ACTOR);
  return s;
}

describe("the threshold the ladder exists for", () => {
  it("includes the rung named — 'Manager or above' means the Manager too", () => {
    // The one place `>=` vs `>` is decided. A firm that said "Manager or above"
    // and found its Managers unable to review would read that as broken, and
    // the fix would be somebody adding one to a threshold somewhere.
    expect(outranks(7, 7)).toBe(true);
    expect(outranks(8, 7)).toBe(true);
    expect(outranks(6, 7)).toBe(false);
  });
});

describe("seeding a new firm", () => {
  it("writes the firm's own confirmed ladder, all of it in use", async () => {
    const { service, grades } = await seeded();
    const ladder = await service.listGrades(TENANT);
    expect(ladder).toHaveLength(DEFAULT_GRADES.length);
    expect(grades.rows.every((g) => g.isActive)).toBe(true);
  });

  it("orders the ladder most senior first, so a picker reads top-down", async () => {
    const { service } = await seeded();
    const ladder = await service.listGrades(TENANT);
    expect(ladder[0]?.code).toBe("partner");
    expect(ladder.at(-1)?.code).toBe("analyst");
  });

  it("records ONE event for the whole ladder, not one per rung", async () => {
    const { events } = await seeded();
    expect(events.verbs()).toEqual(["grade_ladder.seeded"]);
    expect(events.recorded[0]?.payload).toMatchObject({ grades: DEFAULT_GRADES.length });
  });

  it("is idempotent — a retry after a partial failure produces no second Manager", async () => {
    // createTenant and the seeder share no unit of work, so this really can be
    // called twice. Two rungs coded `manager` would make the review threshold
    // ambiguous in a way nothing would report.
    const { service, grades } = await seeded();
    const again = await service.seedDefaultGrades(TENANT, ACTOR);
    expect(again).toEqual([]);
    expect(grades.rows.filter((g) => g.code === "manager")).toHaveLength(1);
  });

  it("leaves a firm's own edits alone when it runs again", async () => {
    const { service, grades } = await seeded();
    const manager = grades.rows.find((g) => g.code === "manager");
    if (!manager) throw new Error("the seeded ladder has no manager rung");
    await service.updateGrade({ tenantId: TENANT, gradeId: manager.id, name: "Engagement Manager" }, ACTOR);

    await service.seedDefaultGrades(TENANT, ACTOR);
    const after = await service.getGrade(TENANT, manager.id);
    expect(after.name).toBe("Engagement Manager");
  });

  it("gives each firm its own ladder", async () => {
    const { service } = await seeded();
    await service.seedDefaultGrades(OTHER_TENANT, ACTOR);
    const mine = await service.listGrades(TENANT);
    const theirs = await service.listGrades(OTHER_TENANT);
    expect(mine).toHaveLength(DEFAULT_GRADES.length);
    expect(theirs).toHaveLength(DEFAULT_GRADES.length);
    // Same codes, different rows: a firm renaming its Manager cannot rename
    // anybody else's.
    expect(new Set(mine.map((g) => g.id)).size).toBe(DEFAULT_GRADES.length);
    expect(mine.some((g) => theirs.some((t) => t.id === g.id))).toBe(false);
  });
});

describe("adding a rung the starting ladder did not have", () => {
  it("accepts the designations the firm's hierarchy never ranked", async () => {
    // Article is the motivating case: real, in use, and deliberately absent
    // from the seed because the firm never placed it.
    const { service } = await seeded();
    const article = await service.createGrade(
      { tenantId: TENANT, code: "article", name: "Article", rank: 1 },
      ACTOR,
    );
    expect(article.rank).toBe(1);
    expect(article.isActive).toBe(true);
  });

  it("normalises the code, so `Manager` and `manager` cannot become two rungs", async () => {
    const { service } = await seeded();
    await expect(
      service.createGrade({ tenantId: TENANT, code: "  MANAGER ", name: "Manager", rank: 7 }, ACTOR),
    ).rejects.toBeInstanceOf(GradeCodeTaken);
  });

  it("refuses a code that is not a handle, naming the shape", async () => {
    const { service } = await seeded();
    await expect(
      service.createGrade({ tenantId: TENANT, code: "Senior Manager!", name: "x", rank: 3 }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidGradeCode);
  });

  it("refuses a rank that is not a whole number above zero", async () => {
    const { service } = await seeded();
    // Distinct valid CODES, so what is being refused is unambiguously the rank
    // — a code carrying the rank in it would trip the code rule first and this
    // test would pass for the wrong reason.
    const cases: readonly [string, number][] = [
      ["rung_zero", 0],
      ["rung_negative", -1],
      ["rung_fractional", 1.5],
      ["rung_nan", Number.NaN],
    ];
    for (const [code, rank] of cases) {
      await expect(
        service.createGrade({ tenantId: TENANT, code, name: "x", rank }, ACTOR),
      ).rejects.toBeInstanceOf(InvalidRank);
    }
  });

  it("allows two rungs to share a rank, because nothing compares within one", async () => {
    const { service } = await seeded();
    await service.createGrade({ tenantId: TENANT, code: "head", name: "Head", rank: 7 }, ACTOR);
    const ladder = await service.listGrades(TENANT);
    expect(ladder.filter((g) => g.rank === 7)).toHaveLength(2);
  });
});

describe("editing a rung", () => {
  it("re-ranks it — the half that makes inserting a rung possible", async () => {
    // The firm adds Article at rank 1 and pushes everything else up. Without
    // re-ranking this needs an engineer with a SQL client.
    const { service, grades } = await seeded();
    const analyst = grades.rows.find((g) => g.code === "analyst");
    if (!analyst) throw new Error("the seeded ladder has no analyst rung");

    await service.updateGrade({ tenantId: TENANT, gradeId: analyst.id, rank: 2 }, ACTOR);
    const article = await service.createGrade(
      { tenantId: TENANT, code: "article", name: "Article", rank: 1 },
      ACTOR,
    );

    const ladder = await service.listGrades(TENANT);
    expect(ladder.at(-1)?.id).toBe(article.id);
    expect((await service.getGrade(TENANT, analyst.id)).rank).toBe(2);
  });

  it("renames and re-ranks in one call", async () => {
    const { service, grades } = await seeded();
    const target = grades.rows[0];
    if (!target) throw new Error("empty ladder");
    const updated = await service.updateGrade(
      { tenantId: TENANT, gradeId: target.id, name: "Renamed", rank: 42 },
      ACTOR,
    );
    expect(updated.name).toBe("Renamed");
    expect(updated.rank).toBe(42);
  });

  it("records both sides of what changed, so the trail explains an approval", async () => {
    const { service, grades, events } = await seeded();
    const manager = grades.rows.find((g) => g.code === "manager");
    if (!manager) throw new Error("the seeded ladder has no manager rung");
    await service.updateGrade({ tenantId: TENANT, gradeId: manager.id, rank: 8 }, ACTOR);

    const last = events.recorded.at(-1);
    expect(last?.verb).toBe("staff_grade.updated");
    expect(last?.payload).toMatchObject({ code: "manager", rankFrom: 7, rankTo: 8 });
  });

  it("records nothing when the patch changes nothing", async () => {
    const { service, grades, events } = await seeded();
    const manager = grades.rows.find((g) => g.code === "manager");
    if (!manager) throw new Error("the seeded ladder has no manager rung");
    const before = events.verbs().length;
    await service.updateGrade({ tenantId: TENANT, gradeId: manager.id, rank: manager.rank }, ACTOR);
    expect(events.verbs()).toHaveLength(before);
  });

  it("refuses a rung this firm does not have", async () => {
    const { service } = await seeded();
    await expect(
      service.updateGrade({ tenantId: TENANT, gradeId: ABSENT_GRADE, name: "x" }, ACTOR),
    ).rejects.toBeInstanceOf(GradeNotFound);
  });

  it("refuses to reach another firm's rung", async () => {
    const { service, grades } = await seeded();
    const mine = grades.rows[0];
    if (!mine) throw new Error("empty ladder");
    await expect(
      service.updateGrade({ tenantId: OTHER_TENANT, gradeId: mine.id, name: "theirs" }, ACTOR),
    ).rejects.toBeInstanceOf(GradeNotFound);
  });
});

describe("retiring a rung", () => {
  it("keeps it readable rather than deleting it", async () => {
    // The distinction the column exists for: a rung somebody held in 2026 is
    // part of why they were allowed to approve something in 2026.
    const { service, grades } = await seeded();
    const deputy = grades.rows.find((g) => g.code === "deputy_manager");
    if (!deputy) throw new Error("the seeded ladder has no deputy_manager rung");

    await service.setGradeActive({ tenantId: TENANT, gradeId: deputy.id, isActive: false }, ACTOR);
    const ladder = await service.listGrades(TENANT);
    expect(ladder.map((g) => g.id)).toContain(deputy.id);
    expect(await service.getGrade(TENANT, deputy.id)).toMatchObject({ isActive: false });
  });

  it("drops it from what a picker would offer, and nothing else", async () => {
    const { service, grades } = await seeded();
    const deputy = grades.rows.find((g) => g.code === "deputy_manager");
    if (!deputy) throw new Error("the seeded ladder has no deputy_manager rung");
    await service.setGradeActive({ tenantId: TENANT, gradeId: deputy.id, isActive: false }, ACTOR);

    const ladder = await service.listGrades(TENANT);
    expect(assignableGrades(ladder)).toHaveLength(DEFAULT_GRADES.length - 1);
    expect(ladder).toHaveLength(DEFAULT_GRADES.length);
  });

  it("can be brought back", async () => {
    const { service, grades } = await seeded();
    const deputy = grades.rows.find((g) => g.code === "deputy_manager");
    if (!deputy) throw new Error("the seeded ladder has no deputy_manager rung");
    await service.setGradeActive({ tenantId: TENANT, gradeId: deputy.id, isActive: false }, ACTOR);
    await service.setGradeActive({ tenantId: TENANT, gradeId: deputy.id, isActive: true }, ACTOR);
    expect(await service.getGrade(TENANT, deputy.id)).toMatchObject({ isActive: true });
  });

  it("records nothing when it is already in that state", async () => {
    const { service, grades, events } = await seeded();
    const deputy = grades.rows.find((g) => g.code === "deputy_manager");
    if (!deputy) throw new Error("the seeded ladder has no deputy_manager rung");
    const before = events.verbs().length;
    await service.setGradeActive({ tenantId: TENANT, gradeId: deputy.id, isActive: true }, ACTOR);
    expect(events.verbs()).toHaveLength(before);
  });
});

describe("ladder order", () => {
  it("is stable when two rungs share a rank", () => {
    // A picker that reordered itself between two loads looks broken even when
    // the data is fine, so the tie-break is part of the contract.
    const rows = [
      { id: "a", tenantId: TENANT, code: "b", name: "Beta", rank: 5, isActive: true },
      { id: "b", tenantId: TENANT, code: "a", name: "Alpha", rank: 5, isActive: true },
    ];
    expect(ladderOrder(rows).map((g) => g.name)).toEqual(["Alpha", "Beta"]);
    expect(ladderOrder([...rows].reverse()).map((g) => g.name)).toEqual(["Alpha", "Beta"]);
  });
});
