-- Down for 0069.
--
-- It does NOT put the old role bodies back, for the reason 0012's, 0045's,
-- 0056's, 0060's and 0064's downs all give: publishing archives the version it
-- replaced, so undoing this would mean un-archiving one version and archiving
-- another — and a firm that has published its OWN role since would have that
-- overwritten by a rollback it never asked for.
--
-- A permission nothing checks any more is inert: with 0068 rolled back there is
-- no route requiring `portal:request`, so a role that still lists it grants
-- exactly nothing. A role body silently rewritten is not inert, and the two are
-- not a close call.
--
-- Note the ordering this implies for a real rollback: run 0069's down and then
-- 0068's, or just 0068's. Running THIS one alone is a no-op by design.

SET ROLE bib_owner;
RESET ROLE;
