-- Down for 0022. Newest-first, IF EXISTS everywhere, and it drops nothing
-- shared: `tenancy.user_account` and `core.party` are only referenced here, and
-- `crm.refuse_signed_change()` (0019) is untouched — this migration never
-- widened the freeze's allow-list, so there is nothing to put back.
--
-- What this loses, stated plainly because a down migration that quietly
-- destroys evidence is worse than one that refuses: every background paragraph,
-- addressee, issue date, lineage link, firm signature block, effective date and
-- declined reason recorded since 0022 ran. The columns are the only place those
-- facts live.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  DROP CONSTRAINT IF EXISTS tenant_firm_signatory_is_whole_chk,
  DROP CONSTRAINT IF EXISTS tenant_firm_signatory_title_not_blank_chk,
  DROP COLUMN IF EXISTS firm_signatory_title,
  DROP COLUMN IF EXISTS firm_signatory_user_id;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_declined_reason_when_rejected_chk,
  DROP CONSTRAINT IF EXISTS proposal_declined_reason_not_blank_chk,
  DROP COLUMN IF EXISTS declined_reason;

DROP INDEX IF EXISTS crm.idx_engagement_effective;
ALTER TABLE crm.engagement
  DROP COLUMN IF EXISTS effective_from;

ALTER TABLE crm.engagement_letter_line
  DROP COLUMN IF EXISTS effective_from;

DROP TRIGGER IF EXISTS trg_el_supersedes ON crm.engagement_letter;
DROP FUNCTION IF EXISTS crm.refuse_bad_supersedes();
DROP INDEX IF EXISTS crm.el_one_live_successor_per_letter;

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_firm_signature_is_whole_chk,
  DROP CONSTRAINT IF EXISTS el_supersedes_not_self_chk,
  DROP CONSTRAINT IF EXISTS el_supersedes_tenant_fkey,
  DROP CONSTRAINT IF EXISTS el_addressed_to_tenant_fkey,
  DROP CONSTRAINT IF EXISTS el_firm_signatory_title_not_blank_chk,
  DROP CONSTRAINT IF EXISTS el_signed_by_title_not_blank_chk,
  DROP CONSTRAINT IF EXISTS el_background_not_blank_chk,
  DROP COLUMN IF EXISTS firm_signed_at,
  DROP COLUMN IF EXISTS firm_signatory_title,
  DROP COLUMN IF EXISTS firm_signatory_user_id,
  DROP COLUMN IF EXISTS signed_by_title,
  DROP COLUMN IF EXISTS effective_from,
  DROP COLUMN IF EXISTS supersedes_id,
  DROP COLUMN IF EXISTS issued_on,
  DROP COLUMN IF EXISTS addressed_to_party_id,
  DROP COLUMN IF EXISTS background;

RESET ROLE;
