-- 0384 down · `request_template` goes back out of `entry_kind_check`.
--
-- Refused while any `config.entry` row has the kind, rather than deleted or
-- relabelled: a request template is a list a firm wrote, its published
-- versions are frozen (0005), and asks may be pinned to them (0385). Withdraw
-- them deliberately first, or leave this migration applied.
--
-- The refusal comes BEFORE the constraint is touched, in 0067's order: a down
-- is run by hand against a database somebody is trying to rescue, and one that
-- dropped the CHECK and then failed to add the narrow one would leave the table
-- with no CHECK at all.

SET ROLE bib_owner;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM config.entry WHERE kind = 'request_template';
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0384: % request_template entries exist, and narrowing entry_kind_check would leave rows violating it. These are lists a firm wrote of what to ask its clients for. Remove them deliberately first, or leave this migration applied.', n;
  END IF;
END $$;

ALTER TABLE config.entry DROP CONSTRAINT IF EXISTS entry_kind_check;
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation',
  'chaser', 'nudge'
]));

RESET ROLE;
