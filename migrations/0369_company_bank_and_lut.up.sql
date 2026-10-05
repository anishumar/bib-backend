-- 0369 · A company's bank accounts and its LUT (Q056, S5, 2026-10-05).
--
-- 10x's answer to Q056 makes BiB's invoice the final GST tax invoice, and two
-- things it prints belong to the ISSUING COMPANY rather than to the invoice:
--
--   1. WHERE TO PAY. `crm.firm_entity_bank_account`: a company may hold several
--      (an INR current account, a USD EEFC account), each optionally FOR one
--      currency. An invoice prints the live account for its own currency, else
--      the company's general one (currency NULL). One live account per
--      (company, currency), and one general one, by a partial unique index.
--   2. THE LETTER OF UNDERTAKING. `crm.firm_entity_lut`: an Indian company that
--      has filed an LUT (form GST RFD-11) for a financial year exports services
--      in that year without paying IGST, and the invoice prints its reference.
--      One live LUT per (company, financial year). The year is the year it
--      STARTS in, as `crm.invoice.financial_year` is.
--
-- BOTH ARE WRITTEN ONCE. An issued invoice points at the account and the LUT it
-- printed (0370), and a pointer to a row that changed afterwards would make the
-- invoice say something it never said. So details are never updated: a
-- correction RETIRES the row and writes a new one, in one transaction, and the
-- grants allow nothing else (UPDATE of `retired_at` only, no DELETE).

SET ROLE bib_owner;

CREATE TABLE crm.firm_entity_bank_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenancy.tenant (id),
  entity_party_id  uuid NOT NULL,
  -- Whose name the account is in, as the bank holds it.
  account_name     text NOT NULL CHECK (length(btrim(account_name)) BETWEEN 1 AND 200),
  account_number   text NOT NULL CHECK (account_number ~ '^[A-Za-z0-9 -]{4,40}$'),
  bank_name        text NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 1 AND 200),
  branch           text CHECK (branch IS NULL OR length(btrim(branch)) BETWEEN 1 AND 200),
  -- India's branch code: 4 letters, a zero, 6 letters or digits. Null for an
  -- account outside India.
  ifsc             text CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  -- For a payer abroad: 8 or 11 characters (ISO 9362).
  swift            text CHECK (swift IS NULL OR swift ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  -- IBAN, for a payer who asks for one (the Gulf, Europe).
  iban             text CHECK (iban IS NULL OR iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  -- The invoice currency this account is FOR; NULL is the company's general
  -- account, printed when no account names the invoice's currency.
  currency         text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,

  CONSTRAINT firm_entity_bank_account_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT firm_entity_bank_account_entity_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

-- CONSCIOUSLY SCOPED: one LIVE account per company per currency, and one live
-- general account (the coalesce makes NULL a value here). Retired rows keep
-- whatever they were, for the invoices that printed them.
CREATE UNIQUE INDEX firm_entity_bank_account_one_live
  ON crm.firm_entity_bank_account (tenant_id, entity_party_id, coalesce(currency, ''))
  WHERE retired_at IS NULL;

ALTER TABLE crm.firm_entity_bank_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_entity_bank_account_isolation ON crm.firm_entity_bank_account
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No portal policy: the client reads the bank details on the invoice PDF, which
-- is rendered on the firm's side.

-- SELECT and INSERT, and UPDATE of the retirement stamp only (the default
-- privileges grant UPDATE of every column, so it is revoked first). Never DELETE.
GRANT SELECT, INSERT ON crm.firm_entity_bank_account TO bib_app;
REVOKE UPDATE, DELETE ON crm.firm_entity_bank_account FROM bib_app;
GRANT UPDATE (retired_at) ON crm.firm_entity_bank_account TO bib_app;

COMMENT ON TABLE crm.firm_entity_bank_account IS
  'Where a client pays one of the firm''s companies (Q056, 0369). Written once: a correction retires the row and writes another, because an issued invoice points at the row it printed. An invoice prints the live account for its currency, else the one with currency NULL.';

CREATE TABLE crm.firm_entity_lut (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenancy.tenant (id),
  entity_party_id  uuid NOT NULL,
  -- The financial year it covers, as the year it starts in (2026 = 2026-27).
  financial_year   integer NOT NULL CHECK (financial_year BETWEEN 2017 AND 2100),
  -- The ARN the portal acknowledged the LUT with (AD2704260012345 and the like).
  reference        text NOT NULL CHECK (reference ~ '^[A-Za-z0-9/-]{5,30}$'),
  filed_on         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,

  CONSTRAINT firm_entity_lut_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT firm_entity_lut_entity_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

-- CONSCIOUSLY SCOPED: one live LUT per company per financial year.
CREATE UNIQUE INDEX firm_entity_lut_one_live
  ON crm.firm_entity_lut (tenant_id, entity_party_id, financial_year)
  WHERE retired_at IS NULL;

ALTER TABLE crm.firm_entity_lut ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_entity_lut_isolation ON crm.firm_entity_lut
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON crm.firm_entity_lut TO bib_app;
REVOKE UPDATE, DELETE ON crm.firm_entity_lut FROM bib_app;
GRANT UPDATE (retired_at) ON crm.firm_entity_lut TO bib_app;

COMMENT ON TABLE crm.firm_entity_lut IS
  'An Indian company''s Letter of Undertaking for one financial year (Q056, 0369): with one in force, a service exported in that year is zero-rated and the invoice prints its reference. Written once; a correction retires it.';

RESET ROLE;
