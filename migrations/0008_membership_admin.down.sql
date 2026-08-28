-- Reverse of 0008. Dropping display_name loses the names that were entered —
-- there is nowhere else they are held — so this is a down for a mistaken deploy,
-- not a routine step.
SET ROLE bib_owner;

DROP INDEX IF EXISTS tenancy.idx_membership_tenant_active;
ALTER TABLE tenancy.user_account DROP COLUMN IF EXISTS display_name;

RESET ROLE;
