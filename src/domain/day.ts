// A calendar day, written the way this product writes every calendar day.
// Pure: stdlib only, and it never constructs a Date.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Refusals carry dates. "This assignment already ended on 2026-08-12", "already
// ended on 2019-06-11", "valid until 2026-10-31" — ten of them across five
// modules, and every one is read by a person on a screen where EVERY OTHER DATE
// says `12 Aug 2026`. The front end has one date format app-wide and enforces
// it; the API's own sentences were the hole in it, and they became more visible
// the day a refusal started taking focus and scrolling itself into view.
//
// The front end cannot fix this. It shows an API refusal VERBATIM, deliberately
// — several of them are the only sentence that says how to fix the thing, and a
// friendlier local rewrite would throw that away. So the format has to be right
// where the sentence is written.
//
// ── IT SPLITS THE STRING, AND THAT IS THE WHOLE POINT ───────────────────────
//
// `new Date("2019-06-11")` is UTC midnight and prints as the 10th west of
// Greenwich. A `date` column is a calendar day with no instant in it, and this
// product has had THREE bugs from treating one as a moment. Splitting cannot
// have that bug: there is no zone in the input and none is invented.
//
// The mirror of `longDay()` in the front end's `@/lib/day`, on purpose and by
// the same rule: a `date` column is SPLIT, a `timestamptz` is PARSED. Nothing
// here parses anything, because nothing here is ever handed an instant.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `2019-06-11` → `11 Jun 2019`.
 *
 * Anything that is not a plain `YYYY-MM-DD` comes back UNCHANGED rather than as
 * a guess or an empty string: these are error messages, and a refusal that says
 * "already ended on Invalid Date" is worse than one that says the ISO day. The
 * same defensive shape `readChaserBody` takes about a stored rung.
 */
export function longDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, year, month, day] = m;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined || year === undefined || day === undefined) return iso;
  // THE LEADING ZERO STAYS. `longDay` in the front end prints the day part of
  // the ISO string untouched — `04 Sep 2026` — and this exists to agree with it
  // exactly. A refusal reading `4 Sep 2026` beside a table reading `04 Sep 2026`
  // is a second date format, which is the thing this is fixing.
  return `${day} ${name} ${year}`;
}
