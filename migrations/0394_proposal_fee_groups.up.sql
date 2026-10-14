-- 0394: one fee for several services on a PROPOSAL, as 0083 gave the letter.
--
-- 10x quotes "A1 Accounting INR 70,000 monthly; A2, A3, C1-C3, D1-D2 included
-- in A1" (EduHubSpot, the user 2026-10-14). The letter could say that since
-- 0083; the quote could not, so a firm priced each service or wrote "included"
-- as a pricing note, and the letter drafted from it lost the bundle. A
-- proposal section is the letter's fee group without its prose: a title, one
-- fee, how often and when it is billed, and the services it pays for. The
-- letter drafted from the quote copies it (`draftFromQuote`).
--
-- The letter's rules, restated for the proposal (0083, 0087, 0344):
--   - a grouped line carries no price, discount or note: the fee is the group's;
--   - a grouped line is in its group's currency, by the key onto the group;
--   - a group still covering live services cannot be struck off, and a live
--     service cannot sit in a struck-off group;
--   - nothing changes under a proposal deleted as a mistake;
--   - every live group's currency is the main one or has a rate (0344).
-- No freeze: a proposal is edited only as a draft, which the use case enforces.
--
-- Totals: `crm.proposal_fee_item` is what a proposal charges, one row per line
-- priced on its own and one per live group. Every total reads it, so a grouped
-- line is neither counted as "as mutually agreed" nor charged twice.

SET ROLE bib_owner;

CREATE TABLE crm.proposal_fee_group (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenancy.tenant(id),
  proposal_id       uuid NOT NULL,
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Order only; the section's letter is its rank among live groups when read.
  position          integer NOT NULL CHECK (position > 0),
  title             text NOT NULL CHECK (btrim(title) <> ''),
  billing_frequency text NOT NULL CHECK (billing_frequency IN
                      ('one_time', 'monthly', 'quarterly', 'annually', 'custom')),
  billing_timing    text CHECK (billing_timing IS NULL OR billing_timing IN ('arrears', 'advance', 'on_date')),
  billing_on        date,
  -- Per billing period, as the letter's.
  amount            numeric(18,4) NOT NULL CHECK (amount >= 0),
  payment_terms     text CHECK (payment_terms IS NULL OR btrim(payment_terms) <> ''),
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_fee_group_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  -- What a line references, so a line on one proposal cannot be priced by a
  -- group on another, nor in another currency.
  CONSTRAINT proposal_fee_group_id_proposal_tenant_currency_key
    UNIQUE (id, proposal_id, tenant_id, currency),
  CONSTRAINT proposal_fee_group_billing_on_chk
    CHECK ((billing_timing IS NOT DISTINCT FROM 'on_date') = (billing_on IS NOT NULL))
);

CREATE UNIQUE INDEX proposal_fee_group_one_per_position
  ON crm.proposal_fee_group (proposal_id, position) WHERE removed_at IS NULL;

CREATE TRIGGER trg_proposal_fee_group_updated_at BEFORE UPDATE ON crm.proposal_fee_group
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE TRIGGER trg_proposal_fee_group_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.proposal_fee_group
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

ALTER TABLE crm.proposal_fee_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_fee_group_isolation ON crm.proposal_fee_group
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE crm.proposal_fee_group IS
  'One fee for several services of a proposal (0394): the letter''s fee group (0083) without its prose. Its lines carry no price; the letter drafted from the proposal copies it.';

-- ── a line's membership ─────────────────────────────────────────────────────

ALTER TABLE crm.proposal_line
  ADD COLUMN fee_group_id uuid,
  ADD CONSTRAINT proposal_line_fee_group_fkey
    FOREIGN KEY (fee_group_id, proposal_id, tenant_id, currency)
    REFERENCES crm.proposal_fee_group (id, proposal_id, tenant_id, currency),
  ADD CONSTRAINT proposal_line_grouped_is_unpriced_chk
    CHECK (fee_group_id IS NULL OR (unit_amount IS NULL AND discount_percent = 0 AND pricing_note IS NULL));

-- "Its fee is the group's" is the reason a grouped line has no price.
ALTER TABLE crm.proposal_line DROP CONSTRAINT proposal_line_unpriced_needs_reason_chk;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL OR fee_group_id IS NOT NULL);

CREATE INDEX idx_proposal_line_fee_group ON crm.proposal_line (fee_group_id)
  WHERE fee_group_id IS NOT NULL;

-- ── a live service is never priced by a struck-off group ───────────────────

CREATE FUNCTION crm.refuse_proposal_fee_group_without_its_lines() RETURNS trigger AS $$
DECLARE
  live bigint;
BEGIN
  IF NEW.removed_at IS NULL OR OLD.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO live
    FROM crm.proposal_line
   WHERE fee_group_id = NEW.id AND removed_at IS NULL;
  IF live > 0 THEN
    RAISE EXCEPTION
      'fee group % still covers % live service(s) on proposal %. Move those services out of it, or remove them, first.',
      NEW.id, live, NEW.proposal_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_proposal_fee_group_keeps_its_lines
  BEFORE UPDATE OF removed_at ON crm.proposal_fee_group
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_proposal_fee_group_without_its_lines();

CREATE FUNCTION crm.refuse_proposal_line_in_removed_fee_group() RETURNS trigger AS $$
BEGIN
  IF NEW.fee_group_id IS NULL OR NEW.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM crm.proposal_fee_group
              WHERE id = NEW.fee_group_id AND removed_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'fee group % has been struck off proposal %, so line % cannot be priced by it.',
      NEW.fee_group_id, NEW.proposal_id, NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_proposal_line_group_is_live
  BEFORE INSERT OR UPDATE OF fee_group_id, removed_at ON crm.proposal_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_proposal_line_in_removed_fee_group();

-- ── every live group's currency has a rate (0344's invariant) ──────────────

CREATE OR REPLACE FUNCTION crm.check_document_currencies(kind text, doc uuid) RETURNS void
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
    SELECT x.currency INTO orphan
      FROM (SELECT l.currency FROM crm.proposal_line l
             WHERE l.proposal_id = doc AND l.removed_at IS NULL
            UNION
            SELECT g.currency FROM crm.proposal_fee_group g
             WHERE g.proposal_id = doc AND g.removed_at IS NULL) x
     WHERE x.currency <> main
       AND NOT EXISTS (SELECT 1 FROM crm.proposal_fx_rate r
                        WHERE r.proposal_id = doc AND r.currency = x.currency)
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

CREATE CONSTRAINT TRIGGER trg_proposal_fee_group_currencies
  AFTER INSERT OR UPDATE OF currency, removed_at ON crm.proposal_fee_group
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crm.check_document_currencies_trigger();

-- ── what a proposal charges ─────────────────────────────────────────────────

CREATE VIEW crm.proposal_fee_item WITH (security_invoker = true) AS
  SELECT l.tenant_id, l.proposal_id, l.currency, l.billing_frequency,
         a.gross, a.net, (l.unit_amount IS NULL) AS unpriced
    FROM crm.proposal_line l
    JOIN crm.proposal_line_amount a ON a.id = l.id
   WHERE l.removed_at IS NULL AND l.fee_group_id IS NULL
  UNION ALL
  SELECT g.tenant_id, g.proposal_id, g.currency, g.billing_frequency,
         g.amount, g.amount, false
    FROM crm.proposal_fee_group g
   WHERE g.removed_at IS NULL;

COMMENT ON VIEW crm.proposal_fee_item IS
  'What a proposal charges (0394): each live line priced on its own (gross/net NULL and unpriced when "as mutually agreed") and each live fee group. Grouped lines are not in it: their fee is the group''s.';

RESET ROLE;
