-- 0320 down · The advance and the final bill. Destroys every advance and final
-- bill, every per-service advance on a letter, and refuses while a credit note
-- carries the reason advance_refund (it would no longer be a reason).

SET ROLE bib_owner;

ALTER TABLE crm.credit_note DROP CONSTRAINT credit_note_reason_check;
ALTER TABLE crm.credit_note
  ADD CONSTRAINT credit_note_reason_check
    CHECK (reason IN ('service_failure', 'billing_error', 'goodwill',
                      'scope_change', 'duplicate_invoice', 'bad_debt'));

DELETE FROM crm.billing_due WHERE kind <> 'period';

DROP INDEX crm.idx_billing_due_advance_invoice;
DROP INDEX crm.billing_due_fee_group_final;
DROP INDEX crm.billing_due_engagement_final;
DROP INDEX crm.billing_due_engagement_advance;
DROP INDEX crm.billing_due_letter_advance;
DROP INDEX crm.billing_due_fee_group_period;
DROP INDEX crm.billing_due_engagement_period;
CREATE UNIQUE INDEX billing_due_engagement_period
  ON crm.billing_due (tenant_id, engagement_id, period_start) WHERE engagement_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_fee_group_period
  ON crm.billing_due (tenant_id, fee_group_id, period_start) WHERE fee_group_id IS NOT NULL;

ALTER TABLE crm.billing_due
  DROP CONSTRAINT billing_due_refund_waived_chk,
  DROP CONSTRAINT billing_due_released_chk,
  DROP CONSTRAINT billing_due_covered_chk,
  DROP CONSTRAINT billing_due_advance_applied_chk,
  DROP CONSTRAINT billing_due_advance_invoice_fkey,
  DROP CONSTRAINT billing_due_letter_fkey,
  DROP CONSTRAINT billing_due_one_subject_chk;
ALTER TABLE crm.billing_due
  ADD CONSTRAINT billing_due_one_subject_chk CHECK ((engagement_id IS NULL) <> (fee_group_id IS NULL));

ALTER TABLE crm.billing_due
  DROP COLUMN refund_waive_reason,
  DROP COLUMN refund_waived_by_user_id,
  DROP COLUMN refund_waived_at,
  DROP COLUMN released_by_user_id,
  DROP COLUMN released_how,
  DROP COLUMN released_at,
  DROP COLUMN covered_at,
  DROP COLUMN advance_applied,
  DROP COLUMN advance_invoice_id,
  DROP COLUMN engagement_letter_id,
  DROP COLUMN kind;

DROP TRIGGER trg_el_z_one_kind_of_advance ON crm.engagement_letter;
DROP FUNCTION crm.refuse_letter_advance_beside_line_advance();
DROP TRIGGER trg_el_line_z_one_kind_of_advance ON crm.engagement_letter_line;
DROP FUNCTION crm.refuse_line_advance_beside_letter_advance();

ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT el_line_grouped_has_no_advance_chk,
  DROP CONSTRAINT el_line_advance_amount_chk,
  DROP COLUMN advance_amount;

RESET ROLE;
