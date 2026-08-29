-- 0028 · Payments, credit notes, and what a client actually still owes (T3.5)
--
-- ── FIRST, A CORRECTION TO 0027 ────────────────────────────────────────────
--
-- `crm.invoice_series` was keyed on (tenant, entity, financial_year) and had no
-- DOCUMENT TYPE. That was an omission rather than a decision, and the proof is
-- one table over: `crm.document_ref_series` (0020) has carried a
-- `document_type` since the day it existed, because a proposal and an
-- engagement letter are two series and not one.
--
-- A CREDIT NOTE IS A THIRD. Under Indian GST it is its own document with its
-- own consecutive series — not an invoice with a minus sign — and issuing one
-- from the invoice counter would interleave two legal series into a single
-- sequence, which is worse than a gap: `INV/2026-27/0042` missing because 42
-- went to a credit note is a number an auditor cannot account for.
--
-- Fixed forward, as the rules require. `crm.invoice` gains a `series_type`
-- pinned to 'invoice' by a CHECK so that its foreign key can keep pointing at
-- the widened primary key — the alternative was dropping that foreign key, and
-- weakening a constraint added yesterday to make room for a feature is the kind
-- of trade that is invisible in six months.
--
-- ── PAYMENTS: THE BALANCE IS A SUM, AND STAYS ONE ──────────────────────────
--
-- No `paid` flag on the invoice and no `amount_paid` column. Both are caches of
-- an addition, and both drift the first time a payment is corrected — the
-- invoice would still say "paid" while the arithmetic says otherwise, and only
-- one of them is evidence. `crm.invoice_balance` computes it, in `numeric`,
-- from the rows that exist. That is the same argument `crm.invoice_totals`
-- makes about the invoice's own figures, extended over two more tables.
--
-- A payment is NOT reversible by deletion (`bib_app` holds no DELETE grant).
-- Money that arrived and then bounced is a NEGATIVE payment with a reason —
-- two rows that tell the story, rather than one row edited into a lie.
--
-- ── CREDIT NOTES: THE REASON IS MANDATORY, AND THAT IS THE POINT ───────────
--
-- The demo's hardest-won finding about revenue: without a reason, "revenue
-- leakage becomes invisible — the numbers always reconcile; WHY forty thousand
-- came off does not." A closed CHECK rather than free text, because a firm
-- wanting to ask "how much did we write off to service failures last year"
-- needs to GROUP BY it, and free text does not group. `note` sits beside it for
-- the particulars.

SET ROLE bib_owner;

-- ── The series correction ──────────────────────────────────────────────────
ALTER TABLE crm.invoice DROP CONSTRAINT invoice_series_fkey;

ALTER TABLE crm.invoice_series
  ADD COLUMN document_type text NOT NULL DEFAULT 'invoice'
    CONSTRAINT invoice_series_type_chk CHECK (document_type IN ('invoice', 'credit_note'));

ALTER TABLE crm.invoice_series DROP CONSTRAINT invoice_series_pkey;
ALTER TABLE crm.invoice_series
  ADD CONSTRAINT invoice_series_pkey
    PRIMARY KEY (tenant_id, entity_party_id, financial_year, document_type);

COMMENT ON TABLE crm.invoice_series IS
  'The gapless counter, one row per (firm entity, financial year, DOCUMENT TYPE). An invoice and a credit note are two legal series and must not interleave. Read with SELECT ... FOR UPDATE inside the SAME transaction as the insert, so a rollback releases the number.';

-- Pinned by a CHECK rather than left free: this column exists only so the
-- foreign key below can point at the widened key, and an invoice whose
-- series_type said 'credit_note' would be a contradiction the schema should not
-- be able to state.
ALTER TABLE crm.invoice
  ADD COLUMN series_type text NOT NULL DEFAULT 'invoice'
    CONSTRAINT invoice_series_type_chk CHECK (series_type = 'invoice');

ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_series_fkey
    FOREIGN KEY (tenant_id, entity_party_id, financial_year, series_type)
      REFERENCES crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type);

-- ── Payments ───────────────────────────────────────────────────────────────
CREATE TABLE crm.payment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant (id),
  invoice_id   uuid NOT NULL,
  -- SIGNED, and that is the design. A bounced cheque or a reversed transfer is
  -- a NEGATIVE payment carrying its own reason and its own date — two rows that
  -- tell the story — rather than the original row edited into something that
  -- never happened. `bib_app` holds no DELETE grant, so this is the only way to
  -- express it, which is the intended pressure.
  amount       numeric(18,4) NOT NULL CHECK (amount <> 0),
  currency     text NOT NULL,
  received_on  date NOT NULL,
  -- How it arrived, as a closed set: a firm reconciling against a bank feed
  -- (T7.4) groups by this, and free text does not group.
  method       text NOT NULL
               CHECK (method IN ('bank_transfer', 'cheque', 'cash', 'card', 'upi', 'other')),
  -- The bank's own reference — a UTR, a cheque number. Free text on purpose:
  -- it is whatever the counterparty's system said, and normalising somebody
  -- else's identifier is how it stops matching theirs.
  reference    text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Currency travels in the key: a payment in a different currency from the
  -- invoice it settles cannot be written at all. Converting it would need a
  -- rate, and a rate struck at payment time is a different fact from the one on
  -- the invoice — that is a feature (multi-currency settlement), not a default.
  CONSTRAINT payment_invoice_fkey
    FOREIGN KEY (invoice_id, tenant_id, currency)
      REFERENCES crm.invoice (id, tenant_id, currency)
);

CREATE INDEX idx_payment_invoice ON crm.payment (invoice_id, received_on);
CREATE INDEX idx_payment_tenant_date ON crm.payment (tenant_id, received_on DESC);

ALTER TABLE crm.payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_isolation ON crm.payment
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_payment_updated
  BEFORE UPDATE ON crm.payment
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- A payment against a DRAFT invoice is a bookkeeping error: nothing has been
-- demanded yet. Against a CANCELLED one it is money to refund or reallocate,
-- and recording it here would quietly reduce a balance on a withdrawn document.
CREATE FUNCTION crm.refuse_payment_on_unissued() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT status INTO state FROM crm.invoice WHERE id = NEW.invoice_id;
  IF state <> 'issued' THEN
    RAISE EXCEPTION
      'invoice % is %, so a payment cannot be applied to it. Money against a draft has nothing to settle, and money against a cancelled invoice is a refund or a reallocation.',
      NEW.invoice_id, state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_invoice_issued
  BEFORE INSERT ON crm.payment
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_payment_on_unissued();

-- ── Credit notes ───────────────────────────────────────────────────────────
CREATE TABLE crm.credit_note (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant (id),
  invoice_id      uuid NOT NULL,
  entity_party_id uuid NOT NULL,
  number          text NOT NULL,
  financial_year  integer NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  series_type     text NOT NULL DEFAULT 'credit_note'
                  CONSTRAINT credit_note_series_type_chk CHECK (series_type = 'credit_note'),
  amount          numeric(18,4) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL,
  issued_on       date NOT NULL,
  -- MANDATORY, AND A CLOSED SET. The demo's hardest-won finding about revenue:
  -- without this, "the numbers always reconcile; WHY forty thousand came off
  -- does not". Free text would satisfy NOT NULL and would not GROUP BY, which
  -- is the only thing anybody ever wants to do with it — "how much did we write
  -- off to service failures last year" is the question.
  reason          text NOT NULL
                  CHECK (reason IN ('service_failure', 'billing_error', 'goodwill',
                                    'scope_change', 'duplicate_invoice', 'bad_debt')),
  -- The particulars, beside the category. Both, because the category is what
  -- reports and the sentence is what a partner reads.
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_note_number_unique UNIQUE (tenant_id, entity_party_id, number),
  CONSTRAINT credit_note_sequence_unique
    UNIQUE (tenant_id, entity_party_id, financial_year, sequence_number),
  CONSTRAINT credit_note_invoice_fkey
    FOREIGN KEY (invoice_id, tenant_id, currency)
      REFERENCES crm.invoice (id, tenant_id, currency),
  CONSTRAINT credit_note_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT credit_note_series_fkey
    FOREIGN KEY (tenant_id, entity_party_id, financial_year, series_type)
      REFERENCES crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type)
);

CREATE INDEX idx_credit_note_invoice ON crm.credit_note (invoice_id);
CREATE INDEX idx_credit_note_reason ON crm.credit_note (tenant_id, reason, issued_on);

ALTER TABLE crm.credit_note ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_note_isolation ON crm.credit_note
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_credit_note_updated
  BEFORE UPDATE ON crm.credit_note
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- Same freeze as an invoice, same reason: a credit note is a legal document
-- with a consecutive number, and a copy has gone to the client.
CREATE FUNCTION crm.refuse_credit_note_change() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
     OR NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION
      'credit note % is issued, and what it credits, why, and for how much cannot change. Issue another.',
      OLD.number USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_credit_note_freeze
  BEFORE UPDATE ON crm.credit_note
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_credit_note_change();

-- ── What is still owed ─────────────────────────────────────────────────────
--
-- DERIVED, never stored, and the one place the whole question is answered. A
-- `paid` flag and an `amount_paid` column are both caches of this addition and
-- both drift the first time a payment is corrected — leaving an invoice that
-- says "paid" beside arithmetic that says otherwise, where only one of them is
-- evidence.
--
-- Every invoice appears, including one nobody has paid: the LEFT JOINs are what
-- make "who owes us money" answerable from this view alone rather than from
-- this view plus a list of the invoices missing from it.
CREATE VIEW crm.invoice_balance WITH (security_invoker = true) AS
SELECT i.id            AS invoice_id,
       i.tenant_id,
       i.party_id,
       i.status,
       i.currency,
       i.due_on,
       COALESCE(t.total, 0)   AS invoiced,
       COALESCE(p.paid, 0)    AS paid,
       COALESCE(c.credited, 0) AS credited,
       COALESCE(t.total, 0) - COALESCE(p.paid, 0) - COALESCE(c.credited, 0) AS outstanding
FROM crm.invoice i
LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS paid FROM crm.payment GROUP BY invoice_id
) p ON p.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS credited FROM crm.credit_note GROUP BY invoice_id
) c ON c.invoice_id = i.id;

COMMENT ON VIEW crm.invoice_balance IS
  'What each invoice still owes: invoiced - paid - credited, in numeric. Derived rather than stored, because a paid flag and an amount_paid column are caches of this addition and drift the first time a payment is corrected.';

GRANT SELECT, INSERT, UPDATE ON crm.payment TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.credit_note TO bib_app;
GRANT SELECT ON crm.invoice_balance TO bib_app;

RESET ROLE;
