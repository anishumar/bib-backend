// Reading a `timestamptz` column back as an INSTANT the whole web can parse.
//
// The sibling of `day.ts`, and its OPPOSITE. That module is about a `date`
// column — a day, which must never be parsed. This one is about a `timestamptz`
// — a moment, which must be, because the day a moment falls on is the READER's
// question and only their browser can answer it.
//
// ── WHAT `::text` ACTUALLY PRODUCES, AND WHY IT IS NOT ISO 8601 ────────────
//
// `SELECT now()::text` renders
//
//     2026-09-01 19:54:05.712839+00
//                ^                 ^^^^^^^^
//                a SPACE           SIX fractional digits, and a bare `+00`
//
// ECMAScript pins the string `Date` must accept — the Date Time String Format —
// to `YYYY-MM-DDTHH:mm:ss.sssZ`: a literal `T`, and EXACTLY three fractional
// digits. What Postgres renders is none of those things. Anything else is
// "implementation-specific", which is the specification saying *each browser
// decides*. V8 and SpiderMonkey are lenient and take it; JavaScriptCore
// historically does not, and `new Date("2026-09-01 19:54:05.712839+00")` there
// is `Invalid Date`. Every portal screen guards with
// `Number.isNaN(at.getTime()) ? iso : …`, so the failure is not a crash — it is
// a client on an iPhone reading `2026-09-01 19:54:05.712839+00` where the firm
// meant to say "1 Sep 2026". Nothing on this machine can see it.
//
// ── AND THE SECOND BUG IN THE SAME CAST, WHICH IS THE WORSE ONE ────────────
//
// `timestamptz::text` renders in the SESSION's `TimeZone`, not in UTC.
// `src/db/pool.ts` sets none, so the value is whatever the SERVER was
// configured with — UTC in the compose container, and therefore UTC in every
// string anyone here has ever looked at. Point the same code at a Postgres
// running `Asia/Kolkata` and the identical row renders `+05:30`.
//
// That is invisible until something SLICES the string. `render-source.ts` did:
// an invoice with no `issued_on` took its printed date from
// `created_at.slice(0, 10)`. Raised at 02:00 IST, the UTC render says the day
// before and the Kolkata render says the day itself — so the date printed on a
// numbered tax document, the one an auditor reads, depended on a setting in
// `postgresql.conf`. It is the `day.ts` bug wearing different clothes: a day
// derived from an instant, by a zone nobody chose.
//
// ── SO: `AT TIME ZONE 'UTC'` FIRST, AND FORMAT EXPLICITLY ──────────────────
//
// `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` gives
// `2026-09-01T19:54:05.712Z` — byte for byte what JS `toISOString()` produces,
// which is the one string every engine is REQUIRED to accept.
//
//   · `AT TIME ZONE 'UTC'` makes the output independent of the server. The
//     literal `Z` is then true rather than hopeful.
//   · `.MS` is three digits, deliberately. `.US` would be six and is more
//     faithful to what Postgres stores — and is back outside the spec, so
//     it is back to each engine deciding. Ordering is done in SQL; nothing
//     here needs microseconds to display a date.
//   · NULL in, NULL out. `to_char(NULL, …)` is NULL, so an unanswered ask keeps
//     its honest `null` and nothing fabricates a moment.
//   · No JS `Date` is constructed at any point, for the same reason `day.ts`
//     prefers a cast: a value that is never parsed cannot be parsed wrong.
//
// ── WHEN YOU WANT A DAY OUT OF ONE OF THESE, DO NOT SLICE ──────────────────
//
// Ask SQL for the day: `(col AT TIME ZONE 'UTC')::date::text`. That is what
// `portal-home-repository.ts` and `escalation-repository.ts` already do, it
// says which zone decided the day, and it cannot drift when the format above
// changes. `tests/architecture/instant-format.test.ts` holds both halves of
// this rule.

/** The one format string. Named once so the integration test can MEASURE the
 *  expression this module actually emits, rather than a copy of it. */
const ISO_8601 = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * A `timestamptz` as an ISO 8601 instant — `2026-09-01T19:54:05.712Z`.
 *
 * @param expr  the column or expression, SQL as written — `a.raised_at`,
 *              `max(c.chased_at)`. It is spliced into the query verbatim, so it
 *              is for STATIC SQL only; never build one from request input.
 * @param alias appended as `AS <alias>` when given. Omit inside a scalar
 *              subquery, which is aliased from outside.
 *
 * Reaches a query through `db.unsafe(...)`, which is what "spliced verbatim"
 * means here:
 *
 *     SELECT ${db.unsafe(isoInstant("a.raised_at", "raised_at"))}
 */
export function isoInstant(expr: string, alias?: string): string {
  const rendered = `to_char(${expr} AT TIME ZONE 'UTC', ${ISO_8601})`;
  return alias === undefined ? rendered : `${rendered} AS ${alias}`;
}

/**
 * The DAY a `timestamptz` falls on in UTC — `2026-09-01`.
 *
 * For the cases that want a calendar day out of a moment. Spelled out rather
 * than sliced off `isoInstant`, because a slice hides which zone answered.
 */
export function utcDayOf(expr: string, alias: string): string {
  return `(${expr} AT TIME ZONE 'UTC')::date::text AS ${alias}`;
}

/**
 * The DAY a `timestamptz` falls on in the FIRM's zone (`tenancy.tenant.time_zone`,
 * 0071) — what a document it dates should print. A proposal sent at 02:15 in
 * Delhi is dated that day, not the UTC day before (T6.18). `zoneExpr` is a SQL
 * expression naming the zone, typically `firm.time_zone` off a join.
 */
export function zoneDayOf(expr: string, zoneExpr: string, alias: string): string {
  return `(${expr} AT TIME ZONE ${zoneExpr})::date::text AS ${alias}`;
}
