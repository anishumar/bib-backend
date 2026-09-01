-- Down for 0065.
--
-- The two tables go, and with them every freeze a firm has recorded and every
-- reminder it has sent — the honest consequence of rolling back a feature.
--
-- ── THE KIND CHECK IS PUT BACK, AND IT WILL FAIL IF IT MUST ──────────────
--
-- Narrowing `config.entry.kind` again is refused by the database if any firm has
-- published a `chaser` ladder, because `ADD CONSTRAINT ... CHECK` validates
-- existing rows. That is deliberate and it is 0063's shape: a rollback that
-- silently dropped those entries would delete a firm's own written-down chasing
-- policy, and a published config version is exactly the thing this schema treats
-- as frozen. Better to fail loudly and make somebody decide.

SET ROLE bib_owner;

DROP TABLE IF EXISTS delivery.client_ask_chase;
DROP TABLE IF EXISTS crm.client_freeze;

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation'
]));

RESET ROLE;
