-- 0328 · Ageing on the firm's calendar day, not the database's (audit 2026-10-03, B29)
--
-- `crm.receivable_ageing` (0038) buckets every invoice by `CURRENT_DATE`, and
-- CURRENT_DATE is the day in the SESSION's TimeZone, which this pool never sets
-- (the server's is Etc/UTC). So between 00:00 and 05:30 IST an invoice due
-- yesterday read "current" on the dashboard while /receivables, which asks on
-- the firm's day, already called it overdue. A view cannot take a parameter,
-- and "today" is the caller's fact (see CLAUDE.md, the firm's own timezone).
--
-- So the same rows come from a FUNCTION that takes the day: the dashboard asks
-- `crm.receivable_ageing_on(<the firm's day>)`. Same columns, same filters,
-- same buckets as 0038's view, with `p_day` where the view says CURRENT_DATE.
--
-- ── WHY THE VIEW STAYS ──────────────────────────────────────────────────────
--
-- Nothing in the app reads it after this (tests/architecture/firm-day-reads
-- bans it in the adapters), but dropping it would be a schema change other
-- in-flight branches cannot see, for no gain. Its comment now says what it is.
--
-- ── SECURITY INVOKER, AND A PLAIN BODY ──────────────────────────────────────
--
-- The function runs as its CALLER, so `bib_app`'s row policies apply exactly as
-- they do through the `security_invoker` view: one firm's ageing never shows
-- another's invoices. The body is a string, not BEGIN ATOMIC, so it binds to
-- `crm.invoice_balance` at call time and a later `CREATE OR REPLACE VIEW` of the
-- balance (another branch's paise fix) does not have to drop it first. STABLE:
-- it reads tables and changes nothing.
SET ROLE bib_owner;

CREATE FUNCTION crm.receivable_ageing_on(p_day date)
  RETURNS TABLE (
    invoice_id            uuid,
    tenant_id             uuid,
    party_id              uuid,
    entity_party_id       uuid,
    number                text,
    currency              text,
    fx_rate               numeric,
    due_on                date,
    issued_on             date,
    invoiced              numeric,
    paid                  numeric,
    credited              numeric,
    outstanding           numeric,
    outstanding_reporting numeric,
    days_overdue          integer,
    bucket                text
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  AS $$
    SELECT b.invoice_id,
           b.tenant_id,
           b.party_id,
           i.entity_party_id,
           i.number,
           b.currency,
           i.fx_rate,
           b.due_on,
           i.issued_on,
           b.invoiced,
           b.paid,
           b.credited,
           b.outstanding,
           round(b.outstanding * i.fx_rate, 4),
           (p_day - b.due_on),
           CASE
             WHEN b.due_on IS NULL        THEN 'no_due_date'
             WHEN p_day <= b.due_on       THEN 'current'
             WHEN p_day - b.due_on <= 30  THEN 'd1_30'
             WHEN p_day - b.due_on <= 60  THEN 'd31_60'
             WHEN p_day - b.due_on <= 90  THEN 'd61_90'
             ELSE 'd90_plus'
           END
      FROM crm.invoice_balance b
      JOIN crm.invoice i ON i.id = b.invoice_id AND i.tenant_id = b.tenant_id
     WHERE i.status NOT IN ('draft', 'cancelled')
       AND b.outstanding > 0
  $$;

COMMENT ON FUNCTION crm.receivable_ageing_on(date) IS
  'crm.receivable_ageing as of a calendar day the CALLER names (the firm''s day), so ageing does not depend on the session''s TimeZone (0328, audit B29). Security invoker: RLS applies as through the view.';

COMMENT ON VIEW crm.receivable_ageing IS
  'Superseded for reads by crm.receivable_ageing_on(day) (0328): this view buckets on CURRENT_DATE, the database session''s day, which is not the firm''s. Kept so nothing outside the app breaks; the app does not read it.';

REVOKE ALL ON FUNCTION crm.receivable_ageing_on(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.receivable_ageing_on(date) TO bib_app;

RESET ROLE;
