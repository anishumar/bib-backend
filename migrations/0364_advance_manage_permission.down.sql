-- Down for 0364.
--
-- Changes nothing in the database. It does NOT take `advance:manage` back out
-- of the roles 0364 republished, for the reason 0321's and 0335's downs give:
-- publishing archived the version it replaced, and a firm that has published
-- its OWN role since would have that overwritten by a rollback it never asked
-- for. With the code gone, a role still listing `advance:manage` grants nothing.
SELECT 1;
