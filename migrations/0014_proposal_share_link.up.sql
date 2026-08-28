-- 0014 · the share link, and what a view is
--
-- The TRACK half of "send/track (views, expiry)". A proposal goes to somebody
-- who does not have a login and will not get one — that is what a proposal IS,
-- the document that comes before the relationship — so the link they open is a
-- bearer capability rather than a session.
--
-- THE TOKEN CARRIES ITS TENANT, and that is the load-bearing decision here.
-- A share link is looked up with no session and therefore no `app.tenant_id`,
-- so the obvious design — find the proposal by digest across all firms — needs
-- a read that RLS does not scope, which is exactly the thing the tenant wall
-- exists to forbid. Instead the token is `<tenant_id>.<secret>`: the reader
-- parses the tenant out of it, opens the ordinary `withTenant` transaction, and
-- the lookup is scoped like every other query in the product. The tenant id is
-- not a secret — anybody holding the token already holds a capability into that
-- firm — and the price of learning it is a uuid, while the price of the
-- alternative is a policy exception on a table that holds money.
--
-- ONLY THE DIGEST IS STORED, like sessions and magic links (0004). A leaked
-- backup then contains no link anyone can open.
--
-- A VIEW IS A COUNT AND ONE EVENT. `view_count` rises on every open, because
-- "they have opened it four times" is real commercial signal; `proposal.viewed`
-- is recorded ONCE, on the first, because the ledger holds state transitions and
-- a client refreshing a page fifty times is not fifty facts about the business.
-- That split is deliberate: per-view analytics does not belong in an
-- append-only log that also has to stay readable.

SET ROLE bib_owner;

ALTER TABLE crm.proposal
  -- SHA-256 hex of the whole token. Unique because a digest collision would
  -- mean one link opening two firms' proposals.
  ADD COLUMN share_token_digest text UNIQUE
             CHECK (share_token_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN first_viewed_at timestamptz,
  ADD COLUMN view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0);

ALTER TABLE crm.proposal
  -- A draft has not been sent, so there is nothing to open. Issuing the token
  -- at SEND rather than at draft means a quote that never went out never had a
  -- reachable link, which is one fewer thing to revoke.
  ADD CONSTRAINT proposal_share_token_after_draft_chk CHECK (
    (status =  'draft' AND share_token_digest IS NULL) OR
    (status <> 'draft')
  ),
  -- The two view columns agree with each other: a proposal that has been
  -- opened has a date for the first time, and one that has not has neither.
  ADD CONSTRAINT proposal_views_are_consistent_chk CHECK (
    (view_count = 0 AND first_viewed_at IS NULL) OR
    (view_count > 0 AND first_viewed_at IS NOT NULL)
  );

RESET ROLE;
