// In-memory fakes for the findings store's ports. `implements` keeps them in
// step with the Postgres adapters.
//
// They reproduce what the service's rules depend on: the dedupe key's
// conflict, a status read off the latest decision, the newest-first page with
// its cursor, the counts, and who is active staff. The CHECKs, RLS, the GLOBAL
// table's grants and the membership key are database properties, proven in
// `tests/fin/findings.integration.test.ts`.
import { FINDING_STATUSES } from "../domain/fin/finding";
import type { FindingLane, FindingStatus } from "../domain/fin/finding";
import type { RuleParameterRow } from "../domain/fin/parameters";
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
} from "../usecase/fin/finding-ports";

interface StoredDecision extends NewDecision {
  readonly at: number;
}

export class FakeFindingStore implements FindingStore {
  readonly findings: NewFinding[] = [];
  readonly decisions: StoredDecision[] = [];
  /** `${tenantId}|${userId}` of active staff. */
  readonly staff = new Set<string>();
  readonly names = new Map<string, string>();
  readonly clientNames = new Map<string, string>();
  private clock = 0;

  addStaff(tenantId: string, userId: string, name?: string): this {
    this.staff.add(`${tenantId}|${userId}`);
    if (name !== undefined) this.names.set(userId, name);
    return this;
  }

  insert(finding: NewFinding): Promise<boolean> {
    const exists = this.findings.some(
      (f) => f.tenantId === finding.tenantId && f.draft.dedupeKey === finding.draft.dedupeKey,
    );
    if (exists) return Promise.resolve(false);
    this.findings.push(finding);
    return Promise.resolve(true);
  }

  private decisionsOf(tenantId: string, findingId: string): DecisionView[] {
    return this.decisions
      .filter((d) => d.tenantId === tenantId && d.findingId === findingId)
      .sort((a, b) => b.at - a.at)
      .map((d) => ({
        id: d.id,
        decision: d.decision,
        reasonCode: d.reasonCode,
        reasonText: d.reasonText,
        decidedByUserId: d.decidedByUserId,
        decidedByName: this.names.get(d.decidedByUserId) ?? null,
        decidedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, d.at)).toISOString(),
      }));
  }

  private view(f: NewFinding): FindingView {
    const latest = this.decisionsOf(f.tenantId, f.id)[0] ?? null;
    return {
      id: f.id,
      lane: f.draft.lane,
      checkKey: f.draft.checkKey,
      clientPartyId: f.draft.clientPartyId,
      clientName: this.clientNames.get(f.draft.clientPartyId) ?? "Client",
      periodStart: f.draft.periodStart,
      periodEnd: f.draft.periodEnd,
      lineIds: [...new Set(f.draft.lineIds)].sort(),
      facts: f.draft.facts,
      status: latest?.decision ?? "open",
      latestDecision: latest,
      createdAt: "2026-10-11T00:00:00.000Z",
    };
  }

  find(tenantId: string, findingId: string): Promise<FindingDetail | null> {
    const f = this.findings.find((x) => x.tenantId === tenantId && x.id === findingId);
    if (f === undefined) return Promise.resolve(null);
    return Promise.resolve({ ...this.view(f), decisions: this.decisionsOf(tenantId, findingId) });
  }

  /** Newest first is insertion order reversed, which is what `created_at`
   *  gives the adapter. */
  list(tenantId: string, filter: FindingFilter): Promise<readonly FindingView[]> {
    let rows = this.findings
      .filter((f) => f.tenantId === tenantId)
      .map((f) => this.view(f))
      .filter((v) => filter.clientPartyId === null || v.clientPartyId === filter.clientPartyId)
      .filter((v) => filter.lane === null || v.lane === filter.lane)
      .filter((v) => filter.checkKey === null || v.checkKey === filter.checkKey)
      .filter((v) => filter.status === null || v.status === filter.status)
      .reverse();
    if (filter.before !== null) {
      const at = rows.findIndex((v) => v.id === filter.before);
      rows = at === -1 ? [] : rows.slice(at + 1);
    }
    return Promise.resolve(rows.slice(0, filter.limit));
  }

  summary(
    tenantId: string,
    filter: { readonly clientPartyId: string | null; readonly lane: FindingLane | null },
  ): Promise<FindingSummary> {
    const zero = (): Record<FindingStatus, number> =>
      Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
    const views = this.findings
      .filter((f) => f.tenantId === tenantId)
      .map((f) => this.view(f))
      .filter((v) => filter.clientPartyId === null || v.clientPartyId === filter.clientPartyId)
      .filter((v) => filter.lane === null || v.lane === filter.lane);
    const byStatus = zero();
    const checks = new Map<string, { checkKey: string; lane: FindingLane; total: number; byStatus: Record<FindingStatus, number> }>();
    for (const v of views) {
      byStatus[v.status] += 1;
      const key = `${v.lane}|${v.checkKey}`;
      const entry = checks.get(key) ?? { checkKey: v.checkKey, lane: v.lane, total: 0, byStatus: zero() };
      entry.total += 1;
      entry.byStatus[v.status] += 1;
      checks.set(key, entry);
    }
    const byCheck = [...checks.values()].sort((a, b) => (a.checkKey < b.checkKey ? -1 : 1));
    return Promise.resolve({ total: views.length, byStatus, byCheck });
  }

  isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.staff.has(`${tenantId}|${userId}`));
  }

  insertDecision(decision: NewDecision): Promise<void> {
    this.clock += 1;
    this.decisions.push({ ...decision, at: this.clock });
    return Promise.resolve();
  }
}

export class FakeRuleParameters implements RuleParameterSource {
  constructor(readonly table: readonly RuleParameterRow[] = []) {}

  rows(jurisdiction: string): Promise<readonly RuleParameterRow[]> {
    return Promise.resolve(this.table.filter((r) => r.jurisdiction === jurisdiction));
  }
}

/** Singapore's values exactly as migration 0387 seeds them, for the unit tests
 *  and the backtest. `tests/fin/findings.integration.test.ts` holds this
 *  copy to the seeded rows, so the two cannot drift. */
export const SINGAPORE_PARAMETERS: readonly RuleParameterRow[] = [
  sg("gst.standard_rate", "2007-07-01", "2023-01-01", { percent: "7" }),
  sg("gst.standard_rate", "2023-01-01", "2024-01-01", { percent: "8" }),
  sg("gst.standard_rate", "2024-01-01", null, { percent: "9" }),
  sg("cpf.ow_ceiling", "2024-01-01", "2025-01-01", { amount: "6800.00", per: "month" }),
  sg("cpf.ow_ceiling", "2025-01-01", "2026-01-01", { amount: "7400.00", per: "month" }),
  sg("cpf.ow_ceiling", "2026-01-01", null, { amount: "8000.00", per: "month" }),
  sg("cpf.annual_salary_ceiling", "2016-01-01", null, { amount: "102000.00", per: "year" }),
  sg("cpf.rates", "2025-01-01", "2026-01-01", {
    aboveMonthlyWage: "750",
    bands: [
      { aboveAge: 0, employer: "17", employee: "20" },
      { aboveAge: 55, employer: "15.5", employee: "17" },
      { aboveAge: 60, employer: "12", employee: "11.5" },
      { aboveAge: 65, employer: "9", employee: "7.5" },
      { aboveAge: 70, employer: "7.5", employee: "5" },
    ],
  }),
  sg("cpf.rates", "2026-01-01", "2027-01-01", {
    aboveMonthlyWage: "750",
    bands: [
      { aboveAge: 0, employer: "17", employee: "20" },
      { aboveAge: 55, employer: "16", employee: "18" },
      { aboveAge: 60, employer: "12.5", employee: "12.5" },
      { aboveAge: 65, employer: "9", employee: "7.5" },
      { aboveAge: 70, employer: "7.5", employee: "5" },
    ],
  }),
  sg("cpf.contributing_passes", "2016-01-01", null, { passTypes: ["citizen", "pr"] }),
  sg("sdl.levy", "2008-10-01", null, { percent: "0.25", minimum: "2.00", maximum: "11.25" }),
];

function sg(key: string, validFrom: string, validTo: string | null, value: Record<string, unknown>): RuleParameterRow {
  return { jurisdiction: "SG", key, validFrom, validTo, value, source: "0387" };
}
