-- 0345 · Daily exchange rates, fetched (Q009, 2026-10-04)
--
-- 0344 let a proposal or a letter price a service in a currency other than its
-- main one, with a rate for each currency TYPED on the document. Ashish asked
-- for the rate to be "auto-fetched" (Q009), and every accounting product a
-- firm like this compares us with does the same: Zoho Books, Xero, QuickBooks
-- and NetSuite keep a daily rate table from a feed, offer the day's rate on
-- every foreign-currency document, and let a person change it there. The rate
-- on the DOCUMENT stays the record (0344): this table only SUGGESTS one, and
-- values a report "at today's rate".
--
-- ── ONE TABLE FOR EVERY FIRM, IN US DOLLARS ────────────────────────────────
--
-- A rate is public data, not a firm's: the AED price of a dollar on 4 October
-- is the same for every tenant. So this table has no tenant and no RLS, and
-- the feed is called ONCE a day for the whole product rather than once per
-- firm. Each row is how many units of a currency one US dollar buys on a day,
-- which is how both feeds publish it; any pair the firms need (AED in INR, SGD
-- in AED) is one exact numeric division of two rows of the SAME day, done in
-- `fx.rate_on`, never in JavaScript.
--
-- ── A DAY'S RATE NEVER CHANGES ─────────────────────────────────────────────
--
-- The app may INSERT a day it does not have and nothing else: a report that
-- valued a fee "at the rate of 4 October" must say the same thing tomorrow.
-- The first feed to deliver a day wins (ON CONFLICT DO NOTHING in the
-- adapter); `source` says which.

CREATE SCHEMA IF NOT EXISTS fx AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA fx FROM PUBLIC;

SET ROLE bib_owner;

CREATE TABLE fx.daily_rate (
  currency   text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  day        date        NOT NULL,
  -- Units of `currency` for one US dollar, exactly as the feed wrote it.
  per_usd    numeric     NOT NULL CHECK (per_usd > 0),
  -- "ExchangeRate-API" or "Currency API": who published it.
  source     text        NOT NULL CHECK (length(btrim(source)) > 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, day),
  -- A dollar is a dollar: a feed that said otherwise is refused, not stored.
  CONSTRAINT daily_rate_usd_is_one CHECK (currency <> 'USD' OR per_usd = 1)
);

-- The newest day on file, which the worker and the read-through ask first.
CREATE INDEX daily_rate_day ON fx.daily_rate (day DESC);

-- What one unit of `p_currency` is worth in `p_reporting` on `p_day`: from the
-- latest day ON OR BEFORE it that has both currencies, as the books of any of
-- the products above do when a day has no rate of its own (a weekend, a feed
-- that failed). Ten decimal places, the scale of every document's rate.
CREATE FUNCTION fx.rate_on(p_currency text, p_reporting text, p_day date)
RETURNS TABLE (fx_rate numeric, rate_day date, source text)
LANGUAGE sql STABLE AS $$
  SELECT round(r.per_usd / c.per_usd, 10), c.day, c.source
    FROM fx.daily_rate c
    JOIN fx.daily_rate r ON r.day = c.day AND r.currency = p_reporting
   WHERE c.currency = p_currency AND c.day <= p_day
   ORDER BY c.day DESC
   LIMIT 1
$$;

-- The EARLIEST day after `p_day` with both, for a date before the feed's
-- history begins (a client imported with a letter signed in 2019): the
-- closest rate there is, and its own date says how close.
CREATE FUNCTION fx.rate_after(p_currency text, p_reporting text, p_day date)
RETURNS TABLE (fx_rate numeric, rate_day date, source text)
LANGUAGE sql STABLE AS $$
  SELECT round(r.per_usd / c.per_usd, 10), c.day, c.source
    FROM fx.daily_rate c
    JOIN fx.daily_rate r ON r.day = c.day AND r.currency = p_reporting
   WHERE c.currency = p_currency AND c.day > p_day
   ORDER BY c.day ASC
   LIMIT 1
$$;

GRANT USAGE ON SCHEMA fx TO bib_app;
GRANT SELECT, INSERT ON fx.daily_rate TO bib_app;
GRANT EXECUTE ON FUNCTION fx.rate_on(text, text, date) TO bib_app;
GRANT EXECUTE ON FUNCTION fx.rate_after(text, text, date) TO bib_app;

RESET ROLE;
