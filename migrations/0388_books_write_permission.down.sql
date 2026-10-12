-- Down for 0388.
--
-- Changes nothing in the database. It does NOT take `books:write` back out of
-- the roles 0388 republished, for the reason 0364's and 0382's downs give:
-- publishing archived the version it replaced, and a firm that has published
-- its OWN role since would have that overwritten by a rollback it never asked
-- for. With the code gone, a role still listing `books:write` grants nothing.
SELECT 1;
