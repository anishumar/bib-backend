-- Down for 0064.
--
-- It does NOT put the old role bodies back, for the reason 0012's, 0045's,
-- 0056's and 0060's downs give: publishing archives the version it replaced, so
-- undoing this would mean un-archiving one version and archiving another — and a
-- firm that has published its OWN role since would have that overwritten by a
-- rollback it never asked for. A permission nothing checks any more is inert; a
-- role body silently rewritten is not.
--
-- It does not remove `client_viewer` either, and that is the same rule applied
-- to a role rather than to a permission. Between this migration and its
-- rollback, a firm may have put somebody on that role — and dropping it would
-- leave a live membership naming a role the firm no longer defines, which
-- `AuthzService` answers with `UnknownRole` on every request that person makes.
-- A role nobody is on is inert; a person locked out by a rollback is not.

SET ROLE bib_owner;
RESET ROLE;
