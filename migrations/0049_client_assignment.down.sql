-- Down for 0049. Newest-first, IF EXISTS throughout.
--
-- What this loses, stated plainly: `crm.client_assignment` is the ONLY record of
-- who owned a client and who they talked to, and it is effective-dated — so
-- dropping it takes the history with it, not just today's answer. "Who was the
-- SPOC in March" becomes unanswerable again, which is the thing 0049 exists to
-- fix. That is the honest consequence of undoing this rather than something to
-- work around.
--
-- `btree_gist` is deliberately NOT dropped. Extensions are database-wide and
-- cheap, another migration may already depend on one, and DROP EXTENSION would
-- cascade into whatever does. Leaving it costs a catalogue row.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_client_assignment_updated_at ON crm.client_assignment;
DROP POLICY IF EXISTS client_assignment_isolation ON crm.client_assignment;
DROP INDEX IF EXISTS crm.idx_client_assignment_user_open;
DROP INDEX IF EXISTS crm.idx_client_assignment_client;
DROP TABLE IF EXISTS crm.client_assignment;

RESET ROLE;
