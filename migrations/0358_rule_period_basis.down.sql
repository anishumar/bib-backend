-- 0358 down · every rule back on its own year.
--
-- REFUSES while a rule follows the client's year end: without the column the
-- next sweep would cut that rule's periods on the rule's month, next to the
-- client-year rows already generated, which is two returns for one stretch of
-- months. Set such rules back to the rule's year (or retire them) first.
SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'delivery' AND table_name = 'obligation_template'
       AND column_name = 'period_basis'
  ) AND EXISTS (
    SELECT 1 FROM delivery.obligation_template WHERE period_basis <> 'rule_calendar'
  ) THEN
    RAISE EXCEPTION '0358 down: % rule(s) follow the client''s year end; set them back first',
      (SELECT count(*) FROM delivery.obligation_template WHERE period_basis <> 'rule_calendar');
  END IF;
END $$;

ALTER TABLE delivery.obligation_instance DROP COLUMN IF EXISTS period_basis;
ALTER TABLE delivery.obligation_template DROP COLUMN IF EXISTS period_basis;

RESET ROLE;
