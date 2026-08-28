// The scheduler domain (T2.6) — what a job is, and the date arithmetic the
// engine runs on. Pure: no clock, no queue, no database. Every function here
// takes the dates it needs as arguments, which is what lets "does a monthly
// obligation produce twelve periods a year out" be a test with no time in it.
//
// The arithmetic is deliberately separate from the machinery. pg-boss decides
// WHEN a sweep runs; this decides WHAT that sweep should find. The second is
// the part that is wrong in ways nobody notices — a quarter that starts in
// January instead of April is right three times out of four — so it is pure,
// and it is tested against the calendar rather than against a running worker.

/** What caused a job to exist. A closed set, mirrored by the CHECK in 0041. */
export type JobSource = "engagement" | "obligation";

/**
 * The engine's own mechanics — NOT the firm's vocabulary.
 *
 * T3.1's work-item states are rows because a firm renames them. These are not
 * the firm's to rename: they describe what the orchestrator is doing, they are
 * identical at every firm, and a `running` renamed to `in progress` would be a
 * firm editing the engine.
 */
export type JobStatus = "pending" | "running" | "blocked" | "done" | "cancelled";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface Job {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceKind: JobSource;
  /** The id of the thing that caused it — an engagement, later an obligation. */
  readonly sourceRef: string;
  readonly status: JobStatus;
  /** The pinned workflow version, once T2.7 gives a job a graph to walk. */
  readonly templateVersionId: string | null;
  /** When the work may begin — the T–X date. */
  readonly runnableAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

// ── Recurrence ──────────────────────────────────────────────────────────────

/**
 * How often a thing recurs.
 *
 * Four, and no more, because these are the four the firm's own filings use and
 * a fifth invented now would be a guess. `annual` covers a financial year;
 * `quarterly` is three months of it. There is deliberately no `weekly` and no
 * cron string: a cron expression in a data row is a formula nobody can query,
 * and the moment somebody needs "every second Tuesday" it should arrive as a
 * column with a name rather than as a string this code has to interpret.
 */
export type Recurrence = "monthly" | "quarterly" | "half_yearly" | "annual";

export const RECURRENCES: readonly Recurrence[] = [
  "monthly",
  "quarterly",
  "half_yearly",
  "annual",
];

export function isRecurrence(v: string): v is Recurrence {
  return (RECURRENCES as readonly string[]).includes(v);
}

/** How many months one period of this recurrence covers. */
export function monthsPerPeriod(recurrence: Recurrence): number {
  switch (recurrence) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "half_yearly":
      return 6;
    case "annual":
      return 12;
  }
}

/**
 * One period of a recurring obligation: the span the filing is ABOUT.
 *
 * Not the same thing as its due date, and the distinction is the whole reason
 * this type exists. August's GSTR-3B covers 1–31 August and is due on 20
 * September. Collapse the two and you can no longer answer "which month is this
 * return for", which is the question a client actually asks.
 */
export interface Period {
  /** Inclusive, ISO date (YYYY-MM-DD). */
  readonly start: string;
  /** Inclusive, ISO date. */
  readonly end: string;
  /** What a person calls it — "Aug 2026", "Q2 FY2026-27". */
  readonly label: string;
}

/**
 * The financial year a date falls in, given the month the year starts in.
 *
 * India's starts in April, so 2026-08-15 is in FY 2026-27 and 2026-02-15 is in
 * FY 2025-26. A parameter rather than a constant: the firm has a US entity, and
 * the whole point of `fiscal_year_start_month` on a template (T3.2) is that the
 * answer differs per jurisdiction. Passing 1 gives the calendar year.
 */
export function fiscalYearOf(date: string, startMonth: number): number {
  const [year = 0, month = 0] = date.split("-").map(Number);
  return month >= startMonth ? year : year - 1;
}

/**
 * The periods of a recurrence, starting from the one containing `from`.
 *
 * THE function T2.6's acceptance is about: twelve months of a monthly
 * obligation, a year out. It is pure arithmetic over ISO date strings — no
 * Date-with-timezone anywhere, because a filing period is a calendar fact in a
 * jurisdiction and not an instant, and the moment a UTC Date is involved a
 * period boundary moves by a day for half the world.
 *
 * `count` periods, so the caller decides the horizon rather than this deciding
 * for it. T3.2 asks for a year; a test asks for two.
 */
export function periodsFrom(
  from: string,
  recurrence: Recurrence,
  count: number,
  fiscalYearStartMonth = 1,
): readonly Period[] {
  const span = monthsPerPeriod(recurrence);
  const [fromYear = 0, fromMonth = 1] = from.split("-").map(Number);

  // The first period is the one CONTAINING `from`, not the one starting on it.
  // A generator run on the 15th must produce that month's period, not next
  // month's — otherwise the current filing is the one it silently skips.
  const alignedMonth = alignToPeriod(fromMonth, span, fiscalYearStartMonth);

  const periods: Period[] = [];
  for (let i = 0; i < count; i += 1) {
    const monthIndex = (fromYear * 12 + (alignedMonth - 1)) + i * span;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const start = iso(year, month, 1);
    const endMonthIndex = monthIndex + span - 1;
    const endYear = Math.floor(endMonthIndex / 12);
    const endMonth = (endMonthIndex % 12) + 1;
    const end = iso(endYear, endMonth, daysInMonth(endYear, endMonth));
    periods.push({ start, end, label: labelFor(start, recurrence, fiscalYearStartMonth) });
  }
  return periods;
}

/**
 * Where a period boundary falls.
 *
 * A quarter is not "three months from whenever you asked" — it is aligned to
 * the financial year, so an Indian quarter runs Apr–Jun and not Aug–Oct. This
 * is the calculation that is wrong three times out of four if nobody thinks
 * about it, and right by accident when the generator happens to run in April.
 */
function alignToPeriod(month: number, span: number, fiscalYearStartMonth: number): number {
  if (span === 1) return month;
  // Months since the financial year began, 0-based.
  const offset = (month - fiscalYearStartMonth + 12) % 12;
  const alignedOffset = Math.floor(offset / span) * span;
  return ((fiscalYearStartMonth - 1 + alignedOffset) % 12) + 1;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** What a person calls the period. Shown to clients, so it reads the way a
 *  filing does rather than as a date range. */
function labelFor(start: string, recurrence: Recurrence, fiscalYearStartMonth: number): string {
  const [year = 0, month = 1] = start.split("-").map(Number);
  const name = MONTH_NAMES[month - 1] ?? "";
  if (recurrence === "monthly") return `${name} ${String(year)}`;

  const fy = fiscalYearOf(start, fiscalYearStartMonth);
  // A financial year that does not start in January spans two calendar years,
  // and naming it by one of them is how a filing ends up in the wrong year.
  const fyLabel =
    fiscalYearStartMonth === 1
      ? String(fy)
      : `FY${String(fy)}-${String((fy + 1) % 100).padStart(2, "0")}`;

  if (recurrence === "annual") return fyLabel;
  const span = monthsPerPeriod(recurrence);
  const offset = (month - fiscalYearStartMonth + 12) % 12;
  const index = Math.floor(offset / span) + 1;
  return recurrence === "quarterly" ? `Q${String(index)} ${fyLabel}` : `H${String(index)} ${fyLabel}`;
}

// ── Due dates and lead time ─────────────────────────────────────────────────

/**
 * How a due date is derived from a period. DATA, not a formula string.
 *
 * Two shapes cover every filing the firm has named, and both are stated as
 * fields rather than as an expression this code would have to parse:
 *
 *   dayOfMonth  — "the 20th of the month AFTER the period ends" (GST).
 *                 `monthOffset` is how many months after the period's end month.
 *   daysAfter   — "within 30 days of the period ending" (some ROC filings).
 *
 * A third kind is deliberately absent. India's QRMP scheme is conditional, and
 * inventing a condition language before seeing a real condition produces the
 * wrong abstraction — when one arrives it becomes a column, not a rewrite.
 */
export type DueRule =
  | { readonly kind: "dayOfMonth"; readonly monthOffset: number; readonly day: number }
  | { readonly kind: "daysAfter"; readonly days: number };

/** The statutory date a period is due on. What the law says; missing it is the
 *  client's money. */
export function dueDateFor(period: Period, rule: DueRule): string {
  if (rule.kind === "daysAfter") return addDays(period.end, rule.days);

  const [year = 0, month = 1] = period.end.split("-").map(Number);
  const monthIndex = year * 12 + (month - 1) + rule.monthOffset;
  const dueYear = Math.floor(monthIndex / 12);
  const dueMonth = (monthIndex % 12) + 1;
  // Clamped, so "the 31st" in a 30-day month is the 30th rather than rolling
  // into the next month — which would make a deadline a day late, silently.
  const day = Math.min(rule.day, daysInMonth(dueYear, dueMonth));
  return iso(dueYear, dueMonth, day);
}

/**
 * T–X: the firm's own date, ahead of the statutory one.
 *
 * The reason the whole scheduler exists. `statutory` is what the law says and
 * missing it costs the client money; this is when the FIRM wants the work in
 * hand, and it is the date the escalation ladder watches — because finding out
 * you are late on the day you are late is useless.
 *
 * Never after the statutory date, whatever lead time is configured: a negative
 * or oversized value would quietly move the firm's own deadline past the law's.
 */
export function internalTargetFor(statutory: string, leadDays: number): string {
  if (leadDays <= 0) return statutory;
  return addDays(statutory, -leadDays);
}

/**
 * When a job for this obligation becomes runnable.
 *
 * A calendar is materialised a year ahead so it can be SEEN, but a job that
 * became runnable the moment it was created would put twelve months of work on
 * somebody's desk this morning. It waits until its own lead time opens.
 */
export function runnableAtFor(internalTarget: string, spawnLeadDays: number): string {
  return spawnLeadDays <= 0 ? internalTarget : addDays(internalTarget, -spawnLeadDays);
}

// ── ISO date helpers ────────────────────────────────────────────────────────
//
// Strings in, strings out. Deliberately not `Date`: a filing period is a
// calendar fact in a jurisdiction, not an instant, and a UTC Date moves a
// period boundary by a day for anyone east or west of it. `Date.UTC` is used
// only as a day-counting device, never as a point in time that is stored.

export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const shifted = new Date(ms);
  return iso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whether a date has arrived, as of `today`. Both ISO dates, compared as
 *  strings — which is exact for this format and needs no timezone. */
export function isDue(date: string, today: string): boolean {
  return date <= today;
}
