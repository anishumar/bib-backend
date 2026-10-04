-- 0355: who won the work, the ORIGINATOR of an engagement letter (Q049).
--
-- Ashish, 4 Oct 2026: "incorporation and statutory filing have different
-- managers: how is revenue captured manager-wise or salesperson-wise?" The
-- MANAGER is already on every invoice (0318, frozen at issue). The SALESPERSON
-- was recorded nowhere. The user approved (2026-10-05): one originator per
-- letter, the deal, as a CRM credits the opportunity's owner (Salesforce, Zoho
-- CRM, HubSpot); Clio keeps an "originating attorney" per matter; Karbon and
-- TaxDome keep a client owner; Xero Practice Manager needs a custom field.
--
-- ── A SIDE TABLE, NOT A COLUMN ON THE LETTER ────────────────────────────────
--
-- A signed letter is frozen (0017, 0019: any column off the allow-list is
-- refused). Who sold the work is not a term the client agreed to, and it must
-- stay correctable after signature, so it lives beside the letter, as
-- `crm.billing_due` does for what the letter caused.
--
-- ── NO ROW IS THE DEFAULT, A ROW IS A PERSON'S WORD ─────────────────────────
--
-- With no row, the originator is read off the deal: the LEAD's owner, else the
-- colleague who PREPARED the proposal (0084), else nobody. A row is a partner
-- or an administrator saying who it is, `originator_user_id` NULL meaning
-- "nobody" said on purpose. `crm.letter_originator_in_force` reads the two
-- together, with `how` saying which answered. Every change is a ledger event
-- (`engagement_letter.originator_set`); this row keeps only the latest word.
--
-- The originator's revenue is read through the letter at report time, so a
-- correction re-credits the letter's invoices: a wrong default is exactly
-- what a partner corrects.
SET ROLE bib_owner;

CREATE TABLE crm.letter_originator (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  engagement_letter_id uuid NOT NULL,
  -- NULL = a person said nobody originated it (an existing client's renewal).
  originator_user_id   uuid REFERENCES tenancy.user_account (id),
  set_by_user_id       uuid REFERENCES tenancy.user_account (id),
  set_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT letter_originator_one_per_letter UNIQUE (tenant_id, engagement_letter_id),
  CONSTRAINT letter_originator_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id)
);

COMMENT ON TABLE crm.letter_originator IS
  'Who won the work of an engagement letter, as a partner or administrator said it (0355, Q049). No row = read off the deal (crm.letter_originator_in_force).';

ALTER TABLE crm.letter_originator ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_originator_isolation ON crm.letter_originator
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- A row is written once per letter and then only its person moves; the letter
-- it is about never changes, and nothing is ever deleted.
REVOKE ALL ON crm.letter_originator FROM bib_app;
GRANT SELECT, INSERT ON crm.letter_originator TO bib_app;
GRANT UPDATE (originator_user_id, set_by_user_id, set_at) ON crm.letter_originator TO bib_app;

-- A deleted draft's rows are final (0087): its originator too.
CREATE TRIGGER trg_letter_originator_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.letter_originator
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

-- ── The originator in force, for every letter ───────────────────────────────
CREATE VIEW crm.letter_originator_in_force WITH (security_invoker = true) AS
SELECT l.tenant_id,
       l.id AS engagement_letter_id,
       CASE WHEN o.id IS NOT NULL THEN o.originator_user_id
            ELSE coalesce(ld.owner_user_id, p.prepared_by_user_id)
       END AS originator_user_id,
       CASE WHEN o.id IS NOT NULL THEN 'set'
            WHEN ld.owner_user_id IS NOT NULL THEN 'lead_owner'
            WHEN p.prepared_by_user_id IS NOT NULL THEN 'proposal_preparer'
            ELSE 'none'
       END AS how,
       o.set_by_user_id,
       o.set_at
  FROM crm.engagement_letter l
  LEFT JOIN crm.letter_originator o
    ON o.engagement_letter_id = l.id AND o.tenant_id = l.tenant_id
  LEFT JOIN crm.proposal p
    ON p.id = l.proposal_id AND p.tenant_id = l.tenant_id
  LEFT JOIN crm.lead ld
    ON ld.id = p.lead_id AND ld.tenant_id = p.tenant_id;

COMMENT ON VIEW crm.letter_originator_in_force IS
  'The originator of each letter (0355): the person a partner set, else the lead''s owner, else who prepared the proposal; `how` says which.';

GRANT SELECT ON crm.letter_originator_in_force TO bib_app;

RESET ROLE;
