-- Reverse of 0005. Dropping the schema takes its tables, policies, triggers,
-- functions and indexes with it. The seeded role rows go with them — after this
-- runs, no tenant has a role definition and gate 3 refuses everyone, which is
-- the correct fail-closed answer for a database that no longer knows its roles.
DROP SCHEMA IF EXISTS config CASCADE;
