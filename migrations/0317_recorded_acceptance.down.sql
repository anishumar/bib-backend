-- Down for 0317.
--
-- Drops the evidence table. It does NOT put the old partner role bodies back,
-- for the reason 0012's, 0045's, 0056's, 0060's, 0064's and 0069's downs all
-- give: publishing archived the version it replaced, and a firm that has
-- published its OWN role since would have that overwritten by a rollback it
-- never asked for. With the routes gone, a role still listing
-- `acceptance:record` grants nothing.
--
-- Refuses while any acceptance is recorded: each row is the only record of how
-- a client agreed to a signed letter or an accepted proposal.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.recorded_acceptance) THEN
    RAISE EXCEPTION '0317 down refused: crm.recorded_acceptance holds recorded acceptances, the only record of how those clients agreed. Export them first.';
  END IF;
END
$$;

DROP TABLE crm.recorded_acceptance;

RESET ROLE;
