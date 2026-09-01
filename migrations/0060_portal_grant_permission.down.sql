-- Down for 0060.
--
-- It does NOT put the old role bodies back, for the reason 0012's, 0045's and
-- 0056's downs give: publishing archives the version it replaced, so undoing
-- this would mean un-archiving one version and archiving another — and a firm
-- that has published its OWN role since would have that overwritten by a
-- rollback it never asked for. A permission nothing checks any more is inert; a
-- role body silently rewritten is not.

SET ROLE bib_owner;
RESET ROLE;
