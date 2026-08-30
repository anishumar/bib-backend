-- 0057 · A compliance rule has a WINDOW, so a law that changes is a new row
--
-- T6.4 shipped the ability to edit a rule's due formula in place, and named
-- what it deliberately did not build. This is that.
--
-- ── THE TWO OPERATIONS THIS SEPARATES ─────────────────────────────────────
--
-- A CORRECTION is "we recorded the fact wrong". The India pack's dates came
-- from a previous vendor's document, everything ships `unconfirmed`, and when a
-- partner supplies the real formula they are not changing the law — they are
-- recording it correctly for the first time. That edits in place and restates
-- the filings already generated, which is what T6.4 built.
--
-- An AMENDMENT is "the law changed, from a date". The old formula was RIGHT for
-- every period before that date, and a filing made under it must go on
-- explaining its own date forever. Editing in place would silently restate why
-- those filings were due when they were — the exact thing this table's
-- immutable identity (`tenant, jurisdiction, name, rule_pack`) and its
-- `supersedes_id` chain exist to prevent.
--
-- So an amendment is a NEW ROW, and these two columns are the cutover between
-- them.
--
-- ── WHY THE COLUMNS WERE NEEDED AND `is_active` WAS NOT ENOUGH ─────────────
--
-- Retiring the old rule and writing a new one was already possible, and it is
-- WRONG for this, in a way that only shows once you run it:
--
--   · Generation runs `today − 90 … today + 365` over every generating rule.
--     A new rule superseding an old one would immediately generate periods the
--     old one already produced — a different `template_id`, so the re-run key
--     `(tenant, template, entity, period_start)` does not catch it, and the
--     calendar shows every filing TWICE with no error anywhere.
--   · Retiring is a blunt instrument in the other direction: it stops the old
--     rule generating at all, including for periods BEFORE the cutover that the
--     ninety-day reach-back has not materialised yet. A client onboarded last
--     month would silently lose the period it was engaged for.
--
-- A window fixes both, because it says WHICH PERIODS each row governs rather
-- than whether the row is switched on.
--
-- ── HALF-OPEN, `[effective_from, effective_to)` ───────────────────────────
--
-- `effective_to` is the FIRST DAY NOT IN FORCE, exactly as `client_assignment`,
-- `party_identifier` and `isInForceOn` already read. The demo used an inclusive
-- bound on assignments and copying it would have shown two SPOCs on every
-- changeover day; the same mistake here shows two rules governing one period,
-- which is two filings for one return.
--
-- ── AND IT IS TESTED AGAINST THE PERIOD START, NOT THE DUE DATE ───────────
--
-- The rule that governs a filing is the one in force for the PERIOD BEING
-- FILED. August's GST return is governed by August's law even though it falls
-- due on 20 September, so a law changing on 1 September must not reach back and
-- restate August. Testing the statutory date would do exactly that, and it
-- would look right — every date would move by one period and nothing would
-- complain.
--
-- ── BOTH NULL IS THE DEFAULT, AND MEANS "ALWAYS" ──────────────────────────
--
-- Which is every row that exists today, so this migration changes no firm's
-- behaviour and no calendar moves when it is applied. A rule with no window is
-- not "unconfigured": it is a rule nobody has had to amend, which is all of
-- them.

SET ROLE bib_owner;

ALTER TABLE delivery.obligation_template
  ADD COLUMN effective_from date,
  ADD COLUMN effective_to   date;

COMMENT ON COLUMN delivery.obligation_template.effective_from IS
  'First period START this rule governs. NULL means from the beginning. Half-open with effective_to.';
COMMENT ON COLUMN delivery.obligation_template.effective_to IS
  'First period START this rule does NOT govern — the day the successor takes over. NULL means forever.';

-- An empty or backwards window is a rule that governs nothing, which is not a
-- state anybody means to be in and is indistinguishable on a screen from one
-- that governs everything.
ALTER TABLE delivery.obligation_template
  ADD CONSTRAINT obligation_template_window_chk
  CHECK (
    effective_from IS NULL
    OR effective_to IS NULL
    OR effective_to > effective_from
  );

RESET ROLE;
