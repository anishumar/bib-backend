-- 0334 down · The frozen parties, the print reading and the client's billing
-- address go. Documents issued meanwhile re-render without their frozen
-- parties: the stored PDFs of record are untouched.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_el_printed_parties ON crm.engagement_letter;
DROP TRIGGER IF EXISTS trg_invoice_printed_parties ON crm.invoice;
DROP FUNCTION IF EXISTS crm.refuse_printed_parties_change();
DROP FUNCTION IF EXISTS crm.print_identity(uuid, date);

ALTER TABLE crm.engagement_letter DROP COLUMN IF EXISTS printed_parties;
ALTER TABLE crm.invoice DROP COLUMN IF EXISTS printed_parties;
ALTER TABLE core.party DROP COLUMN IF EXISTS billing_address;

RESET ROLE;
