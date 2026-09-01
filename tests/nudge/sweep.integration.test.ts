// THE PROACTIVE NUDGE against real Postgres (T6.7, migration 0067).
//
// `tests/nudge/service.test.ts` proves the arithmetic over fakes. What only a
// real database can say is here, and it is the half that has cost this codebase
// the most:
//
//   · THE DAY ARITHMETIC. `o.statutory_due_on - ${asOf}::date` — postgres.js
//     sends every parameter UNTYPED, so the cast is load-bearing and its absence
//     is a 500 on the first real request rather than a red test. That is exactly
//     what T6.5 shipped and T3.2 shipped before it. A fake cannot catch it.
//   · AT-LEAST-ONCE, taken by `obligation_nudge_once` rather than by a Set.
//   · APPEND-ONLY BY GRANT.
//   · GATE 4, on `entity_party_id` — which is NOT the client, and that is the
//     part somebody meets as a surprise.
//
// ── HOW THIS FILE WAS CHECKED ────────────────────────────────────────────
//
//   BEGIN; DROP POLICY obligation_nudge_portal_scope ON delivery.obligation_nudge;
//   -- run this file: the two gate-4 tests fail
//   ROLLBACK;
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";
import { NudgeService } from "../../src/usecase/nudge/service";
import {
  PostgresNudgeCandidates,
  PostgresNudgeRepository,
  PostgresNudgeTenants,
} from "../../src/infrastructure/postgres/nudge-repository";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import type { NudgeRung } from "../../src/domain/nudge/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
let mine = "";
let theirs = "";
let templateId = "";
let stateId = "";
let dueSoon = "";
let dueLater = "";
let alreadyFiled = "";
let theirFiling = "";

const LADDER: readonly NudgeRung[] = [
  { key: "week", beforeDays: 7, label: "A week to go" },
  { key: "three_days", beforeDays: 3, label: "Three days to go" },
  { key: "eve", beforeDays: 1, label: "Due tomorrow" },
];

/** The ladder is published in-memory rather than through the config registry:
 *  what this file is testing is the SQL, and `PostgresNudgeLadder` is a plain
 *  config read already covered by the registry's own tests. */
const ladders = { ladderFor: () => Promise.resolve(LADDER) };

function service(events = new RecordingEventSink()) {
  return {
    events,
    svc: new NudgeService({
      tenants: new PostgresNudgeTenants(app),
      ladders,
      candidates: new PostgresNudgeCandidates(app),
      nudges: new PostgresNudgeRepository(app),
      clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
      events,
    }),
  };
}

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`nudge-${stamp}`}, 'Nudge Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const party = async (name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${name}`);
    return row.id;
  };
  mine = await party(`Mine ${stamp}`);
  theirs = await party(`Theirs ${stamp}`);

  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, sort_order)
    VALUES (${tenantId}, 'pending', 'Pending', 10) RETURNING id
  `;
  if (!state) throw new Error("could not seed the obligation state");
  stateId = state.id;

  const [template] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, due_rule, due_month_offset,
       due_day_of_month, lead_time_days, rule_pack, status, is_active)
    VALUES (${tenantId}, 'IN', 'GSTR-3B', 'monthly', 'day_of_month', 1, 20, 5,
            ${`test-${stamp}`}, 'confirmed', true)
    RETURNING id
  `;
  if (!template) throw new Error("could not seed the obligation template");
  templateId = template.id;

  const filing = async (
    entity: string,
    periodStart: string,
    dueOn: string,
    filedOn: string | null,
  ): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
         statutory_due_on, internal_target_on, state_id, filed_on)
      VALUES (${tenantId}, ${templateId}, ${entity}, ${periodStart}::date,
              (${periodStart}::date + 27), ${`P ${periodStart}`},
              ${dueOn}::date, (${dueOn}::date - 5), ${stateId}, ${filedOn}::date)
      RETURNING id
    `;
    if (!row) throw new Error(`could not create the filing due ${dueOn}`);
    return row.id;
  };

  // Sweeps below run "as of" 2026-09-01.
  dueSoon = await filing(mine, "2026-08-01", "2026-09-04", null); // 3 days out
  dueLater = await filing(mine, "2026-09-01", "2026-10-20", null); // 49 days out
  alreadyFiled = await filing(mine, "2026-07-01", "2026-09-03", "2026-08-30");
  theirFiling = await filing(theirs, "2026-08-01", "2026-09-04", null);
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_nudge WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("the sweep, over real rows", () => {
  it("counts the days DOWN in the database, on the caller's own day", async () => {
    // THE THING NO FAKE CAN CHECK. `statutory_due_on - ${asOf}::date` with the
    // cast missing dies at runtime with "operator is not unique: date - unknown"
    // — it typechecks, it lints, the unit tests pass, and it surfaces as a 500
    // on the first real request. T6.5 shipped exactly that.
    const rows = await new PostgresNudgeCandidates(app).upcomingFilings(
      tenantId,
      "2026-09-01",
      7,
    );
    // TWO rows, one per company: this read is `withTenant`, because a sweep is
    // the firm's own machinery and not a portal read. Gate 4 is asserted further
    // down, on the table the sweep WRITES.
    const mineRow = rows.find((r) => r.obligationId === dueSoon);
    expect(mineRow?.daysUntil).toBe(3);
    expect(mineRow?.dueOn).toBe("2026-09-04");
    expect(rows.every((r) => r.daysUntil === 3)).toBe(true);
  });

  it("never offers a filing already discharged, whatever state it is in", async () => {
    // KEYED ON `filed_on`, not on the state being terminal — 0052 seeds two
    // terminal states and T3.3's `resolved` is the end of a deadline already
    // MISSED. Telling a client that a return they never filed is "coming up"
    // would be 0054's false statement from the other side.
    const rows = await new PostgresNudgeCandidates(app).upcomingFilings(
      tenantId,
      "2026-09-01",
      365,
    );
    expect(rows.map((r) => r.obligationId)).not.toContain(alreadyFiled);
  });

  it("never offers a filing already PAST its date — that is a missed deadline", async () => {
    // `days_until >= 0` is the CHECK in 0067 and `statutory_due_on >= asOf` is
    // the query saying the same thing, which is the database agreeing rather
    // than a second rule. "Due in -5 days" is not a sentence.
    const rows = await new PostgresNudgeCandidates(app).upcomingFilings(
      tenantId,
      "2026-09-10",
      365,
    );
    expect(rows.map((r) => r.obligationId)).not.toContain(dueSoon);
  });

  it("takes its window from the ladder, so a far-off filing is not offered", async () => {
    const near = await new PostgresNudgeCandidates(app).upcomingFilings(tenantId, "2026-09-01", 7);
    expect(near.map((r) => r.obligationId)).not.toContain(dueLater);
    const far = await new PostgresNudgeCandidates(app).upcomingFilings(tenantId, "2026-09-01", 60);
    expect(far.map((r) => r.obligationId)).toContain(dueLater);
  });

  it("writes the rungs that are due, and snapshots what fired", async () => {
    const { svc, events } = service();
    const report = await svc.sweepTenant(tenantId, "2026-09-01");
    // Three days out with a 7/3/1 ladder: the week rung and the three-day rung
    // are both due, and BOTH go — a firm whose worker was down must not lose a
    // rung silently.
    expect(report.sent).toBe(4);

    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ rung_key: string; before_days: number; days_until: number; due_on: string }[]>`
        SELECT rung_key, before_days, days_until, due_on::text AS due_on
          FROM delivery.obligation_nudge
         WHERE obligation_id = ${dueSoon} ORDER BY before_days DESC
      `;
    });
    expect(rows.map((r) => r.rung_key)).toEqual(["week", "three_days"]);
    expect(rows[0]?.before_days).toBe(7);
    expect(rows[0]?.days_until).toBe(3);
    // THE DATE THE NUDGE NAMED, taken from the obligation inside the INSERT and
    // never from the caller. A date quoted to a client is a statement the firm
    // made.
    expect(rows[0]?.due_on).toBe("2026-09-04");
    expect(events.recorded.filter((e) => e.verb === "obligation.nudged")).toHaveLength(4);
  });

  it("a second sweep writes nothing and emits nothing", async () => {
    // `alreadySent` is 0 and NOT 4, which is worth stating because the first
    // draft of this test expected 4. A rung already recorded is dropped by
    // `dueRungs` before the insert is even attempted, so it never becomes
    // "wanted" — `alreadySent` counts only the gap between wanted and created,
    // which is a genuine RACE (two workers, or a redelivery overlapping the run
    // it duplicates). Normally zero, and a non-zero value is idempotency working
    // rather than a fault. The index is what holds under that race, and the next
    // test is the index.
    const { svc, events } = service();
    const report = await svc.sweepTenant(tenantId, "2026-09-01");
    expect(report.sent).toBe(0);
    expect(report.alreadySent).toBe(0);
    expect(events.recorded.filter((e) => e.verb === "obligation.nudged")).toHaveLength(0);
  });

  it("AT-LEAST-ONCE is taken by the INDEX, not by the service noticing", async () => {
    // The half a fake cannot have. pg-boss redelivers and two workers overlap;
    // what makes a redelivery unwritable is `obligation_nudge_once`, and it has
    // to refuse even a caller that skipped every check above it.
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`
          INSERT INTO delivery.obligation_nudge
            (tenant_id, obligation_id, entity_party_id, rung_key, before_days, days_until, due_on)
          VALUES (${tenantId}, ${dueSoon}, ${mine}, 'week', 7, 3, '2026-09-04')
        `;
      }),
    ).rejects.toThrow(/obligation_nudge_once|duplicate key/i);
  });

  it("the wall column cannot disagree with the obligation's", async () => {
    // The composite foreign key in 0067, and it is what makes "each table names
    // its own column" a guarantee rather than a convention. A row claiming this
    // filing belongs to the OTHER company is unwritable, not merely wrong.
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`
          INSERT INTO delivery.obligation_nudge
            (tenant_id, obligation_id, entity_party_id, rung_key, before_days, days_until, due_on)
          VALUES (${tenantId}, ${dueSoon}, ${theirs}, 'forged', 7, 3, '2026-09-04')
        `;
      }),
    ).rejects.toThrow(/foreign key|obligation_nudge_obligation_fkey/i);
  });

  it("APPEND-ONLY BY GRANT: a nudge cannot be edited", async () => {
    // `client_ask_chase`, `client_ask_response`, `document_version` and the
    // ledger all have this arrangement. A trigger is a rule the table carries; a
    // missing grant is a permission the role does not hold, and an import walks
    // past the first and not the second.
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`UPDATE delivery.obligation_nudge SET rung_key = 'tampered'
                   WHERE tenant_id = ${tenantId}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("gate 4, on the column this table carries", () => {
  it("a STAFF session is untouched: every nudge is readable", async () => {
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_nudge WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("AND IT TRIES: another company's nudges, asked for BY filing id, come back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_nudge WHERE obligation_id = ${theirFiling}
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("scopes on entity_party_id, which is NOT the client — and that is the surprise", async () => {
    // 0053's rule: "the ENTITY, never the client". A grant naming Cobalt Foods
    // reaches Cobalt Foods' filings and not its subsidiary's, even though the
    // subsidiary's TASK is on the same page. Reaching them would mean joining
    // `crm.engagement` — a nullable join, and the derivation 0059 refused. A
    // contact who should see both gets two grants.
    const mineRows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ obligation_id: string }[]>`
        SELECT obligation_id FROM delivery.obligation_nudge WHERE tenant_id = ${tenantId}
      `;
    });
    // Only `dueSoon`: `dueLater` is 49 days out and no rung on a 7/3/1 ladder
    // has reached it, and `theirFiling` is another company's — same due date,
    // same rungs fired, invisible here.
    expect(new Set(mineRows.map((r) => r.obligation_id))).toEqual(new Set([dueSoon]));
  });

  it("a portal session with NO grants sees no nudges at all", async () => {
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_nudge WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows).toHaveLength(0);
  });
});
