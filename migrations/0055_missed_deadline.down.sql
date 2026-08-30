-- Down for 0055. Newest-first, IF EXISTS throughout.
--
-- Dropping these takes the writer for `obligation.missed` with them, so the
-- product returns to what T3.2 and 0054 shipped: a calendar that can show a
-- filing is late and has nowhere to record what was decided about it.
--
-- THE DECISIONS ALREADY RECORDED ARE DESTROYED by this, and that is worth
-- saying plainly rather than discovering. The ledger keeps `obligation.resolved`
-- so WHICH option was chosen survives — but the event deliberately does NOT
-- carry `resolution_reason`, because that is a partner's free text about a
-- client and may name a person, which §3.4 of the event contract keeps out of a
-- log that cannot be erased. So the reason exists in this column and nowhere
-- else, and this rollback is the one operation that loses it.
--
-- `compliance_policy` config entries are left in place. Dropping the kind from
-- the CHECK while rows still carry it would make the constraint unaddable, so
-- the constraint goes back to its 0048 form only after any such rows are gone —
-- and a firm that set a floor date should not lose it because a migration was
-- rolled back and re-applied.

SET ROLE bib_owner;

DELETE FROM config.version v
  USING config.entry e
  WHERE v.entry_id = e.id AND e.kind = 'compliance_policy';
DELETE FROM config.entry WHERE kind = 'compliance_policy';

ALTER TABLE config.entry DROP CONSTRAINT IF EXISTS entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier', 'verification_policy'));

DROP INDEX IF EXISTS delivery.idx_obligation_instance_undecided;

ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_resolution_tenant_fkey;
ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_resolution_chk;
ALTER TABLE delivery.obligation_instance
  DROP COLUMN IF EXISTS resolved_at,
  DROP COLUMN IF EXISTS resolution_reason,
  DROP COLUMN IF EXISTS resolution_option_id;

DROP TABLE IF EXISTS delivery.obligation_resolution_option;

DROP INDEX IF EXISTS delivery.idx_obligation_state_one_resolution;
DROP INDEX IF EXISTS delivery.idx_obligation_state_one_missed;

ALTER TABLE delivery.obligation_state
  DROP CONSTRAINT IF EXISTS obligation_state_one_destination_chk;
ALTER TABLE delivery.obligation_state
  DROP CONSTRAINT IF EXISTS obligation_state_resolution_chk;
ALTER TABLE delivery.obligation_state
  DROP CONSTRAINT IF EXISTS obligation_state_missed_chk;
ALTER TABLE delivery.obligation_state
  DROP COLUMN IF EXISTS is_resolution,
  DROP COLUMN IF EXISTS is_missed;

RESET ROLE;
