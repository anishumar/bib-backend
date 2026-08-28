-- Down for 0040. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `tenancy.set_updated_at` is 0001's and every table in the schema uses
-- it, so the trigger goes and the function stays.
--
-- Dropping the column takes the grades off every membership with it. That is
-- the honest consequence of undoing this migration rather than something to
-- work around: the grades live nowhere else, so there is nothing to preserve
-- them into.

SET ROLE bib_owner;

ALTER TABLE tenancy.membership
  DROP CONSTRAINT IF EXISTS membership_grade_tenant_fkey;

ALTER TABLE tenancy.membership
  DROP COLUMN IF EXISTS grade_id;

DROP TRIGGER IF EXISTS trg_staff_grade_updated_at ON tenancy.staff_grade;
DROP POLICY IF EXISTS staff_grade_isolation ON tenancy.staff_grade;
DROP INDEX IF EXISTS tenancy.idx_staff_grade_tenant_rank;
DROP TABLE IF EXISTS tenancy.staff_grade;

RESET ROLE;
