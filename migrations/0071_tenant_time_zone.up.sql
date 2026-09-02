-- 0071 · The firm's own timezone — because "which month is this in" has been
--        answered by the SERVER until now, and nobody chose that
--
-- ── THE BUG THIS FIXES IS ON A CLIENT'S SCREEN TODAY ──────────────────────
--
-- `/portal/month` answers *"what did 10x Global do for me in September"*. It
-- computes that by casting a `timestamptz` to a `date` — and an unqualified
-- cast uses the SESSION's TimeZone, which nothing in this product sets. So the
-- answer is the SERVER's, which is UTC in the compose container and whatever
-- the platform happens to configure in production.
--
-- For an Indian firm that is wrong for five and a half hours every night: a
-- document filed at 02:00 IST on 1 October is 20:30 UTC on 30 September, and
-- lands in SEPTEMBER's digest. The client and the firm then disagree about what
-- a month contained, which is exactly the thing a monthly statement exists to
-- settle.
--
-- The chaser has the same shape of bug with a sharper edge:
-- `(asOf::date - raised_at::date)` decides which rung of the ladder has been
-- reached, so a request raised after 18:30 UTC counts a day older than it is,
-- and a D+3 reminder goes out on day 2.
--
-- ── WHY THE FIRM'S ZONE AND NOT THE READER'S ──────────────────────────────
--
-- The obvious alternative is the viewer's own zone, which is what T6.9 settled
-- for rendering an INSTANT ("2 September 2026" is the day it happened where the
-- reader is). That is right for a moment and wrong for a PERIOD.
--
-- A monthly digest is a STATEMENT BY THE FIRM about a period. It has to have
-- ONE boundary, or the partner in Delhi and the client's CFO in Dubai open the
-- same September and see different documents in it — and the one who is missing
-- a row cannot tell whether it was filed late or whether their screen drew the
-- line somewhere else. An invoice's date is one date for the same reason.
--
-- And not UTC-by-default either, which is the same failure with better manners:
-- deterministic, and still nobody's actual calendar.
--
-- ── THE DEFAULT IS 'UTC', SO APPLYING THIS CHANGES NO FIRM'S BEHAVIOUR ────
--
-- The compose container runs UTC and so does every environment this has ever
-- run in, so 'UTC' reproduces exactly what every existing row already does.
-- `work_split_axis` (0043) and `client_request_routing` (0070) both took this
-- position and it is the one that makes a migration safe to apply on a Friday:
-- the behaviour changes when a firm CHOOSES, not when the schema does.
--
-- ── A COLUMN ON `tenancy.tenant`, NOT A CONFIG-REGISTRY KIND ──────────────
--
-- 0043's argument, third time. A registry entry buys versioning, publishing,
-- freezing and pinning, and this needs none of them: nobody will ever ask what
-- a firm's timezone said last March, and a frozen historical value would be
-- actively wrong — moving offices means every future digest uses the new zone,
-- which is what a firm means by moving. Freely changeable, restates nothing
-- that is STORED.
--
-- What it does restate is what a past digest DISPLAYS, and that is deliberate
-- and normal: the digest is computed on read, so changing the zone re-cuts
-- historical months too. Every accounting product behaves this way and the
-- alternative — pinning a zone onto each period as it passes — would mean a
-- firm that fixed a wrong setting could never correct the months it got wrong.
--
-- ── AND IT IS VALIDATED BY A TRIGGER, WHICH A CHECK COULD NOT DO ──────────
--
-- The value has to be a real IANA zone or every read that uses it throws at
-- query time — which is the worst place to find out, because the query is a
-- client loading their own page. A CHECK cannot express it: the only ways to
-- ask Postgres whether a zone exists are `pg_timezone_names` (a subquery, not
-- allowed in a CHECK) and `AT TIME ZONE` (STABLE, not IMMUTABLE, also not
-- allowed). A trigger can do both, and it is where 0070 put its own rule that
-- a CHECK could not hold, for the same reason.
--
-- A trigger also means an import, a psql session and a future admin screen all
-- meet the same refusal — `build2.md`'s rule that a rule living in a form is
-- one a script walks straight past.
SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN tenancy.tenant.time_zone IS
  'IANA zone deciding which calendar DAY or MONTH an instant belongs to for this '
  'firm — the monthly digest and the chaser''s day arithmetic. Not for rendering '
  'an instant: that is the reader''s own zone (T6.9). Default UTC reproduces the '
  'behaviour every firm had before 0071.';

CREATE FUNCTION tenancy.assert_known_time_zone() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- `pg_timezone_names` is the database's own list, so this cannot drift from
    -- what `AT TIME ZONE` will actually accept when the digest runs.
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
      RAISE EXCEPTION
        'tenancy.tenant.time_zone must be an IANA time zone this database knows; % is not (try Asia/Kolkata, Europe/London, UTC)',
        NEW.time_zone
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $$;

-- Fires only when the value actually arrives or moves, so an ordinary rename of
-- a firm costs nothing. `pg_timezone_names` is a view over the tzdata files and
-- is not free to scan; a firm's zone changes approximately never.
CREATE TRIGGER trg_tenant_time_zone_known
  BEFORE INSERT OR UPDATE OF time_zone ON tenancy.tenant
  FOR EACH ROW EXECUTE FUNCTION tenancy.assert_known_time_zone();

RESET ROLE;
