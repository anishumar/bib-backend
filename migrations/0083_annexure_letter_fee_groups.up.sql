-- 0083 · The Annexure letter, and one fee that covers several services
--
-- The firm's new engagement letter (10X Global, "MyDojo EL", July 2026) is a
-- different DOCUMENT from the one this product prints, not a restyle of it:
--
--   page 1      a cover letter — date, addressee, subject, the firm's own
--               opening paragraphs, "Yours sincerely" and the firm's signature,
--               then an Acceptance paragraph and the client's signature;
--   Annexure 1  Scope of Services, Deliverables & Fees — background, then the
--               work in SECTIONS ("A. One-time initial activities", "B. Ongoing
--               recurring services"), each service with its scope, the client's
--               responsibilities and its exclusions, then a SUMMARY OF FEES with
--               one row per section, then commercials, team and exclusions;
--   Annexure 2  the standard terms and conditions, numbered.
--
-- Three things in that document have nowhere to live today, and each is one
-- part of this migration.
--
-- ── 1. WHICH LAYOUT A LETTER PRINTS IN — `crm.engagement_letter.layout` ──────
--
-- A rendered letter's bytes are evidence (T3.8): `signed_content_hash`, the
-- DocuSign envelope's stamped hash and `files.document_version.content_hash`
-- all rest on "re-rendering unchanged data reproduces the file". Switching every
-- letter to the new layout would re-render every letter ALREADY ISSUED as a
-- document the client never saw — and an envelope still out for signature would
-- carry a PDF the product can no longer produce. So the layout is a fact about
-- the letter, recorded, and never derived from the date or the code version.
--
--   'classic'   every letter that has already gone out — sent, signed or
--               withdrawn. It is TRUE of them: that is the layout they were
--               issued in. Not an invented value, which is why this NOT NULL
--               column is honest where 0020's `ref` was not.
--   'annexure'  every DRAFT, and every letter drafted from now on (decided
--               2026-09-26: "switch everyone"). A draft has been sent to nobody,
--               so there is no issued document for its bytes to have to match.
--
-- ADD COLUMN with a constant default writes no rows, so no trigger fires and a
-- signed letter is not touched — the freeze (0019) compares the whole row, and
-- from this moment `layout` is inside that comparison like every other column:
-- a signed letter's layout can never change. The drafts are then moved with an
-- ordinary UPDATE, which the freeze allows because none of them is signed.
--
-- NOT a term, and deliberately absent from `canonicalContent`: the same letter
-- in either layout is the same agreement. What changes with it is PRESENTATION.
--
-- ── 2. A FEE THAT COVERS SEVERAL SERVICES — `crm.engagement_letter_fee_group`
--
-- "USD 5,000 per month" in the MyDojo letter pays for B1 Accounting, B2 Tax and
-- B3 Payroll across four companies. G0.1 makes that TWELVE lines — an
-- engagement is one service for one legal entity — and until now every one of
-- them had to carry a price of its own. There was no honest way to write the
-- retainer down: split it twelve ways and the letter states twelve prices
-- nobody agreed to; put 5,000 on one line and zero on eleven and the letter says
-- eleven services are free.
--
-- A fee group IS a section of Annexure 1: a title, the fee, how often it is
-- billed, how it is paid ("40% advance, 60% on completion"), the sentence the
-- Summary of Fees prints, and the section's own prose — its introduction, its
-- deliverables and the client's responsibilities for the section as a whole.
-- Its LINES carry no price of their own (`el_line_grouped_is_unpriced_chk`):
-- the fee is the group's, stated once.
--
-- The fee is a TERM and the signature commits to it — the group is inside
-- `canonicalContent` (domain/engagement/model.ts) — and the freeze reaches it
-- for free: `crm.refuse_signed_child_change()` resolves its parent from
-- `engagement_letter_id`, which this table has, exactly as 0025 found for the
-- prose blocks.
--
-- ONE LETTER, ONE CURRENCY: the group is held to its letter's currency by the
-- same composite key a line is (0017), so a USD retainer on an INR letter is
-- unrepresentable rather than merely refused.
--
-- `removed_at` is THE FOURTH SOFT DELETE, and it carries the argument CLAUDE.md
-- asks of one: a group is a row of the document's own Summary of Fees, struck
-- off while the document is a draft — the same thing a removed line is. A group
-- that still has live services cannot be struck off (`trg_el_fee_group_keeps_its_lines`),
-- because its services would be left with no price and no reason.
--
-- ── 3. THE COVER LETTER AND THE ACCEPTANCE ARE THE FIRM'S OWN PROSE ──────────
--
-- Two new kinds of document block, `cover` and `acceptance`. They are the
-- paragraphs the new letter opens with and the sentence the client accepts
-- under, and they are LEGAL TEXT — "You may procure services under this
-- Agreement for ... your consolidated subsidiaries" binds a client's group. So
-- they are not written by this product: the firm maintains them once in its
-- standard set (G1.7), each new letter copies them, the copy is edited per
-- letter, and a signed letter's copy is frozen. Exactly the arrangement the
-- exclusions have, which is why this is two words in a CHECK and not a table.
--
-- Nothing is seeded. A firm's cover letter says what the firm decided it says,
-- and a default this product invented would be a paragraph on a contract that
-- nobody at the firm wrote. Until a firm writes one, its letters open with the
-- date, the addressee and the subject, and go straight to the signature.
--
-- They are LETTER-ONLY: a proposal has no cover letter and nobody accepts it by
-- signing. `document_block_letter_only_kinds_chk` says so to any writer, not
-- only to the service.
--
-- ── 4. MRR, NOW THAT A FEE CAN COVER SEVERAL ENGAGEMENTS ─────────────────────
--
-- `crm.engagement_mrr` (0038) reads each engagement's price off its letter
-- line. A grouped line has none, so every engagement a retainer covers would
-- have been counted `unpriced` — MRR would have silently lost the firm's
-- largest recurring fees and blamed the firm for not pricing them. See the view
-- below for how the group's fee is shared.

SET ROLE bib_owner;

-- ── 1. layout ────────────────────────────────────────────────────────────────

ALTER TABLE crm.engagement_letter
  ADD COLUMN layout text NOT NULL DEFAULT 'classic'
    CONSTRAINT el_layout_chk CHECK (layout IN ('classic', 'annexure'));

UPDATE crm.engagement_letter SET layout = 'annexure' WHERE status = 'draft';

-- From here on, a letter nobody names a layout for is an Annexure letter. The
-- service always names it; this is for the writers that are not the service.
ALTER TABLE crm.engagement_letter ALTER COLUMN layout SET DEFAULT 'annexure';

COMMENT ON COLUMN crm.engagement_letter.layout IS
  'Which layout the letter PRINTS in. classic: every letter issued before 0083. annexure: cover letter + Annexure 1 (scope, deliverables, fees) + Annexure 2 (terms). Presentation, not a term — absent from the content hash — and frozen with the rest of a signed letter, so a re-render reproduces the document the client holds.';

-- ── 2. fee groups ────────────────────────────────────────────────────────────

CREATE TABLE crm.engagement_letter_fee_group (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant(id),
  engagement_letter_id uuid NOT NULL,
  -- Held to the letter's by the composite key below.
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The section's ORDER. Its letter (A, B, …) is derived from its rank among the
  -- live groups when it is read, so striking out A does not leave a letter that
  -- starts at B.
  position             integer NOT NULL CHECK (position > 0),
  -- "Ongoing recurring services" — the section heading and the name a screen
  -- lists it by.
  title                text NOT NULL CHECK (btrim(title) <> ''),
  -- The same vocabulary as a line's (0023). NOT NULL, unlike a line's: a group
  -- exists to state a fee, and a fee with no period is not one anybody can bill.
  billing_frequency    text NOT NULL CHECK (billing_frequency IN
                         ('one_time', 'monthly', 'quarterly', 'annually', 'custom')),
  -- PER BILLING PERIOD — 5,000 on a monthly group is 5,000 a month. NOT NULL:
  -- "as mutually agreed" belongs on a line of its own, where 0023's pricing
  -- note already says it; a group with no fee is a heading.
  amount               numeric(18,4) NOT NULL CHECK (amount >= 0),
  -- "40% advance, 60% on completion". Prose, because how a firm staggers a fee
  -- is not a shape anybody has asked this product to compute.
  payment_terms        text CHECK (payment_terms IS NULL OR btrim(payment_terms) <> ''),
  -- The sentence the Summary of Fees prints for this section. NULL prints the
  -- title and the services it covers.
  fee_description      text CHECK (fee_description IS NULL OR btrim(fee_description) <> ''),
  -- The section's own prose: the paragraph under its heading, what it delivers
  -- as a whole, and what the client must do for it as a whole. Each service's
  -- own scope, responsibilities and exclusions stay on its LINE (0023's four
  -- blocks); these are the section-level ones the letter prints after them.
  intro                text CHECK (intro IS NULL OR btrim(intro) <> ''),
  deliverables         text CHECK (deliverables IS NULL OR btrim(deliverables) <> ''),
  client_obligations   text CHECK (client_obligations IS NULL OR btrim(client_obligations) <> ''),
  removed_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- The letter, its tenant AND its currency in one key — the line's own
  -- arrangement (0017), so a fee in another currency is unrepresentable.
  CONSTRAINT el_fee_group_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency),
  -- What a line references: the group, its LETTER and its tenant. Carrying the
  -- letter is what stops a line on one letter being priced by a group on
  -- another, which no amount of checking in the service makes impossible.
  CONSTRAINT el_fee_group_id_letter_tenant_key UNIQUE (id, engagement_letter_id, tenant_id)
);

-- UNIQUE SCOPE: one live group per position per LETTER. Struck-off groups are
-- excluded, the line's own arrangement (`el_line_one_per_position`).
CREATE UNIQUE INDEX el_fee_group_one_per_position
  ON crm.engagement_letter_fee_group (engagement_letter_id, position) WHERE removed_at IS NULL;

CREATE TRIGGER trg_el_fee_group_updated_at BEFORE UPDATE ON crm.engagement_letter_fee_group
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- THE FREEZE, reused rather than restated. 0024's function checks the letter a
-- row belongs to AND the one it is moving to, by `engagement_letter_id`.
CREATE TRIGGER trg_el_fee_group_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.engagement_letter_fee_group
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();

ALTER TABLE crm.engagement_letter_fee_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY el_fee_group_isolation ON crm.engagement_letter_fee_group
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── 2b. a line's membership ──────────────────────────────────────────────────
--
-- NULLABLE, and null is the ordinary case: a line priced on its own. It is also
-- the only option — 0018 and CLAUDE.md: once signed letters exist, no NOT NULL
-- column can be added to a letter line, because the freeze refuses a backfill.

ALTER TABLE crm.engagement_letter_line
  ADD COLUMN fee_group_id uuid,
  -- MATCH SIMPLE: a line with no group skips the check entirely.
  ADD CONSTRAINT el_line_fee_group_fkey
    FOREIGN KEY (fee_group_id, engagement_letter_id, tenant_id)
    REFERENCES crm.engagement_letter_fee_group (id, engagement_letter_id, tenant_id),
  -- THE FEE IS THE GROUP'S. A grouped line carrying a price of its own would be
  -- counted twice — once in the group, once on the line — and a discount off a
  -- price the line does not have is not a number (0023's rule, again).
  ADD CONSTRAINT el_line_grouped_is_unpriced_chk
    CHECK (fee_group_id IS NULL OR (unit_amount IS NULL AND discount_percent = 0));

-- 0023's rule, widened by exactly one case. A line with no price still has to
-- say WHY — and "its fee is the group's" is a why the row itself states, so a
-- grouped line needs no pricing note to be readable.
ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT el_line_unpriced_needs_reason_chk;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL OR fee_group_id IS NOT NULL);

CREATE INDEX idx_el_line_fee_group ON crm.engagement_letter_line (fee_group_id)
  WHERE fee_group_id IS NOT NULL;

-- ── 2c. a live service is never priced by a struck-off group ────────────────
--
-- The foreign key cannot see `removed_at`, so this is a trigger, and it guards
-- the fact from both sides: a group with live services cannot be struck off,
-- and a live service cannot be put into (or left in) a group that has been.
-- Either way round the result is a service on a contract with no price and no
-- reason — the state 0023 made unrepresentable for a line on its own.
--
-- Both triggers are NAMED to sort after the freeze on their table (BEFORE
-- triggers fire in name order — 0306's rule), so a change to a signed letter is
-- refused as that.

CREATE OR REPLACE FUNCTION crm.refuse_fee_group_without_its_lines() RETURNS trigger AS $$
DECLARE
  live bigint;
BEGIN
  IF NEW.removed_at IS NULL OR OLD.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO live
    FROM crm.engagement_letter_line
   WHERE fee_group_id = NEW.id AND removed_at IS NULL;
  IF live > 0 THEN
    RAISE EXCEPTION
      'fee group % still covers % live service(s) on engagement letter %. Move those services out of it, or remove them from the letter, first: struck off, it would leave them with no price and no reason.',
      NEW.id, live, NEW.engagement_letter_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_fee_group_keeps_its_lines
  BEFORE UPDATE OF removed_at ON crm.engagement_letter_fee_group
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_fee_group_without_its_lines();

CREATE OR REPLACE FUNCTION crm.refuse_line_in_removed_fee_group() RETURNS trigger AS $$
BEGIN
  IF NEW.fee_group_id IS NULL OR NEW.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crm.engagement_letter_fee_group
     WHERE id = NEW.fee_group_id AND removed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'fee group % has been struck off engagement letter %, so line % cannot be priced by it. Put the service in a live group, or price it on its own line.',
      NEW.fee_group_id, NEW.engagement_letter_id, NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_line_group_is_live
  BEFORE INSERT OR UPDATE OF fee_group_id, removed_at ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_line_in_removed_fee_group();

-- ── 3. the cover letter and the acceptance ──────────────────────────────────

ALTER TABLE crm.standard_document_block
  DROP CONSTRAINT standard_document_block_kind_check;
ALTER TABLE crm.standard_document_block
  ADD CONSTRAINT standard_document_block_kind_check
    CHECK (kind IN ('exclusion', 'commercial', 'team', 'cover', 'acceptance'));

ALTER TABLE crm.document_block
  DROP CONSTRAINT document_block_kind_check;
ALTER TABLE crm.document_block
  ADD CONSTRAINT document_block_kind_check
    CHECK (kind IN ('exclusion', 'commercial', 'team', 'cover', 'acceptance'));

-- A proposal has no cover letter and nobody signs one to accept it.
ALTER TABLE crm.document_block
  ADD CONSTRAINT document_block_letter_only_kinds_chk
    CHECK (proposal_id IS NULL OR kind IN ('exclusion', 'commercial', 'team'));

-- ── 4. MRR ───────────────────────────────────────────────────────────────────
--
-- A GROUPED engagement's revenue is its SHARE of the group's fee: the fee split
-- equally across the group's live services, with the last one (by line
-- position) taking whatever rounding leaves, so the shares add up to the fee
-- EXACTLY and MRR by client is the retainer to the cent. Equal shares are an
-- ALLOCATION, stated as one: the letter prices the group and not its parts, so
-- "MRR by service" is honest about the total and approximate about the split —
-- and the alternative, the whole fee on one engagement and nothing on the rest,
-- would put the retainer on one service and call eleven free.
--
-- A grouped engagement takes the GROUP's billing frequency. Its line's own is
-- the service's recurrence copied at drafting, which says how often the work
-- comes round and not how the retainer is billed.
--
-- AN UNGROUPED LINE'S ARITHMETIC IS 0038's, EXPRESSION FOR EXPRESSION — the
-- rounding included — so no figure the dashboard already showed moves.

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
)
SELECT e.id                          AS engagement_id,
       e.tenant_id,
       e.party_id,
       e.entity_party_id,
       e.status,
       l.service_version_id,
       coalesce(s.group_frequency, l.billing_frequency) AS billing_frequency,
       l.currency,
       el.fx_rate,
       el.fx_rate_date,

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
             WHEN 'monthly'   THEN round(s.share * el.fx_rate, 4)
             WHEN 'quarterly' THEN round(s.share * el.fx_rate / 3, 4)
             WHEN 'annually'  THEN round(s.share * el.fx_rate / 12, 4)
             ELSE NULL
           END
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate, 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 12, 4)
         ELSE NULL
       END                           AS monthly_reporting,

       -- A group's fee and period are both NOT NULL, so a grouped engagement is
       -- never `unpriced` or `no_frequency_stated` — only one-off or custom.
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
JOIN crm.engagement_letter el
  ON el.id = l.engagement_letter_id AND el.tenant_id = l.tenant_id
LEFT JOIN shares s ON s.line_id = l.id
WHERE l.removed_at IS NULL;

COMMENT ON VIEW crm.engagement_mrr IS
  'One row per engagement, with its fee normalised to a month and converted at the rate stored on its letter. A fee-group engagement carries an equal share of its group''s fee (the last share takes the rounding, so the shares sum to the fee exactly) at the group''s frequency. Derived, never stored. `excluded_because` names what could not be counted.';

RESET ROLE;

-- Grants. No DELETE, as everywhere: a group struck off a draft is `removed_at`.
GRANT SELECT, INSERT, UPDATE ON crm.engagement_letter_fee_group TO bib_app;
