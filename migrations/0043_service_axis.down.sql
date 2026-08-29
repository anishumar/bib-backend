-- Down for 0043. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `tenancy.set_updated_at` is 0001's and every table in the schema uses
-- it, so the trigger goes and the function stays.
--
-- Undoing this takes the firm's Dept and team LISTS with it, and its choice of
-- how work is split. Neither is a loss of catalogue data: the codes themselves
-- live on in every service body that named them, which is where they were
-- before this migration and is why the backfill could reconstruct them at all.
-- What is lost is the display names somebody typed and the active flags — those
-- exist nowhere else, and that is the honest consequence of undoing this rather
-- than something to work around.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  DROP CONSTRAINT IF EXISTS tenant_work_split_axis_chk;

ALTER TABLE tenancy.tenant
  DROP COLUMN IF EXISTS work_split_axis;

DROP TRIGGER IF EXISTS trg_service_axis_updated_at ON tenancy.service_axis;
DROP POLICY IF EXISTS service_axis_isolation ON tenancy.service_axis;
DROP INDEX IF EXISTS tenancy.idx_service_axis_tenant_axis_order;
DROP TABLE IF EXISTS tenancy.service_axis;

RESET ROLE;
