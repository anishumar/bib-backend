// Handing a rule over to its successor, proven against the real database
// (T6.4's remaining half, migration 0057).
//
// ── WHY THIS FILE HAD TO BE WRITTEN ────────────────────────────────────────
//
// `supersede` is the second non-trivial statement this module has added, and
// the first one taught the lesson: the batch INSERT four hundred lines above it
// needed a `::text::jsonb` DOUBLE CAST to run AT ALL, every sweep died on it,
// and it was found by RUNNING the worker — because the unit tests use a fake
// repository and the old integration test inserted rows by hand. So new SQL
// gets executed here or it ships unexecuted.
//
// Four things are proven, and each is a claim the fake cannot make:
//
//   1. Both halves land — the predecessor closed at the cutover AND the
//      successor written with `supersedes_id` — in one statement pair inside
//      one transaction.
//   2. IT ROLLS BACK AS ONE. A successor colliding on the rule's identity
//      leaves the predecessor OPEN. This is the whole reason it is one method:
//      a closed predecessor with no successor is a calendar that silently stops
//      telling the firm's clients what they owe.
//   3. `obligation_template_window_chk` refuses a backwards window at DDL
//      level, so a script or a psql session cannot write one either.
//   4. The window reads back as a DAY, not as whatever the process's zone makes
//      of a UTC midnight — the mistake `day.ts` exists to name.
//
// And since 0303, three more, each about the calendar the old rule already
// produced past the cutover:
//
//   5. The LINEAGE is derived by the database, not supplied: a successor
//      inherits its predecessor's, and nobody can move it afterwards.
//   6. The HANDOVER moves only what the guard allows — past the cutover, and
//      nobody has started it — even when handed an id it must refuse.
//   7. THE WALL: a period an earlier rule in the chain still holds cannot be
//      generated again under a later one, by the sweep's own insert or by hand.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationTemplateRepository } from "../../src/infrastructure/postgres/obligation-rule-repository";
import { PostgresObligationInstanceRepository } from "../../src/infrastructure/postgres/obligation-instance-repository";
import type { NewObligationTemplate } from "../../src/usecase/obligation/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const templates = new PostgresObligationTemplateRepository(app);
const instances = new PostgresObligationInstanceRepository(app);

const stamp = Date.now().toString(36);
const slug = `supersede-test-${stamp}`;

let tenantId: string;
let predecessorId: string;

const CUTOVER = "2026-09-01";

function successor(over: Partial<NewObligationTemplate> = {}): NewObligationTemplate {
  return {
    id: crypto.randomUUID(),
    tenantId,
    jurisdiction: "IN",
    entityType: null,
    serviceEntryId: null,
    module: "GST",
    // The IDENTITY carries over — same filing, same country. Only the pack
    // moves, which is what makes it a different row at all.
    name: "GSTR-3B",
    authority: "GST",
    recurrence: "monthly",
    fiscalYearStartMonth: 4,
    dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null },
    unresolvedReason: null,
    leadTimeDays: 0,
    rulePack: "gst-in@2026.09",
    supersedesId: predecessorId,
    status: "confirmed",
    effectiveFrom: CUTOVER,
    effectiveTo: null,
    ...over,
  };
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, 'Harbour Point', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test firm");
  tenantId = t.id;

  const [r] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${tenantId}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, 'gst-in@2026.07')
    RETURNING id
  `;
  if (!r) throw new Error("could not create the predecessor");
  predecessorId = r.id;
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE slug = ${slug}`;
  await Promise.all([owner.end(), app.end()]);
});

async function windowOf(id: string): Promise<{ from: string | null; to: string | null }> {
  const [row] = await owner<{ f: string | null; t: string | null }[]>`
    SELECT effective_from::text AS f, effective_to::text AS t
    FROM delivery.obligation_template WHERE id = ${id}
  `;
  return { from: row?.f ?? null, to: row?.t ?? null };
}

describe("the window the database itself enforces", () => {
  it("refuses a window that ends before it starts", async () => {
    // A rule governing nothing is not a state anybody means to be in, and on a
    // screen it is indistinguishable from one governing everything.
    await expect(
      owner`
        UPDATE delivery.obligation_template
        SET effective_from = '2026-09-01'::date, effective_to = '2026-08-01'::date
        WHERE id = ${predecessorId}
      `,
    ).rejects.toThrow(/obligation_template_window_chk/);
  });

  it("refuses a window that ends on the day it starts", async () => {
    // Half-open, so `to` is the first day NOT in force — equal bounds are the
    // empty window rather than a one-day one.
    await expect(
      owner`
        UPDATE delivery.obligation_template
        SET effective_from = '2026-09-01'::date, effective_to = '2026-09-01'::date
        WHERE id = ${predecessorId}
      `,
    ).rejects.toThrow(/obligation_template_window_chk/);
  });
});

describe("the handover", () => {
  it("ROLLS BACK AS ONE when the successor cannot be written", async () => {
    // Deliberately FIRST, while the predecessor is still open, because this is
    // the property the whole method exists for. A successor reusing the
    // predecessor's rule pack collides on
    // `(tenant, jurisdiction, name, rule_pack)`.
    const before = await windowOf(predecessorId);
    expect(before.to).toBeNull();

    await expect(
      templates.supersede(tenantId, predecessorId, successor({ rulePack: "gst-in@2026.07" }), []),
    ).rejects.toThrow();

    // THE POINT: the predecessor is still open. A closed one with no successor
    // is a calendar that stops telling the firm's clients what they owe, and
    // nothing would have reported it.
    expect(await windowOf(predecessorId)).toEqual({ from: null, to: null });
  });

  it("closes the predecessor and opens the successor on the same day", async () => {
    const { rule: written } = await templates.supersede(tenantId, predecessorId, successor(), []);

    expect(await windowOf(predecessorId)).toEqual({ from: null, to: CUTOVER });
    expect(written.effectiveFrom).toBe(CUTOVER);
    expect(written.effectiveTo).toBeNull();
    expect(written.supersedesId).toBe(predecessorId);

    // Read back as DAYS through the repository's own mapper — `::text`, so no
    // `Date` is constructed and no zone is involved at any point.
    const read = await templates.findById(tenantId, written.id);
    expect(read?.effectiveFrom).toBe(CUTOVER);
    expect(read?.effectiveTo).toBeNull();
    const closed = await templates.findById(tenantId, predecessorId);
    expect(closed?.effectiveTo).toBe(CUTOVER);
    // NOT retired. It still governs every period before the cutover.
    expect(closed?.isActive).toBe(true);
  });

  it("keeps the successor reachable from the row it replaced", async () => {
    // The chain is what lets a filing made under the old rule still explain its
    // own date after the law changed.
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.obligation_template
      WHERE tenant_id = ${tenantId} AND supersedes_id = ${predecessorId}
    `;
    expect(Number(row?.n)).toBe(1);
  });
});

// ── 0303: the calendar the old rule already produced ───────────────────────

describe("the handover, and the wall behind it (0303)", () => {
  // A second, untouched chain, so this section does not depend on the order
  // the handover tests above ran in.
  let entity: string;
  let state: string;
  let oldRule: string;
  let newRule: string;
  const row = new Map<string, string>();

  const MONTHS = [
    { start: "2026-08-01", end: "2026-08-31", label: "Aug 2026", due: "2026-09-20" },
    { start: "2026-09-01", end: "2026-09-30", label: "Sep 2026", due: "2026-10-20" },
    { start: "2026-10-01", end: "2026-10-31", label: "Oct 2026", due: "2026-11-20" },
    { start: "2026-11-01", end: "2026-11-30", label: "Nov 2026", due: "2026-12-20" },
  ] as const;

  async function lineageOfRule(id: string): Promise<string | null> {
    const [r] = await owner<{ l: string | null }[]>`
      SELECT lineage_id AS l FROM delivery.obligation_template WHERE id = ${id}
    `;
    return r?.l ?? null;
  }

  async function onCalendar(label: string) {
    return owner<{ id: string; template_id: string; lineage_id: string; due: string }[]>`
      SELECT id, template_id, lineage_id, statutory_due_on::text AS due
      FROM delivery.obligation_instance
      WHERE tenant_id = ${tenantId} AND entity_party_id = ${entity} AND period_label = ${label}
    `;
  }

  beforeAll(async () => {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', 'Kaveri Foods Pvt Ltd') RETURNING id
    `;
    const [s] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
      VALUES (${tenantId}, 'pending', 'Pending', true) RETURNING id
    `;
    const [r] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_template
        (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
         due_rule, due_month_offset, due_day_of_month, rule_pack)
      VALUES (${tenantId}, 'IN', 'GSTR-1', 'monthly', 4, 'day_of_month', 1, 20, 'gst-in@2026.07')
      RETURNING id
    `;
    if (!e || !s || !r) throw new Error("could not seed the handover chain");
    entity = e.id;
    state = s.id;
    oldRule = r.id;

    // By hand, as a sweep would have left them: four months under the old rule.
    for (const m of MONTHS) {
      const [i] = await owner<{ id: string }[]>`
        INSERT INTO delivery.obligation_instance
          (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
           statutory_due_on, internal_target_on, state_id)
        VALUES (${tenantId}, ${oldRule}, ${entity}, ${m.start}::date, ${m.end}::date, ${m.label},
                ${m.due}::date, ${m.due}::date, ${state})
        RETURNING id
      `;
      if (!i) throw new Error(`could not seed ${m.label}`);
      row.set(m.label, i.id);
    }
    // October has already been FILED — the row the handover must refuse.
    await owner`
      UPDATE delivery.obligation_instance SET filed_on = '2026-11-18'::date
      WHERE id = ${row.get("Oct 2026") ?? ""}
    `;
  });

  it("gives a rule that replaces nothing its OWN lineage, derived rather than supplied", async () => {
    expect(await lineageOfRule(oldRule)).toBe(oldRule);
    // And the calendar rows inserted by hand, knowing nothing about it, carry it.
    const [aug] = await onCalendar("Aug 2026");
    expect(aug?.lineage_id).toBe(oldRule);
  });

  it("hands over exactly what the guard allows, in the same transaction", async () => {
    // Handed EVERY month, including two it must refuse: August is before the
    // cutover, October is filed. The SQL is the truth, not the list.
    const handover = MONTHS.map((m) => ({
      id: row.get(m.label) ?? "",
      statutoryDueOn: m.due.replace(/-20$/, "-11"),
      internalTargetOn: m.due.replace(/-20$/, "-11"),
    }));
    const result = await templates.supersede(
      tenantId,
      oldRule,
      successor({ name: "GSTR-1", rulePack: "gst-in@2026.09", supersedesId: oldRule }),
      handover,
    );
    newRule = result.rule.id;

    expect([...result.handedOver].sort()).toEqual(
      [row.get("Sep 2026"), row.get("Nov 2026")].sort(),
    );
    // October stayed, filed, on the rule it was filed under.
    expect(result.kept).toBe(1);

    const [aug] = await onCalendar("Aug 2026");
    const [sep] = await onCalendar("Sep 2026");
    const [oct] = await onCalendar("Oct 2026");
    expect(aug?.template_id).toBe(oldRule);
    expect(aug?.due).toBe("2026-09-20");
    expect(sep?.template_id).toBe(newRule);
    expect(sep?.due).toBe("2026-10-11");
    expect(sep?.id).toBe(row.get("Sep 2026"));
    expect(oct?.template_id).toBe(oldRule);
    expect(oct?.due).toBe("2026-11-20");
  });

  it("gives the successor its predecessor's lineage, and the moved rows keep it", async () => {
    expect(await lineageOfRule(newRule)).toBe(oldRule);
    const [sep] = await onCalendar("Sep 2026");
    expect(sep?.lineage_id).toBe(oldRule);
  });

  it("REFUSES a second October under the successor through the sweep's own insert", async () => {
    // The row that could not be handed over. Before 0303 the re-run key was
    // per TEMPLATE, so this proposal was new and the calendar showed October
    // twice.
    const made = await instances.createIfAbsent([
      {
        id: crypto.randomUUID(),
        tenantId,
        templateId: newRule,
        entityPartyId: entity,
        engagementId: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        periodLabel: "Oct 2026",
        statutoryDueOn: "2026-11-11",
        internalTargetOn: "2026-11-11",
        stateId: state,
      },
      {
        // A period nobody holds yet is still generated in the same batch.
        id: crypto.randomUUID(),
        tenantId,
        templateId: newRule,
        entityPartyId: entity,
        engagementId: null,
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
        periodLabel: "Dec 2026",
        statutoryDueOn: "2027-01-11",
        internalTargetOn: "2027-01-11",
        stateId: state,
      },
    ]);
    expect(made.map((m) => m.periodLabel)).toEqual(["Dec 2026"]);
    expect(await onCalendar("Oct 2026")).toHaveLength(1);
  });

  it("REFUSES it by hand too — the key is the wall, not the generator's care", async () => {
    await expect(
      owner`
        INSERT INTO delivery.obligation_instance
          (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
           statutory_due_on, internal_target_on, state_id)
        VALUES (${tenantId}, ${newRule}, ${entity}, '2026-10-01'::date, '2026-10-31'::date,
                'Oct 2026', '2026-11-11'::date, '2026-11-11'::date, ${state})
      `,
    ).rejects.toThrow(/obligation_instance_lineage_key/);
  });

  it("REFUSES moving a rule into another chain once it is written", async () => {
    await expect(
      owner`UPDATE delivery.obligation_template SET supersedes_id = NULL WHERE id = ${newRule}`,
    ).rejects.toThrow(/which rule it replaces is fixed/);
    expect(await lineageOfRule(newRule)).toBe(oldRule);
  });
});
