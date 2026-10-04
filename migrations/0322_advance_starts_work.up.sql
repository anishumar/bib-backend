-- 0322 · The advance no longer holds the work; the invoice number is drawn at
-- ISSUE (Ashish, 2026-10-02; the user's calls the same night).
--
-- Ashish: "the invoice for advance should be created as draft invoice and job as
-- per EL should be created simultaneously and work can be started ... generally
-- it comes within 5 to 15 days of starting of work". So signing starts the work
-- and drafts the advance invoice at once, and the money is chased by reminders
-- (the SPOC, the Key Manager and the partner on My day; the admins weekly by
-- email) instead of by a gate. Four things in the schema:
--
--   1. AN INVOICE NUMBER IS DRAWN WHEN THE INVOICE IS ISSUED, NOT WHEN THE DRAFT
--      IS MADE. A draft drew its gapless number at creation (0027), so an
--      automatic draft that a firm cancelled left a cancelled number in the
--      series for an auditor, which is why the billing desk only ever wrote
--      bills. GST's consecutive-serial rule (Rule 46) is about ISSUED tax
--      invoices; a draft is not one. Now `number` and `sequence_number` are
--      empty on a draft and the issue takes the next number of the draft's
--      series (its financial year is still chosen at the draft: "which year's
--      books", 0027) under the same counter-row lock, in the same transaction
--      as the status change. A cancelled draft spends nothing. Drafts made
--      before this keep the number they drew: removing it would leave the gap
--      this exists to prevent.
--   2. THE FIRM'S ADVANCE REMINDER POLICY, on the tenant row like
--      `auto_billing` (a column, not config: one value per firm, read by a
--      sweep). Defaults are the user's answers for the first firm and every
--      firm may change them: a draft advance turns Overdue after 3 days, an
--      unpaid one after 15; the partner reminded is the first person above the
--      client's Key Manager at grade rank 9 or above (the default ladder's
--      Director); the weekly summary goes out Monday (ISO 1) at 10:00 in the
--      firm's own time zone.
--   3. A DEFAULT TAX RATE PER COMPANY (`crm.issuer_tax_default`): an automatic
--      draft needs a rate and a letter states none. Per issuing company, not
--      per firm: a firm's Indian, Gulf, Singapore and US companies charge
--      different taxes. No row = no automatic draft (the bill waits for a
--      person), never a guessed 0%.
--   4. THE WEEKLY SUMMARY'S RECORD (`crm.advance_digest`): one row per firm per
--      week, claimed before anything is sent, so a redelivered or doubled
--      worker sends one summary.

SET ROLE bib_owner;

-- ── 1. The number at issue ──────────────────────────────────────────────────

ALTER TABLE crm.invoice ALTER COLUMN number DROP NOT NULL;
ALTER TABLE crm.invoice ALTER COLUMN sequence_number DROP NOT NULL;

-- Both or neither: a number is its series position written out.
ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_number_whole_chk CHECK ((number IS NULL) = (sequence_number IS NULL));

-- An issued invoice always carries its number. A cancelled one may not: a draft
-- withdrawn before it was issued never drew one.
ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_issued_is_numbered_chk CHECK (status <> 'issued' OR number IS NOT NULL);

COMMENT ON COLUMN crm.invoice.number IS
  'The tax invoice number, drawn from the series when the invoice is ISSUED (0322) and frozen from then. Empty on a draft made since 0322 and on a draft cancelled before it was issued; drafts made before 0322 keep the number they drew.';

-- The freeze, with the one change it now admits: a draft with no number takes
-- one in the same write that issues it, and only then.
CREATE OR REPLACE FUNCTION crm.refuse_invoice_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number THEN
    IF NOT (OLD.number IS NULL AND OLD.sequence_number IS NULL
            AND OLD.status = 'draft' AND NEW.status = 'issued'
            AND NEW.number IS NOT NULL AND NEW.sequence_number IS NOT NULL) THEN
      RAISE EXCEPTION
        'invoice % is numbered %, and an invoice number is not editable — a consecutive series is a legal record. Cancel it and issue a new one.',
        OLD.id, coalesce(OLD.number, '(not yet)') USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id THEN
    RAISE EXCEPTION
      'invoice % belongs to its company''s series for its financial year, and that does not move. Cancel it and raise a new one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'issued' AND (
       NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
    OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
    OR NEW.party_id IS DISTINCT FROM OLD.party_id) THEN
    RAISE EXCEPTION
      'invoice % has been issued, so what it says the client owes cannot change. Cancel it and issue a new one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.irn IS NOT NULL AND NEW.irn IS DISTINCT FROM OLD.irn THEN
    RAISE EXCEPTION
      'invoice % is registered as IRN %, and that is the registry''s identifier, not ours.',
      OLD.id, OLD.irn USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2. The firm's advance reminder policy ──────────────────────────────────

ALTER TABLE tenancy.tenant
  ADD COLUMN advance_draft_overdue_days  smallint NOT NULL DEFAULT 3
    CONSTRAINT tenant_advance_draft_overdue_days_chk CHECK (advance_draft_overdue_days BETWEEN 1 AND 90),
  ADD COLUMN advance_unpaid_overdue_days smallint NOT NULL DEFAULT 15
    CONSTRAINT tenant_advance_unpaid_overdue_days_chk CHECK (advance_unpaid_overdue_days BETWEEN 1 AND 180),
  ADD COLUMN advance_partner_min_rank    smallint NOT NULL DEFAULT 9
    CONSTRAINT tenant_advance_partner_min_rank_chk CHECK (advance_partner_min_rank BETWEEN 1 AND 100),
  ADD COLUMN advance_digest_weekday      smallint NOT NULL DEFAULT 1
    CONSTRAINT tenant_advance_digest_weekday_chk CHECK (advance_digest_weekday BETWEEN 1 AND 7),
  ADD COLUMN advance_digest_hour         smallint NOT NULL DEFAULT 10
    CONSTRAINT tenant_advance_digest_hour_chk CHECK (advance_digest_hour BETWEEN 0 AND 23);

COMMENT ON COLUMN tenancy.tenant.advance_draft_overdue_days IS
  'Days after signing that a DRAFT advance invoice turns Overdue on the reminder rows (0322).';
COMMENT ON COLUMN tenancy.tenant.advance_unpaid_overdue_days IS
  'Days after issue that an UNPAID (or part-paid) advance invoice turns Overdue on the reminder rows (0322).';
COMMENT ON COLUMN tenancy.tenant.advance_partner_min_rank IS
  'The "partner" reminded about an advance: the first person above the client''s Key Manager on the reporting line whose grade rank is at least this (0322).';
COMMENT ON COLUMN tenancy.tenant.advance_digest_weekday IS
  'ISO weekday (1 = Monday) the weekly summary of pending advances goes to the firm''s administrators (0322).';
COMMENT ON COLUMN tenancy.tenant.advance_digest_hour IS
  'Hour (0-23, the firm''s own time zone) the weekly summary goes out (0322).';

-- ── 3. A default tax rate per company ───────────────────────────────────────

CREATE TABLE crm.issuer_tax_default (
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- One of the firm's own companies (the service checks it is one).
  entity_party_id uuid NOT NULL,
  tax_percent     numeric(5,2) NOT NULL CHECK (tax_percent >= 0 AND tax_percent <= 100),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_party_id),
  CONSTRAINT issuer_tax_default_entity_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

ALTER TABLE crm.issuer_tax_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY issuer_tax_default_isolation ON crm.issuer_tax_default
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON crm.issuer_tax_default FROM bib_app;
GRANT SELECT, INSERT ON crm.issuer_tax_default TO bib_app;
GRANT UPDATE (tax_percent, updated_at) ON crm.issuer_tax_default TO bib_app;

COMMENT ON TABLE crm.issuer_tax_default IS
  'The tax rate an automatic draft (the advance at signing, 0322) puts on its line when the work has never been invoiced, per issuing company. No row: no automatic draft, the bill waits for a person.';

-- ── 4. The weekly summary, sent once ───────────────────────────────────────

CREATE TABLE crm.advance_digest (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- The firm's day of the week's slot this summary is for.
  week_of    date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  recipients integer CHECK (recipients >= 0),
  advances   integer CHECK (advances >= 0),
  UNIQUE (tenant_id, week_of)
);

ALTER TABLE crm.advance_digest ENABLE ROW LEVEL SECURITY;
CREATE POLICY advance_digest_isolation ON crm.advance_digest
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON crm.advance_digest FROM bib_app;
GRANT SELECT, INSERT ON crm.advance_digest TO bib_app;
GRANT UPDATE (claimed_at, sent_at, recipients, advances) ON crm.advance_digest TO bib_app;

COMMENT ON TABLE crm.advance_digest IS
  'One weekly summary of pending advances per firm per week (0322): claimed before it is sent, so a doubled worker sends it once. A claim older than 30 minutes with nothing sent may be taken again.';

RESET ROLE;
