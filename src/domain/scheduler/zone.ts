// A calendar day and an instant, converted in a NAMED zone — the two
// conversions the per-period spawn needs and nothing else in `domain/` had.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS SMALL ──────────────────────────────
//
// This product has had three bugs from treating a calendar day as an instant,
// and the rule that came out of them is that the FIELD'S TYPE decides: a
// `date` column is split as a string, a `timestamptz` is parsed. A period job
// straddles that line on purpose. Its period is three `date` columns and is
// pure string arithmetic (`model.ts`). Its `runnable_at` is a `timestamptz`,
// because the orchestrator compares it with the clock — and "the day after
// the period ends" is only an instant once you say WHERE. Midnight in
// Kolkata is the previous evening in UTC; a job runnable at UTC midnight
// would open five and a half hours late for the firm this was built for, and
// a US entity's would open early. So the firm's own zone (0071) is the input,
// and these two functions are the only place a zone and a day meet.
//
// ── NO LIBRARY ──────────────────────────────────────────────────────────────
//
// `Intl.DateTimeFormat` knows every zone Postgres knows (`isTimeZone` in the
// tenancy model measured that) and can say what wall-clock time an instant
// is in a zone. The reverse — what instant a wall-clock midnight is — is
// derived from it by measuring the zone's offset at a guess and correcting
// once, which is exact everywhere except across a DST transition at midnight
// itself, where a second pass settles it. Two passes are enough because an
// offset changes at most once a day.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The wall-clock offset of `timeZone` at `instantMs`, in minutes east of UTC. */
function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wall = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return Math.round((wall - instantMs) / 60_000);
}

/**
 * The instant at which `day` BEGINS in `timeZone`, as an ISO timestamp.
 *
 * `startOfDayInZone("2026-10-01", "Asia/Kolkata")` is
 * `2026-09-30T18:30:00.000Z` — which is the point: the job for September's
 * books opens when October starts for the firm, not for Greenwich.
 *
 * A day that is not `YYYY-MM-DD`, or a zone the runtime does not know, throws
 * rather than guessing: the caller is a sweep writing `runnable_at`, and a
 * silently wrong instant is a job that opens on the wrong day for a month
 * before anybody notices.
 */
export function startOfDayInZone(day: string, timeZone: string): string {
  const m = ISO_DAY.exec(day);
  if (!m) throw new RangeError(`not a calendar day: ${JSON.stringify(day)}`);
  const [, y, mo, d] = m;
  const wallMidnight = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  let guess = wallMidnight;
  for (let pass = 0; pass < 2; pass += 1) {
    guess = wallMidnight - offsetMinutesAt(guess, timeZone) * 60_000;
  }
  return new Date(guess).toISOString();
}

/**
 * The calendar day `instant` falls on in `timeZone`, as `YYYY-MM-DD`.
 *
 * The other direction, and the one the sweep uses to ask "what is today for
 * this firm" before deciding which periods have begun. An hourly sweep at
 * 23:30 UTC on the 30th is already the 1st in Kolkata, and a job for the
 * month that just started must be created on THAT pass, not the next day's.
 */
export function dayInZone(instant: string, timeZone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`not an instant: ${JSON.stringify(instant)}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}
