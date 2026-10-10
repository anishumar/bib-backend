-- 0383 down · `books_input` goes back out of both lists.
--
-- Refused while any row uses it rather than relabelled: turning a client's
-- books files into `other` behind everybody's back would change what fin and
-- the screens do with them. Re-file them first if a rollback is really meant.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM files.document WHERE kind = 'books_input')
     OR EXISTS (SELECT 1 FROM delivery.client_ask WHERE document_kind = 'books_input') THEN
    RAISE EXCEPTION '0383 down: documents or asks still use the books_input kind; re-file them before rolling back';
  END IF;
END $$;

ALTER TABLE files.document DROP CONSTRAINT document_kind_check;
ALTER TABLE files.document ADD CONSTRAINT document_kind_check CHECK (kind IN (
  'proposal', 'engagement_letter', 'invoice', 'credit_note',
  'identity_proof', 'statutory_filing', 'working_paper',
  'correspondence', 'brand_asset', 'other'
));

ALTER TABLE delivery.client_ask DROP CONSTRAINT client_ask_document_kind_check;
ALTER TABLE delivery.client_ask ADD CONSTRAINT client_ask_document_kind_check CHECK (document_kind IN (
  'proposal', 'engagement_letter', 'invoice', 'credit_note',
  'identity_proof', 'statutory_filing', 'working_paper',
  'correspondence', 'brand_asset', 'other'
));

RESET ROLE;
