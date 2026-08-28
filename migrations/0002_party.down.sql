-- Reverse of 0002. Dropping the schema takes its tables, policies, triggers and
-- indexes with it. The pg_trgm extension is cluster-level and left in place.
DROP SCHEMA IF EXISTS core CASCADE;
