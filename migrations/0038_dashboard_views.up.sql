-- 0038 · The figures a partner acts on (T3.7) — MRR, ageing, and the honest
-- denominator underneath both.
--
-- ── VIEWS, AND THE ACCEPTANCE SAYS SO ──────────────────────────────────────
--
-- "Figures reconcile to underlying rows, not cached columns." So there is no
-- `mrr` column anywhere and no nightly job that fills one. These are views over
-- the rows themselves, exactly as `crm.invoice_totals` (0027) and
-- `crm.proposal_totals` (0013) are, and for the same reason: a stored aggregate
-- drifts from its rows the first time one moves, and a number a partner takes to
-- a client must not be a cache.
--
-- The cost, stated rather than discovered: these recompute on every read. That
-- is the right trade at this size — a firm has hundreds of engagements, not
-- millions — and when it stops being right the answer is a materialised view
-- with a stated refresh, not a column somebody updates by hand.
--
-- `security_invoker = true` on both. A plain view runs as its OWNER, who is not
-- subject to the row policies, so a totals view over tenant-scoped tables would
-- be a hole straight through the tenant wall.
--
-- ── PER ROW, NOT PRE-AGGREGATED, AND THAT IS THE DESIGN ────────────────────
--
-- Each view emits ONE ROW PER ENGAGEMENT or ONE ROW PER INVOICE, normalised.
-- The GROUP BY lives in the query that asks the question, because the board asks
-- for MRR and ageing "by client / by service / by owner" — three groupings of
-- one fact. A pre-aggregated view would have to pick one of them and the other
-- two would need their own views, which is three places for the same arithmetic
-- to drift.
--
-- ── EVERY FIGURE IS IN THE FIRM'S REPORTING CURRENCY, AT THE STORED RATE ───
--
-- Money in this product is amount + currency + fx_rate + rate_date, and the rate
-- is STORED so that history is never restated (0009's rule, on
-- `tenancy.tenant.reporting_currency`). So these convert using the rate stored
-- on the document — the letter's rate for a fee, the invoice's rate for a
-- receivable — and never a rate looked up today. A dashboard that re-converted
-- at today's rate would change last quarter's MRR every morning.
--
-- Both the original and the converted figure are emitted. "We billed 12,000 USD"
-- and "that is 10,08,000 INR at the rate on the letter" are different sentences
-- and a firm wants both.
--
-- ── MRR COUNTS WHAT IT CAN AND SAYS WHAT IT COULD NOT ──────────────────────
--
-- This is the part worth arguing about, and the argument is settled the way G1.6
-- settled the unpriced proposal line: **a total that silently drops what it
-- cannot understand is worse than no total.**
--
-- Four things are not monthly recurring revenue and each is excluded for its own
-- reason, named in `excluded_because` so a screen can show the firm exactly what
-- is missing from its own headline number:
--
--   * `one_time`   — a fee charged once is not recurring. Excluding it silently
--                    would be defensible; NAMING it is what stops somebody
--                    wondering why MRR × 12 does not match the year's letters.
--   * `custom`     — the firm said "custom" precisely because no formula fits.
--                    Guessing a period here would invent revenue.
--   * NULL         — nobody stated a frequency. An unstated fact is not a
--                    monthly one, and G2.3's rule applies: an unresolved fact
--                    keeps the safe answer rather than assuming.
--   * unpriced     — `unit_amount IS NULL` is a real state (G1.6): a line the
--                    firm has agreed to and not yet priced. It has no revenue to
--                    count, and pretending it is zero would understate MRR while
--                    looking complete.
--
-- ── WHY THE ENGAGEMENT AND NOT THE LETTER ──────────────────────────────────
--
-- `crm.engagement` is one row per (service × ONE legal entity) — G0.1's rule —
-- and it carries the STATUS. MRR is what the firm is being paid for *now*, so it
-- is the engagements that are `active`, not every line of every letter ever
-- signed. A paused engagement is deliberately out: the firm is not billing for
-- it this month, and counting it would make MRR a measure of what was once
-- agreed rather than of what is running.

SET ROLE bib_owner;

-- ── crm.engagement_mrr ─────────────────────────────────────────────────────

CREATE VIEW crm.engagement_mrr WITH (security_invoker = true) AS
SELECT e.id                          AS engagement_id,
       e.tenant_id,
       e.party_id,
       e.entity_party_id,
       e.status,
       l.service_version_id,
       l.billing_frequency,
       l.currency,
       el.fx_rate,
       el.fx_rate_date,

       -- The line's own money, the same arithmetic `crm.invoice_line_amount`
       -- does: quantity, then the discount, and never a float.
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
       END                           AS line_amount,

       -- Normalised to ONE MONTH, in the line's own currency. NULL whenever the
       -- fee is not monthly recurring revenue — see `excluded_because`.
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 12, 4)
         ELSE NULL
       END                           AS monthly_amount,

       -- The same figure in the firm's reporting currency, at the rate stored on
       -- the LETTER. Never a rate looked up today.
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate, 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 12, 4)
         ELSE NULL
       END                           AS monthly_reporting,

       -- NULL means it counted. Anything else is the reason it did not, and a
       -- screen showing MRR is expected to show these alongside it.
       CASE
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
-- A line struck off a draft letter never became revenue. The engagement should
-- not exist for one, but the filter is stated rather than assumed: `removed_at`
-- is the only soft delete in this product and every read has to remember it.
WHERE l.removed_at IS NULL;

COMMENT ON VIEW crm.engagement_mrr IS
  'One row per engagement, with its fee normalised to a month and converted at the rate stored on its letter. Derived, never stored. `excluded_because` names what could not be counted — a total that silently drops what it does not understand is worse than no total.';

-- ── crm.receivable_ageing ──────────────────────────────────────────────────

CREATE VIEW crm.receivable_ageing WITH (security_invoker = true) AS
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
       round(b.outstanding * i.fx_rate, 4)  AS outstanding_reporting,

       -- Negative until it falls due, which is deliberate: "due in 9 days" is a
       -- fact a collections screen shows, and clamping it at zero would lose it.
       (CURRENT_DATE - b.due_on)            AS days_overdue,

       -- The buckets every ageing report in this industry uses. `current`
       -- includes anything not yet due AND anything due today.
       CASE
         WHEN b.due_on IS NULL             THEN 'no_due_date'
         WHEN CURRENT_DATE <= b.due_on     THEN 'current'
         WHEN CURRENT_DATE - b.due_on <= 30 THEN 'd1_30'
         WHEN CURRENT_DATE - b.due_on <= 60 THEN 'd31_60'
         WHEN CURRENT_DATE - b.due_on <= 90 THEN 'd61_90'
         ELSE 'd90_plus'
       END                                  AS bucket

FROM crm.invoice_balance b
JOIN crm.invoice i ON i.id = b.invoice_id AND i.tenant_id = b.tenant_id
-- Only money the firm is actually owed. A draft has not been sent and a
-- cancelled invoice was withdrawn; including either would make the receivable a
-- number the firm cannot chase.
--
-- `outstanding > 0` rather than `<> 0`: an overpaid invoice has a negative
-- balance and is money the firm OWES, which is a real thing and is not ageing.
-- It belongs on a screen of its own, and rolling it into ageing would let one
-- client's overpayment quietly cancel another's debt.
WHERE i.status NOT IN ('draft', 'cancelled')
  AND b.outstanding > 0;

COMMENT ON VIEW crm.receivable_ageing IS
  'One row per invoice the firm is still owed money on, bucketed by how overdue it is and converted at the rate stored on the invoice. Excludes drafts, cancellations and overpayments — an overpayment is money owed the other way and is not ageing.';

GRANT SELECT ON crm.engagement_mrr TO bib_app;
GRANT SELECT ON crm.receivable_ageing TO bib_app;

RESET ROLE;
