-- 0358 · A filing's period may follow the CLIENT's year end (Q070 Part B, B2)
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- A rule cut every client's quarters and years on the RULE's own year
-- (`fiscal_year_start_month`, 4 for India). That is right for a statute that
-- fixes the year for everybody, and wrong for UAE corporate tax and Singapore's
-- annual filings, which run on each company's own financial year: a December
-- year-end client was given April-March periods and the due dates that follow
-- (10x, Ashish, Q037: "Corporate Tax Returns in Dubai is due within 9 months
-- of End of FY ... tax payer has to choose").
--
-- Practice CS, CCH Workstream ("Fiscal") and XPM ("Balance date") all hang
-- annual deadlines off the client's own year end. No tool uses the firm's year.
--
-- ── THE RULE SAYS WHICH ─────────────────────────────────────────────────────
--
-- `obligation_template.period_basis`:
--   rule_calendar    today's behaviour, the rule's own year. Every existing
--                    rule is this, so applying 0358 moves nothing.
--   client_year_end  quarters, half-years and years are cut on the client's
--                    `core.legal_entity.financial_year_end` (MM-DD; the year
--                    starts the month after). Monthly is a month either way.
--
-- Part of the period SHAPE with `recurrence` and `fiscal_year_start_month`:
-- `period_start` is the re-run key, so it is editable only while the rule has
-- produced nothing (PERIOD_SHAPE_LOCKED), enforced by the service.
--
-- ── AND EACH ROW SAYS WHICH IT GOT ──────────────────────────────────────────
--
-- `obligation_instance.period_basis`: what the generator actually used.
--   rule_fallback    the rule asked for the client's year end and the client
--                    had none recorded, so the rule's own month was used. The
--                    calendar says so in words ("Using April: no year end
--                    recorded"), never a guess. Stored, not derived at read:
--                    a year end recorded LATER must not make an old row claim
--                    it followed it.
--
-- ── A CLIENT'S YEAR END CHANGES (Q078, unanswered) ──────────────────────────
--
-- SPEC's default, Senta's behaviour: filings already generated stay; new
-- periods follow the new end. No transition period and no regeneration. The
-- generator skips a proposed period that OVERLAPS a live row of the same chain
-- and company (a different period start), so the change never puts two
-- returns for one stretch of months on the calendar.

SET ROLE bib_owner;

ALTER TABLE delivery.obligation_template
  ADD COLUMN period_basis text NOT NULL DEFAULT 'rule_calendar'
    CONSTRAINT obligation_template_period_basis_check
      CHECK (period_basis IN ('rule_calendar', 'client_year_end'));

COMMENT ON COLUMN delivery.obligation_template.period_basis IS
  'Whose year a quarter/half-year/year is cut on: the rule''s own (rule_calendar) or the client''s '
  'core.legal_entity.financial_year_end (client_year_end). Part of the period shape (0358).';

ALTER TABLE delivery.obligation_instance
  ADD COLUMN period_basis text NOT NULL DEFAULT 'rule_calendar'
    CONSTRAINT obligation_instance_period_basis_check
      CHECK (period_basis IN ('rule_calendar', 'client_year_end', 'rule_fallback'));

COMMENT ON COLUMN delivery.obligation_instance.period_basis IS
  'What the generator used for this row''s period: the rule''s year, the client''s year end, or '
  'rule_fallback (the rule asked for the client''s year end and none was recorded) (0358).';

RESET ROLE;
