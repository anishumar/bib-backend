// The missed-deadline rules, proven where they actually have to hold (T3.3).
//
// Everything below is a claim the DATABASE makes, which is the point: a script,
// an import, an agent or a psql session walks straight past a service check,
// and each of these rules is about a statutory filing. Five properties, none of
// them testable with a fake:
//
//   1. A firm may hold AT MOST ONE missed state and AT MOST ONE resolution
//      state. With two, where an overdue filing goes is a coin toss and the
//      four rules reading the flags each pick a different answer.
//   2. A state the sweep sends work to MUST ask somebody. Without this a firm
//      could point `is_missed` at an ordinary working state and every overdue
//      filing would move there in silence.
//   3. A state cannot hold two DESTINATIONS. They are answers to four different
//      questions about the same row.
//   4. A DECISION AND ITS REASON ARE ONE FACT. All three columns or none, and
//      a blank reason is not a reason — the CHECK is what makes "say why"
//      true of the table rather than only of the form.
//   5. RLS and the composite foreign key isolate the options, so one firm can
//      never resolve a filing against another firm's answer.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `missed-test-a-${stamp}`;
const slugB = `missed-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  entityA: string;
  stateA: string;
  missedA: string;
  ruleA: string;
  optionA: string;
  optionB: string;
}
let ids: Ids;

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Northfield Advisory', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");

  const [ea] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${a.id}, 'organization', 'Kaveri Foods Pvt Ltd') RETURNING id
  `;
  if (!ea) throw new Error("could not create the test entity");

  const [sa] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
    VALUES (${a.id}, 'pending', 'Pending', true) RETURNING id
  `;
  const [ma] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state
      (tenant_id, code, name, needs_decision, is_missed, sort_order)
    VALUES (${a.id}, 'missed', 'Missed', true, true, 40) RETURNING id
  `;
  if (!sa || !ma) throw new Error("could not create the test states");

  const [ra] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${a.id}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, 'gst-in@2026.07')
    RETURNING id
  `;
  if (!ra) throw new Error("could not create the test rule");

  const [oa] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_resolution_option (tenant_id, code, name)
    VALUES (${a.id}, 'late_fee', 'Accept the late fee') RETURNING id
  `;
  const [ob] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_resolution_option (tenant_id, code, name)
    VALUES (${b.id}, 'late_fee', 'Accept the late fee') RETURNING id
  `;
  if (!oa || !ob) throw new Error("could not create the test options");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    entityA: ea.id,
    stateA: sa.id,
    missedA: ma.id,
    ruleA: ra.id,
    optionA: oa.id,
    optionB: ob.id,
  };
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_resolution_option WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM core.party WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.tenant WHERE slug IN (${slugA}, ${slugB})`;
  await Promise.all([owner.end(), app.end()]);
});

async function asTenant<T>(
  tenantId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

/**
 * One overdue obligation, in the missed state, returned by id.
 *
 * A DIFFERENT PERIOD each call, because `obligation_instance_key` is the
 * re-run key that makes the generator idempotent — one obligation per entity
 * per rule per period, forever. Two fixtures sharing a period is the same
 * collision a second nightly sweep would hit, which is the constraint working.
 */
let periodMonth = 0;
async function overdueInstance(): Promise<string> {
  periodMonth += 1;
  const start = `2026-${String(periodMonth).padStart(2, "0")}-01`;
  const rows = await asTenant(ids.tenantA, (tx) => tx<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES
      (${ids.tenantA}, ${ids.ruleA}, ${ids.entityA}, ${start}::date,
       (${start}::date + INTERVAL '1 month - 1 day')::date,
       ${`P${String(periodMonth)} 2026`},
       (${start}::date + INTERVAL '50 days')::date,
       (${start}::date + INTERVAL '43 days')::date,
       ${ids.missedA})
    RETURNING id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("could not create the overdue obligation");
  return id;
}

describe("a firm has exactly one place for each kind of ending", () => {
  it("refuses a SECOND missed state", async () => {
    // The partial unique index. Postgres cannot enforce "at least one" — the
    // seed and `ObligationVocabularyService` are what guarantee that floor —
    // but it can and does enforce at most one, which is the half that decides
    // whether `missedState()` has a single answer.
    await expect(
      owner`
        INSERT INTO delivery.obligation_state
          (tenant_id, code, name, needs_decision, is_missed)
        VALUES (${ids.tenantA}, 'overdue', 'Overdue', true, true)
      `,
    ).rejects.toThrow(/idx_obligation_state_one_missed/);
  });

  it("refuses a SECOND resolution state", async () => {
    await owner`
      INSERT INTO delivery.obligation_state
        (tenant_id, code, name, is_terminal, is_resolution)
      VALUES (${ids.tenantA}, 'resolved', 'Resolved', true, true)
    `;
    await expect(
      owner`
        INSERT INTO delivery.obligation_state
          (tenant_id, code, name, is_terminal, is_resolution)
        VALUES (${ids.tenantA}, 'written_off', 'Written off', true, true)
      `,
    ).rejects.toThrow(/idx_obligation_state_one_resolution/);
    await owner`
      DELETE FROM delivery.obligation_state
      WHERE tenant_id = ${ids.tenantA} AND code = 'resolved'
    `;
  });

  it("lets ANOTHER FIRM hold its own, which is what per-tenant means", async () => {
    await owner`
      INSERT INTO delivery.obligation_state
        (tenant_id, code, name, needs_decision, is_missed)
      VALUES (${ids.tenantB}, 'missed', 'Missed', true, true)
    `;
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.obligation_state
      WHERE tenant_id = ${ids.tenantB} AND is_missed
    `;
    expect(row?.n).toBe("1");
  });
});

describe("a state cannot be shaped in a way that loses filings", () => {
  it("refuses a missed state that asks nobody", async () => {
    // The silence this constraint exists to prevent: every overdue filing
    // moves there and no partner is ever asked. Refused by the DATABASE and
    // not only by the service, because a firm's vocabulary is exactly the kind
    // of table somebody edits from psql during an onboarding.
    await expect(
      owner`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_missed)
        VALUES (${ids.tenantA}, 'silent', 'Silent', true)
      `,
    ).rejects.toThrow(/obligation_state_missed_chk/);
  });

  it("refuses a resolution state that is not an ending", async () => {
    await expect(
      owner`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_resolution)
        VALUES (${ids.tenantA}, 'half', 'Half', true)
      `,
    ).rejects.toThrow(/obligation_state_resolution_chk/);
  });

  it("refuses a state claiming two destinations", async () => {
    await expect(
      owner`
        INSERT INTO delivery.obligation_state
          (tenant_id, code, name, is_terminal, is_filed, is_resolution)
        VALUES (${ids.tenantA}, 'two', 'Two', true, true, true)
      `,
    ).rejects.toThrow(/obligation_state_one_destination_chk/);
  });
});

describe("a decision and its reason are one fact", () => {
  it("refuses a decision with NO REASON", async () => {
    // The whole feature, as a database rule. "Say why" being true of the FORM
    // is worth little — a partner in a hurry meets the form, and an import
    // does not. The CHECK is what makes it true of the record.
    const id = await overdueInstance();
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        UPDATE delivery.obligation_instance
        SET resolution_option_id = ${ids.optionA}, resolved_at = now()
        WHERE id = ${id}
      `),
    ).rejects.toThrow(/obligation_instance_resolution_chk/);
  });

  it("refuses a BLANK reason, which is the same hole with whitespace in it", async () => {
    const id = await overdueInstance();
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        UPDATE delivery.obligation_instance
        SET resolution_option_id = ${ids.optionA},
            resolution_reason = '   ',
            resolved_at = now()
        WHERE id = ${id}
      `),
    ).rejects.toThrow(/obligation_instance_resolution_chk/);
  });

  it("refuses a reason attached to no decision", async () => {
    // The other direction, and it is not symmetry for its own sake: a note
    // nobody can act on, sitting on a filing that was never decided about,
    // would read on the screen as though a decision had been taken.
    const id = await overdueInstance();
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        UPDATE delivery.obligation_instance
        SET resolution_reason = 'client sent books late'
        WHERE id = ${id}
      `),
    ).rejects.toThrow(/obligation_instance_resolution_chk/);
  });

  it("accepts all three together", async () => {
    const id = await overdueInstance();
    await asTenant(ids.tenantA, (tx) => tx`
      UPDATE delivery.obligation_instance
      SET resolution_option_id = ${ids.optionA},
          resolution_reason = 'client sent the books on the 19th',
          resolved_at = now(),
          state_id = ${ids.stateA}
      WHERE id = ${id}
    `);
    const [row] = await asTenant(ids.tenantA, (tx) => tx<{ reason: string }[]>`
      SELECT resolution_reason AS reason FROM delivery.obligation_instance WHERE id = ${id}
    `);
    expect(row?.reason).toBe("client sent the books on the 19th");
  });
});

describe("the tenant wall holds around the firm's own answers", () => {
  it("hides another firm's resolution options", async () => {
    const rows = await asTenant(ids.tenantA, (tx) => tx<{ id: string }[]>`
      SELECT id FROM delivery.obligation_resolution_option
    `);
    expect(rows.map((r) => r.id)).toContain(ids.optionA);
    expect(rows.map((r) => r.id)).not.toContain(ids.optionB);
  });

  it("REFUSES A DECISION AGAINST ANOTHER FIRM'S OPTION", async () => {
    // The failure RLS does NOT catch on its own, and the reason CLAUDE.md
    // insists every reference carries the tenant: a foreign-key check runs as
    // a system operation the row policies do not filter, so an id-only
    // reference would let one firm's filing be resolved against another firm's
    // answer with no policy violation anywhere.
    const id = await overdueInstance();
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        UPDATE delivery.obligation_instance
        SET resolution_option_id = ${ids.optionB},
            resolution_reason = 'borrowed from the firm next door',
            resolved_at = now()
        WHERE id = ${id}
      `),
    ).rejects.toThrow(/obligation_instance_resolution_tenant_fkey/);
  });

  it("holds no DELETE grant on the options", async () => {
    // Nothing is hard-deleted. A retired option still EXPLAINS every decision
    // recorded against it, and this is enforced by a missing grant rather than
    // by a rule somebody remembers — an import walks past the second and not
    // the first.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        DELETE FROM delivery.obligation_resolution_option WHERE id = ${ids.optionA}
      `),
    ).rejects.toThrow(/permission denied/i);
  });
});
