-- 0380 down: new Indian companies start OFF again, as 0375 left them.
--
-- The switches 0380 turned on stay on: a down cannot tell them from a switch a
-- partner turned on since, and switching a firm's rounding off behind its back
-- would change its drafts. Turn them off on Your firm if that is wanted.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_firm_entity_round_off_default ON crm.firm_entity;
DROP FUNCTION IF EXISTS crm.firm_entity_round_off_default();

COMMENT ON COLUMN crm.firm_entity.round_off_total IS
  'Whether this company rounds an invoice total to the nearest whole unit with a Round off line (Q087, 0375). Off until the firm turns it on.';

RESET ROLE;
