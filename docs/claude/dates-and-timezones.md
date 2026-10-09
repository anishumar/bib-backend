# Dates, instants and time zones

The long form of the date rules `CLAUDE.md` states in one line each: a `date` column, a
`timestamptz`, the firm's day, a company's day and year, and the caller's `asOf`.

**The field's TYPE decides which rule applies, and getting it backwards is silent either side of
Greenwich.** A DAY is never parsed; an INSTANT always is, and the day it falls on is answered by
whoever owns the question (the reader, the firm, the company, the filing).

| Question | Answer | Where |
|---|---|---|
| What DAY is this `date` column? | its UTC fields (postgres.js builds it at UTC midnight) | `day.ts` |
| When did this `timestamptz` happen, for a reader? | the READER's own zone, client-side | T6.9 |
| Which MONTH or DAY does this instant belong to, for the FIRM? | `tenancy.tenant.time_zone` | 0071 |
| What is TODAY for a SWEEP (no caller to send a day)? | `dayInZone(clock.now(), timeZoneFor(tenant))`, per firm, per pass | T6.14 |
| Which DAY is a company's document dated on; which YEAR is its number or period in? | that company's own zone and year, else the firm's | 0337 |
| Which day is a FILING's day? | the filing's zone (client entity, else country, else firm) | S3, see `compliance-calendar.md` |

## A `date` column is a DAY, and postgres.js hands it back as a UTC instant

- **Measured:** postgres.js materialises `'2026-08-20'::date` as `2026-08-20T00:00:00.000Z` in
  every zone. An adapter reads the **UTC fields** (`toDay` / `toDayOrNull` in
  `infrastructure/postgres/day.ts`), never the local ones, which name the day BEFORE west of
  Greenwich.
- **Trap: the local getters look like the careful choice.** `getFullYear()/getMonth()/getDate()`
  was in `engagement-repository.ts` (with a comment asserting the opposite) and copied into
  `proposal-repository.ts`; it would have made an engagement's `effective_from` (the base of every
  SLA due date) a day early on a laptop in New York, and nothing here runs there.
- `tests/architecture/calendar-day.test.ts` bans the local getters in `infrastructure/postgres/`
  and demonstrates the lost day via `Intl`, so it fails on a UTC runner too (a behavioural test
  passes both implementations east of Greenwich).
- **Better, where a query is being written anyway: `SELECT some_date::text`** - no `Date`, no
  zone. The compliance calendar does this; copy it.
- This is not "today". `clock.now().toISOString().slice(0, 10)` is the SERVER's day; for what
  replaces it see "Today is the caller's fact" and "Every sweep cuts today on the firm's
  calendar" below.

## A `timestamptz` is an INSTANT, and `::text` is not a format a browser must accept (T6.10)

- `SELECT now()::text` gives `2026-09-01 19:54:05.712839+00`. ECMAScript requires `Date` to
  accept only `YYYY-MM-DDTHH:mm:ss.sssZ` (literal `T`, exactly three fractional digits). **V8
  takes the Postgres form** (measured in `tests/architecture/instant-format.test.ts`), so node,
  curl, smoke and every local browser walk passed; JavaScriptCore historically does not, and the
  portal screens' `Number.isNaN(at.getTime()) ? iso : ...` guard showed an iPhone client the raw
  string.
- **The worse bug in the same cast: `timestamptz::text` renders in the SESSION's `TimeZone`.**
  `src/db/pool.ts` sets none, so it is the server's (UTC in the compose container).
  `render-source.ts` took an invoice's printed date from `created_at.slice(0, 10)` when
  `issued_on` was null, so the date on a numbered tax document depended on `postgresql.conf`
  (the 1st under UTC, the 2nd under `Asia/Kolkata`; measured in
  `instant-format.integration.test.ts`).
- **`infrastructure/postgres/instant.ts` holds two helpers, both pinning the zone:**
  - `isoInstant(expr, alias?)` -> `to_char(x AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    byte for byte JS `toISOString()`. `.MS` (three digits) on purpose: `.US` is six and outside
    the spec.
  - `utcDayOf(expr, alias)` -> `(x AT TIME ZONE 'UTC')::date::text`, for code that wanted a day.
  - NULL in, NULL out. No `Date` is constructed (a value never parsed cannot be parsed wrong).
- **The guard is a grep as well as an assertion:** `instant-format.test.ts` bans `_at::text`
  across `infrastructure/postgres/` (`_at::date::text` deliberately not matched), bans the format
  literal outside `instant.ts`, and (since T6.11) bans a bare `_at::date`. Name the zone.
- **A day out of an instant is never a slice** - use `utcDayOf` or the expression written out, as
  `portal-home-repository.ts` and `escalation-repository.ts` do.
- **postgres.js rounds a timestamp-shaped PARAMETER to milliseconds** (it becomes a JS `Date`).
  Found by the integration test's subject coming back with three digits where the server stores
  six; a test observing precision writes a SQL literal. Nothing stores through that path today.

## The firm's own timezone - which calendar a MONTH is cut on (T6.11, 0071)

- **`tenancy.tenant.time_zone`**, because `x_at::date` used the session's (the server's) zone:
  `/portal/month` put a document filed at 02:00 IST on 1 October into SEPTEMBER on a client's
  page, and the chaser's `(asOf::date - raised_at::date)` sent a D+3 reminder on day 2 for asks
  raised after 18:30 UTC.
- **The firm's zone, not the reader's, by design.** A digest is a STATEMENT BY THE FIRM about a
  period and needs one boundary (the partner in Delhi and the CFO in Dubai must see the same
  September); an invoice's date is one date for the same reason. T6.9's rule still holds the
  other way: a MOMENT shown to a person is shown where they are.
- **Default `'UTC'`**, so applying 0071 changed no firm (the `work_split_axis` /
  `client_request_routing` position). **A column, not a registry kind**: nobody asks what it said
  last March, and moving office means every future digest uses the new zone.
- **It DOES restate what a past digest displays**, deliberately: the page is computed on read, so
  a corrected zone fixes the months it got wrong (as every accounting product behaves).
- **Validated by a trigger, because a CHECK cannot** (`pg_timezone_names` is a subquery,
  `AT TIME ZONE` is STABLE; 0070 used a trigger for the same reason).
- **`Intl.supportedValuesOf("timeZone")` is the wrong list (measured):** it omits `UTC` and
  `Asia/Kolkata` and canonicalises Kolkata to `Asia/Calcutta`, which this database does not know.
  `isTimeZone` constructs an `Intl.DateTimeFormat` instead and separately refuses an OFFSET
  (`+05:30`) - `pg_timezone_names` rejects it, and an offset cannot express daylight saving.
  `tests/portallibrary/digest-timezone.integration.test.ts` pins the measurement so a tzdata
  upgrade surfaces there.
- **One adapter, many ports.** `PostgresFirmTimeZone` satisfies the `FirmTimeZone` /
  `TimeZoneSetting` port declared beside each use case: chaser, portallibrary, serviceaxis,
  scheduler (T6.13), and since T6.14 escalation, nudge, obligation, dunning and orchestrator. Two
  implementations would be two answers (a chaser counting days in one zone while the digest cuts
  months in another).
- A new firm's zone from its country at provisioning (F07): see `firm-setup-and-structure.md`.

### Every daily sweep cuts "today" on the firm's calendar (T6.14, 2026-09-18)

- A sweep has no caller to send `asOf`, and the UTC day is yesterday in India until 05:30: for 5.5
  hours a night no T-X task was raised, a filing due yesterday was not yet MISSED, a D+1 rung had
  not fired, a D-1 nudge asked about the wrong day, and a step opening at 01:00 used the day
  before's assignment.
- The per-period spawn (T6.13) and the chaser (T6.11) already asked the firm; the other five now
  use `firmDay(tenantId)` = `dayInZone(now, timeZoneFor(tenantId))`, resolved **per firm inside
  the pass**, never once for all firms.
- **`filed_on` is the FILING's day** (since S7, 2026-10-05): the instant of completion read in
  the filing's zone, the clock "missed" uses; `completed_at` keeps the instant. See
  `compliance-calendar.md`.
- Routes that take a date from the browser are untouched (the caller's day is the caller's).
- **The PORTAL resolves the firm's day BEFORE `withPortal` opens** - `tenancy.tenant` has no
  portal policy and must not grow one (T6.9's rule about the Key Manager).

### A letter's two days (2026-09-28)

`send` dated an undated letter, and `sign` started work, on `utcDay(now)` (a letter sent at 01:00
IST was dated the day before). Both now take the caller's `asOf` (query param, held to the firm's
day +/-1 by `isCallersToday`, else `NOT_CALLERS_TODAY`), else the firm's day, as invoices do; the
browser sends `browserDay()`. The signature sweep and the import send none and get the firm's day.
`withState` ("has this work started yet") reads the firm's day too. Letters already sent or signed
keep their stored days.

### The audit of 2026-10-03: five more UTC days, all fixed (fix/audit-dates)

- **Proposal expiry (B24):** every `isPastValidity` caller passed the UTC instant;
  `ProposalService.firmToday` decides it on every path, the shared link included.
- **Dashboard ageing and DSO (B29, 0328):** `crm.receivable_ageing` buckets on `CURRENT_DATE`
  (the session's day). The dashboard reads `crm.receivable_ageing_on(<firm's day>)` (security
  invoker, the view's body); the view stays, unread, and `tests/architecture/firm-day-reads.test.ts`
  bans it and `CURRENT_DATE` in the dashboard adapter.
- **The chaser (B41):** its today and a lifted freeze's default day were the server's.
- **Handlers (B44):** the decision queue and the portal-scope echo used `new Date()`;
  `ObligationService.decisionDay` and `scopeFor(...).onDate` answer from the injected clock.
- **Escalations (F11):** each row also ships `daysPastNow` = `daysPast` + days since `raisedOn`
  on the firm's day; `daysPast` stays the record of the day it fired.
- **Emails (CA#50):** letters FROM a firm (portal invite and welcome, staff welcome, proposal
  decision notice) print times on the firm's clock with the zone named in words; the sign-in and
  reset letters belong to a global account and stay UTC.

### A date is a real day (B43)

`domain/day.ts` `isCalendarDay` is the one check (split arithmetic, no `Date`); `isDay` and the
shape-only `isIsoDate`s use it, and `mapError` answers SQLSTATE 22008/22007 as a 400 as the floor.
Never validate a day with `new Date(...)`: V8 rolls 2026-02-31 into March.

## Today is the caller's fact, not the server's (G3.2, 2026-09-25)

- `clock.now().toISOString().slice(0, 10)` is a day out east of Greenwich every morning (found
  opening the account-team screen at 04:11 in Delhi: the panel said "as of 29-08" on the 30th, and
  a client assigned from it was missing from its holder's book because `CURRENT_DATE` on a UTC
  server had not reached it).
- So `GET /api/v1/my-clients` takes `asOf`, `listOpenForClient` takes the date, `CURRENT_DATE`
  appears nowhere in the client-assignment SQL, and the browser sends its LOCAL day. Defaults are
  the FIRM's day (`dayInZone`, since the 2026-09-23 fix), never the server's.
- **`invoice`, `dunning` and `lead` follow it since 2026-09-25.** Dunning's sweep already moved in
  T6.14. `invoice` (a tax invoice's issue date, the series year of an undated one, a credit note's
  date) and `lead` (the day a capture's contact details are in force from) take `?asOf=` and
  default to the firm's day.
- **A caller's `asOf` on a WRITE is held to the firm's day or one either side** (`isCallersToday`
  in `domain/scheduler/zone.ts`, refused `NOT_CALLERS_TODAY`). Every inhabited zone is within a
  day of every other, so no real today is lost; without it a route stamping "today" on a numbered
  tax invoice could backdate one (the 2026-09-23 audit's High was a caller-supplied day deciding a
  recorded fact). A record that legitimately belongs to another day has its own field
  (`seriesDate`, a credit note's `issuedOn`).
- The one server-side `CURRENT_DATE` left in an adapter is the dashboard's "invoiced in the last N
  days".

## Each company's own year and clock (0337, 2026-10-04)

A firm with companies in India, the UAE, Singapore and the US cannot run one calendar (a UAE
year starts in January; New York's 31 October is already 1 November in Delhi). Every multi-entity
ERP (NetSuite, Business Central, Xero, Zoho, Odoo, Tally) keeps year and document date per legal
entity; no practice-management tool does (`bib/reports/Per company fiscal year and timezone.md`).

- **Two axes, never mixed.**
  - (A) What a firm COMPANY issues follows that company's year and zone, else the firm's: an
    invoice's date and its number's year, billing periods and bill dates, letters, proposals,
    engagement dates, recurring work periods, a draft's PDF date.
  - (B) A CLIENT's filing follows the filing's country and, where its rule says so, the client's
    own year end. Designed in `bib/prompts/company-calendar/SPEC.md` §5 and **built in S3
    (2026-10-05)**: the filing zone (B1, `domain/obligation/filing-zone.ts`, SQL `FILING_ZONE`)
    and the rule's `period_basis` (B2, 0358) - see `compliance-calendar.md`.
  - **Reminders to people stay on the firm's day**: To raise ages, advance Overdue, dunning, the
    digest, staff routing, the dashboard.
- **Storage.** `core.legal_entity.time_zone` (trigger-checked against `pg_timezone_names`) and
  `financial_year_end` (MM-DD, the last day; the start month is the month after). NULL = the
  firm's; nothing was backfilled. The API speaks `timeZone` and `fiscalYearStartMonth` (1-12) on
  `/firm-entities`; a company with no country recorded is refused both (`COMPANY_NOT_REGISTERED`).
- **Reading it.** Each use case's `FirmTimeZone` port has `companyCalendars(tenantId)` (filtered
  by `crm.is_firm_entity`, so a CLIENT's year end is never read here); `domain/calendar/model.ts`
  resolves `zoneOfCompany` / `yearStartOfCompany`. In SQL, `crm.issuer_zone(tenant, party)` is
  the company's zone else the firm's: use it wherever a company document's instant becomes a day
  (`printed_parties`, `signed_on`, `done_on`, a company's own tax number's `valid_from`).
- **A series keeps its year.** `crm.invoice_series.start_month` is fixed when the series row is
  made, so a mid-series year change keeps the label until the new year (a transition period, as
  Business Central does); a new series row carries the company's latest prefix. The invoice read's
  `financialYearLabel` is read off the frozen number, never rebuilt. **A number is never drawn in
  a series OLDER than the newest one the company has drawn in** (`seriesYearFor`): moving a year
  start later (January to April) would otherwise reopen a closed series.
- **An engagement keeps the year it was first cut on (0338).** `crm.engagement.year_start_month`
  is pinned when billing is scheduled (go-live, or by hand) or the first recurring period is cut,
  and never moved; the billing sweep and the scheduler cut on it before the company's live year.
  A company's year change applies only to engagements starting after it.
- **A recorded acceptance takes the RECORDER's day** (`asOf`, held to the company's day +/-1, on
  letters and proposals): a partner in Delhi at 09:00 must be able to record "today" for a New
  York company still on yesterday.
- **`asOf` on a company document is held to the COMPANY's day** or one either side; the screens no
  longer send it and the API dates the document on the company's day. The invoice read's
  `issuesOn` is the day Issue would date a draft, for the confirmation to say.
