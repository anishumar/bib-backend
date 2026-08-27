-- Down for 0001. Drops everything this migration created inside the tenancy
-- schema — tables, triggers, the trigger function, and the RLS policy fall with
-- the schema via CASCADE.
--
-- Deliberately does NOT drop:
--   * roles bib_owner / bib_app  — cluster-level, ensured by cmd/migrate and
--                                  (in prod) provisioned by DevOps
--   * extensions pgcrypto / citext — shared cluster objects other schemas rely on
-- A per-service down must never remove infrastructure other schemas depend on.

DROP SCHEMA IF EXISTS tenancy CASCADE;
