-- Down for 0335.
--
-- Changes nothing in the database. It does NOT take `invoice:issue` back out
-- of the roles 0335 republished, for the reason 0012's, 0045's, 0056's, 0060's,
-- 0064's, 0069's, 0317's and 0321's downs all give: publishing archived the
-- version it replaced, and a firm that has published its OWN role since would
-- have that overwritten by a rollback it never asked for. With the code gone,
-- issuing is `tenant:admin` again and a role still listing `invoice:issue`
-- grants nothing.
SELECT 1;
