// The row locks a step's own two lists stand on (T6.15, 0307), shared by the
// three adapters that read or write them: marks, steps and checks.
//
// ── WHY A LOCK, AND WHY THESE TWO ROWS ──────────────────────────────────────
//
// Done reads the sub-steps and then moves the step; Approve reads the review
// points and then decides the check. The use case makes those as separate
// calls, so on their own they are check-then-act: a tick taken back between the
// read and the move would finish a step with a line open, and a tick landing
// after the move would change a list somebody else has already judged. Two
// tabs, or two people on a step on nobody's desk, are enough; the reviewers
// reproduced both.
//
// So every write that depends on a list, and every write TO one, takes one
// row lock first, in its own transaction, and reads the list after it:
//
//   a sub-step mark, a guarded step move, a guarded check opening
//                                                    -> the STEP's row
//   a review mark, a guarded Approve                 -> the CHECK's row
//
// Under READ COMMITTED each statement reads a fresh snapshot, and a statement
// that waited for a lock starts after the holder committed. So the read that
// follows the lock sees every mark made by whoever held it before, and a mark
// that waited for the move sees the move. A single statement with a subquery
// would NOT do this: an UPDATE that waits on a row re-checks only that row, and
// reads every other table from the snapshot it started with.
//
// `FOR NO KEY UPDATE`, the lock an UPDATE of a non-key column takes itself,
// and not `FOR UPDATE`: it serialises everything above against each other and
// against the moves' own UPDATEs, and it does not make an unrelated insert that
// merely REFERENCES the step (a run, a check, a mark's foreign key) wait.
//
// Always in the same order, and never more than one of the two per
// transaction: nothing here can wait on a lock held by somebody waiting on it.
import type { Db } from "../../db/pool";

/**
 * Lock one step's row, only if it is in `status`, and say whether every named
 * sub-step is marked (done or not applicable) as read after the lock.
 *
 * False when the step is not in that state any more, or when a line is open.
 * The caller reads false as "not now" and the service says which.
 */
export async function lockStepWithSubStepsSettled(
  db: Db,
  stepId: string,
  status: string,
  subStepKeys: readonly string[],
): Promise<boolean> {
  const [held] = await db<{ id: string }[]>`
    SELECT id FROM delivery.job_step
    WHERE id = ${stepId} AND status = ${status}
    FOR NO KEY UPDATE
  `;
  if (!held) return false;
  return (await openSubSteps(db, stepId, subStepKeys)) === 0;
}

/** How many of these sub-steps of one step have no outcome. A key with no row
 *  at all is open, which is what an absent row means. */
export async function openSubSteps(db: Db, stepId: string, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM unnest(${db.array([...keys])}::text[]) AS k(item_key)
    WHERE NOT EXISTS (
      SELECT 1 FROM delivery.job_step_check c
      WHERE c.list = 'checklist' AND c.job_step_id = ${stepId}
        AND c.item_key = k.item_key AND c.outcome IS NOT NULL
    )
  `;
  // No row back is impossible for a count; reading it as "all open" keeps the
  // gate shut rather than open if it ever happens.
  return row?.n ?? keys.length;
}

/** How many of these review points of one CHECK have no outcome. */
export async function openReviewPoints(db: Db, approvalId: string, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM unnest(${db.array([...keys])}::text[]) AS k(item_key)
    WHERE NOT EXISTS (
      SELECT 1 FROM delivery.job_step_check c
      WHERE c.list = 'review' AND c.step_approval_id = ${approvalId}
        AND c.item_key = k.item_key AND c.outcome IS NOT NULL
    )
  `;
  return row?.n ?? keys.length;
}
