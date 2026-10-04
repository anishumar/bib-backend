-- 0344 · One proposal or engagement letter, fees in more than one currency (Q006, Q008-Q011)
--
-- ── WHAT CHANGES, AND THE DECISION IT REVERSES ──────────────────────────────
--
-- D1 said "one document, one issuer, one currency": every line and every fee
-- group was held to its document's currency by a composite key onto
-- UNIQUE (id, tenant_id, currency). The client (Ashish, 10x Global, 1-4 Oct
-- 2026) wants one EL whose services are priced in different currencies, each
-- in its own, nothing converted: "We should keep multi currency and no need to
-- convert it in INR". Anish agreed to reversing D1 (Shrestha, 2026-10-04).
-- What the client confirmed and this migration therefore holds:
--   - proposals AND letters (Q008);
--   - a fee group (one fee for several services) is ONE currency (Q011);
--   - a tax invoice stays one currency (Q007), so nothing on the invoice side
--     moves here: its keys onto UNIQUE (id, tenant_id, currency) all stay.
--
-- ── WHERE THE RATES LIVE: THE MAIN ONE WHERE IT WAS, THE OTHERS BESIDE IT ───
--
-- The document keeps `currency` / `fx_rate` / `fx_rate_date`: its MAIN currency
-- (the default for a new line, still defaulted from the issuing company) and
-- that currency's rate to the firm's reporting currency. Every OTHER currency a
-- line or group uses has one row in `crm.proposal_fx_rate` /
-- `crm.engagement_letter_fx_rate`, with its own rate and date, frozen with the
-- document exactly as the main one is.
--
-- Chosen over "every rate in the child table" because then NOTHING EXISTING
-- MOVES: every document today is "only its main currency", so it has no child
-- rows, every line's rate is still the document's, and its totals, MRR, PDF and
-- DocuSign hash are byte-identical with no backfill. (A backfill into a child of
-- a SIGNED letter would be refused by 0019's freeze anyway.) And over a rate on
-- each line because two lines in the same currency could then disagree.
--
-- ── THE ONE INVARIANT, CHECKED AT COMMIT ────────────────────────────────────
--
-- For every document: each LIVE line and group is in the document's main
-- currency or in a currency with a rate row, and no rate row repeats the main
-- currency. A key cannot say "this or that", so `crm.check_document_currencies`
-- says it, from DEFERRED constraint triggers on all four tables and on the
-- document's currency: deferred because a legitimate change passes through a
-- moment where it does not hold (make AED the main currency of a letter with
-- AED lines: the AED rate row goes, the head moves, in one transaction). A
-- line with no rate would otherwise drop out of MRR as a silent NULL.
--
-- ── A GROUP'S LINES ARE THE GROUP'S CURRENCY (Q011) ─────────────────────────
--
-- A grouped line carries no price (0083), but its engagement is billed in the
-- group's fee, so the line's currency must be the group's: the line's key onto
-- its group gains the currency. MATCH SIMPLE leaves an ungrouped line alone.
--
-- ── AN ADVANCE IS IN WHAT IT WAS AGREED IN ──────────────────────────────────
--
-- `billing_due_letter_fkey` (0320) put every advance in the LETTER's currency,
-- per-service advances included. A per-service advance is now in its LINE's
-- currency, the letter-wide advance in the letter's main currency (Shrestha,
-- 2026-10-04; the client: two currencies means two advance invoices). Said by
-- a trigger, as the key cannot follow the engagement to its line.
--
-- ── WHAT READS A RATE ───────────────────────────────────────────────────────
--
-- `crm.engagement_mrr` multiplied every line by the LETTER's rate. It now takes
-- the rate of the line's own currency: the letter's when the line is in the
-- main currency (every engagement today), the rate row otherwise. Same column
-- list, same values for every existing row.

SET ROLE bib_owner;

-- ── the rates ───────────────────────────────────────────────────────────────

CREATE TABLE crm.proposal_fx_rate (
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant (id),
  proposal_id  uuid NOT NULL,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- 1 unit of `currency` is this many of the firm's reporting currency: the
  -- document head's own meaning and scale (0011).
  fx_rate      numeric(20,10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date date NOT NULL,
  -- Where the number came from: typed by a person, or a rate service's answer
  -- (or its last stored one), so a report can say "rate of 29 Sep, ECB" rather
  -- than leave a figure nobody can trace. Free text: the providers are config.
  source       text NOT NULL DEFAULT 'typed' CHECK (btrim(source) <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_fx_rate_pkey PRIMARY KEY (proposal_id, currency),
  CONSTRAINT proposal_fx_rate_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id)
);

CREATE TABLE crm.engagement_letter_fx_rate (
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- The column is named `engagement_letter_id` on purpose: 0019's child freeze
  -- and 0087's deleted-parent guard both find the parent by that name, and the
  -- freeze sweep test finds child tables by it.
  engagement_letter_id uuid NOT NULL,
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fx_rate              numeric(20,10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date         date NOT NULL,
  source               text NOT NULL DEFAULT 'typed' CHECK (btrim(source) <> ''),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_letter_fx_rate_pkey PRIMARY KEY (engagement_letter_id, currency),
  CONSTRAINT engagement_letter_fx_rate_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id)
);

CREATE TRIGGER trg_proposal_fx_rate_updated_at BEFORE UPDATE ON crm.proposal_fx_rate
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE TRIGGER trg_el_fx_rate_updated_at BEFORE UPDATE ON crm.engagement_letter_fx_rate
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- A signed letter's rates are terms like its prices: frozen (0019, 0024).
CREATE TRIGGER trg_el_fx_rate_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.engagement_letter_fx_rate
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();
-- And nothing changes under a document deleted as a mistake (0087). Named to
-- sort after the freeze, as 0087's are.
CREATE TRIGGER trg_el_fx_rate_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_fx_rate
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();
CREATE TRIGGER trg_proposal_fx_rate_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.proposal_fx_rate
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

ALTER TABLE crm.proposal_fx_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_fx_rate_isolation ON crm.proposal_fx_rate
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE crm.engagement_letter_fx_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY engagement_letter_fx_rate_isolation ON crm.engagement_letter_fx_rate
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The schema's default privileges give bib_app SELECT, INSERT, UPDATE; a rate a
-- draft no longer uses is DELETED (it is a draft's working figure, and a sent
-- or signed document cannot lose one: the invariant and the freeze say so).
GRANT DELETE ON crm.proposal_fx_rate TO bib_app;
GRANT DELETE ON crm.engagement_letter_fx_rate TO bib_app;

-- ── lines and groups: free of the document's currency ───────────────────────

ALTER TABLE crm.proposal_line DROP CONSTRAINT proposal_line_proposal_fkey;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id);

ALTER TABLE crm.engagement_letter_line DROP CONSTRAINT el_line_letter_fkey;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id);

ALTER TABLE crm.engagement_letter_fee_group DROP CONSTRAINT el_fee_group_letter_fkey;
ALTER TABLE crm.engagement_letter_fee_group
  ADD CONSTRAINT el_fee_group_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id),
  ADD CONSTRAINT el_fee_group_id_letter_tenant_currency_key
    UNIQUE (id, engagement_letter_id, tenant_id, currency);

-- A grouped line is in its group's currency (Q011).
ALTER TABLE crm.engagement_letter_line DROP CONSTRAINT el_line_fee_group_fkey;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_fee_group_fkey
    FOREIGN KEY (fee_group_id, engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter_fee_group (id, engagement_letter_id, tenant_id, currency);

-- ── the invariant ───────────────────────────────────────────────────────────

CREATE FUNCTION crm.check_document_currencies(kind text, doc uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  main    text;
  ref     text;
  orphan  text;
  repeats boolean;
BEGIN
  IF kind = 'proposal' THEN
    SELECT p.currency, p.ref INTO main, ref FROM crm.proposal p WHERE p.id = doc;
    IF main IS NULL THEN RETURN; END IF;
    SELECT l.currency INTO orphan
      FROM crm.proposal_line l
     WHERE l.proposal_id = doc AND l.removed_at IS NULL AND l.currency <> main
       AND NOT EXISTS (SELECT 1 FROM crm.proposal_fx_rate r
                        WHERE r.proposal_id = doc AND r.currency = l.currency)
     LIMIT 1;
    SELECT EXISTS (SELECT 1 FROM crm.proposal_fx_rate r
                    WHERE r.proposal_id = doc AND r.currency = main) INTO repeats;
  ELSE
    SELECT el.currency, el.ref INTO main, ref FROM crm.engagement_letter el WHERE el.id = doc;
    IF main IS NULL THEN RETURN; END IF;
    SELECT x.currency INTO orphan
      FROM (SELECT l.currency FROM crm.engagement_letter_line l
             WHERE l.engagement_letter_id = doc AND l.removed_at IS NULL
            UNION
            SELECT g.currency FROM crm.engagement_letter_fee_group g
             WHERE g.engagement_letter_id = doc AND g.removed_at IS NULL) x
     WHERE x.currency <> main
       AND NOT EXISTS (SELECT 1 FROM crm.engagement_letter_fx_rate r
                        WHERE r.engagement_letter_id = doc AND r.currency = x.currency)
     LIMIT 1;
    SELECT EXISTS (SELECT 1 FROM crm.engagement_letter_fx_rate r
                    WHERE r.engagement_letter_id = doc AND r.currency = main) INTO repeats;
  END IF;

  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION '% has fees in % and no exchange rate for %. Give % a rate first.',
      coalesce(ref, 'This document'), orphan, orphan, orphan
      USING ERRCODE = 'check_violation';
  END IF;
  IF repeats THEN
    RAISE EXCEPTION '% is already in %, so it needs no second rate for it.',
      coalesce(ref, 'This document'), main
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION crm.check_document_currencies_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  IF TG_TABLE_NAME IN ('proposal', 'engagement_letter') THEN
    PERFORM crm.check_document_currencies(
      CASE TG_TABLE_NAME WHEN 'proposal' THEN 'proposal' ELSE 'engagement_letter' END,
      (rec ->> 'id')::uuid);
  ELSIF rec ? 'proposal_id' THEN
    PERFORM crm.check_document_currencies('proposal', (rec ->> 'proposal_id')::uuid);
  ELSE
    PERFORM crm.check_document_currencies('engagement_letter', (rec ->> 'engagement_letter_id')::uuid);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_proposal_currencies
  AFTER UPDATE OF currency ON crm.proposal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();
CREATE CONSTRAINT TRIGGER trg_proposal_line_currencies
  AFTER INSERT OR UPDATE OF currency, removed_at ON crm.proposal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();
CREATE CONSTRAINT TRIGGER trg_proposal_fx_rate_currencies
  AFTER INSERT OR UPDATE OR DELETE ON crm.proposal_fx_rate
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();

CREATE CONSTRAINT TRIGGER trg_el_currencies
  AFTER UPDATE OF currency ON crm.engagement_letter
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();
CREATE CONSTRAINT TRIGGER trg_el_line_currencies
  AFTER INSERT OR UPDATE OF currency, removed_at ON crm.engagement_letter_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();
CREATE CONSTRAINT TRIGGER trg_el_fee_group_currencies
  AFTER INSERT OR UPDATE OF currency, removed_at ON crm.engagement_letter_fee_group
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();
CREATE CONSTRAINT TRIGGER trg_el_fx_rate_currencies
  AFTER INSERT OR UPDATE OR DELETE ON crm.engagement_letter_fx_rate
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();

-- ── an advance is in what it was agreed in ──────────────────────────────────

ALTER TABLE crm.billing_due DROP CONSTRAINT billing_due_letter_fkey;
ALTER TABLE crm.billing_due
  ADD CONSTRAINT billing_due_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id);

CREATE FUNCTION crm.refuse_advance_in_another_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  agreed text;
BEGIN
  IF NEW.kind <> 'advance' THEN RETURN NEW; END IF;
  IF NEW.engagement_id IS NULL THEN
    SELECT el.currency INTO agreed FROM crm.engagement_letter el WHERE el.id = NEW.engagement_letter_id;
  ELSE
    SELECT ll.currency INTO agreed
      FROM crm.engagement e
      JOIN crm.engagement_letter_line ll
        ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
     WHERE e.id = NEW.engagement_id;
  END IF;
  IF agreed IS NOT NULL AND agreed <> NEW.currency THEN
    RAISE EXCEPTION 'An advance is billed in what it was agreed in: %, not %.', agreed, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_billing_due_advance_currency
  BEFORE INSERT OR UPDATE OF currency, kind, engagement_id, engagement_letter_id ON crm.billing_due
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_advance_in_another_currency();

-- ── MRR at the rate of each line's own currency ─────────────────────────────

CREATE OR REPLACE VIEW crm.engagement_mrr WITH (security_invoker = true) AS
WITH shares AS (
  SELECT l.id AS line_id,
         g.billing_frequency AS group_frequency,
         CASE
           WHEN row_number() OVER w < count(*) OVER w
             THEN round(g.amount / count(*) OVER w, 4)
           ELSE g.amount - round(g.amount / count(*) OVER w, 4) * (count(*) OVER w - 1)
         END AS share
  FROM crm.engagement_letter_line l
  JOIN crm.engagement_letter_fee_group g
    ON g.id = l.fee_group_id AND g.tenant_id = l.tenant_id
  WHERE l.removed_at IS NULL AND g.removed_at IS NULL
  WINDOW w AS (PARTITION BY g.id ORDER BY l.position
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
),
-- The rate of the line's OWN currency: the letter's when the line is in its
-- main currency (every engagement before 0344), its rate row otherwise.
priced AS (
  SELECT l.id AS line_id,
         (CASE WHEN l.currency = el.currency THEN el.fx_rate ELSE r.fx_rate END)::numeric(20,10) AS fx_rate,
         CASE WHEN l.currency = el.currency THEN el.fx_rate_date ELSE r.fx_rate_date END AS fx_rate_date
  FROM crm.engagement_letter_line l
  JOIN crm.engagement_letter el
    ON el.id = l.engagement_letter_id AND el.tenant_id = l.tenant_id
  LEFT JOIN crm.engagement_letter_fx_rate r
    ON r.engagement_letter_id = el.id AND r.tenant_id = el.tenant_id AND r.currency = l.currency
)
SELECT e.id                          AS engagement_id,
       e.tenant_id,
       e.party_id,
       e.entity_party_id,
       e.status,
       l.service_version_id,
       coalesce(s.group_frequency, l.billing_frequency) AS billing_frequency,
       l.currency,
       p.fx_rate,
       p.fx_rate_date,

       CASE
         WHEN s.line_id IS NOT NULL THEN s.share
         WHEN l.unit_amount IS NULL THEN NULL
         ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
       END                           AS line_amount,

       CASE
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'monthly'   THEN s.share
             WHEN 'quarterly' THEN round(s.share / 3, 4)
             WHEN 'annually'  THEN round(s.share / 12, 4)
             ELSE NULL
           END
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 12, 4)
         ELSE NULL
       END                           AS monthly_amount,

       CASE
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'monthly'   THEN round(s.share * p.fx_rate, 4)
             WHEN 'quarterly' THEN round(s.share * p.fx_rate / 3, 4)
             WHEN 'annually'  THEN round(s.share * p.fx_rate / 12, 4)
             ELSE NULL
           END
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * p.fx_rate, 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * p.fx_rate / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * p.fx_rate / 12, 4)
         ELSE NULL
       END                           AS monthly_reporting,

       CASE
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'one_time' THEN 'one_time'
             WHEN 'custom'   THEN 'custom_frequency'
             ELSE NULL
           END
         WHEN l.unit_amount IS NULL                  THEN 'unpriced'
         WHEN l.billing_frequency IS NULL            THEN 'no_frequency_stated'
         WHEN l.billing_frequency = 'one_time'       THEN 'one_time'
         WHEN l.billing_frequency = 'custom'         THEN 'custom_frequency'
         ELSE NULL
       END                           AS excluded_because

FROM crm.engagement e
JOIN crm.engagement_letter_line l
  ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
JOIN priced p ON p.line_id = l.id
LEFT JOIN shares s ON s.line_id = l.id
WHERE l.removed_at IS NULL;

RESET ROLE;
