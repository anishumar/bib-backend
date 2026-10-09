// A `timestamptz` read back as an ISO 8601 INSTANT every browser must parse (T6.10). The opposite
// of `day.ts`: a `date` is a DAY and never parsed; an instant always is, in the reader's zone.
// Two traps in `col::text`, both in docs/claude/dates-and-timezones.md:
//  - `2026-09-01 19:54:05.712839+00` (space, six digits, bare `+00`) is outside the ECMAScript
//    Date format; V8 takes it, JavaScriptCore historically does not, so an iPhone portal client
//    saw the raw string.
//  - it renders in the SESSION's TimeZone (`src/db/pool.ts` sets none), so a day sliced off it
//    depends on `postgresql.conf`; an invoice's printed date in `render-source.ts` once did.
// So: `AT TIME ZONE 'UTC'` then an explicit `to_char` = JS `toISOString()`. `.MS` (3 digits) on
// purpose, `.US` is outside the spec. NULL in, NULL out. No JS `Date` is ever built. A day from
// an instant is asked of SQL with its zone named, never sliced (`instant-format.test.ts`).

/** The one format string, named so the integration test measures what this module emits. */
const ISO_8601 = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * A `timestamptz` as an ISO 8601 instant, `2026-09-01T19:54:05.712Z`.
 * `expr` is spliced verbatim via `db.unsafe(...)`: STATIC SQL only, never request input.
 * Omit `alias` inside a scalar subquery, which is aliased from outside.
 */
export function isoInstant(expr: string, alias?: string): string {
  const rendered = `to_char(${expr} AT TIME ZONE 'UTC', ${ISO_8601})`;
  return alias === undefined ? rendered : `${rendered} AS ${alias}`;
}

/** The UTC DAY a `timestamptz` falls on, `2026-09-01`; never slice `isoInstant`, it hides the zone. */
export function utcDayOf(expr: string, alias: string): string {
  return `(${expr} AT TIME ZONE 'UTC')::date::text AS ${alias}`;
}

/**
 * The DAY a `timestamptz` falls on in a zone (`zoneExpr`, typically `firm.time_zone`, 0071):
 * what a document should print. A proposal sent 02:15 in Delhi is that day, not UTC's (T6.18).
 */
export function zoneDayOf(expr: string, zoneExpr: string, alias: string): string {
  return `(${expr} AT TIME ZONE ${zoneExpr})::date::text AS ${alias}`;
}

/**
 * Microsecond precision for a value compared back against its column, never sent to a browser:
 * the notification outbox cursor (0323). Milliseconds would round it BELOW events already passed.
 */
export function fullInstant(expr: string, alias: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
}
