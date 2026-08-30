// Postgres adapter for what a machine produced and what it was allowed to do
// with it (T2.8).
//
// ── ALMOST NOTHING IS ENFORCED HERE, AND THAT IS THE POINT ──────────────────
//
// The guardrail — "unattended action requires the machine to have been strictly
// above the bar that was in force" — is a CHECK on the insert, not a branch in
// this file. `build2.md` puts the reason in the firm's own terms: *a rule that
// lives in a form is a rule that a script, an import or an AI agent walks
// straight past.* Here the rule is ABOUT agents, so an agent walking past it is
// not hypothetical; it is the failure this exists to prevent.
//
// So this adapter's job is to hand the database an honest row and let it refuse.
// If the decision and the numbers ever disagree, the insert raises rather than
// storing a lie about what was permitted.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { AgentDecision, ProposalOutcome } from "../../domain/agent/model";
import type {
  AgentRun,
  AgentRunRepository,
  NewAgentRun,
  RunDecision,
} from "../../usecase/orchestrator/ports";

interface RunRow {
  id: string;
  tenant_id: string;
  job_id: string;
  job_step_id: string;
  confidence: string;
  auto_commit_at: string;
  review_at: string;
  tier_version_id: string | null;
  decision: AgentDecision;
  approval_required: boolean;
  proposed: Record<string, unknown>;
  applied: Record<string, unknown> | null;
  outcome: ProposalOutcome | null;
  rejected_reason: string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  model: string;
  prompt_version: string;
  created_at: Date | string;
}

const COLUMNS =
  "id, tenant_id, job_id, job_step_id, confidence, auto_commit_at, review_at, " +
  "tier_version_id, decision, approval_required, proposed, applied, outcome, rejected_reason, " +
  "decided_by, decided_at, model, prompt_version, created_at";

function ts(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `numeric` arrives as a STRING from postgres.js, deliberately — the driver
 * refuses to lose precision on the way out, which is right for money and right
 * here too.
 *
 * It becomes a number at this door because a confidence IS a number: the domain
 * compares it against thresholds, and a string comparison would make "0.9" look
 * larger than "0.85". Money goes the other way and stays a string all the way to
 * the wire; the difference is that money is added up and this is only ever
 * compared.
 */
function score(value: string): number {
  return Number(value);
}

function toRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jobId: r.job_id,
    jobStepId: r.job_step_id,
    confidence: score(r.confidence),
    autoCommitAt: score(r.auto_commit_at),
    reviewAt: score(r.review_at),
    tierVersionId: r.tier_version_id,
    decision: r.decision,
    approvalRequired: r.approval_required,
    proposed: r.proposed,
    applied: r.applied,
    outcome: r.outcome,
    rejectedReason: r.rejected_reason,
    decidedBy: r.decided_by,
    decidedAt: ts(r.decided_at),
    model: r.model,
    promptVersion: r.prompt_version,
    createdAt: ts(r.created_at) ?? "",
  };
}

export class PostgresAgentRunRepository implements AgentRunRepository {
  constructor(private readonly app: Db) {}

  async record(run: NewAgentRun): Promise<AgentRun> {
    return withTenant(this.app, run.tenantId, async (db) => {
      const [row] = await db<RunRow[]>`
        INSERT INTO delivery.agent_run
          (id, tenant_id, job_id, job_step_id, confidence, auto_commit_at, review_at,
           tier_version_id, decision, approval_required, proposed, applied, model, prompt_version)
        VALUES (
          ${run.id}, ${run.tenantId}, ${run.jobId}, ${run.jobStepId}, ${run.confidence},
          ${run.autoCommitAt}, ${run.reviewAt}, ${run.tierVersionId}, ${run.decision}, ${run.approvalRequired},
          ${db.json(run.proposed as Parameters<typeof db.json>[0])}, ${run.applied === null ? null : db.json(run.applied as Parameters<typeof db.json>[0])},
          ${run.model}, ${run.promptVersion}
        )
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) {
        throw new Error(
          `agent run ${run.id} was not written and postgres raised nothing, which should be ` +
            `impossible — the insert either succeeds or the guardrail CHECK refuses it`,
        );
      }
      return toRun(row);
    });
  }

  async openForStep(tenantId: string, jobStepId: string): Promise<AgentRun | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // The UNDECIDED one, and a committed run is never it — nobody decides a
      // commit, that is what unattended means. Newest first, because a retry is
      // a second row on purpose: "it got it right the second time" is part of
      // the accuracy record and the second attempt is the live one.
      const [row] = await db<RunRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.agent_run
        WHERE job_step_id = ${jobStepId}
          AND outcome IS NULL
          AND decision <> 'committed'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ? toRun(row) : null;
    });
  }

  async openForJob(tenantId: string, jobId: string): Promise<ReadonlyMap<string, AgentRun>> {
    return withTenant(this.app, tenantId, async (db) => {
      // DISTINCT ON keeps the newest undecided run per step in one pass — a
      // retry is a second row on purpose, and the live one is the latest.
      const rows = await db<RunRow[]>`
        SELECT DISTINCT ON (job_step_id) ${db.unsafe(COLUMNS)}
        FROM delivery.agent_run
        WHERE job_id = ${jobId}
          AND outcome IS NULL
          AND decision <> 'committed'
        ORDER BY job_step_id, created_at DESC
      `;
      return new Map(rows.map((r) => [r.job_step_id, toRun(r)]));
    });
  }

  async decide(
    tenantId: string,
    runId: string,
    decision: RunDecision,
  ): Promise<AgentRun | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // `WHERE outcome IS NULL` does the work, in SQL. Two people can be looking
      // at the same queue and click at once; the second must find it already
      // answered rather than overwrite the first's verdict — which is the record
      // of who decided, and the number T2.9's maker-checker rule compares.
      const [row] = await db<RunRow[]>`
        UPDATE delivery.agent_run
        SET outcome = ${decision.outcome},
            applied = ${decision.applied === null ? null : db.json(decision.applied as Parameters<typeof db.json>[0])},
            rejected_reason = ${decision.rejectedReason},
            decided_by = ${decision.decidedBy},
            decided_at = ${decision.decidedAt}
        WHERE id = ${runId} AND outcome IS NULL
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toRun(row) : null;
    });
  }
}
