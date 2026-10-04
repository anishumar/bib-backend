-- 0343 · Several firm signatories, and a choice on each letter (Q005)
--
-- ── WHAT THE CLIENT ASKED FOR ───────────────────────────────────────────────
--
-- Ashish Jain (COO, 10x Global), 30 Sep 2026, on a screenshot of the EL: "here
-- also pls add option to add signatories and then the drop down at the time of
-- finalizing EL to select who will sign that particular EL". 0022 gave the firm
-- ONE signatory ("unki ek hi signature rahegi"); a firm with several partners
-- signs different clients' letters with different partners, so one is a list.
--
-- ── THE LIST, AND WHY THE DEFAULT STAYS ON THE TENANT ROW ───────────────────
--
-- `tenancy.firm_signatory` is the list: a staff member, the capacity they sign
-- in, and (optionally) their OWN signature image. The firm-wide DEFAULT stays
-- where 0022 put it, `tenancy.tenant.firm_signatory_user_id/_title`, because
-- three readers already depend on that answer and none of them should move:
-- the owner rule's last resort (T6.17, `work-owner.ts`), the job desk's
-- "somebody to hand it to", and a draft letter's preview. They all mean "the
-- person who signs for the firm unless someone chose otherwise", which is
-- exactly what the default is.
--
-- TWO PLACES, ONE FACT, HELD TOGETHER BY A KEY rather than by care. The tenant's
-- pair is a composite foreign key onto the list's (tenant_id, user_id, title),
-- ON UPDATE CASCADE: the default is always somebody ON the list, and editing that
-- person's title on the list moves the tenant's copy in the same statement.
-- MATCH SIMPLE leaves a firm that has named nobody unchecked, which 0022's
-- both-or-neither check already makes the only NULL shape there is.
--
-- ── THE SIGNATURE IMAGE IS NOW A PERSON'S ───────────────────────────────────
--
-- 0081 pins `files.brand_asset` kind 'signature', which is keyed on the ISSUING
-- COMPANY. With one signatory that was harmless; with several it would print
-- partner A's uploaded signature over partner B's printed name, a forged
-- document produced by an ordinary choice in a dropdown. So each signatory may
-- carry their own image, and send pins THAT. The company's image stays in use
-- for the DEFAULT signatory only (who has no image of their own), which is what
-- every letter sent today already does, so nothing in flight changes. Anyone
-- else with no image of their own gets a bare rule, never somebody else's mark.
--
-- ── THE CHOICE ON THE LETTER ────────────────────────────────────────────────
--
-- `crm.engagement_letter.chosen_signatory_id`, nullable, and NULL means "the
-- firm's default at send", which is every letter that exists today. It is a
-- DRAFT's choice so the preview and the PDF show the right name before anybody
-- presses send; `send` still SNAPSHOTS the person, the title and the image into
-- 0022's and 0081's columns, and those remain the record. 0019's freeze covers
-- the new column the day it exists (the trigger compares the whole row minus an
-- allow-list), and it is added with no default and no backfill, so the freeze
-- has nothing to refuse (0018's lesson).
--
-- canonicalContent does NOT read it. The content hash already carries the
-- snapshot (firm_signatory_user_id + title), which is what the client signs;
-- adding the choice would move the hash of every letter in flight.

SET ROLE bib_owner;

CREATE TABLE tenancy.firm_signatory (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- By id alone, like 0022's columns: a user_account is GLOBAL. That the person
  -- works HERE is a membership question no key on a global table can express,
  -- so TenancyService checks an active STAFF membership before writing.
  user_id              uuid NOT NULL REFERENCES tenancy.user_account (id),
  -- The capacity printed under the name: "Director", "Managing Partner".
  title                text NOT NULL CHECK (btrim(title) <> ''),
  -- Their own signature, a document version (immutable bytes with a hash) and
  -- not a brand_asset slot, for 0081's reason. NULL: no image of their own.
  signature_version_id uuid,
  -- `is_active`, not `deleted_at` (0040's distinction): a partner who has left
  -- signed letters that must keep reading, and the row is how the list still
  -- names them. Retired means "cannot be chosen for a new letter".
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES tenancy.user_account (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One entry per person per firm: a second "Director" row for the same partner
  -- would make the dropdown offer one person twice.
  CONSTRAINT firm_signatory_one_per_person UNIQUE (tenant_id, user_id),
  -- The composite-key targets: (id, tenant_id) for the letter's choice, and
  -- (tenant_id, user_id, title) for the tenant's default. Both constrain no data
  -- beyond the key above; they give a foreign key something to point at that
  -- carries the tenant (and, for the default, the title) with it.
  CONSTRAINT firm_signatory_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT firm_signatory_default_key UNIQUE (tenant_id, user_id, title),

  CONSTRAINT firm_signatory_signature_version_tenant_fkey
    FOREIGN KEY (signature_version_id, tenant_id)
      REFERENCES files.document_version (id, tenant_id)
);

CREATE TRIGGER trg_firm_signatory_updated_at BEFORE UPDATE ON tenancy.firm_signatory
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The list is always read whole, per firm; the unique key above leads with
-- tenant_id and serves that read, so no further index.

ALTER TABLE tenancy.firm_signatory ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_signatory_isolation ON tenancy.firm_signatory
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── backfill: today's single signatory becomes the list's first entry ───────
--
-- As the owner, so RLS does not filter the read across firms. Every firm that
-- named a signatory gets exactly that person and title; a firm that named
-- nobody gets an empty list, which is what it had.
INSERT INTO tenancy.firm_signatory (tenant_id, user_id, title)
SELECT t.id, t.firm_signatory_user_id, t.firm_signatory_title
  FROM tenancy.tenant t
 WHERE t.firm_signatory_user_id IS NOT NULL
   AND t.firm_signatory_title IS NOT NULL;

-- ── the default is somebody on the list ─────────────────────────────────────
ALTER TABLE tenancy.tenant
  ADD CONSTRAINT tenant_default_signatory_listed_fkey
    FOREIGN KEY (id, firm_signatory_user_id, firm_signatory_title)
      REFERENCES tenancy.firm_signatory (tenant_id, user_id, title)
      ON UPDATE CASCADE;

-- ── the letter's choice ─────────────────────────────────────────────────────
ALTER TABLE crm.engagement_letter
  ADD COLUMN chosen_signatory_id uuid,
  -- The tenant travels with the reference: a foreign-key check runs as a system
  -- operation RLS does not filter, so an id-only key would let one firm's
  -- letter name another firm's partner as its signatory.
  ADD CONSTRAINT el_chosen_signatory_tenant_fkey
    FOREIGN KEY (chosen_signatory_id, tenant_id)
      REFERENCES tenancy.firm_signatory (id, tenant_id);

COMMENT ON COLUMN crm.engagement_letter.chosen_signatory_id IS
  'Who the drafter chose to sign this letter for the firm (Q005). NULL: the firm''s default '
  'at send. A draft''s choice only; send snapshots the person, title and image into '
  'firm_signatory_user_id / firm_signatory_title / firm_signature_version_id, which are the record.';

RESET ROLE;

-- Grants are not repeated: ALTER DEFAULT PRIVILEGES in 0001 gives bib_app
-- SELECT, INSERT, UPDATE on tables bib_owner creates in tenancy. No DELETE, and
-- none is wanted: a signatory is retired, never erased.
