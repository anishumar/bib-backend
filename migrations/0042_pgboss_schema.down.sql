-- Down for 0042.
--
-- DROPS THE QUEUE'S TABLES WITH IT — CASCADE is not decoration here. pg-boss
-- created everything inside this schema, so a plain DROP SCHEMA would fail while
-- its tables exist, and there is no other migration that knows how to remove
-- them. Anything still queued goes; nothing in there is a business fact (the
-- jobs that matter are `delivery.job`, which 0041 owns), but work scheduled and
-- not yet run WILL be lost. The next worker start reinstalls a fresh schema, and
-- the spawn sweep rediscovers its backlog from the ledger.

SET ROLE bib_owner;
DROP SCHEMA IF EXISTS pgboss CASCADE;
RESET ROLE;
