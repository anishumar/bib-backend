-- 0312 down · one standard set per firm again, and a currency key with no
-- ON UPDATE action.
--
-- REFUSES rather than destroys (0311's arrangement). A standard line written
-- for one of the firm's companies would, with its column gone, become a line
-- of the firm-wide default set and start printing on every other company's
-- documents. The down stops and says what to do instead.
--
-- Safe to run by hand and twice: the refusal comes before any change, and
-- every constraint is dropped by name before it is added.

SET ROLE bib_owner;

DO $$
DECLARE
  owned int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'standard_document_block'
      AND column_name = 'issuing_entity_party_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM crm.standard_document_block
             WHERE issuing_entity_party_id IS NOT NULL' INTO owned;
    IF owned > 0 THEN
      RAISE EXCEPTION
        '0312 down: % standard line(s) belong to one of the firm''s companies. Without the column they would print on every company''s documents. Retire them (is_active = false) and copy what should stay into the default set, then run this again.',
        owned;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS crm.idx_std_block_issuer;
ALTER TABLE crm.standard_document_block
  DROP CONSTRAINT IF EXISTS std_block_issuing_entity_fkey;
ALTER TABLE crm.standard_document_block
  DROP COLUMN IF EXISTS issuing_entity_party_id;

ALTER TABLE crm.proposal_line
  DROP CONSTRAINT IF EXISTS proposal_line_proposal_fkey;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id, currency)
    REFERENCES crm.proposal (id, tenant_id, currency);

RESET ROLE;
