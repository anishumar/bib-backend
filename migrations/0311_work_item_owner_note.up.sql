-- 0311 · A task the owner rule put on a fallback desk says why it is there (2026-09-27)
--
-- ── THE RULE THAT CHANGED ──────────────────────────────────────────────────
--
-- Work always has an owner (Shrestha, 2026-09-27). When a client has no SPOC
-- for the work's Dept, the router gives it to the client's Key Manager, and
-- failing that to the person who signs for the firm, to HAND OUT
-- (`resolveOwner` in `domain/workitem/model.ts`). Until now it left such work
-- on nobody's desk with `assignment_note` saying why.
--
-- ── WHY THE CHECK GOES ─────────────────────────────────────────────────────
--
-- 0051's `work_item_note_only_when_unassigned` refused a note beside a name,
-- on the ground that on an assigned row the note would be "a stale sentence
-- contradicting the name beside it". A fallback owner is the opposite case:
-- the note is the one thing that tells them the task came to them to hand
-- out, and why ("No SPOC is recorded for Financial Reporting and Compliance
-- on this client, so it came to the client's Key Manager to hand out"). The
-- staleness 0051 guarded against cannot arise: moving a task by hand writes
-- NULL over the note (`setAssignee`), so a note on an assigned row is always
-- the router's, about the desk the router chose.
--
-- Left with no CHECK in its place. "This sentence is about the name beside
-- it" is not something SQL can test, and the one writer that sets both is the
-- router.
--
-- Nothing is rewritten: every existing row satisfies the looser rule.

SET ROLE bib_owner;

ALTER TABLE delivery.work_item
  DROP CONSTRAINT IF EXISTS work_item_note_only_when_unassigned;

RESET ROLE;
