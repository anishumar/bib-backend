-- 0318 down · Recurring billing dues. Destroys every due and every invoice's
-- manager; run only against a database somebody is trying to rescue.

SET ROLE bib_owner;

DROP TABLE crm.billing_due;

ALTER TABLE crm.invoice_line DROP CONSTRAINT invoice_line_id_tenant_key;
ALTER TABLE crm.engagement_letter_fee_group DROP CONSTRAINT el_fee_group_id_tenant_key;

DROP TRIGGER trg_invoice_z_manager_freeze ON crm.invoice;
DROP FUNCTION crm.refuse_issued_invoice_manager_change();
ALTER TABLE crm.invoice DROP COLUMN manager_user_id;

ALTER TABLE crm.engagement
  DROP CONSTRAINT engagement_billing_schedule_chk,
  DROP COLUMN paused_on,
  DROP COLUMN first_invoice_on,
  DROP COLUMN billing_from;

ALTER TABLE tenancy.tenant DROP COLUMN auto_billing;

RESET ROLE;
