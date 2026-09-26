-- 0085 · A proposal emailed to the client, and the client's own answer
--
-- Until now bib handed the firm a link at Send and the firm emailed it; the
-- link was READ-ONLY and a colleague recorded what the client said. Decided
-- 2026-09-26 (user): bib emails the proposal itself — the PDF attached, with
-- Accept and Decline buttons — and the client answers on the link's page,
-- confirming an acceptance with their name and a tick against a statement.
--
-- Three things that decision needs, and nothing here stores the link itself:
-- the token is still only a digest, on the proposal row, as 0014 made it.
--
-- ── 1. THE PDF OF RECORD — `crm.proposal.sent_pdf_version_id` ───────────────
--
-- The one rendered file the client was sent: the email's attachment, the
-- link's download, and what an answer is recorded against. PINNED rather than
-- re-rendered on demand, because a render reads the firm's brand assets as they
-- stand today, and "the proposal they accepted" must not change when somebody
-- uploads a new logo. Set once — the first time a sent proposal needs its PDF —
-- and never on a draft, which has not been sent anything.
--
-- ── 2. EACH EMAIL BIB SENT — `crm.proposal_email` ───────────────────────────
--
-- Where it went, when, with which note, which PDF, and the DIGEST of the link
-- it carried — so an answer given through a link can say which email it came
-- from. An email is only written once the mail server has taken it: a letter
-- the relay refused is told to the person who pressed the button, on the spot.
--
-- ── 3. THE CLIENT'S ANSWER — `crm.proposal_client_decision` ─────────────────
--
-- The evidence behind a status the client set themselves: the name they typed,
-- the exact statement they ticked (acceptances only), the email whose link they
-- used, the PDF of record at that moment, and the address and browser the
-- answer came from. One per proposal, because an answer is final (0011: the
-- decided statuses are terminal). A decision a COLLEAGUE records has no row
-- here — the ledger names that actor, and a colleague is not evidence of what
-- a client agreed to.
--
-- ── WHAT IS PERSONAL AND WHERE IT STAYS ──────────────────────────────────────
--
-- Addresses, names, IP addresses and user agents are personal data. They live
-- in these erasable rows and NEVER in the ledger, the rule 0080 follows for a
-- letter's signer: `proposal.emailed` carries the email's id and the PDF's
-- hash, and the decision events say only that the answer came through the link.
SET ROLE bib_owner;

-- ── 1 ────────────────────────────────────────────────────────────────────────
ALTER TABLE crm.proposal
  ADD COLUMN sent_pdf_version_id uuid,
  -- The tenant travels with the reference (the tenant wall): an id-only key
  -- would let one firm's proposal cite another firm's file.
  ADD CONSTRAINT proposal_sent_pdf_fkey
    FOREIGN KEY (sent_pdf_version_id, tenant_id)
    REFERENCES files.document_version (id, tenant_id),
  ADD CONSTRAINT proposal_sent_pdf_after_draft_chk CHECK (
    sent_pdf_version_id IS NULL OR status <> 'draft'
  );

-- ── 2 ────────────────────────────────────────────────────────────────────────
CREATE TABLE crm.proposal_email (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenancy.tenant (id),
  proposal_id    uuid NOT NULL,
  -- The same shape 0080 holds a signer's address to. Deliverability is the
  -- mail server's to judge; this refuses only what is not an address at all.
  to_email       text NOT NULL CHECK (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- The colleague's own words above the standard letter. NULL when they wrote
  -- none; blank is refused, as every optional prose column here refuses it.
  note           text CHECK (note IS NULL OR btrim(note) <> ''),
  pdf_version_id uuid NOT NULL,
  link_digest    text NOT NULL CHECK (link_digest ~ '^[0-9a-f]{64}$'),
  sent_by        uuid REFERENCES tenancy.user_account (id),
  sent_at        timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_email_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT proposal_email_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  CONSTRAINT proposal_email_pdf_fkey
    FOREIGN KEY (pdf_version_id, tenant_id) REFERENCES files.document_version (id, tenant_id)
);

-- What the proposal page reads: this proposal's emails, newest first.
CREATE INDEX idx_proposal_email_proposal
  ON crm.proposal_email (tenant_id, proposal_id, sent_at DESC);

ALTER TABLE crm.proposal_email ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_email_isolation ON crm.proposal_email
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- UPDATE is for erasure, which rewrites personal data in place; nothing in the
-- product edits an email after it went.
GRANT SELECT, INSERT, UPDATE ON crm.proposal_email TO bib_app;

-- ── 3 ────────────────────────────────────────────────────────────────────────
CREATE TABLE crm.proposal_client_decision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenancy.tenant (id),
  proposal_id    uuid NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  signer_name    text NOT NULL CHECK (length(btrim(signer_name)) > 0),
  -- The sentence beside the tick box, word for word, as the page showed it.
  -- An acceptance always has one and a decline never does: the tick is what
  -- turns a click into a statement, and declining asks for no statement.
  statement      text CHECK (statement IS NULL OR btrim(statement) <> ''),
  -- Which of bib's emails carried the link that was used. NULL when the link
  -- reached the client some other way — copied from the page and sent by hand.
  email_id       uuid,
  -- The PDF of record when they answered. NULL only when none could be filed,
  -- which is a render failing — the answer is not refused for that.
  pdf_version_id uuid,
  -- As the API derived them for rate limiting (see api/ratelimit.ts), so the
  -- address here is the one this deployment trusts. Text, not inet: an
  -- unknown address is NULL, never a guess, and nothing queries these as
  -- addresses.
  ip_address     text CHECK (ip_address IS NULL OR length(ip_address) <= 64),
  user_agent     text CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  decided_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_client_decision_one_per_proposal UNIQUE (tenant_id, proposal_id),
  CONSTRAINT proposal_client_decision_statement_chk CHECK (
    (decision = 'accepted') = (statement IS NOT NULL)
  ),
  CONSTRAINT proposal_client_decision_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  CONSTRAINT proposal_client_decision_email_fkey
    FOREIGN KEY (email_id, tenant_id) REFERENCES crm.proposal_email (id, tenant_id),
  CONSTRAINT proposal_client_decision_pdf_fkey
    FOREIGN KEY (pdf_version_id, tenant_id) REFERENCES files.document_version (id, tenant_id)
);

ALTER TABLE crm.proposal_client_decision ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_client_decision_isolation ON crm.proposal_client_decision
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON crm.proposal_client_decision TO bib_app;

COMMENT ON COLUMN crm.proposal.sent_pdf_version_id IS
  'The PDF of record (0085): the one rendered file the client was sent — the email attachment, the link''s download, and what an answer is recorded against. Pinned once, never on a draft.';
COMMENT ON TABLE crm.proposal_email IS
  'Each email bib sent a proposal in (0085): where, when, which PDF and the digest of the link it carried. Personal data; never copied to the ledger.';
COMMENT ON TABLE crm.proposal_client_decision IS
  'The evidence behind a proposal the CLIENT accepted or declined on its link (0085): the name typed, the statement ticked, the email and PDF, the address and browser. One per proposal; a colleague''s recorded decision has none.';

RESET ROLE;
