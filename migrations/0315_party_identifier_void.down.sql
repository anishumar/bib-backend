-- 0315 down · identifiers cannot be voided.
--
-- REFUSES while any identifier is voided: the schema before 0315 would read it
-- as an open identifier again, and it would block the corrected value.

SET ROLE bib_owner;

DO $$
DECLARE
  voided int;
BEGIN
  SELECT count(*) INTO voided FROM core.party_identifier WHERE voided_at IS NOT NULL;
  IF voided > 0 THEN
    RAISE EXCEPTION
      '0315 down refused: % voided identifier(s) would count as live again. Fix forward with a new migration instead.',
      voided;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_party_identifier_voided_final ON core.party_identifier;
DROP FUNCTION IF EXISTS core.refuse_change_to_voided_identifier();
DROP INDEX IF EXISTS core.idx_party_identifier_open;
ALTER TABLE core.party_identifier
  DROP CONSTRAINT IF EXISTS party_identifier_voided_by_needs_stamp,
  DROP CONSTRAINT IF EXISTS party_identifier_voided_by_fkey,
  DROP COLUMN IF EXISTS voided_by_user_id,
  DROP COLUMN IF EXISTS voided_at;

RESET ROLE;
