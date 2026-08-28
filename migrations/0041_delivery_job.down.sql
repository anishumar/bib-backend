-- Down for 0041. Newest-first, IF EXISTS throughout.
--
-- The `delivery` schema goes with it, because 0041 created it and nothing else
-- lives there yet. `pgboss` is NOT touched: pg-boss owns that schema, creates it
-- itself, and it holds queue state that has nothing to do with this table —
-- dropping it here would take another component's data with a migration that
-- never created it.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_job_updated_at ON delivery.job;
DROP POLICY IF EXISTS job_isolation ON delivery.job;
DROP INDEX IF EXISTS delivery.idx_job_runnable;
DROP TABLE IF EXISTS delivery.job;
DROP FUNCTION IF EXISTS delivery.set_updated_at();
DROP SCHEMA IF EXISTS delivery;

RESET ROLE;
