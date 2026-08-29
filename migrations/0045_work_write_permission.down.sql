-- Down for 0045.
--
-- It does NOT put the old role bodies back, and that is deliberate rather than
-- lazy. Publishing archives the version it replaced, so undoing this would mean
-- un-archiving one version and archiving another — and a firm that has published
-- its OWN role since would have that overwritten by a rollback it never asked
-- for. A permission nothing checks any more is inert; a role body silently
-- rewritten is not.
--
-- So this is a no-op with its reasoning, exactly as 0012's is.

SET ROLE bib_owner;
RESET ROLE;
