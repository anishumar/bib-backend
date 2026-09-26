-- 0084 down · The proposal as a document the firm sends
--
-- The narrow brand-asset CHECK goes on FIRST, under a temporary name, so a
-- database holding a proposal cover refuses the down BEFORE anything is
-- dropped (0067's lesson: a refusal after the drops leaves no constraint at
-- all). Put the covers away by hand first if the down is really wanted.

SET ROLE bib_owner;

ALTER TABLE files.brand_asset
  ADD CONSTRAINT brand_asset_kind_check_0084_down
    CHECK (kind IN ('logo', 'signature', 'letterhead'));
ALTER TABLE files.brand_asset DROP CONSTRAINT IF EXISTS brand_asset_kind_check;
ALTER TABLE files.brand_asset
  RENAME CONSTRAINT brand_asset_kind_check_0084_down TO brand_asset_kind_check;

DROP INDEX IF EXISTS crm.idx_proposal_addressed_to;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_prepared_by_fkey,
  DROP CONSTRAINT IF EXISTS proposal_addressed_to_tenant_fkey,
  DROP CONSTRAINT IF EXISTS proposal_background_not_blank_chk,
  DROP COLUMN IF EXISTS prepared_by_user_id,
  DROP COLUMN IF EXISTS addressed_to_party_id,
  DROP COLUMN IF EXISTS background;

RESET ROLE;
