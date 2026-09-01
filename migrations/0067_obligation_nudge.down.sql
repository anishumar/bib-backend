-- Down for 0067.
--
-- ── THE ORDER IS THE WHOLE OF THIS FILE, AND THE FIRST DRAFT GOT IT WRONG ──
--
-- The obvious order is: drop the table, drop the composite key, then narrow
-- `entry_kind_check` back to 0065's list. Run against a database where a firm
-- has published a `nudge` entry — which the demo does — that sequence DESTROYS
-- THE TABLE, destroys the key, and only then discovers it cannot narrow the
-- CHECK, leaving the schema in a state neither migration describes and the
-- constraint missing entirely. 0066's own down carries a paragraph about
-- exactly this failure; this file made it, which is why it is written down.
--
-- So it runs in the opposite order, and the CHECK is swapped rather than
-- replaced:
--
--   1. ADD the narrow constraint under a temporary name. If any row uses
--      'nudge', THIS is where the down stops — with nothing dropped, nothing
--      lost, and a message naming the constraint. Refusing is correct: the
--      check is telling the truth about rows that exist, and the fix is to
--      withdraw the entry rather than to loosen the check.
--   2. Only then drop the old one and rename the new into its place.
--   3. Only then drop the table and the key, by which point nothing can fail.
--
-- `npm run migrate` wraps each file in a transaction, so through the migrator
-- the first draft would have rolled back. A DOWN is routinely run by hand,
-- against a database somebody is trying to rescue, and that is the case it has
-- to be safe in.

SET ROLE bib_owner;

-- 1 · the refusal happens HERE, before anything is destroyed.
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check_pre_0067 CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation',
  'chaser'
]));

-- 2 · swap it into place. Both statements are safe once the ADD above passed.
ALTER TABLE config.entry DROP CONSTRAINT IF EXISTS entry_kind_check;
ALTER TABLE config.entry RENAME CONSTRAINT entry_kind_check_pre_0067 TO entry_kind_check;

-- 3 · and only now the rows. The table goes before the unique constraint it
-- depends on: a foreign key keeps that constraint alive, so the reverse fails.
DROP TABLE IF EXISTS delivery.obligation_nudge;

ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_id_entity_tenant_key;

RESET ROLE;
