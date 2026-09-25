-- 0303 down · drop the lineage wall. The calendar rows keep their template;
-- nothing a firm can see changes, and duplicates become possible again.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS obligation_instance_lineage ON delivery.obligation_instance;
DROP FUNCTION IF EXISTS delivery.obligation_instance_lineage();
ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_lineage_key,
  DROP CONSTRAINT IF EXISTS obligation_instance_lineage_tenant_fkey,
  DROP COLUMN IF EXISTS lineage_id;

DROP TRIGGER IF EXISTS obligation_template_lineage ON delivery.obligation_template;
DROP FUNCTION IF EXISTS delivery.obligation_template_lineage();
ALTER TABLE delivery.obligation_template
  DROP CONSTRAINT IF EXISTS obligation_template_id_lineage_tenant_key,
  DROP CONSTRAINT IF EXISTS obligation_template_lineage_tenant_fkey,
  DROP COLUMN IF EXISTS lineage_id;

RESET ROLE;
