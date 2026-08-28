// Putting a person on a rung — the tenancy half of G3.3.
//
// The ladder itself is service.test.ts. This is the join: `membership.grade_id`,
// the refusals an assignment owes, and the roster read that has to show a NAME
// rather than the uuid it stores.
//
// The contrast worth holding onto while reading: changing a ROLE can leave a
// firm with nobody able to administer it, so it has a guard. Changing a GRADE
// grants nothing and can strand nobody, so it deliberately has none — and the
// last test here is what keeps that difference honest.
import { describe, expect, it } from "vitest";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import { MembershipNotFound } from "../../src/domain/tenancy/errors";
import { GradeNotAssignable, GradeNotFound } from "../../src/domain/staffgrade/errors";

const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000e1" };
const ABSENT = "00000000-0000-4000-8000-0000000009f9";

/** A firm with one partner and the ladder createTenant gave it. */
async function firm() {
  const f = makeFakes();
  const service = new TenancyService(f);
  const grades = new StaffGradeService({ grades: f.grades, ids: f.ids, events: f.events });
  const tenant = await service.createTenant({
    name: "Harbour Point",
    slug: "harbour-point",
    reportingCurrency: "INR",
  });
  const owner = await service.ensureUser("partner@harbour.example", "Anita Rao");
  const membership = await service.addMember({
    tenantId: tenant.id,
    userId: owner.id,
    audience: "STAFF",
    role: "partner",
    commercialVisibility: true,
  });
  const rung = (code: string): string => {
    const found = f.grades.rows.find((g) => g.tenantId === tenant.id && g.code === code);
    if (!found) throw new Error(`the seeded ladder has no ${code} rung`);
    return found.id;
  };
  return { service, grades, f, tenant, membership, rung };
}

describe("assigning a rung", () => {
  it("changes seniority without touching what the person may do", async () => {
    // Role and grade are independent axes. A promotion is not a grant.
    const { service, tenant, membership, rung } = await firm();
    const updated = await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    expect(updated.gradeId).toBe(rung("manager"));
    expect(updated.role).toBe("partner");
    expect(updated.commercialVisibility).toBe(true);
  });

  it("leaves somebody ungraded until a decision is made", async () => {
    // Null is a real state, not a gap waiting to be filled: a portal contact
    // has no rung, and neither does somebody the firm's hierarchy never ranked.
    const { service, tenant } = await firm();
    const [row] = await service.listMembers(tenant.id);
    expect(row?.membership.gradeId).toBeNull();
    expect(row?.grade).toBeNull();
  });

  it("takes somebody off the ladder when asked", async () => {
    const { service, tenant, membership, rung, f } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    const cleared = await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: null },
      ACTOR,
    );
    expect(cleared.gradeId).toBeNull();
    // Both moves are recorded — taking somebody off a rung is a decision too.
    expect(f.events.verbs().filter((v) => v === "membership.grade_changed")).toHaveLength(2);
  });

  it("records nothing when they are already on that rung", async () => {
    const { service, tenant, membership, rung, f } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    const before = f.events.verbs().length;
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    expect(f.events.verbs()).toHaveLength(before);
  });
});

describe("what the trail says about a promotion", () => {
  it("names both rungs, so 'when did they become a Senior Manager' is answerable", async () => {
    const { service, tenant, membership, rung, f } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("senior_manager") },
      ACTOR,
    );
    const last = f.events.recorded.at(-1);
    expect(last?.verb).toBe("membership.grade_changed");
    // Codes, not uuids: two uuids cannot answer the question without two more
    // lookups, and the ladder they point at may have been renamed since.
    expect(last?.payload).toMatchObject({ from: "manager", to: "senior_manager", rank: 8 });
  });

  it("keeps the person's email out of it — this log cannot be erased", async () => {
    const { service, tenant, membership, rung, f } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("manager") },
      ACTOR,
    );
    const last = f.events.recorded.at(-1);
    expect(JSON.stringify(last?.payload)).not.toContain("partner@harbour.example");
  });
});

describe("the roster shows the rung, not its id", () => {
  it("carries the name and the rank, so no screen looks a grade up per row", async () => {
    const { service, tenant, membership, rung } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("senior_manager") },
      ACTOR,
    );
    const [row] = await service.listMembers(tenant.id);
    expect(row?.grade?.name).toBe("Senior Manager");
    expect(row?.grade?.rank).toBe(8);
    expect(row?.grade?.code).toBe("senior_manager");
  });

  it("keeps a retired rung visible on somebody who holds it, marked retired", async () => {
    // The whole argument for `is_active` over a delete: the person really is on
    // that rung, and an approval they made in 2026 has to stay explicable.
    const { service, grades, tenant, membership, rung } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("deputy_manager") },
      ACTOR,
    );
    await grades.setGradeActive(
      { tenantId: tenant.id, gradeId: rung("deputy_manager"), isActive: false },
      ACTOR,
    );

    const [row] = await service.listMembers(tenant.id);
    expect(row?.grade?.name).toBe("Deputy Manager");
    expect(row?.grade?.isActive).toBe(false);
  });
});

describe("what an assignment refuses", () => {
  it("refuses a rung this firm has never defined", async () => {
    const { service, tenant, membership } = await firm();
    await expect(
      service.changeMemberGrade(
        { tenantId: tenant.id, membershipId: membership.id, gradeId: ABSENT },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(GradeNotFound);
  });

  it("refuses a rung the firm has stopped promoting through", async () => {
    // People already on it keep it. Putting somebody NEW on a retired rung is
    // almost always a stale picker, and allowing it quietly would spread a rung
    // the firm deliberately left behind.
    const { service, grades, tenant, membership, rung } = await firm();
    await grades.setGradeActive(
      { tenantId: tenant.id, gradeId: rung("deputy_manager"), isActive: false },
      ACTOR,
    );
    await expect(
      service.changeMemberGrade(
        { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("deputy_manager") },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(GradeNotAssignable);
  });

  it("refuses a membership that is not this firm's", async () => {
    const { service, tenant, rung } = await firm();
    await expect(
      service.changeMemberGrade(
        { tenantId: tenant.id, membershipId: ABSENT, gradeId: rung("manager") },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(MembershipNotFound);
  });

  it("cannot reach another firm's ladder", async () => {
    // The service check, backed at the database by the composite foreign key in
    // migration 0040 — the failure RLS alone does not catch, because a
    // foreign-key check runs as a system operation the row policies do not
    // filter. Proven against real Postgres in assignment.integration.test.ts.
    //
    // The second firm is created through the SAME service, not a second set of
    // fakes: two independent fakes would hand out identical deterministic ids
    // and the test would pass by collision rather than by isolation.
    const { service, tenant, membership, f } = await firm();
    const other = await service.createTenant({
      name: "Northfield Advisory",
      slug: "northfield",
      reportingCurrency: "INR",
    });
    const theirManager = f.grades.rows.find(
      (g) => g.tenantId === other.id && g.code === "manager",
    );
    if (!theirManager) throw new Error("the second firm was created without a ladder");
    expect(theirManager.tenantId).not.toBe(tenant.id);

    await expect(
      service.changeMemberGrade(
        { tenantId: tenant.id, membershipId: membership.id, gradeId: theirManager.id },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(GradeNotFound);
  });
});

describe("a grade grants nothing, so it can strand nobody", () => {
  it("lets the only partner be taken off the ladder", async () => {
    // The deliberate contrast with changeMemberRole, which refuses the move
    // that would leave a firm with no administrator. Clearing the last
    // partner's GRADE is allowed; clearing their ROLE is not. If somebody ever
    // adds a last-administrator guard to grades, this test says why not to.
    const { service, tenant, membership, rung } = await firm();
    await service.changeMemberGrade(
      { tenantId: tenant.id, membershipId: membership.id, gradeId: rung("partner") },
      ACTOR,
    );
    await expect(
      service.changeMemberGrade(
        { tenantId: tenant.id, membershipId: membership.id, gradeId: null },
        ACTOR,
      ),
    ).resolves.toMatchObject({ gradeId: null });
  });
});
