-- 0380: Round off starts ON for an Indian company (Q087, Shrestha 2026-10-05).
--
-- 0375 built "Round off the total" OFF for every company until a firm turned
-- it on. The S8 brief asked for ON for INR companies by default, as Tally and
-- Zoho Books do, and 10x answered plainly "round off". So:
--
--   1. every company registered in India that exists today is switched ON;
--   2. a company that BECOMES the firm's later starts ON when it is Indian.
--
-- Other countries stay OFF until the firm turns them on (nobody has asked for
-- AED, SGD or USD rounding).
--
-- Issued invoices are untouched: `crm.invoice.round_off` was frozen at issue
-- (0375), and the freeze trigger refuses a change. Only drafts re-render, which
-- is what a draft is for.
--
-- The switch's own changes are ledger events (`firm_entity.round_off_set`).
-- This is a default, like 0375's `DEFAULT false`, so it writes none.
--
-- BEFORE INSERT on `crm.firm_entity` rather than in the repository, because a
-- company joins the firm by three roads (the Companies screen, routing a
-- country to a party (0313's trigger), and 0313's backfill); one trigger
-- covers all of them. Nothing inserts `round_off_total` explicitly, so
-- OR-ing keeps any explicit TRUE and only turns a default FALSE on.

SET ROLE bib_owner;

UPDATE crm.firm_entity fe
   SET round_off_total = true
  FROM core.legal_entity le
 WHERE le.party_id = fe.party_id
   AND le.tenant_id = fe.tenant_id
   AND le.jurisdiction = 'IN'
   AND NOT fe.round_off_total;

CREATE FUNCTION crm.firm_entity_round_off_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.round_off_total := NEW.round_off_total OR EXISTS (
    SELECT 1 FROM core.legal_entity le
     WHERE le.party_id = NEW.party_id
       AND le.tenant_id = NEW.tenant_id
       AND le.jurisdiction = 'IN');
  RETURN NEW;
END $$;

CREATE TRIGGER trg_firm_entity_round_off_default
  BEFORE INSERT ON crm.firm_entity
  FOR EACH ROW EXECUTE FUNCTION crm.firm_entity_round_off_default();

COMMENT ON COLUMN crm.firm_entity.round_off_total IS
  'Whether this company rounds an invoice total to the nearest whole unit with a Round off line (Q087, 0375). ON by default for a company registered in India (0380), OFF elsewhere until the firm turns it on.';

RESET ROLE;
