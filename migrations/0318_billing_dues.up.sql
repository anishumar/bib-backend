-- 0318 · Recurring billing: what is due to be billed, and whose kitty it goes in
--         (auto-invoice, phase 1)
--
-- The firm's problem, in its own words: work arrives on the board every month
-- by itself, an invoice only when somebody remembers, and a forgotten bill is
-- a service delivered for free. This migration lets a sweep say WHAT IS OWED.
--
-- ── A DUE, NOT AN INVOICE ─────────────────────────────────────────────────
--
-- An invoice draws its number from the gapless GST series when its DRAFT is
-- created (0027), so a sweep that drafted invoices would leave a cancelled
-- number behind every bill a manager decided not to raise. `crm.billing_due`
-- carries no number: it is "this client owes a bill for this service for this
-- period", and a person turns one or more dues into an invoice. Its amount may
-- be NULL (a line priced "as mutually agreed"): the invoice line's NOT NULL
-- amount is met when a person types it, not invented here.
--
-- ── THE FIRM'S RULES (Ashish, 2026-10-01) ─────────────────────────────────
--
--   * tenancy.tenant.auto_billing — the switch. FALSE by default, so applying
--     this changed no firm's behaviour; the sweep writes nothing until a firm
--     turns it on (client_request_routing's position, 0070).
--   * crm.engagement.billing_from + first_invoice_on — the FIRST period billed
--     (its first day) and the date its invoice falls due; later periods follow
--     at the letter's frequency, each one span after the last. Both are needed:
--     a 1 November invoice may be October's (arrears) or November's (advance),
--     and a yearly audit billed in October 2026 is FY 2025-26's. NULL means
--     billing is not set up and nothing is billed: it is each client's go-live,
--     because the firm has no single go-live day, and nothing before
--     `billing_from` is ever billed, so an existing client's earlier, manually
--     billed months raise nothing.
--   * Pro-rata by DAYS, computed HERE (`amount` is generated from the full
--     amount and the days), never in TypeScript.
--   * Revenue belongs to a MANAGER (`crm.invoice.manager_user_id`), frozen once
--     the invoice is issued, because "reports to" is not effective-dated and a
--     team change must not move last quarter's revenue.
--
-- ── crm.engagement.paused_on ──────────────────────────────────────────────
--
-- `paused_at` (0314) is cleared on resume, so after a pause nothing said when
-- it BEGAN, and a period half served before the pause could not be pro-rated.
-- `paused_on` is the firm's day the LAST pause began and is kept after the
-- resume. Backfilled from `paused_at` for engagements paused now, and from the
-- latest `engagement.resumed` event's `pausedAt` for those already resumed.

SET ROLE bib_owner;

-- ── The switch ──────────────────────────────────────────────────────────────

ALTER TABLE tenancy.tenant
  ADD COLUMN auto_billing boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenancy.tenant.auto_billing IS
  'Whether the billing sweep writes bill dues for this firm (0318). FALSE by default: nothing is billed automatically until the firm turns it on.';

-- ── The schedule, and the pause's first day ─────────────────────────────────

ALTER TABLE crm.engagement
  ADD COLUMN billing_from     date,
  ADD COLUMN first_invoice_on date,
  ADD COLUMN paused_on        date;

ALTER TABLE crm.engagement
  ADD CONSTRAINT engagement_billing_schedule_chk CHECK (
    (billing_from IS NULL) = (first_invoice_on IS NULL)
  );

COMMENT ON COLUMN crm.engagement.billing_from IS
  'The first day of the FIRST billing period (0318). Nothing before it is billed by the sweep. NULL = billing not set up.';
COMMENT ON COLUMN crm.engagement.first_invoice_on IS
  'The date the invoice for the period starting billing_from falls due; each later period one billing span after (0318). NULL = billing not set up.';
COMMENT ON COLUMN crm.engagement.paused_on IS
  'The firm''s day the LAST pause began (0318). Kept after a resume, unlike paused_at, so a period half served before a pause can be billed pro-rata.';

UPDATE crm.engagement e
   SET paused_on = (e.paused_at AT TIME ZONE t.time_zone)::date
  FROM tenancy.tenant t
 WHERE t.id = e.tenant_id
   AND e.paused_at IS NOT NULL;

UPDATE crm.engagement e
   SET paused_on = (
         SELECT ((ev.payload ->> 'pausedAt')::timestamptz AT TIME ZONE t.time_zone)::date
           FROM ledger.event ev
          WHERE ev.tenant_id = e.tenant_id
            AND ev.object_id = e.id
            AND ev.verb = 'engagement.resumed'
            AND ev.payload ->> 'pausedAt' IS NOT NULL
          ORDER BY ev.occurred_at DESC
          LIMIT 1
       )
  FROM tenancy.tenant t
 WHERE t.id = e.tenant_id
   AND e.paused_at IS NULL
   AND e.resumed_on IS NOT NULL;

-- ── Whose kitty an invoice is in ────────────────────────────────────────────

ALTER TABLE crm.invoice
  ADD COLUMN manager_user_id uuid REFERENCES tenancy.user_account (id);

COMMENT ON COLUMN crm.invoice.manager_user_id IS
  'The manager whose revenue this invoice is (0318). Set from the bill dues it was raised from; frozen once the invoice is issued.';

CREATE FUNCTION crm.refuse_issued_invoice_manager_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.manager_user_id IS DISTINCT FROM OLD.manager_user_id THEN
    RAISE EXCEPTION
      'invoice % has been issued, so whose revenue it is cannot change.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort after trg_invoice_number_freeze: BEFORE triggers fire in name
-- order, and a change the number freeze refuses must be refused as that.
CREATE TRIGGER trg_invoice_z_manager_freeze
  BEFORE UPDATE OF manager_user_id ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_issued_invoice_manager_change();

-- ── Keys the dues reference ─────────────────────────────────────────────────

ALTER TABLE crm.engagement_letter_fee_group
  ADD CONSTRAINT el_fee_group_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE crm.invoice_line
  ADD CONSTRAINT invoice_line_id_tenant_key UNIQUE (id, tenant_id);

-- ── The dues ────────────────────────────────────────────────────────────────

CREATE TABLE crm.billing_due (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- Who is billed, by which of the firm's companies, in what currency: the
  -- three things one invoice must share (0027, F-10-1).
  party_id                uuid NOT NULL,
  issuing_entity_party_id uuid NOT NULL,
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- What is billed: one engagement priced on its own, or one fee group
  -- (0083) priced once for several services. Never both.
  engagement_id           uuid,
  fee_group_id            uuid,
  period_start            date NOT NULL,
  period_end              date NOT NULL,
  period_label            text NOT NULL CHECK (btrim(period_label) <> ''),
  bill_on                 date NOT NULL,
  -- The letter's amount for one whole period; NULL when the letter names no
  -- price. `amount` is it pro-rated by days, in numeric, by the database.
  full_amount             numeric(18,4) CHECK (full_amount IS NULL OR full_amount >= 0),
  served_days             integer NOT NULL CHECK (served_days > 0),
  period_days             integer NOT NULL CHECK (period_days >= served_days),
  amount                  numeric(18,2) GENERATED ALWAYS AS (
                            round(full_amount * served_days / period_days, 2)
                          ) STORED,
  manager_user_id         uuid REFERENCES tenancy.user_account (id),
  manager_how             text NOT NULL CHECK (manager_how IN ('spoc_manager', 'key_manager', 'none')),
  manager_note            text CHECK (manager_note IS NULL OR btrim(manager_note) <> ''),
  invoice_id              uuid,
  invoice_line_id         uuid,
  skipped_at              timestamptz,
  skipped_by_user_id      uuid REFERENCES tenancy.user_account (id),
  skip_reason             text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_due_one_subject_chk CHECK ((engagement_id IS NULL) <> (fee_group_id IS NULL)),
  CONSTRAINT billing_due_period_chk CHECK (period_start <= period_end),
  CONSTRAINT billing_due_manager_chk CHECK (
    (manager_how = 'none') = (manager_user_id IS NULL)
    AND (manager_how = 'spoc_manager') = (manager_note IS NULL)
  ),
  CONSTRAINT billing_due_skip_chk CHECK (
    (skipped_at IS NULL) = (skipped_by_user_id IS NULL)
    AND (skipped_at IS NULL) = (skip_reason IS NULL)
    AND (skip_reason IS NULL OR (btrim(skip_reason) <> '' AND length(skip_reason) <= 500))
  ),
  CONSTRAINT billing_due_line_needs_invoice_chk CHECK (invoice_line_id IS NULL OR invoice_id IS NOT NULL),
  CONSTRAINT billing_due_party_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT billing_due_issuer_fkey
    FOREIGN KEY (issuing_entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT billing_due_engagement_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id),
  CONSTRAINT billing_due_fee_group_fkey
    FOREIGN KEY (fee_group_id, tenant_id) REFERENCES crm.engagement_letter_fee_group (id, tenant_id),
  -- The invoice must be in the due's currency: an INR bill on a USD invoice is
  -- ENGAGEMENT_IN_ANOTHER_CURRENCY's mistake (2026-09-28), refused by a key.
  CONSTRAINT billing_due_invoice_fkey
    FOREIGN KEY (invoice_id, tenant_id, currency) REFERENCES crm.invoice (id, tenant_id, currency),
  CONSTRAINT billing_due_invoice_line_fkey
    FOREIGN KEY (invoice_line_id, tenant_id) REFERENCES crm.invoice_line (id, tenant_id)
);

-- One due per subject per period: a redelivered sweep, or two workers, write
-- one row (ON CONFLICT DO NOTHING), which is what stops a period being billed
-- twice.
CREATE UNIQUE INDEX billing_due_engagement_period
  ON crm.billing_due (tenant_id, engagement_id, period_start) WHERE engagement_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_fee_group_period
  ON crm.billing_due (tenant_id, fee_group_id, period_start) WHERE fee_group_id IS NOT NULL;
CREATE INDEX idx_billing_due_tenant_bill_on ON crm.billing_due (tenant_id, bill_on);
CREATE INDEX idx_billing_due_invoice ON crm.billing_due (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;

ALTER TABLE crm.billing_due ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_due_isolation ON crm.billing_due
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The crm schema's default privileges hand bib_app UPDATE on every new table
-- (found by 0317), so REVOKE first. What a person may change on a due is how it
-- was settled — raised, linked, or skipped — and nothing about what was owed.
REVOKE ALL ON crm.billing_due FROM bib_app;
GRANT SELECT, INSERT ON crm.billing_due TO bib_app;
GRANT UPDATE (invoice_id, invoice_line_id, skipped_at, skipped_by_user_id, skip_reason)
  ON crm.billing_due TO bib_app;

COMMENT ON TABLE crm.billing_due IS
  'A bill a recurring engagement (or fee group) owes for one period, written by the billing sweep (0318). Not an invoice and carries no number: a person raises an invoice from one or more dues, links one already raised, or skips it with a reason. Status is derived: open / drafted / billed / skipped; a cancelled invoice makes its dues open again.';

RESET ROLE;
