-- 0023 · Line detail on both document lines (G1.6) — and an unpriced line
--
-- Both line tables carried seven meaningful columns; the services master they
-- replaced carried seventeen. This adds the nine §4.6 names and relaxes the
-- tenth thing, which is not a column at all.
--
-- ── THE HARD PART: `unit_amount NOT NULL CHECK (>= 0)` ──────────────────────
--
-- That constraint makes an UNPRICED LINE UNREPRESENTABLE. Several real lines
-- are genuinely "as mutually agreed" — an Incorporation whose fee depends on
-- the registrar, a vCFO retainer scoped after a month — and the only way to
-- write one down was to quote it as ZERO, which says something completely
-- different to a client and reads as a commitment to work for nothing.
--
-- Relaxing it is one word. What it costs is the meaning of every total, and
-- that is settled HERE rather than left to whichever query runs first:
--
--   A LINE WITH NO PRICE CONTRIBUTES NOTHING TO A TOTAL AND IS COUNTED
--   SEPARATELY. `crm.proposal_line_amount` already yields NULL for such a line
--   (NULL * quantity is NULL), `sum()` skips it, and `crm.proposal_totals`
--   gains `unpriced_line_count` so that the figure beside it can never be read
--   as the price of the whole document.
--
-- The alternative — coalescing an unpriced line to zero — is the one thing this
-- migration refuses to do. `sum` would then be a number a partner acts on that
-- is quietly missing a line, and nothing on the row would say so. A total is a
-- claim about what a client owes; when a line has no price the honest claim is
-- "this much, PLUS whatever is agreed for N further lines", and that is two
-- values, not one. Both travel together from here to the wire.
--
-- `pricing_note` is therefore REQUIRED when there is no amount
-- (`line_unpriced_needs_reason_chk`). The acceptance says a line may say "as
-- mutually agreed" WITH A REASON, and a blank where a price belongs is
-- indistinguishable from data somebody forgot to enter. A priced line may carry
-- a note too — "plus statutory fees at actuals" is ordinary — so the constraint
-- is one-directional.
--
-- A DISCOUNT ON AN UNPRICED LINE IS REFUSED for the same reason: 15% off "as
-- mutually agreed" is not a number. It would also reach
-- `needsDiscountApproval`, which takes the LARGEST discount on any line, and
-- hold a proposal at the approval gate over a discount that does not exist.
--
-- ── THE FOUR OVERRIDES ──────────────────────────────────────────────────────
--
-- `scope_override`, `client_obligations_override`, `volume_limits_override`,
-- `exclusions_override`. All null in the ordinary case, and then the pinned
-- catalogue version's words print. THIS IS WHAT MAKES AN ISSUED DOCUMENT
-- REPRODUCIBLE: the document carries its own wording, so a catalogue revision
-- next year cannot change what a signed letter says. Without them, tailoring
-- one client's scope silently rewrites the standard scope for every document
-- issued afterwards — the firm edits the catalogue because there is nowhere
-- else to edit.
--
-- NULL and '' are deliberately not the same thing, which is why blank is
-- REFUSED. Null means "this document did not tailor it — print the catalogue's
-- words". A firm that wants a block to print nothing at all writes the sentence
-- ("None.") rather than an empty string, because an empty block on a signed
-- document is indistinguishable from a rendering fault.
--
-- ── billing_frequency ───────────────────────────────────────────────────────
--
-- How often this DEAL is billed. It shares its vocabulary with the catalogue's
-- `recurrence` and defaults from it, and it is a different fact: A1 is a
-- MONTHLY service that some clients are billed QUARTERLY for. Deriving it at
-- read time would make that arrangement unrepresentable, which is the whole
-- reason it is a column.
--
-- ── The out-of-pocket range, and why its currency is NOT held by a key ──────
--
-- `oop_estimate_min` / `oop_estimate_max` / `oop_currency` — "approx. USD
-- 5,000–6,000", reimbursed at ACTUALS and separate from the professional fee.
-- A range, because that is how the firm writes it.
--
-- `unit_amount`'s currency is held equal to the document's by a composite
-- foreign key (0011/0017), and this one deliberately is NOT. The reason is that
-- the constraint would make the column pointless: if the out-of-pocket estimate
-- had to be in the document's currency it would already be in `currency`, and
-- the third column would never need to exist. It exists because the estimate
-- routinely is not — a client quoted in INR still faces a Delaware franchise
-- fee in USD and an apostille in AED, and those are the numbers the firm writes
-- down. That also means an OOP estimate can NEVER be added into a total: the
-- document's `fx_rate` is struck for the fee currency and says nothing about a
-- third one, so there is no honest conversion available here. Which is correct,
-- because an out-of-pocket estimate is not a fee and was never part of the
-- total.
--
-- What IS constrained: all three columns together or none of them, and
-- min <= max. A range with one end is not a range — a reader would have to
-- guess whether the other end is unbounded — and an amount with no currency is
-- the one shape this codebase never stores.
--
-- ── jurisdiction ────────────────────────────────────────────────────────────
--
-- Where the work is. A proposal is built by picking countries and then the
-- services offered in them, so the country is the thing the user actually
-- chose. Stated, never derived: on a letter it is the entity's own
-- jurisdiction, and resolving that at write time needs the entity's
-- registrations, which is a lookup this task does not add. A jurisdiction
-- invented from a null would be indistinguishable from one somebody chose.
--
-- ── The freeze ──────────────────────────────────────────────────────────────
--
-- Every column below lands on a table whose signed rows are frozen by
-- `trg_el_line_freeze` (0017), which refuses ANY write once the parent letter
-- is signed — so these are protected the day they exist, with no allow-list to
-- widen. Nothing here touches `crm.signed_letter_mutable_columns()`. All ten
-- are NULLABLE, which is also what CLAUDE.md requires of a letter line once
-- real signed letters exist: the freeze refuses a backfill, and there is no
-- honest value to write into a document that never said it.

SET ROLE bib_owner;

-- ── crm.proposal_line ───────────────────────────────────────────────────────

ALTER TABLE crm.proposal_line
  ALTER COLUMN unit_amount DROP NOT NULL,
  ADD COLUMN jurisdiction        text,
  ADD COLUMN billing_frequency   text,
  ADD COLUMN scope_override              text,
  ADD COLUMN client_obligations_override text,
  ADD COLUMN volume_limits_override      text,
  ADD COLUMN exclusions_override         text,
  ADD COLUMN oop_estimate_min numeric(18,4),
  ADD COLUMN oop_estimate_max numeric(18,4),
  ADD COLUMN oop_currency     text,
  ADD COLUMN pricing_note     text;

ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_jurisdiction_chk
    CHECK (jurisdiction IS NULL OR jurisdiction ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT proposal_line_billing_frequency_chk
    CHECK (billing_frequency IS NULL OR billing_frequency IN
           ('one_time', 'monthly', 'quarterly', 'annually', 'custom')),
  -- Blank is not an override; null is. See the note above.
  ADD CONSTRAINT proposal_line_overrides_not_blank_chk
    CHECK (btrim(coalesce(scope_override, 'x'))              <> ''
       AND btrim(coalesce(client_obligations_override, 'x')) <> ''
       AND btrim(coalesce(volume_limits_override, 'x'))      <> ''
       AND btrim(coalesce(exclusions_override, 'x'))         <> ''),
  ADD CONSTRAINT proposal_line_pricing_note_not_blank_chk
    CHECK (pricing_note IS NULL OR btrim(pricing_note) <> ''),
  -- The relaxed price keeps its floor: unpriced is a real state, negative is
  -- not.
  ADD CONSTRAINT proposal_line_unit_amount_non_negative_chk
    CHECK (unit_amount IS NULL OR unit_amount >= 0),
  ADD CONSTRAINT proposal_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL),
  ADD CONSTRAINT proposal_line_unpriced_has_no_discount_chk
    CHECK (unit_amount IS NOT NULL OR discount_percent = 0),
  ADD CONSTRAINT proposal_line_oop_is_whole_chk
    CHECK ((oop_estimate_min IS NULL AND oop_estimate_max IS NULL AND oop_currency IS NULL)
        OR (oop_estimate_min IS NOT NULL AND oop_estimate_max IS NOT NULL
            AND oop_currency IS NOT NULL)),
  ADD CONSTRAINT proposal_line_oop_range_chk
    CHECK (oop_estimate_min IS NULL
       OR (oop_estimate_min >= 0 AND oop_estimate_max >= oop_estimate_min)),
  ADD CONSTRAINT proposal_line_oop_currency_chk
    CHECK (oop_currency IS NULL OR oop_currency ~ '^[A-Z]{3}$');

-- ── crm.engagement_letter_line ──────────────────────────────────────────────
-- The same ten, because the two line tables are the same document line at two
-- stages of its life and a proposal that cannot carry what its letter will is a
-- proposal nobody can convert.

ALTER TABLE crm.engagement_letter_line
  ALTER COLUMN unit_amount DROP NOT NULL,
  ADD COLUMN jurisdiction        text,
  ADD COLUMN billing_frequency   text,
  ADD COLUMN scope_override              text,
  ADD COLUMN client_obligations_override text,
  ADD COLUMN volume_limits_override      text,
  ADD COLUMN exclusions_override         text,
  ADD COLUMN oop_estimate_min numeric(18,4),
  ADD COLUMN oop_estimate_max numeric(18,4),
  ADD COLUMN oop_currency     text,
  ADD COLUMN pricing_note     text;

ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_jurisdiction_chk
    CHECK (jurisdiction IS NULL OR jurisdiction ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT el_line_billing_frequency_chk
    CHECK (billing_frequency IS NULL OR billing_frequency IN
           ('one_time', 'monthly', 'quarterly', 'annually', 'custom')),
  ADD CONSTRAINT el_line_overrides_not_blank_chk
    CHECK (btrim(coalesce(scope_override, 'x'))              <> ''
       AND btrim(coalesce(client_obligations_override, 'x')) <> ''
       AND btrim(coalesce(volume_limits_override, 'x'))      <> ''
       AND btrim(coalesce(exclusions_override, 'x'))         <> ''),
  ADD CONSTRAINT el_line_pricing_note_not_blank_chk
    CHECK (pricing_note IS NULL OR btrim(pricing_note) <> ''),
  ADD CONSTRAINT el_line_unit_amount_non_negative_chk
    CHECK (unit_amount IS NULL OR unit_amount >= 0),
  ADD CONSTRAINT el_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL),
  ADD CONSTRAINT el_line_unpriced_has_no_discount_chk
    CHECK (unit_amount IS NOT NULL OR discount_percent = 0),
  ADD CONSTRAINT el_line_oop_is_whole_chk
    CHECK ((oop_estimate_min IS NULL AND oop_estimate_max IS NULL AND oop_currency IS NULL)
        OR (oop_estimate_min IS NOT NULL AND oop_estimate_max IS NOT NULL
            AND oop_currency IS NOT NULL)),
  ADD CONSTRAINT el_line_oop_range_chk
    CHECK (oop_estimate_min IS NULL
       OR (oop_estimate_min >= 0 AND oop_estimate_max >= oop_estimate_min)),
  ADD CONSTRAINT el_line_oop_currency_chk
    CHECK (oop_currency IS NULL OR oop_currency ~ '^[A-Z]{3}$');

-- ── What a total MEANS when a line has no price ─────────────────────────────
--
-- `crm.proposal_line_amount` needs no change and that is the point: an unpriced
-- line already yields NULL gross and NULL net, because NULL * quantity is NULL.
-- NULL is the honest per-line answer — there is no amount — and it is exactly
-- what `sum()` skips.
--
-- `crm.proposal_totals` gains ONE column, appended so CREATE OR REPLACE can do
-- it in place (the view is depended on by nothing else, but replacing rather
-- than dropping keeps its grants and never leaves a window with no view).
--
-- `line_count` still counts every live line — it answers "how big is this
-- document" and always did. `unpriced_line_count` is how many of them the money
-- beside it does NOT cover. Read them together or the total is a lie: three
-- priced lines and two "as mutually agreed" is a document whose net is a FLOOR,
-- and a screen that prints the floor alone tells a partner the client agreed to
-- a number nobody agreed to.
CREATE OR REPLACE VIEW crm.proposal_totals WITH (security_invoker = true) AS
SELECT a.proposal_id,
       a.tenant_id,
       count(*)             AS line_count,
       sum(a.gross)         AS gross,
       sum(a.gross - a.net) AS discount,
       sum(a.net)           AS net,
       count(*) FILTER (WHERE a.gross IS NULL) AS unpriced_line_count
FROM crm.proposal_line_amount a
GROUP BY a.proposal_id, a.tenant_id;

COMMENT ON COLUMN crm.proposal_totals.unpriced_line_count IS
  'How many live lines have no unit_amount and are therefore NOT in gross/discount/net. Non-zero means the totals beside it are a floor, not the price of the document.';

RESET ROLE;
