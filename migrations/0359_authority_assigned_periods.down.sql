-- 0359 down · no authority-assigned periods.
--
-- REFUSES while a rule is on them: without the basis its next sweep would cut
-- the rule's own quarters beside the clients' assigned ones. Set such rules to
-- another basis (or retire them) first. Rows already generated on an assigned
-- period are re-marked 'rule_calendar' so 0358's CHECK holds; their dates stay.
SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery.obligation_template WHERE period_basis = 'authority_assigned') THEN
    RAISE EXCEPTION '0359 down: % rule(s) follow an authority-assigned period; set them back first',
      (SELECT count(*) FROM delivery.obligation_template WHERE period_basis = 'authority_assigned');
  END IF;
END $$;

UPDATE delivery.obligation_instance SET period_basis = 'rule_calendar' WHERE period_basis = 'authority_assigned';

ALTER TABLE delivery.obligation_instance DROP CONSTRAINT IF EXISTS obligation_instance_period_basis_check;
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_period_basis_check
    CHECK (period_basis IN ('rule_calendar', 'client_year_end', 'rule_fallback'));

ALTER TABLE delivery.obligation_template DROP CONSTRAINT IF EXISTS obligation_template_assigned_needs_module;
ALTER TABLE delivery.obligation_template DROP CONSTRAINT IF EXISTS obligation_template_period_basis_check;
ALTER TABLE delivery.obligation_template
  ADD CONSTRAINT obligation_template_period_basis_check
    CHECK (period_basis IN ('rule_calendar', 'client_year_end'));

DROP TABLE IF EXISTS core.legal_entity_return_period;

RESET ROLE;
