-- 0306 down · commercial references are checked for tenant only, as before 0306.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_el_quote_is_the_clients ON crm.engagement_letter;
DROP TRIGGER IF EXISTS trg_invoice_line_is_the_clients ON crm.invoice_line;
DROP TRIGGER IF EXISTS trg_invoice_series_is_the_firms ON crm.invoice_series;
DROP TRIGGER IF EXISTS trg_invoice_party_not_archived ON crm.invoice;
DROP TRIGGER IF EXISTS trg_invoice_parties ON crm.invoice;
DROP FUNCTION IF EXISTS crm.letter_quote_is_the_clients();
DROP FUNCTION IF EXISTS crm.invoice_line_bills_the_clients_engagement();
DROP FUNCTION IF EXISTS crm.invoice_series_is_the_firms();
DROP FUNCTION IF EXISTS crm.invoice_names_the_right_parties();
DROP FUNCTION IF EXISTS crm.is_firm_entity(uuid, uuid);

RESET ROLE;
