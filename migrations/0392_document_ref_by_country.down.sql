SET ROLE bib_owner;

-- Refused while a new-shape number exists: the old CHECK would reject rows
-- already written, and those numbers have gone to clients.
ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_ref_shape_chk,
  ADD CONSTRAINT proposal_ref_shape_chk CHECK (ref ~ '^PR-[0-9]{4}-[0-9]{4,}$');
ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_ref_shape_chk,
  ADD CONSTRAINT el_ref_shape_chk CHECK (ref ~ '^EL-[0-9]{4}-[0-9]{4,}$');

DROP TABLE IF EXISTS crm.document_numbering;
DROP TABLE IF EXISTS crm.document_ref_country_series;

RESET ROLE;
