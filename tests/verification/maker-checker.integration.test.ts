// MAKER != CHECKER, proven where the whole claim rests: the database (T2.9, 0048).
//
// `queue.test.ts` proves what a PERSON is told. A fake agrees with the service by
// construction, and this task's entire argument is that the rule does NOT depend
// on the service agreeing with it — `build2.md` quotes the demo's own reason for
// making it a constraint:
//
//   "a rule that lives in a form is a rule that a script, an import or an AI
//    agent walks straight past."
//
// So every assertion below goes around the application entirely, as the OWNER
// role — which is what a migration, a backfill, an import script or a 2 a.m.
// psql session runs as. If any of these succeeds, the rule is decoration.
//
//   1. The person who performed a step cannot approve it.
//   2. Naming somebody ELSE as the maker does not get you past it — the maker
//      is DERIVED from the step, and anything the caller sends is overwritten.
//   3. The maker cannot be edited afterwards to make an approval legal.
//   4. A decision is whole: a decider and a time, or neither.
//   5. A rejection must say why.
//   6. One open check per step.
//   7. Nobody reports to themselves.
//   8. RLS isolates the table.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();

interface Fixture {
  tenant: string;
  otherTenant: string;
  job: string;
  /** A step Priya performed. */
  step: string;
  priya: string;
  anand: string;
}
let f: Fixture;

/** Open a check on a step, as the owner role. Returns its id. */
async function open(stepId: string, tenantId: string = f.tenant): Promise<string> {
  const id = ref();
  await owner`
    INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id)
    VALUES (${id}, ${tenantId}, ${f.job}, ${stepId})
  `;
  return id;
}

async function decide(
  approvalId: string,
  decidedBy: string | null,
  decision = "approved",
  notes: string | null = null,
): Promise<void> {
  await owner`
    UPDATE delivery.step_approval
       SET decision = ${decision}, decided_by = ${decidedBy}, notes = ${notes},
           decided_at = ${decidedBy === null ? null : owner`now()`}
     WHERE id = ${approvalId}
  `;
}

/** A fresh step of the same job, performed by whoever is named. Each test that
 *  opens a check needs its own, because one OPEN check per step is itself one of
 *  the rules under test. */
async function stepPerformedBy(performer: string | null): Promise<string> {
  const id = ref();
  const key = `step-${randomUUID().slice(0, 8)}`;
  await owner`
    INSERT INTO delivery.job_step
      (id, tenant_id, job_id, step_key, label, executor, status, started_at, performed_by)
    VALUES (${id}, ${f.tenant}, ${f.job}, ${key}, 'A step', 'human', 'blocked', now(), ${performer})
  `;
  return id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`check-a-${stamp}`}, 'Maker-Checker Test A', 'INR') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`check-b-${stamp}`}, 'Maker-Checker Test B', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("could not create the test firms");

  // `source_kind = 'obligation'` so no crm rows are needed: this file is about
  // the CHECKs, and a letter, a client and a published service would be fixture
  // that proves nothing here.
  const job = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at)
    VALUES (${job}, ${t.id}, 'obligation', ${ref()}, now())
  `;

  const [p] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`priya-${stamp}@example.com`}, 'Priya') RETURNING id
  `;
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`anand-${stamp}@example.com`}, 'Anand') RETURNING id
  `;
  if (!p || !a) throw new Error("could not create the test users");

  f = { tenant: t.id, otherTenant: o.id, job, step: "", priya: p.id, anand: a.id };
  f.step = await stepPerformedBy(p.id);
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("THE ACCEPTANCE LINE — the maker cannot be the checker", () => {
  it("lets somebody else approve", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    await expect(decide(id, f.anand)).resolves.toBeUndefined();
  });

  it("REFUSES the person who performed the step", async () => {
    // The whole task, in one assertion, as the role a script runs as.
    const id = await open(await stepPerformedBy(f.priya));
    await expect(decide(id, f.priya)).rejects.toThrow(/step_approval_maker_is_not_checker/);
  });

  it("refuses them however the row is written — an UPDATE is not a way round", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    await expect(
      owner`
        UPDATE delivery.step_approval
           SET decision = 'approved', decided_by = ${f.priya}, decided_at = now()
         WHERE id = ${id}
      `,
    ).rejects.toThrow(/step_approval_maker_is_not_checker/);
  });
});

describe("the maker is DERIVED, so naming somebody else does not help", () => {
  it("overwrites whatever the caller sends with the step's real performer", async () => {
    // The attack the CHECK alone would not stop: say Anand made it, then approve
    // as Priya. The trigger reads `job_step.performed_by` and the lie is gone
    // before the constraint is even consulted.
    const step = await stepPerformedBy(f.priya);
    const id = ref();
    await owner`
      INSERT INTO delivery.step_approval
        (id, tenant_id, job_id, job_step_id, submitted_by)
      VALUES (${id}, ${f.tenant}, ${f.job}, ${step}, ${f.anand})
    `;
    const [row] = await owner<{ submitted_by: string }[]>`
      SELECT submitted_by FROM delivery.step_approval WHERE id = ${id}
    `;
    expect(row?.submitted_by).toBe(f.priya);
    // And the approval that the lie was for is still refused.
    await expect(decide(id, f.priya)).rejects.toThrow(/step_approval_maker_is_not_checker/);
  });

  it("refuses to let the maker be edited afterwards", async () => {
    // A rule whose left-hand side can be changed after the fact is not a rule:
    // approve as yourself would become "move the maker, then approve".
    const id = await open(await stepPerformedBy(f.priya));
    await expect(
      owner`UPDATE delivery.step_approval SET submitted_by = ${f.anand} WHERE id = ${id}`,
    ).rejects.toThrow(/cannot change who made the work/);
  });

  it("refuses to let the check be repointed at a different step", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    const other = await stepPerformedBy(f.anand);
    await expect(
      owner`UPDATE delivery.step_approval SET job_step_id = ${other} WHERE id = ${id}`,
    ).rejects.toThrow(/cannot change who made the work/);
  });
});

describe("a machine that committed unattended has no self to approve", () => {
  it("lets anybody check a step no person performed", async () => {
    // `performed_by` is null there. maker != checker has nothing to compare, and
    // that is the correct reading rather than a hole — the guardrail deciding
    // whether the machine could act at all is 0047's and ran before this row.
    const id = await open(await stepPerformedBy(null));
    await expect(decide(id, f.priya)).resolves.toBeUndefined();
  });
});

describe("a decision is whole, or it has not happened", () => {
  it("refuses an approval with no decider", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    await expect(
      owner`UPDATE delivery.step_approval SET decision = 'approved' WHERE id = ${id}`,
    ).rejects.toThrow(/step_approval_decided_evidence/);
  });

  it("refuses a pending row that names a decider", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    await expect(
      owner`
        UPDATE delivery.step_approval SET decided_by = ${f.anand}, decided_at = now()
        WHERE id = ${id}
      `,
    ).rejects.toThrow(/step_approval_decided_evidence/);
  });

  it("refuses a rejection that does not say why", async () => {
    // The only signal that ever explains rework, and it is only ever written by
    // somebody already in a hurry — which is why it is insisted on here.
    const id = await open(await stepPerformedBy(f.priya));
    await expect(decide(id, f.anand, "rejected", "   ")).rejects.toThrow(
      /step_approval_rejection_says_why/,
    );
  });

  it("accepts a rejection that does", async () => {
    const id = await open(await stepPerformedBy(f.priya));
    await expect(
      decide(id, f.anand, "rejected", "The March input credit is on the wrong period."),
    ).resolves.toBeUndefined();
  });
});

describe("one OPEN check per step", () => {
  it("refuses a second while the first is undecided", async () => {
    // Otherwise two people can each open one and each approve the other's.
    const step = await stepPerformedBy(f.priya);
    await open(step);
    await expect(open(step)).rejects.toThrow(/idx_step_approval_one_open/);
  });

  it("ALLOWS a second once the first is decided — a redo is a second row", async () => {
    // "It was sent back once" is part of the record, exactly as a retried agent
    // run is a second row in 0047.
    const step = await stepPerformedBy(f.priya);
    const first = await open(step);
    await decide(first, f.anand, "rejected", "wrong period");
    await expect(open(step)).resolves.toBeTruthy();
  });
});

describe("the reporting line", () => {
  it("refuses somebody reporting to themselves", async () => {
    // The one loop a CHECK can see. Longer ones are the service's, because a
    // constraint sees one row.
    const [m] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
      VALUES (${f.tenant}, ${f.priya}, 'STAFF', 'member') RETURNING id
    `;
    await expect(
      owner`
        UPDATE tenancy.membership SET reports_to_user_id = ${f.priya} WHERE id = ${m?.id ?? ""}
      `,
    ).rejects.toThrow(/membership_reports_to_is_not_self/);
  });

  it("accepts a colleague", async () => {
    const [m] = await owner<{ id: string }[]>`
      SELECT id FROM tenancy.membership WHERE tenant_id = ${f.tenant} AND user_id = ${f.priya}
    `;
    await expect(
      owner`
        UPDATE tenancy.membership SET reports_to_user_id = ${f.anand} WHERE id = ${m?.id ?? ""}
      `,
    ).resolves.toBeTruthy();
  });
});

describe("THE TENANT WALL holds on this table too", () => {
  it("shows a firm only its own checks", async () => {
    const step = await stepPerformedBy(f.priya);
    const id = await open(step);

    const mine = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${f.tenant}, true)`;
      return tx<{ id: string }[]>`SELECT id FROM delivery.step_approval WHERE id = ${id}`;
    });
    expect(mine).toHaveLength(1);

    const theirs = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${f.otherTenant}, true)`;
      return tx<{ id: string }[]>`SELECT id FROM delivery.step_approval WHERE id = ${id}`;
    });
    expect(theirs).toHaveLength(0);
  });

  it("returns nothing at all with no tenant set", async () => {
    // The wall holds by DEFAULT, not by remembering to filter.
    const rows = await app.begin(
      async (tx) => tx<{ id: string }[]>`SELECT id FROM delivery.step_approval`,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to DELETE a check, even as the app role", async () => {
    // A rejection that was deleted is rework with no record of why it happened.
    const step = await stepPerformedBy(f.priya);
    const id = await open(step);
    await expect(
      app.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${f.tenant}, true)`;
        return tx`DELETE FROM delivery.step_approval WHERE id = ${id}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
