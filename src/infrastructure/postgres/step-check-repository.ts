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
//
// EVERY WRITE LOCKS FIRST. A sub-step mark locks its step's row and a review
// mark its check's row, and checks under that lock that the list is still open
// to marks (`mayMark`). The moves that read a list lock the same rows, so a
// tick can never land between Done's read of the list and Done's move, nor
// after it. Why a lock and not a predicate in the write: `step-lines.ts`.
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
   * FIRST, THE LIST MUST STILL BE OPEN TO MARKS, checked under a row lock in
   * this transaction (`mayMark`); null, with nothing written, when it is not.
   *
   * IDEMPOTENT IN SQL: the `DO UPDATE ... WHERE ... IS DISTINCT FROM` leaves a
   * line that already carries this outcome and this reason untouched, so a
   * second click does not move who ticked it or when. The statement then
   * returns nothing, and the row as it stands is read by a SECOND statement.
   * It has to be a second one. A conflicting row another request inserted and
   * committed while this statement waited on it is locked and left alone by
   * the `DO UPDATE`, but it is invisible to any read in the same statement,
   * which runs on the snapshot taken before the wait. The first draft read it
   * with a `UNION ALL` arm of the same statement, and two first ticks of one
   * line at once answered one of the two with a 500: a reviewer's probe threw
   * on 40 of 80. Under READ COMMITTED the next statement's snapshot is new and
   * sees the row. (The lock in `mayMark` now makes the two requests queue in
   * the first place; the second statement is what makes this method correct
   * without leaning on that.)
   */
  async upsert(mark: NewStepCheckMark): Promise<StepCheckMark | null> {
    return withTenant(this.app, mark.tenantId, async (db) => {
      if (!(await mayMark(db, mark))) return null;
      const target =
        mark.list === "checklist"
          ? db`(tenant_id, job_step_id, item_key) WHERE list = 'checklist'`
          : db`(tenant_id, step_approval_id, item_key) WHERE list = 'review'`;
      const [written] = await db<MarkRow[]>`
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
      `;
      if (written) return toMark(written);

      const sameLine =
        mark.list === "checklist"
          ? db`c.job_step_id = ${mark.jobStepId}`
          : db`c.step_approval_id = ${mark.stepApprovalId}`;
      const [kept] = await db<MarkRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM delivery.job_step_check c
        LEFT JOIN tenancy.user_account u ON u.id = c.marked_by_user_id
        WHERE c.list = ${mark.list} AND c.item_key = ${mark.itemKey} AND ${sameLine}
      `;
      if (!kept) {
        throw new Error(
          `job_step_check: the mark on ${mark.list} line ${JSON.stringify(mark.itemKey)} was neither ` +
            `written nor found. The insert met a row on that line and left it as it was, and a fresh ` +
            `read of the line then found nothing, which only a row outside this firm's reach explains.`,
        );
      }
      return toMark(kept);
    });
  }

  /** Untick a line. Only a row that is actually ticked is touched, so taking
   *  back a tick nobody made writes nothing, and never inserts a row for it.
   *  False, with nothing written, when the list is closed to marks. */
  async clear(ref: StepCheckLineRef): Promise<boolean> {
    return withTenant(this.app, ref.tenantId, async (db) => {
      if (!(await mayMark(db, ref))) return false;
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
      return true;
    });
  }
}

/**
 * Whether this line's list is open to marks NOW, decided under the row lock the
 * moves that read the list take too (`step-lines.ts`), so the answer holds
 * until this transaction commits.
 *
 * A SUB-STEP: its step is `blocked`, and has no check that is pending or
 * approved. Pending is work somebody else is looking at; approved is the
 * moment between Approve and the step's own move to done, when the list that
 * was approved must not change either. A rejected check is no lock at all:
 * after a send-back the doer changes their ticks again.
 *
 * A REVIEW POINT: its check is still pending. Only the check's row is locked,
 * because only Approve and Send back close a checker's list, and both write
 * that row.
 */
async function mayMark(db: Db, ref: StepCheckLineRef): Promise<boolean> {
  if (ref.list === "checklist") {
    const [step] = await db<{ status: string }[]>`
      SELECT status FROM delivery.job_step WHERE id = ${ref.jobStepId}
      FOR NO KEY UPDATE
    `;
    if (step?.status !== "blocked") return false;
    const [check] = await db<{ id: string }[]>`
      SELECT id FROM delivery.step_approval
      WHERE job_step_id = ${ref.jobStepId} AND decision IN ('pending', 'approved')
      LIMIT 1
    `;
    return check === undefined;
  }
  if (ref.stepApprovalId === null) return false;
  const [check] = await db<{ decision: string }[]>`
    SELECT decision FROM delivery.step_approval
    WHERE id = ${ref.stepApprovalId} AND job_step_id = ${ref.jobStepId}
    FOR NO KEY UPDATE
  `;
  return check?.decision === "pending";
}
