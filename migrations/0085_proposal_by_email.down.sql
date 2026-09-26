-- 0085 down · A proposal emailed to the client, and the client's own answer
--
-- Drops the evidence with the tables. A database holding client answers loses
-- the record of who accepted what; export crm.proposal_client_decision first if
-- the down is really wanted on anything but a developer's copy.

SET ROLE bib_owner;

DROP TABLE IF EXISTS crm.proposal_client_decision;
DROP TABLE IF EXISTS crm.proposal_email;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_sent_pdf_after_draft_chk,
  DROP CONSTRAINT IF EXISTS proposal_sent_pdf_fkey,
  DROP COLUMN IF EXISTS sent_pdf_version_id;

RESET ROLE;
