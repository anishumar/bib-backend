-- Reverses 0014. Dropping the columns takes the constraints with them.
SET ROLE bib_owner;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_share_token_after_draft_chk,
  DROP CONSTRAINT IF EXISTS proposal_views_are_consistent_chk;
ALTER TABLE crm.proposal
  DROP COLUMN IF EXISTS share_token_digest,
  DROP COLUMN IF EXISTS first_viewed_at,
  DROP COLUMN IF EXISTS view_count;

RESET ROLE;
