-- Down for 0058.
--
-- WHAT ROLLING BACK LOSES, STATED RATHER THAN DISCOVERED: every notice already
-- raised. The ledger keeps `work_item.escalated` and `obligation.escalated`
-- because it is append-only, so the HISTORY survives — but the sweep's own
-- memory does not, and re-applying this migration on a firm whose work is still
-- overdue will re-fire every rung it had already climbed. 0055's down loses a
-- partner's reason for the same kind of reason: a row is erasable and an event
-- is not, which is the whole arrangement §3.4 asks for.
--
-- The kind CHECK goes back to nine. A firm that published an `escalation` entry
-- would fail that constraint, so the entries are removed first — deliberately
-- and narrowly: only this kind, only its versions.

SET ROLE bib_owner;

DROP TABLE IF EXISTS delivery.escalation_notice;

DELETE FROM config.version
  WHERE entry_id IN (SELECT id FROM config.entry WHERE kind = 'escalation');
DELETE FROM config.entry WHERE kind = 'escalation';

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier', 'verification_policy',
                    'compliance_policy'));

RESET ROLE;
