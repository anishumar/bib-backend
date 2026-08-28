-- Reverse of 0003. Dropping the schema takes the event table, its policy,
-- triggers, indexes and the reject_mutation function with it. Nothing
-- cluster-level (roles, extensions) is touched — other schemas depend on those.
--
-- Note what this means in practice: rolling 0003 back DESTROYS the audit trail.
-- It is here because every up has a down, and it is safe only on an environment
-- whose history is disposable.
DROP SCHEMA IF EXISTS ledger CASCADE;
