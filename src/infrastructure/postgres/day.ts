// Reading a `date` column back as a DAY.
//
// ── THE FACT EVERYTHING HERE RESTS ON, MEASURED RATHER THAN ASSUMED ────────
//
// postgres.js materialises a `date` column as a JS `Date` at **UTC midnight**.
// Asked for `'2026-08-20'::date` it returns exactly `2026-08-20T00:00:00.000Z`,
// whatever zone the process runs in. That was checked against this database
// rather than reasoned about, because two adapters already carried a comment
// asserting the opposite and both were wrong.
//
// Everything follows from it:
//
//   · reading the UTC fields gives the stored day, in EVERY zone. Correct.
//   · reading the LOCAL fields gives the day that instant falls on where the
//     process happens to run — which west of Greenwich is the day BEFORE.
//
// ── SO THE TRAP IS THE LOCAL GETTERS, AND IT IS THE ONE THAT LOOKS SAFER ───
//
// `getFullYear()/getMonth()/getDate()` reads like the careful choice — it
// avoids a string slice and it avoids the word UTC, which in this codebase is
// usually the thing to be suspicious of. `engagement-repository.ts` used it and
// carried a comment saying `toISOString().slice(0, 10)` "would be wrong east of
// UTC"; `proposal-repository.ts` copied both. **The comment had it backwards
// and so did the code.** Nothing went red, because the failure only appears on
// a machine running west of UTC and this product is developed and deployed east
// of it. An invoice dated the 20th would read as the 19th on a developer's
// laptop in New York, or in a pod in `us-east-1`.
//
// It is worst where it costs money and cannot be argued with:
//
//   · `invoice.issued_on`   — a tax invoice's own date, on a numbered document
//                             an auditor reads.
//   · `payment.received_on` — 1 April reading as 31 March moves a payment into
//                             the previous FINANCIAL YEAR.
//   · `engagement.effective_from` — the day work begins, which is what every
//                             SLA due date is counted from.
//
// ── AND THE BETTER ANSWER, WHERE A QUERY IS BEING WRITTEN ANYWAY ───────────
//
// `SELECT some_date::text`. Postgres renders the day, no `Date` is constructed,
// and no zone is involved at any point. The compliance calendar does exactly
// that and is the pattern to copy in new queries. This module exists for the
// queries that already hand back a `Date`.

/**
 * A `date` column as the day it actually is — `YYYY-MM-DD`, in every zone.
 *
 * The UTC fields, deliberately, because that is where postgres.js put the day.
 * **Never the local getters**, and never `getFullYear()/getMonth()/getDate()` on
 * a value that came out of Postgres — `tests/architecture/calendar-day.test.ts`
 * holds the build red if either comes back into an adapter.
 *
 * Written out rather than as `toISOString().slice(0, 10)`, which is identical,
 * because the slice hides which of the two mistakes it is avoiding.
 */
export function toDay(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}

/** The same, for a nullable column. Null is a real answer — an unissued invoice
 *  has no issue date — and is never turned into a fabricated day. */
export function toDayOrNull(d: Date | null): string | null {
  return d === null ? null : toDay(d);
}
