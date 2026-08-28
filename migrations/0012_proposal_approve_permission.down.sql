-- Reverses 0012: put back whichever version this migration archived, and
-- archive the one it published.
--
-- Only for versions this migration itself created — identified by being
-- published, carrying `proposal:approve`, and sitting directly on top of an
-- archived version that is the old default. A firm that has published its own
-- role since is left alone, in both directions.
SET ROLE bib_owner;

CREATE TEMP TABLE role_downgrade ON COMMIT DROP AS
SELECT added.id AS added_id, prior.id AS prior_id
FROM config.version added
JOIN config.entry e ON e.id = added.entry_id AND e.kind = 'role' AND e.key = 'partner'
JOIN config.version prior
  ON prior.entry_id = added.entry_id
 AND prior.status   = 'archived'
 AND prior.body     = '{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin"]}'::jsonb
WHERE added.status = 'published'
  AND added.body @> '{"permissions":["proposal:approve"]}'::jsonb;

-- Archive the one we added first: only one version per entry may be published.
UPDATE config.version
   SET status = 'archived', archived_at = now()
 WHERE id IN (SELECT added_id FROM role_downgrade);

UPDATE config.version
   SET status = 'published', archived_at = NULL
 WHERE id IN (SELECT prior_id FROM role_downgrade);

RESET ROLE;
