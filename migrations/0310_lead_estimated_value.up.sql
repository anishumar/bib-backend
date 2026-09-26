-- 0310 · a lead says what it could be worth (Shrestha, 2026-09-26)
--
-- The pipeline listed WHO and WHERE-IN-THE-FUNNEL and never HOW MUCH, so a
-- partner could not tell a ₹40,000 registration from a ₹25 lakh audit without
-- opening each one, and could not filter the list to the big ones at all.
--
-- An ESTIMATE, not a quote. The quote is crm.proposal with its own currency and
-- FX rate; this is the one number somebody writes at capture ("about 5 lakh a
-- year") so the pipeline can be sized and sorted before any proposal exists.
--
-- NULLABLE, and null is ordinary: nobody knows the value when a prospect first
-- phones in, and a capture must never be refused for it.
--
-- The currency is stored ON THE ROW, beside the amount, rather than read from
-- the tenant at display time. Money is a pair everywhere in this schema, and an
-- amount whose meaning depends on a join is one a later change to the join
-- silently re-denominates. The service writes the firm's reporting currency
-- (0009) today, so every lead in a firm compares with every other and the
-- value filter is honest; a per-lead currency later is a wire change, not a
-- migration.

SET ROLE bib_owner;

ALTER TABLE crm.lead
  ADD COLUMN estimated_value numeric(18,2),
  ADD COLUMN estimated_value_currency text;

ALTER TABLE crm.lead
  ADD CONSTRAINT lead_estimated_value_nonneg_chk
    CHECK (estimated_value IS NULL OR estimated_value >= 0),
  -- The pair moves together: an amount with no currency means nothing, and a
  -- currency with no amount is a value somebody half-cleared.
  ADD CONSTRAINT lead_estimated_value_pair_chk
    CHECK ((estimated_value IS NULL) = (estimated_value_currency IS NULL)),
  ADD CONSTRAINT lead_estimated_value_currency_iso4217_chk
    CHECK (estimated_value_currency IS NULL OR estimated_value_currency ~ '^[A-Z]{3}$');

RESET ROLE;
