-- Down for 0382.
--
-- Changes nothing in the database. It does NOT take `books:read` back out of
-- the roles 0382 republished, for the reason 0364's down gives: publishing
-- archived the version it replaced, and a firm that has published its OWN role
-- since would have that overwritten by a rollback it never asked for. With the
-- code gone, a role still listing `books:read` grants nothing.
SELECT 1;
