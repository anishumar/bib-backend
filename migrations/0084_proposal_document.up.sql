-- 0084 · The proposal as a document the firm sends — "Proposal For Services"
--
-- Until now a proposal was a screen and a share link, and nothing printed it:
-- the render source refused the kind by name. The firm's own proposal (10X
-- Global, September 2026) is a document of its own, not the engagement letter
-- with the signatures taken off:
--
--   page 1   a COVER — the firm's full-page artwork, with "Prepared for" (who
--            at which client) and "Prepared by" (who at which of the firm's
--            companies) printed over it;
--   then     Background, the in-scope services, the work in SECTIONS by the
--            firm's own Dept ("A. Financial Reporting & Compliance"), each
--            service under its catalogue code ("H3. Transfer pricing audit")
--            with its fee, a Summary of Fees, and Notes — the team, the general
--            exclusions and the commercials — under the firm's logo.
--
-- Three things on that document have nowhere to live today.
--
-- ── 1. WHAT THE PROPOSAL SAYS ABOUT THE CLIENT — `background` ───────────────
--
-- The paragraph the firm writes about the client's business. The letter has
-- had one since 0022, and it is the same prose: a quote accepted and written up
-- as a letter carries it across. Blank is refused, as the letter's is — ""
-- means somebody cleared the field, and the service stores NULL for that.
--
-- ── 2. WHO IT IS FOR AND WHO PREPARED IT — the two names on the cover ───────
--
-- `addressed_to_party_id` is the PERSON at the client it is written to — the
-- letter's column (0022), with the letter's rules: a person, recorded in the
-- client's structure (F-10-1), checked by the service against the same read
-- that fills the picker. It carries the tenant like every reference here. NOT
-- behind 0305's archived-party wall, deliberately, the letter's care-of
-- person's position: it is a contact on an existing document, not a new
-- commercial reference to a client.
--
-- `prepared_by_user_id` is the colleague whose name, company and email the
-- cover prints. It references the GLOBAL `tenancy.user_account`, so the key
-- carries no tenant — the service is what holds it to an active STAFF member of
-- THIS firm, as `discount_approved_by` is held. Drafting sets it to whoever
-- drafted; a draft may hand it to a colleague.
--
-- EXISTING PROPOSALS ARE BACKFILLED FROM THE LEDGER, which is the one place
-- that already knows: `proposal.drafted` names its actor. It is a fact, not a
-- default — "prepared by" is exactly who drafted it — and a proposal whose
-- drafter was not a person (an import, the system) or whose account no longer
-- resolves stays NULL, which the cover prints as no person at all.
--
-- ── 3. THE COVER ARTWORK — brand asset kind `proposal_cover` ────────────────
--
-- A full-page image, per ISSUING ENTITY like every brand asset (G1.2 applied to
-- paper): the cover is the firm's own design, with its logo and "Proposal For
-- Services" drawn into it, and a firm on two letterheads has two. Drawn as an
-- image, so the service refuses anything but PNG and JPEG at upload, as it
-- does a logo. Superseding, never editing — the brand-asset rule since 0037.
--
-- NOT a term and not frozen: a proposal is an offer, re-rendered whenever the
-- firm presses the button, and none of these columns is evidence the way a
-- signed letter's are.

SET ROLE bib_owner;

ALTER TABLE crm.proposal
  ADD COLUMN background            text,
  ADD COLUMN addressed_to_party_id uuid,
  ADD COLUMN prepared_by_user_id   uuid;

ALTER TABLE crm.proposal
  ADD CONSTRAINT proposal_background_not_blank_chk
    CHECK (background IS NULL OR btrim(background) <> ''),
  ADD CONSTRAINT proposal_addressed_to_tenant_fkey
    FOREIGN KEY (addressed_to_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  ADD CONSTRAINT proposal_prepared_by_fkey
    FOREIGN KEY (prepared_by_user_id) REFERENCES tenancy.user_account (id);

-- Partial: most proposals will carry an addressee, and "every proposal to this
-- person" is the question a contact's page asks.
CREATE INDEX idx_proposal_addressed_to
  ON crm.proposal (tenant_id, addressed_to_party_id)
  WHERE addressed_to_party_id IS NOT NULL;

-- The drafter, off the ledger — see (2). One row per proposal: `proposal.drafted`
-- is written once, by `ProposalService.draft`.
UPDATE crm.proposal p
   SET prepared_by_user_id = e.actor_id
  FROM ledger.event e
 WHERE e.tenant_id = p.tenant_id
   AND e.object_id = p.id
   AND e.verb = 'proposal.drafted'
   AND e.actor_type = 'human'
   AND p.prepared_by_user_id IS NULL
   AND EXISTS (SELECT 1 FROM tenancy.user_account u WHERE u.id = e.actor_id);

ALTER TABLE files.brand_asset DROP CONSTRAINT brand_asset_kind_check;
ALTER TABLE files.brand_asset
  ADD CONSTRAINT brand_asset_kind_check
    CHECK (kind IN ('logo', 'signature', 'letterhead', 'proposal_cover'));

COMMENT ON COLUMN crm.proposal.background IS
  'The firm''s paragraph about the client''s business — the proposal''s Background. NULL when unwritten; blank is refused (proposal_background_not_blank_chk).';
COMMENT ON COLUMN crm.proposal.addressed_to_party_id IS
  'The PERSON at the client the proposal is written to, printed under "Prepared for". Held to a person in the client''s structure by the service (F-10-1). Carries the tenant.';
COMMENT ON COLUMN crm.proposal.prepared_by_user_id IS
  'The colleague printed under "Prepared by" — set to the drafter at drafting, reassignable on a draft. GLOBAL target, so the service holds it to active staff of this firm.';

RESET ROLE;
