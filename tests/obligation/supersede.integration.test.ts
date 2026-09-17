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
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationTemplateRepository } from "../../src/infrastructure/postgres/obligation-rule-repository";
import type { NewObligationTemplate } from "../../src/usecase/obligation/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const templates = new PostgresObligationTemplateRepository(app);

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
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
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
      templates.supersede(tenantId, predecessorId, successor({ rulePack: "gst-in@2026.07" })),
    ).rejects.toThrow();

    // THE POINT: the predecessor is still open. A closed one with no successor
    // is a calendar that stops telling the firm's clients what they owe, and
    // nothing would have reported it.
    expect(await windowOf(predecessorId)).toEqual({ from: null, to: null });
  });

  it("closes the predecessor and opens the successor on the same day", async () => {
    const written = await templates.supersede(tenantId, predecessorId, successor());

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
