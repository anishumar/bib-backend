// The row lock the two writers of one filing's calendar take turns on (T6.16,
// found in review 2026-09-26): the chain's ROOT rule, the
// `delivery.obligation_template` row whose id IS the chain's `lineage_id`.
//
// ── WHY A LOCK ──────────────────────────────────────────────────────────────
//
// Two things write a chain's calendar rows because of a catalogue link:
//
//   the generator's write (`createIfAbsent`), which asks the link again at the
//     write (`STILL_LINKED`) and then inserts or restores;
//   a removal (`RuleServiceLinkRepository.unlink`), which ends one link, reads
//     that service's rows and what else still covers them, and withdraws or
//     re-points them.
//
// Each is right on its own. Together, at READ COMMITTED with nothing making one
// wait for the other, the reviewers found two orders that leave filings LIVE
// under no link at all, and nothing afterwards withdraws them, because the
// generator only ever restores:
//
//   two removals of one filing from two services at once: each counted the
//     other's link, still uncommitted, as cover; one moved the rows onto the
//     other service's engagement and the other found nothing there to withdraw;
//   a removal landing while the generator's insert was running: the insert had
//     read the link as live when it started, and the removal could not see the
//     rows it had not yet committed.
//
// So both take one row lock FIRST, in a statement of its own, and read after
// it. Under READ COMMITTED a statement that waited for a lock starts after the
// holder committed, so a removal that waited sees the other removal's
// re-pointing and the generator's rows, and a generator that waited sees the
// link gone. A locking clause inside `STILL_LINKED` would NOT do: a statement
// that waits on a row re-checks that row and reads every other table from the
// snapshot it started with (T6.15's `step-lines.ts` says the same).
//
// ── WHY THIS ROW ────────────────────────────────────────────────────────────
//
// One row per chain however many services carry it, and it exists before any
// link does. Locking the chain's live LINKS instead is several rows, taken by
// the generator's insert in whatever order its plan reads them, which is a
// deadlock waiting between a sweep and a removal.
//
// The generator takes FOR SHARE, so two sweeps, or a sweep and a link's own
// fill, never wait for each other. A removal takes FOR NO KEY UPDATE, the lock
// an UPDATE takes itself, which waits for both and for another removal. Neither
// makes a foreign-key check on the rule wait (that takes FOR KEY SHARE), so
// writing a calendar row, a link or an exception is not held up; an edit of the
// root rule waits for a write in flight, which is one short transaction.
//
// No cycle is possible: the generator locks every chain its proposals name, in
// id order, in one statement, before it touches a calendar row, and touches
// only those chains' rows; a removal locks its one chain before anything else.
import type { Db } from "../../db/pool";

/** The removal's lock: one chain, exclusive among writers of its calendar. */
export async function lockChainForRemoval(db: Db, lineageId: string): Promise<void> {
  await db`
    SELECT id FROM delivery.obligation_template
    WHERE id = ${lineageId}
    FOR NO KEY UPDATE
  `;
}

/** The generator's lock: every chain the proposals' rules belong to, shared,
 *  in id order so two writers always meet the rows in the same order. */
export async function lockChainsForWrite(
  db: Db,
  templateIds: readonly string[],
): Promise<void> {
  if (templateIds.length === 0) return;
  await db`
    SELECT root.id FROM delivery.obligation_template root
    WHERE root.id IN (
      SELECT t.lineage_id FROM delivery.obligation_template t
      WHERE t.id = ANY(${db.array([...new Set(templateIds)])}::uuid[])
    )
    ORDER BY root.id
    FOR SHARE
  `;
}
