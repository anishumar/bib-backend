// The guardrail, proven where the whole claim rests: the database (T2.8, 0047).
//
// `agent.test.ts` proves the RULE against a fake. A fake agrees with the service
// by construction, and this task's entire argument is that the rule does NOT
// depend on the service agreeing with it — `build2.md` in the firm's own terms:
// *"a rule that lives in a form is a rule that a script, an import or an AI
// agent walks straight past."* Here the rule is about agents, so an agent
// walking past it is the literal failure mode.
//
// So every assertion below goes around the application entirely, as the OWNER
// role — which is what a migration, a backfill or a 2 a.m. psql session runs as.
// If any of these inserts succeeds, the guardrail is decoration.
//
//   1. A `committed` run below the bar is refused.
//   2. So is one on a step the firm marked for approval, at any confidence.
//   3. `proposed`, `confidence` and the thresholds cannot be rewritten afterwards.
//   4. A `corrected` that changed nothing is refused, and an `accepted` that did.
//   5. A rejection must say why.
//   6. RLS isolates the table.
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
  step: string;
  person: string;
}
let f: Fixture;

/** One agent run, with everything coherent unless a test says otherwise. */
function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref(),
    tenant_id: f.tenant,
    job_id: f.job,
    job_step_id: f.step,
    confidence: 0.8,
    auto_commit_at: 0.95,
    review_at: 0.7,
    tier_version_id: null,
    decision: "queued",
    approval_required: false,
    proposed: JSON.stringify({ total: "1200.00" }),
    applied: null,
    outcome: null,
    rejected_reason: null,
    decided_by: null,
    decided_at: null,
    model: "fake",
    prompt_version: "v1",
    ...over,
  };
}

async function insert(row: Record<string, unknown>): Promise<void> {
  await owner`
    INSERT INTO delivery.agent_run ${owner(
      row,
      "id",
      "tenant_id",
      "job_id",
      "job_step_id",
      "confidence",
      "auto_commit_at",
      "review_at",
      "tier_version_id",
      "decision",
      "approval_required",
      "proposed",
      "applied",
      "outcome",
      "rejected_reason",
      "decided_by",
      "decided_at",
      "model",
      "prompt_version",
    )}
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`guard-a-${stamp}`}, 'Guardrail Test A', 'INR') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`guard-b-${stamp}`}, 'Guardrail Test B', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("could not create the test firms");

  // A job and a step to hang runs off. `source_kind = 'obligation'` so no crm
  // rows are needed: this file is about the CHECKs, and a letter, a client and a
  // published service would be fixture that proves nothing here.
  const job = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at)
    VALUES (${job}, ${t.id}, 'obligation', ${ref()}, now())
  `;
  const step = ref();
  await owner`
    INSERT INTO delivery.job_step (id, tenant_id, job_id, step_key, label, executor)
    VALUES (${step}, ${t.id}, ${job}, 'reconcile', 'Reconcile', 'agent')
  `;

  // A real login, because `decided_by` is a foreign key to the GLOBAL
  // `user_account` table and a decision is whole or it has not happened.
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`guard-${stamp}@example.com`}, 'A Checker') RETURNING id
  `;
  if (!u) throw new Error("could not create the test user");

  f = { tenant: t.id, otherTenant: o.id, job, step, person: u.id };
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("unattended action is refused by the DATABASE", () => {
  it("allows a commit strictly above the bar", async () => {
    await expect(
      insert(run({ decision: "committed", confidence: 0.96, applied: JSON.stringify({ total: "1200.00" }) })),
    ).resolves.toBeUndefined();
  });

  it("refuses a commit AT the bar — which is what makes 1.0 an off switch", async () => {
    // Strictly above, so publishing `autoCommitAt: 1` stops every unattended
    // commit with one edit. If this ever passes, that lever is gone.
    await expect(
      insert(run({ decision: "committed", confidence: 0.95, applied: JSON.stringify({ total: "1200.00" }) })),
    ).rejects.toThrow(/agent_run_commit_needs_confidence/);
  });

  it("refuses a commit below the bar", async () => {
    await expect(
      insert(run({ decision: "committed", confidence: 0.4, applied: JSON.stringify({ total: "1200.00" }) })),
    ).rejects.toThrow(/agent_run_commit_needs_confidence/);
  });

  // THE FIRM'S OWN INSTRUCTION, enforced in the schema and not only in the
  // orchestrator. A step marked `agent_with_approval` may never commit, and a
  // future agent runtime that decided otherwise is refused here.
  it("refuses a commit on a step the firm marked for approval, however sure", async () => {
    await expect(
      insert(
        run({
          decision: "committed",
          confidence: 0.999,
          approval_required: true,
          applied: JSON.stringify({ total: "1200.00" }),
        }),
      ),
    ).rejects.toThrow(/agent_run_commit_needs_confidence/);
  });

  it("refuses a decision that disagrees with the numbers it claims", async () => {
    // An `escalated` row sitting above the review bar would describe a routing
    // that never happened, and the accuracy record would be fiction.
    await expect(insert(run({ decision: "escalated", confidence: 0.9 }))).rejects.toThrow(
      /agent_run_escalate_band/,
    );
    await expect(insert(run({ decision: "queued", confidence: 0.2 }))).rejects.toThrow(
      /agent_run_queue_band/,
    );
  });

  it("refuses thresholds that describe no possible routing", async () => {
    // The queue band fires first on this row, which is the same wall by a
    // different brick — both refuse it, and asserting on the exact constraint
    // would be asserting on the order postgres happens to evaluate them in.
    await expect(
      insert(run({ auto_commit_at: 0.5, review_at: 0.9, confidence: 0.6 })),
    ).rejects.toThrow(/agent_run_tiers_are_coherent|agent_run_queue_band/);
  });

  it("refuses a committed run that names a decider — nobody decides a commit", async () => {
    await expect(
      insert(
        run({
          decision: "committed",
          confidence: 0.96,
          applied: JSON.stringify({ total: "1200.00" }),
          outcome: "accepted",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("what a machine said cannot be rewritten", () => {
  it("refuses to change the proposal, the confidence or the bar it was judged by", async () => {
    const id = ref();
    await insert(run({ id }));

    // The whole value of this table is that it is EVIDENCE. If these can be
    // edited afterwards then an accuracy figure means nothing, and neither does
    // "we were allowed to commit this".
    for (const [column, value] of [
      ["proposed", JSON.stringify({ total: "9999.00" })],
      ["confidence", 0.99],
      ["auto_commit_at", 0.1],
      ["decision", "committed"],
      ["approval_required", true],
      ["model", "something-else"],
    ] as const) {
      await expect(
        owner`UPDATE delivery.agent_run SET ${owner.unsafe(column)} = ${value} WHERE id = ${id}`,
      ).rejects.toThrow(/records what a machine actually proposed/);
    }
  });

  it("still lets a person record their decision", async () => {
    // The half that legitimately happens later. A trigger that froze the whole
    // row would make the table unusable.
    const id = ref();
    await insert(run({ id }));
    const rows = await owner<{ id: string }[]>`
      UPDATE delivery.agent_run
      SET outcome = 'corrected', applied = ${JSON.stringify({ total: "1350.00" })},
          decided_by = ${f.person}, decided_at = now()
      WHERE id = ${id} RETURNING id
    `;
    expect(rows).toHaveLength(1);
  });

  it("refuses HALF a decision — an outcome with nobody who made it", async () => {
    const id = ref();
    await insert(run({ id }));
    await expect(
      owner`
        UPDATE delivery.agent_run
        SET outcome = 'corrected', applied = ${JSON.stringify({ total: "1350.00" })}
        WHERE id = ${id}
      `,
    ).rejects.toThrow(/agent_run_human_decision_is_whole/);
  });
});

describe("the accuracy signal is kept honest, not merely collected", () => {
  it("refuses a `corrected` that changed nothing", async () => {
    // An acceptance somebody mis-clicked. Counted as a correction it understates
    // the agent, and a number nobody can trust is worse than no number.
    const id = ref();
    await insert(run({ id }));
    await expect(
      owner`
        UPDATE delivery.agent_run
        SET outcome = 'corrected', applied = proposed,
            decided_by = ${f.person}, decided_at = now()
        WHERE id = ${id}
      `,
    ).rejects.toThrow(/agent_run_corrected_actually_differs/);
  });

  it("refuses an `accepted` whose value differs from the proposal", async () => {
    const id = ref();
    await insert(run({ id }));
    await expect(
      owner`
        UPDATE delivery.agent_run
        SET outcome = 'accepted', applied = ${JSON.stringify({ total: "9999.00" })},
            decided_by = ${f.person}, decided_at = now()
        WHERE id = ${id}
      `,
    ).rejects.toThrow(/agent_run_accepted_does_not_differ/);
  });

  it("refuses a rejection with no reason", async () => {
    const id = ref();
    await insert(run({ id }));
    await expect(
      owner`
        UPDATE delivery.agent_run
        SET outcome = 'rejected', decided_by = ${f.person}, decided_at = now()
        WHERE id = ${id}
      `,
    ).rejects.toThrow(/agent_run_rejected_says_why/);
  });
});

describe("the tenant wall and the grants", () => {
  it("hides one firm's runs from another", async () => {
    const id = ref();
    await insert(run({ id }));
    const theirs = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${f.otherTenant}, true)`;
      return tx<{ id: string }[]>`SELECT id FROM delivery.agent_run WHERE id = ${id}`;
    });
    expect(theirs).toHaveLength(0);
  });

  it("gives the app no DELETE grant — an unattended action leaves a record", async () => {
    const rows = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'delivery' AND table_name = 'agent_run' AND grantee = 'bib_app'
    `;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
