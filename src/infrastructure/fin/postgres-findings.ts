// FinCompliance findings and the dated values, in Postgres (0387).
//
// Every finding read and write goes through `withTenant`, so RLS is the wall;
// the queries name `tenant_id` in their JOINs only to use the composite keys'
// indexes. `fin.rule_parameter` is GLOBAL (the law is the same for every firm)
// and is read on the app pool directly, as `PostgresFinFirms` reads the
// tenant list.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { FINDING_STATUSES } from "../../domain/fin/finding";
import type {
  DismissReason,
  FindingDecision,
  FindingFact,
  FindingLane,
  FindingStatus,
} from "../../domain/fin/finding";
import type { RuleParameterRow } from "../../domain/fin/parameters";
import type {
  DecisionView,
  FindingDetail,
  FindingFilter,
  FindingStore,
  FindingSummary,
  FindingView,
  NewDecision,
  NewFinding,
  RuleParameterSource,
} from "../../usecase/fin/finding-ports";
import { isoInstant } from "../postgres/instant";

/** Fin's screens read through the API's pool, so a slow fin read is capped
 *  well below the pool's own limit (the intake list's arrangement). */
const FIN_READ_TIMEOUT_MS = 5_000;

interface FindingRow {
  id: string;
  lane: FindingLane;
  check_key: string;
  client_party_id: string;
  client_name: string;
  period_start: string;
  period_end: string;
  facts: Record<string, FindingFact>;
  line_ids: string[];
  decision_id: string | null;
  decision: FindingDecision | null;
  reason_code: DismissReason | null;
  reason_text: string | null;
  decided_by_user_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
}

interface DecisionRow {
  id: string;
  decision: FindingDecision;
  reason_code: DismissReason | null;
  reason_text: string | null;
  decided_by_user_id: string;
  decided_by_name: string | null;
  decided_at: string;
}

function toDecision(r: DecisionRow): DecisionView {
  return {
    id: r.id,
    decision: r.decision,
    reasonCode: r.reason_code,
    reasonText: r.reason_text,
    decidedByUserId: r.decided_by_user_id,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
  };
}

function toView(r: FindingRow): FindingView {
  const latest =
    r.decision_id === null || r.decision === null || r.decided_by_user_id === null || r.decided_at === null
      ? null
      : toDecision({
          id: r.decision_id,
          decision: r.decision,
          reason_code: r.reason_code,
          reason_text: r.reason_text,
          decided_by_user_id: r.decided_by_user_id,
          decided_by_name: r.decided_by_name,
          decided_at: r.decided_at,
        });
  return {
    id: r.id,
    lane: r.lane,
    checkKey: r.check_key,
    clientPartyId: r.client_party_id,
    clientName: r.client_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    lineIds: r.line_ids,
    facts: r.facts,
    status: latest?.decision ?? "open",
    latestDecision: latest,
    createdAt: r.created_at,
  };
}

function zeroCounts(): Record<FindingStatus, number> {
  return Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
}

export class PostgresFindingStore implements FindingStore {
  constructor(private readonly app: Db) {}

  async insert(finding: NewFinding): Promise<boolean> {
    const d = finding.draft;
    return withTenant(this.app, finding.tenantId, async (db) => {
      // `::text::jsonb`: postgres.js encodes a string parameter as JSON again,
      // and a bare `::jsonb` would store a jsonb STRING (T3.2's lesson).
      const rows = await db<{ id: string }[]>`
        INSERT INTO fin.finding
          (id, tenant_id, lane, check_key, client_party_id, period_start, period_end, facts, dedupe_key)
        VALUES
          (${finding.id}, ${finding.tenantId}, ${d.lane}, ${d.checkKey}, ${d.clientPartyId},
           ${d.periodStart}::date, ${d.periodEnd}::date, ${JSON.stringify(d.facts)}::text::jsonb, ${d.dedupeKey})
        ON CONFLICT ON CONSTRAINT finding_once DO NOTHING
        RETURNING id
      `;
      if (rows.length !== 1) return false;
      const lineIds = [...new Set(d.lineIds)];
      if (lineIds.length > 0) {
        await db`
          INSERT INTO fin.finding_line (tenant_id, finding_id, line_id)
          SELECT ${finding.tenantId}, ${finding.id}, l
            FROM unnest(${db.array(lineIds)}::uuid[]) AS l
        `;
      }
      return true;
    });
  }

  /** The SELECT every finding read shares: the client's name, the lines, and
   *  the LATEST decision with the decider's name read through this firm's
   *  membership, never straight off the global account table. */
  private select(db: Db) {
    return db`
      SELECT f.id,
             f.lane,
             f.check_key,
             f.client_party_id,
             p.display_name AS client_name,
             f.period_start::text AS period_start,
             f.period_end::text AS period_end,
             f.facts,
             coalesce((SELECT array_agg(l.line_id ORDER BY l.line_id)
                         FROM fin.finding_line l
                        WHERE l.tenant_id = f.tenant_id AND l.finding_id = f.id), '{}') AS line_ids,
             d.id AS decision_id,
             d.decision,
             d.reason_code,
             d.reason_text,
             d.decided_by_user_id,
             d.decided_by_name,
             ${db.unsafe(isoInstant("d.decided_at", "decided_at"))},
             ${db.unsafe(isoInstant("f.created_at", "created_at"))}
        FROM fin.finding f
        JOIN core.party p ON p.id = f.client_party_id AND p.tenant_id = f.tenant_id
        LEFT JOIN LATERAL (
              SELECT x.id, x.decision, x.reason_code, x.reason_text, x.decided_by_user_id, x.decided_at,
                     u.display_name AS decided_by_name
                FROM fin.finding_decision x
                LEFT JOIN tenancy.membership m
                       ON m.tenant_id = x.tenant_id AND m.user_id = x.decided_by_user_id AND m.audience = 'STAFF'
                LEFT JOIN tenancy.user_account u ON u.id = m.user_id
               WHERE x.tenant_id = f.tenant_id AND x.finding_id = f.id
               ORDER BY x.decided_at DESC, x.id DESC
               LIMIT 1
             ) d ON true
    `;
  }

  async find(tenantId: string, findingId: string): Promise<FindingDetail | null> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const [row] = await db<FindingRow[]>`${this.select(db)} WHERE f.id = ${findingId}`;
      if (row === undefined) return null;
      const decisions = await db<DecisionRow[]>`
        SELECT x.id, x.decision, x.reason_code, x.reason_text, x.decided_by_user_id,
               u.display_name AS decided_by_name,
               ${db.unsafe(isoInstant("x.decided_at", "decided_at"))}
          FROM fin.finding_decision x
          LEFT JOIN tenancy.membership m
                 ON m.tenant_id = x.tenant_id AND m.user_id = x.decided_by_user_id AND m.audience = 'STAFF'
          LEFT JOIN tenancy.user_account u ON u.id = m.user_id
         WHERE x.finding_id = ${findingId}
         ORDER BY x.decided_at DESC, x.id DESC
      `;
      return { ...toView(row), decisions: decisions.map(toDecision) };
    });
  }

  async list(tenantId: string, filter: FindingFilter): Promise<readonly FindingView[]> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const rows = await db<FindingRow[]>`
        ${this.select(db)}
         WHERE (${filter.clientPartyId}::uuid IS NULL OR f.client_party_id = ${filter.clientPartyId}::uuid)
           AND (${filter.lane}::text IS NULL OR f.lane = ${filter.lane}::text)
           AND (${filter.checkKey}::text IS NULL OR f.check_key = ${filter.checkKey}::text)
           AND (${filter.status}::text IS NULL OR coalesce(d.decision, 'open') = ${filter.status}::text)
           -- The cursor is the previous page's last row at its own precision.
           -- An id this firm does not hold matches nothing: an empty page,
           -- never another firm's.
           AND (${filter.before}::uuid IS NULL OR (f.created_at, f.id) < (
                 SELECT c.created_at, c.id FROM fin.finding c WHERE c.id = ${filter.before}::uuid))
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ${filter.limit}
      `;
      return rows.map(toView);
    });
  }

  async summary(
    tenantId: string,
    filter: { readonly clientPartyId: string | null; readonly lane: FindingLane | null },
  ): Promise<FindingSummary> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const rows = await db<{ check_key: string; lane: FindingLane; status: FindingStatus; n: number }[]>`
        SELECT f.check_key, f.lane, coalesce(d.decision, 'open') AS status, count(*)::int AS n
          FROM fin.finding f
          LEFT JOIN LATERAL (
                SELECT x.decision FROM fin.finding_decision x
                 WHERE x.tenant_id = f.tenant_id AND x.finding_id = f.id
                 ORDER BY x.decided_at DESC, x.id DESC
                 LIMIT 1
               ) d ON true
         WHERE (${filter.clientPartyId}::uuid IS NULL OR f.client_party_id = ${filter.clientPartyId}::uuid)
           AND (${filter.lane}::text IS NULL OR f.lane = ${filter.lane}::text)
         GROUP BY f.check_key, f.lane, coalesce(d.decision, 'open')
         ORDER BY f.check_key, f.lane
      `;
      const byStatus = zeroCounts();
      const checks = new Map<string, { checkKey: string; lane: FindingLane; total: number; byStatus: Record<FindingStatus, number> }>();
      for (const r of rows) {
        byStatus[r.status] += r.n;
        const key = `${r.lane}|${r.check_key}`;
        const entry = checks.get(key) ?? { checkKey: r.check_key, lane: r.lane, total: 0, byStatus: zeroCounts() };
        entry.total += r.n;
        entry.byStatus[r.status] += r.n;
        checks.set(key, entry);
      }
      const total = rows.reduce((n, r) => n + r.n, 0);
      return {
        total,
        byStatus,
        byCheck: [...checks.values()],
      };
    });
  }

  async isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ ok: number }[]>`
        SELECT 1 AS ok
          FROM tenancy.membership m
          JOIN tenancy.user_account u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId}
           AND m.user_id = ${userId}
           AND m.audience = 'STAFF'
           AND m.is_active
           AND u.status = 'active'
      `;
      return rows.length > 0;
    });
  }

  async insertDecision(decision: NewDecision): Promise<void> {
    await withTenant(this.app, decision.tenantId, async (db) => {
      await db`
        INSERT INTO fin.finding_decision
          (id, tenant_id, finding_id, decision, reason_code, reason_text, decided_by_user_id)
        VALUES
          (${decision.id}, ${decision.tenantId}, ${decision.findingId}, ${decision.decision},
           ${decision.reasonCode}, ${decision.reasonText}, ${decision.decidedByUserId})
      `;
    });
  }
}

/** `fin.rule_parameter`, GLOBAL: one read per jurisdiction, no tenant. */
export class PostgresRuleParameters implements RuleParameterSource {
  constructor(private readonly app: Db) {}

  async rows(jurisdiction: string): Promise<readonly RuleParameterRow[]> {
    const rows = await this.app<
      { jurisdiction: string; key: string; valid_from: string; valid_to: string | null; value: unknown; source: string }[]
    >`
      SELECT jurisdiction, key, valid_from::text AS valid_from, valid_to::text AS valid_to, value, source
        FROM fin.rule_parameter
       WHERE jurisdiction = ${jurisdiction}
       ORDER BY key, valid_from
    `;
    return rows.map((r) => ({
      jurisdiction: r.jurisdiction,
      key: r.key,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      value: r.value,
      source: r.source,
    }));
  }
}
