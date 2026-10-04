-- Down for 0343. Newest-first, IF EXISTS throughout.
--
-- The tenant's default pair stays exactly as it is: it was 0022's before this
-- migration and remains a valid both-or-neither pair after the key onto the
-- list goes. Every other entry on the list, every signatory's own image and
-- every draft's choice are lost, which is the honest consequence of undoing it:
-- they live nowhere else. Letters already SENT are untouched, because their
-- record is 0022's and 0081's snapshot columns, not the choice.

SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_chosen_signatory_tenant_fkey;
ALTER TABLE crm.engagement_letter
  DROP COLUMN IF EXISTS chosen_signatory_id;

ALTER TABLE tenancy.tenant
  DROP CONSTRAINT IF EXISTS tenant_default_signatory_listed_fkey;

DROP TRIGGER IF EXISTS trg_firm_signatory_updated_at ON tenancy.firm_signatory;
DROP POLICY IF EXISTS firm_signatory_isolation ON tenancy.firm_signatory;
DROP TABLE IF EXISTS tenancy.firm_signatory;

RESET ROLE;
