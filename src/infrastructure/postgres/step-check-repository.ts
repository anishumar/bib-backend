// Postgres adapter for the ticks on a step's own two lists (T6.15, 0307):
// sub-steps, ticked by whoever does the step, and review points, ticked by
// whoever checks it. Every read and write goes through withTenant; a tick
// belongs to the firm whose work it is about.
//
// ONE ROW PER (LIST, LINE) AND AN ABSENT ROW IS OPEN. A mark is written by an
// upsert against whichever of the two partial unique indexes its list uses,
// and taking a tick back sets the row's outcome to NULL again. There is no
// DELETE here and `bib_app` holds no DELETE grant on the table.
//
// THE MARKER'S NAME IS A JOIN, in the same statement as the marks, for the
// rule every read model here follows: a screen must never fetch a person per
// row, and a tick made by somebody who has since left still says who made it.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { CheckListKind, StepCheckMark } from "../../domain/orchestrator/model";
import { isMarkOutcome } from "../../domain/orchestrator/model";
import type {
  NewStepCheckMark,
  StepCheckLineRef,
  StepCheckRepository,
} from "../../usecase/orchestrator/ports";

interface MarkRow {
  id: string;
  tenant_id: string;
  job_step_id: string;
  step_approval_id: string | null;
  list: string;
  item_key: string;
  label: string;
  outcome: string | null;
  note: string | null;
  marked_by_user_id: string | null;
  marked_by_name: string | null;
  marked_at: Date | string | null;
}

const COLUMNS =
  "c.id, c.tenant_id, c.job_step_id, c.step_approval_id, c.list, c.item_key, c.label, " +
  "c.outcome, c.note, c.marked_by_user_id, c.marked_at, " +
  // The name, falling back to the address: `display_name` is nullable and is
  // genuinely empty at seeded firms, and "ticked by nobody we can name" is the
  // blank-beside-a-tick bug T4.5 found on a different read.
  "coalesce(u.display_name, u.email::text) AS marked_by_name";

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function toMark(r: MarkRow): StepCheckMark {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jobStepId: r.job_step_id,
    stepApprovalId: r.step_approval_id,
    // Both guaranteed by the CHECKs in 0307; the guards read an unrecognised
    // value as the SAFE answer, which is an open line (it keeps the gate shut)
    // on the sub-step list rather than a tick on the checker's.
    list: (r.list === "review" ? "review" : "checklist") satisfies CheckListKind,
    itemKey: r.item_key,
    label: r.label,
    outcome: r.outcome !== null && isMarkOutcome(r.outcome) ? r.outcome : null,
    note: r.note,
    markedByUserId: r.marked_by_user_id,
    markedByName: r.marked_by_name,
    markedAt: iso(r.marked_at),
  };
}

export class PostgresStepCheckRepository implements StepCheckRepository {
  constructor(private readonly app: Db) {}

  async listForJob(tenantId: string, jobId: string): Promise<readonly StepCheckMark[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Through the STEP, because a mark names its step and not its job: the
      // job is a fact on the step's row, and a copy of it here would be a
      // column that could disagree with it.
      const rows = await db<MarkRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM delivery.job_step_check c
        JOIN delivery.job_step s ON s.id = c.job_step_id
        LEFT JOIN tenancy.user_account u ON u.id = c.marked_by_user_id
        WHERE s.job_id = ${jobId}
      `;
      return rows.map(toMark);
    });
  }

  async listForApprovals(tenantId: string, approvalIds: readonly string[]): Promise<readonly StepCheckMark[]> {
    if (approvalIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // `list = 'review'` is redundant with the pairing CHECK and is here for
      // the planner: it is the predicate of the partial index this reads.
      const rows = await db<MarkRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM delivery.job_step_check c
        LEFT JOIN tenancy.user_account u ON u.id = c.marked_by_user_id
        WHERE c.list = 'review'
          AND c.step_approval_id = ANY(${db.array([...approvalIds])}::uuid[])
      `;
      return rows.map(toMark);
    });
  }

  /**
   * Write a mark, or overwrite the one already on that line.
   *
   * `ON CONFLICT` against the partial unique index of the mark's own list:
   * `(tenant, step, line)` for a sub-step, `(tenant, CHECK, line)` for a review
   * point, which is what makes the second round after a send-back a fresh set
   * of rows rather than an overwrite of the first round's.
   *
   * IDEMPOTENT IN SQL: the `DO UPDATE ... WHERE ... IS DISTINCT FROM` leaves a
   * line that already carries this outcome and this reason untouched, so a
   * second click does not move who ticked it or when. Nothing is returned by
   * the CTE then, and the second arm reads the row as it stands; both arms see
   * the snapshot from before the statement, which is exactly the row that was
   * left alone.
   */
  async upsert(mark: NewStepCheckMark): Promise<StepCheckMark> {
    return withTenant(this.app, mark.tenantId, async (db) => {
      const target =
        mark.list === "checklist"
          ? db`(tenant_id, job_step_id, item_key) WHERE list = 'checklist'`
          : db`(tenant_id, step_approval_id, item_key) WHERE list = 'review'`;
      const sameLine =
        mark.list === "checklist"
          ? db`c.job_step_id = ${mark.jobStepId}`
          : db`c.step_approval_id = ${mark.stepApprovalId}`;
      const [row] = await db<MarkRow[]>`
        WITH up AS (
          INSERT INTO delivery.job_step_check AS c
            (id, tenant_id, job_step_id, step_approval_id, list, item_key, label,
             outcome, note, marked_by_user_id, marked_at)
          VALUES (
            ${mark.id}, ${mark.tenantId}, ${mark.jobStepId}, ${mark.stepApprovalId},
            ${mark.list}, ${mark.itemKey}, ${mark.label},
            ${mark.outcome}, ${mark.note}, ${mark.markedByUserId}, ${mark.markedAt}::timestamptz
          )
          ON CONFLICT ${target}
          DO UPDATE SET
            label             = EXCLUDED.label,
            outcome           = EXCLUDED.outcome,
            note              = EXCLUDED.note,
            marked_by_user_id = EXCLUDED.marked_by_user_id,
            marked_at         = EXCLUDED.marked_at
          WHERE (c.outcome, c.note) IS DISTINCT FROM (EXCLUDED.outcome, EXCLUDED.note)
          RETURNING c.*
        )
        SELECT ${db.unsafe(COLUMNS)}
        FROM up c
        LEFT JOIN tenancy.user_account u ON u.id = c.marked_by_user_id
        UNION ALL
        SELECT ${db.unsafe(COLUMNS)}
        FROM delivery.job_step_check c
        LEFT JOIN tenancy.user_account u ON u.id = c.marked_by_user_id
        WHERE c.list = ${mark.list} AND c.item_key = ${mark.itemKey} AND ${sameLine}
          AND NOT EXISTS (SELECT 1 FROM up)
      `;
      if (!row) {
        throw new Error(
          `job_step_check: the mark on ${mark.list} line ${JSON.stringify(mark.itemKey)} was neither ` +
            `written nor found. The statement inserts, updates or reads that line, so this means the ` +
            `row is outside this firm's reach.`,
        );
      }
      return toMark(row);
    });
  }

  /** Untick a line. Only a row that is actually ticked is touched, so taking
   *  back a tick nobody made writes nothing, and never inserts a row for it. */
  async clear(ref: StepCheckLineRef): Promise<void> {
    await withTenant(this.app, ref.tenantId, async (db) => {
      const sameLine =
        ref.list === "checklist"
          ? db`job_step_id = ${ref.jobStepId}`
          : db`step_approval_id = ${ref.stepApprovalId}`;
      await db`
        UPDATE delivery.job_step_check SET
          outcome = NULL, note = NULL, marked_by_user_id = NULL, marked_at = NULL
        WHERE list = ${ref.list} AND item_key = ${ref.itemKey} AND ${sameLine}
          AND outcome IS NOT NULL
      `;
    });
  }
}
