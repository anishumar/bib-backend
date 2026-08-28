-- 0013 · the money arithmetic, written once, in the schema
--
-- A proposal's figures are needed in three places — one proposal's detail, a
-- list of thirty, and eventually an invoice built from an accepted quote — and
-- the formula must be the same in all three. Putting it in each query is how a
-- list total ends up disagreeing with the detail page it links to, over
-- rounding, at some size of number nobody tested.
--
-- It is NOT computed in TypeScript, and that is the point of doing it here:
-- `numeric` is exact and a JavaScript number cannot hold 1499.50. A second
-- implementation in the application would eventually differ from this one in
-- the direction nobody checks.
--
-- WHY A SEPARATE MIGRATION and not part of 0011: 0011 has been applied. The
-- rule is fix forward with a new number, and it has no exception for "the same
-- afternoon" — see 0006, which says the same thing about 0005.
--
-- SECURITY_INVOKER IS LOAD-BEARING. Without it a view runs with its OWNER's
-- privileges, and the owner is bib_owner, which is not subject to the row-level
-- policies on crm.proposal_line. A plain view over a tenant-scoped table is a
-- hole straight through the tenant wall: every firm's lines, aggregated, served
-- to whoever asked. With it, the policies apply as the caller.

SET ROLE bib_owner;

-- One line's money. The ONE place the discount arithmetic is written.
-- Four decimal places, matching the columns: minor units run 0 (JPY) to 3
-- (KWD), and a per-unit rate routinely needs a fourth.
CREATE VIEW crm.proposal_line_amount WITH (security_invoker = true) AS
SELECT l.id,
       l.tenant_id,
       l.proposal_id,
       l.position,
       round(l.unit_amount * l.quantity, 4) AS gross,
       round(l.unit_amount * l.quantity * (1 - l.discount_percent / 100), 4) AS net
FROM crm.proposal_line l
WHERE l.removed_at IS NULL;

-- What a proposal comes to. `discount` is summed PER LINE as gross − net rather
-- than taken as the difference of the two grand totals, so the three figures
-- reconcile exactly however the per-line rounding falls.
--
-- A proposal with no lines has no row here at all — SUM over nothing is null,
-- and a row of nulls reads as "we could not work it out" rather than "nothing
-- yet". The callers LEFT JOIN and coalesce to zero in the quote's own currency.
CREATE VIEW crm.proposal_totals WITH (security_invoker = true) AS
SELECT a.proposal_id,
       a.tenant_id,
       count(*)          AS line_count,
       sum(a.gross)      AS gross,
       sum(a.gross - a.net) AS discount,
       sum(a.net)        AS net
FROM crm.proposal_line_amount a
GROUP BY a.proposal_id, a.tenant_id;

RESET ROLE;

GRANT SELECT ON crm.proposal_line_amount TO bib_app;
GRANT SELECT ON crm.proposal_totals      TO bib_app;
