-- 0027 · Invoicing (T3.4) — and the one number in this product that may not gap
--
-- ── THE HARD PART, AND THE WHOLE REASON THIS IS NOT 0020 AGAIN ─────────────
--
-- `crm.document_ref_series` (0020) hands out proposal and letter references and
-- BURNS a number when a draft fails: its adapter advances the counter in its own
-- committed transaction, so a gap is possible and honest. `PR-2026-0007` missing
-- means somebody started a quote and abandoned it.
--
-- AN INVOICE NUMBER IS THE OPPOSITE, and it is a legal requirement rather than a
-- preference. Under Indian GST (and most VAT regimes) a tax invoice series must
-- be CONSECUTIVE — an auditor who finds INV/2026-27/0041 missing is entitled to
-- read it as a suppressed sale, and "our software burnt it" is not a defence.
-- So this counter must roll back with the invoice that failed.
--
-- THREE MECHANISMS WERE AVAILABLE AND TWO OF THEM ARE WRONG:
--
--   * A SEQUENCE keeps its value on rollback, by design — that is what makes
--     sequences fast and non-blocking. `nextval` returning 41 in a transaction
--     that aborts burns 41 forever. This is the single most common way gapless
--     numbering is got wrong, and it cannot be patched afterwards.
--   * `max(number) + 1` reads a snapshot. Two concurrent invoices both see 40,
--     both write 41, and the UNIQUE constraint turns a numbering bug into a lost
--     invoice — better than a duplicate, still wrong.
--   * A COUNTER ROW TAKEN UNDER `SELECT … FOR UPDATE`, in the SAME transaction
--     as the insert. The second writer blocks on the row lock until the first
--     COMMITS OR ROLLS BACK, then reads what is actually stored. A rollback
--     releases the number, because the counter never moved. This is the one.
--
-- The lock is per (tenant, entity, financial year), so two firms — and two of
-- one firm's entities — never wait on each other. Within one series the writes
-- ARE serialised, and that is not a cost to be engineered away: a gapless
-- consecutive series is by definition a total order, so issuing two invoices in
-- the same series at the same instant is exactly what must not happen
-- concurrently.
--
-- ── PER ENTITY, PER FINANCIAL YEAR ─────────────────────────────────────────
--
-- The series belongs to the LEGAL ENTITY that issues the invoice, never to the
-- firm: two companies of one firm each file their own returns and each owes its
-- own consecutive series. That is the same `entity_party_id` G0.1 threaded
-- through the document chain, and the reason it had to exist.
--
-- The year is the FINANCIAL year, not the calendar year, and the two differ for
-- three months of every year in India. `crm.financial_year_of(date)` is a
-- function rather than a column so that a stored value cannot drift from the
-- date beside it, and it lives here rather than in TypeScript because the
-- constraint below has to evaluate it.
--
-- FY START IS 1 APRIL, HARDCODED, AND THAT IS A LIMIT WORTH SEEING. It is right
-- for India and wrong for the UK (6 April), the US (varies) and the UAE
-- (calendar). `core.legal_entity.financial_year_end` already exists and is the
-- column that would generalise this. It is NOT used yet because doing so makes
-- the series' year depend on a mutable column on another table — change the
-- entity's year end and every future number changes its prefix while issued
-- ones keep theirs. That is a decision about a legal document series and it
-- needs a firm to make it, not a migration.
--
-- ── WHAT IS DERIVED AND WHAT IS STORED ─────────────────────────────────────
--
-- Totals are VIEWS, exactly as the proposal's are (0013), and for the same
-- reason: a stored subtotal drifts from its lines the first time a line moves,
-- and a number a partner acts on must not be a cache. `security_invoker`,
-- because a plain view runs as its owner — who is not subject to the row
-- policies — and a totals view over a tenant-scoped table would be a hole
-- straight through the tenant wall.
--
-- THE BALANCE IS ALSO A VIEW, and it is honest about what does not exist yet:
-- it subtracts payments, and `crm.payment` arrives with T3.5. Until then the
-- view reads `net - 0`, which is the correct answer for a product that has
-- recorded no payments rather than a placeholder.

SET ROLE bib_owner;

-- ── The key an invoice line needs to point at ──────────────────────────────
-- `crm.engagement` carries a primary key on `id` alone, so a reference to it
-- from another tenant-scoped table could not carry the tenant. Redundant with
-- that primary key, which is exactly why it is safe to add: it constrains no
-- data, it only gives a foreign key something to point at that carries the
-- tenant with it. Same move migration 0015 made across `core`, and the reason
-- `tests/architecture/tenant-keys.integration.test.ts` stays green.
ALTER TABLE crm.engagement
  ADD CONSTRAINT engagement_id_tenant_key UNIQUE (id, tenant_id);

-- ── The financial year a date falls in ─────────────────────────────────────
-- Returns the year the FY STARTS in: 2026-03-31 → 2025, 2026-04-01 → 2026.
-- IMMUTABLE so a CHECK constraint and an index can both use it.
CREATE FUNCTION crm.financial_year_of(d date) RETURNS integer AS $$
  SELECT CASE WHEN EXTRACT(MONTH FROM d) >= 4
              THEN EXTRACT(YEAR FROM d)::integer
              ELSE EXTRACT(YEAR FROM d)::integer - 1 END;
$$ LANGUAGE sql IMMUTABLE STRICT;

COMMENT ON FUNCTION crm.financial_year_of(date) IS
  'The year an Indian financial year STARTS in (1 April). A function, not a column, so a stored year cannot drift from the date beside it.';

-- ── The counter ────────────────────────────────────────────────────────────
CREATE TABLE crm.invoice_series (
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant (id),
  entity_party_id uuid NOT NULL,
  financial_year  integer NOT NULL CHECK (financial_year BETWEEN 2000 AND 9999),
  -- The last number ISSUED. Starts at 0, so the first invoice is 1.
  last_number     integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  -- What this entity's numbers READ as: 'INV', or '10XUS', or whatever the
  -- firm's accountant has always used. It exists because a firm operating two
  -- companies wants to tell their invoices apart at a glance, and because an
  -- existing firm arriving with a series already in progress needs its numbers
  -- to keep looking like its numbers.
  --
  -- It does NOT carry the uniqueness — see the constraint on crm.invoice. Two
  -- entities that both leave this at 'INV' are correct and issue identically
  -- numbered invoices in two separate series, which is what separate legal
  -- entities do.
  prefix          text NOT NULL DEFAULT 'INV'
                  CHECK (prefix ~ '^[A-Z0-9][A-Z0-9/-]{0,11}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_party_id, financial_year),
  CONSTRAINT invoice_series_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

COMMENT ON TABLE crm.invoice_series IS
  'The gapless counter, one row per (firm entity, financial year). Read with SELECT ... FOR UPDATE inside the SAME transaction as the invoice insert, so a rollback releases the number. Never a sequence: a sequence keeps its value on rollback.';

ALTER TABLE crm.invoice_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_series_isolation ON crm.invoice_series
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_invoice_series_updated
  BEFORE UPDATE ON crm.invoice_series
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── The invoice ────────────────────────────────────────────────────────────
CREATE TABLE crm.invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- WHO IS BILLED. The client, which is not the entity the work was delivered
  -- to — the distinction G0.1 exists for, and invoicing is the half that needs
  -- the client while the compliance calendar needs the entity.
  party_id        uuid NOT NULL,
  -- WHO IS CHARGING. One of the firm's own entities, and the series it owns.
  entity_party_id uuid NOT NULL,
  -- The human-facing number. Composed by the application from the series, and
  -- FROZEN by a trigger the moment the row exists.
  number          text NOT NULL,
  financial_year  integer NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'issued', 'cancelled')),
  -- ONE CURRENCY PER INVOICE, one rate, struck once — the lines are held to it
  -- by a composite foreign key, exactly as a proposal's are, so a mixed-currency
  -- invoice is unrepresentable rather than discouraged. The rate is stored even
  -- when the currencies match (1.0, dated), so "did we convert this?" is never
  -- inferred.
  currency        text NOT NULL,
  fx_rate         numeric(20,10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date    date NOT NULL,
  issued_on       date,
  due_on          date,
  -- India's e-invoice Invoice Reference Number, returned by the IRP when the
  -- invoice is registered. Nullable because registration is a separate act that
  -- may fail or may not apply outside India, and FROZEN once set for the same
  -- reason the number is: it is the government's identifier for this document.
  irn             text,
  irn_registered_at timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- CONSCIOUSLY SCOPED, and this one took a correction before it was applied.
  -- The obvious constraint is UNIQUE (tenant_id, number) — one number per firm,
  -- which is what a person quoting "invoice 41" down the phone assumes. It is
  -- WRONG here, and would have failed on the second entity's first invoice: the
  -- series is per ENTITY, so a firm's two companies each issue their own
  -- INV/2026-27/0001, and both are correct. A firm-wide unique would have made
  -- a legally ordinary arrangement unrepresentable, discovered by whichever
  -- customer opened a second company.
  --
  -- The prefix on the series is what lets a firm tell them apart when it wants
  -- to; it is a convenience, not the guarantee. The guarantee is below.
  CONSTRAINT invoice_number_unique UNIQUE (tenant_id, entity_party_id, number),
  -- The series' own guarantee, at the table: one invoice per position per
  -- series. This is what makes a DUPLICATE impossible even if the counter were
  -- read wrongly, and it is the constraint that would fail loudly rather than
  -- silently issuing two invoices numbered 41.
  CONSTRAINT invoice_sequence_unique
    UNIQUE (tenant_id, entity_party_id, financial_year, sequence_number),
  CONSTRAINT invoice_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT invoice_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT invoice_series_fkey
    FOREIGN KEY (tenant_id, entity_party_id, financial_year)
      REFERENCES crm.invoice_series (tenant_id, entity_party_id, financial_year),
  -- An issued invoice has a date; a draft has not been issued and must not.
  CONSTRAINT invoice_issued_has_date_chk
    CHECK ((status = 'issued') = (issued_on IS NOT NULL)),
  -- An IRN is the registry's answer and cannot exist without the moment it
  -- arrived — half of it stored is a fact nobody can date.
  CONSTRAINT invoice_irn_dated_chk
    CHECK ((irn IS NULL) = (irn_registered_at IS NULL)),
  -- The composite key an invoice LINE references, so a line cannot hang off
  -- another firm's invoice AND cannot be in another currency.
  CONSTRAINT invoice_id_tenant_currency_key UNIQUE (id, tenant_id, currency)
);

CREATE INDEX idx_invoice_tenant_party ON crm.invoice (tenant_id, party_id, created_at DESC);
CREATE INDEX idx_invoice_tenant_status ON crm.invoice (tenant_id, status, created_at DESC);
CREATE INDEX idx_invoice_entity ON crm.invoice (tenant_id, entity_party_id, financial_year);

ALTER TABLE crm.invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_isolation ON crm.invoice
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_invoice_updated
  BEFORE UPDATE ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── The number cannot be edited. Nor can the series it sits in ─────────────
--
-- A TRIGGER rather than a service check, for the reason CLAUDE.md gives about
-- every rule this expensive: an application check is one an import, an agent or
-- a psql session walks straight past, and "why is invoice 41 now numbered 43"
-- is a question an auditor asks. Editing a number is not an operation — a wrong
-- invoice is CANCELLED and a new one issued, which is what the status is for.
--
-- The FX rate joins them once the invoice is issued: the rate is what the
-- client's amount was struck against, and changing it afterwards restates a
-- document already sent.
CREATE FUNCTION crm.refuse_invoice_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
     OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id THEN
    RAISE EXCEPTION
      'invoice % is numbered %, and an invoice number is not editable — a consecutive series is a legal record. Cancel it and issue a new one.',
      OLD.id, OLD.number USING ERRCODE = 'restrict_violation';
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

  -- The IRN is the government registry's answer about this document. It may be
  -- set once — a registration that has happened cannot un-happen.
  IF OLD.irn IS NOT NULL AND NEW.irn IS DISTINCT FROM OLD.irn THEN
    RAISE EXCEPTION
      'invoice % is registered as IRN %, and that is the registry''s identifier, not ours.',
      OLD.id, OLD.irn USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_number_freeze
  BEFORE UPDATE ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_invoice_number_change();

-- ── The lines ──────────────────────────────────────────────────────────────
CREATE TABLE crm.invoice_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenancy.tenant (id),
  invoice_id       uuid NOT NULL,
  -- What the work WAS, when it came from one. Nullable: a firm invoices things
  -- that never had an engagement (a one-off certificate, an out-of-pocket
  -- recharge), and refusing those would make the schema narrower than the
  -- business.
  engagement_id    uuid,
  description      text NOT NULL CHECK (btrim(description) <> ''),
  position         integer NOT NULL CHECK (position > 0),
  quantity         numeric(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- NOT NULL here, unlike a proposal line. A quote may say "as mutually
  -- agreed"; an invoice is a demand for a specific sum and a line with no
  -- amount is not one.
  unit_amount      numeric(18,4) NOT NULL CHECK (unit_amount >= 0),
  currency         text NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0
                   CHECK (discount_percent >= 0 AND discount_percent <= 100),
  -- The tax RATE, stored per line because it is per service: GST is 18% on
  -- professional fees and 0% on an out-of-pocket recharge, on the same invoice.
  -- The amount is derived from it in the view, never stored — a stored tax
  -- amount is a second source of truth about one multiplication.
  tax_percent      numeric(5,2) NOT NULL DEFAULT 0
                   CHECK (tax_percent >= 0 AND tax_percent <= 100),
  removed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_line_position_unique UNIQUE (invoice_id, position),
  -- Currency travels in the key, so a line in another currency than its
  -- invoice cannot be written at all.
  CONSTRAINT invoice_line_invoice_fkey
    FOREIGN KEY (invoice_id, tenant_id, currency)
      REFERENCES crm.invoice (id, tenant_id, currency),
  CONSTRAINT invoice_line_engagement_tenant_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id)
);

CREATE INDEX idx_invoice_line_invoice
  ON crm.invoice_line (invoice_id, position) WHERE removed_at IS NULL;

ALTER TABLE crm.invoice_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_line_isolation ON crm.invoice_line
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_invoice_line_updated
  BEFORE UPDATE ON crm.invoice_line
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- An ISSUED invoice's lines are frozen, the same way a signed letter's are and
-- for a stronger reason: this document has been sent to a client as a demand
-- for a specific sum, and a tax authority holds a copy.
CREATE FUNCTION crm.refuse_issued_invoice_line_change() RETURNS trigger AS $$
DECLARE
  parent uuid;
  state  text;
BEGIN
  parent := CASE TG_OP WHEN 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT status INTO state FROM crm.invoice WHERE id = parent;
  IF state IN ('issued', 'cancelled') THEN
    RAISE EXCEPTION
      'invoice % is %, so its lines are fixed. Cancel it and issue a new one.',
      parent, state USING ERRCODE = 'restrict_violation';
  END IF;
  -- On an UPDATE that MOVES a line, the invoice it is leaving matters as much
  -- as the one it is joining — the lesson migration 0024 learnt on the letter.
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
    SELECT status INTO state FROM crm.invoice WHERE id = OLD.invoice_id;
    IF state IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION
        'invoice % is %, so a line cannot be moved off it.',
        OLD.invoice_id, state USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_line_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.invoice_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_issued_invoice_line_change();

-- ── The arithmetic, in the schema, in numeric ──────────────────────────────
CREATE VIEW crm.invoice_line_amount WITH (security_invoker = true) AS
SELECT l.id AS invoice_line_id,
       l.invoice_id,
       l.tenant_id,
       round(l.quantity * l.unit_amount, 4) AS gross,
       round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4) AS net,
       round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100)
             * l.tax_percent / 100, 4) AS tax
FROM crm.invoice_line l
WHERE l.removed_at IS NULL;

CREATE VIEW crm.invoice_totals WITH (security_invoker = true) AS
SELECT a.invoice_id,
       a.tenant_id,
       count(*)                     AS line_count,
       sum(a.gross)                 AS gross,
       sum(a.gross - a.net)         AS discount,
       sum(a.net)                   AS net,
       sum(a.tax)                   AS tax,
       -- What the client actually owes: net of discount, plus tax.
       sum(a.net) + sum(a.tax)      AS total
FROM crm.invoice_line_amount a
GROUP BY a.invoice_id, a.tenant_id;

COMMENT ON VIEW crm.invoice_totals IS
  'Derived, never stored. A stored subtotal drifts from its lines the first time one moves, and a figure a partner acts on must not be a cache. security_invoker so the row policies still apply.';

GRANT SELECT, INSERT, UPDATE ON crm.invoice_series TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.invoice TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.invoice_line TO bib_app;
GRANT SELECT ON crm.invoice_line_amount TO bib_app;
GRANT SELECT ON crm.invoice_totals TO bib_app;

RESET ROLE;
