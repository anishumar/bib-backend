// The obligation domain (T3.2) — what the LAW asks of an entity, and when.
// Pure nouns and pure rules; imports nothing internal and nothing beyond the
// standard library (enforced by the arch test).
//
// ── AN OBLIGATION IS NOT A TASK ────────────────────────────────────────────
//
// The obligation is what the law requires of the ENTITY — Kaveri Foods must
// file GSTR-3B for August by 20 September. The task (`domain/workitem`) is what
// somebody at the firm must DO about it. Merge them and the calendar can never
// be generated, only typed, which is the Excel this product replaces. Migration
// 0052 argues it at length; this file is what makes it computable.
//
// ── EVERY DATE HERE IS A `YYYY-MM-DD` STRING, NEVER A `Date` ───────────────
//
// A `Date` carries a time and a zone, and "the 20th" in a process running in
// one zone is the 19th in another — which for a statutory deadline is a
// penalty, not a rounding error. This is the same rule the repo already learned
// the hard way with `toISOString()` producing yesterday in India, and it is why
// nothing below constructs a `Date` except to ask the calendar how long a month
// is.
//
// ── AND NOTHING HERE READS A CLOCK ─────────────────────────────────────────
//
// Every function is a pure transform from a rule and a window to dates. A
// statutory deadline is something a client is held to, so it has to be testable
// exhaustively and cheaply, and a function that reaches for `new Date()` cannot
// be. The clock lives in the use case, which passes `today` in.

/** A calendar date, `YYYY-MM-DD`, always UTC-free — it names a day, not an
 *  instant. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

// ── the rule ───────────────────────────────────────────────────────────────

/**
 * How often the work comes round.
 *
 * `half_yearly` is here and is not in the demo this was built from: MSME-1 is
 * explicitly half-yearly on the firm's own sheet, and rounding it to quarterly
 * would have produced four filings a year for an obligation that has two.
 *
 * `event` has no period and therefore no schedule — a director changes and a
 * clock starts. It PRODUCES NOTHING today because nothing in this system knows
 * the event happened. It exists as a member so the firm can see that we know
 * about FC-GPR and DIR-12, rather than finding them silently absent.
 */
export type ObligationRecurrence = "monthly" | "quarterly" | "half_yearly" | "annual" | "event";

export const OBLIGATION_RECURRENCES: readonly ObligationRecurrence[] = [
  "monthly",
  "quarterly",
  "half_yearly",
  "annual",
  "event",
];

export function isObligationRecurrence(v: string): v is ObligationRecurrence {
  return (OBLIGATION_RECURRENCES as readonly string[]).includes(v);
}

/** How many months one period covers. `event` has no period; callers must not
 *  ask, and `periodsBetween` returns nothing for it. */
const MONTHS_PER_PERIOD: Record<Exclude<ObligationRecurrence, "event">, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  annual: 12,
};

/**
 * How the statutory date is computed from the period. DATA, not a formula
 * string somebody has to parse.
 *
 * - `day_of_month` — `dueMonthOffset` months after the period ends, then
 *   `dueDayOfMonth`. "The 20th of the month following the period end." Advance
 *   Tax falls out of the same shape at offset 0 (Q1 Apr–Jun ends 30 June →
 *   15 June), which is BEFORE the period ends and needed no new kind.
 * - `days_after` — `dueDaysAfter` days after the period ends.
 *
 * A third kind is deliberately absent — see 0052. When a conditional rule
 * arrives it becomes a column, not a rewrite.
 */
export type DueRuleKind = "day_of_month" | "days_after";

export const DUE_RULE_KINDS: readonly DueRuleKind[] = ["day_of_month", "days_after"];

export function isDueRuleKind(v: string): v is DueRuleKind {
  return (DUE_RULE_KINDS as readonly string[]).includes(v);
}

/** Whether the FIRM has checked this rule against the statute. Everything seeds
 *  `unconfirmed`, India included — the shipped dates came from a previous
 *  vendor's document, and the firm's own practice may be earlier. */
export type RuleStatus = "unconfirmed" | "confirmed";

export const RULE_STATUSES: readonly RuleStatus[] = ["unconfirmed", "confirmed"];

export function isRuleStatus(v: string): v is RuleStatus {
  return (RULE_STATUSES as readonly string[]).includes(v);
}

/** The computable half of a rule. Null `kind` is the honest case: the rule is
 *  real and its date cannot be derived — see `ObligationTemplate.unresolvedReason`. */
export interface DueRule {
  readonly kind: DueRuleKind;
  readonly dueMonthOffset: number | null;
  readonly dueDayOfMonth: number | null;
  readonly dueDaysAfter: number | null;
}

/** The same rule, plus the one period it replaces. */
export interface DueRuleException extends DueRule {
  /** The calendar month the filed PERIOD ends in. March is 3. */
  readonly periodEndMonth: number;
  /** Why this period is different, in the firm's own words. Mandatory: an
   *  exception nobody explained is one a partner cannot review. */
  readonly note: string;
}

export interface ObligationTemplate {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 3166-1 alpha-2. */
  readonly jurisdiction: string;
  /** Null means EVERY entity type, which is the common case: GST does not care
   *  what shape the company is. */
  readonly entityType: string | null;
  /** The `config.entry` of the service that makes this the firm's problem — the
   *  catalogue key, not a pinned version. Null means the entity owes it
   *  regardless, which generates nothing today (see 0053). */
  readonly serviceEntryId: string | null;
  /** The statute's own grouping — "GST", "TDS", "MCA". NOT `ServiceBody.module`,
   *  which is the firm's revenue axis. Two axes, deliberately uncrossed. */
  readonly module: string | null;
  readonly name: string;
  readonly authority: string | null;
  readonly recurrence: ObligationRecurrence;
  /** 4 for India, 1 for a calendar year. On the rule because an Indian QUARTER
   *  is Apr–Jun, and computing quarters on the calendar would put every Indian
   *  quarterly filing in the wrong period. */
  readonly fiscalYearStartMonth: number;
  /** Null when the rule is real and its date cannot be computed. */
  readonly dueRule: DueRule | null;
  /** Why not, in the firm's own words. Present exactly when `dueRule` is null. */
  readonly unresolvedReason: string | null;
  /** T–X, the firm's own practice rather than the law. */
  readonly leadTimeDays: number;
  readonly rulePack: string;
  readonly supersedesId: string | null;
  readonly status: RuleStatus;
  readonly isActive: boolean;
}

// ── what a rule is actually doing, and why ─────────────────────────────────

/**
 * Whether a rule can produce dates, and if not, why not.
 *
 * DERIVED from the columns rather than stored, so there is no fourth thing to
 * keep in step. It exists because the alternative is silence: a firm that
 * cannot find GSTR-9C on its calendar must be told which rule is missing what,
 * on a screen, in these terms — never left to wonder whether the software is
 * broken.
 *
 *   `generating`     it produces dates, and the calendar shows them.
 *   `needs_formula`  a real obligation whose timing this system cannot derive.
 *                    Around forty of the firm's fifty-five are here, and the
 *                    reason is on the row. NOT a bug and never rendered as one.
 *   `event_driven`   no period, so nothing to count from until the event
 *                    happens — and nothing here knows that it has.
 *   `retired`        the firm has moved on. Past instances still read.
 */
export type RuleCoverage = "generating" | "needs_formula" | "event_driven" | "retired";

export function coverageOf(t: ObligationTemplate): RuleCoverage {
  if (!t.isActive) return "retired";
  if (t.dueRule === null) return "needs_formula";
  if (t.recurrence === "event") return "event_driven";
  return "generating";
}

/** The rules that will actually put rows on the calendar. The generator's own
 *  filter, named once so the screen and the sweep cannot disagree about it. */
export function generatesDates(t: ObligationTemplate): boolean {
  return coverageOf(t) === "generating";
}

// ── the state an obligation is in ──────────────────────────────────────────

/**
 * One row of the firm's own vocabulary for where an obligation has got to.
 *
 * Rows, not an enum, for 0050's reason — and NOTHING in this codebase ever
 * compares `code`. The demo this was built from looked states up by the literal
 * strings 'pending' and 'in_progress', which hardcodes the very names the firm
 * was promised it could change; the first rename would have switched the rule
 * off silently.
 */
export interface ObligationState {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle. Never compared by any rule here. */
  readonly code: string;
  readonly name: string;
  /** What a newly generated obligation starts in. At most one per firm. */
  readonly isInitial: boolean;
  /** Nothing further happens. */
  readonly isTerminal: boolean;
  /** A partner has to choose what happens next — T3.3's queue. */
  readonly needsDecision: boolean;
  /**
   * Where an obligation lands when the work that discharges it is FINISHED
   * (0054). At most one per firm, enforced by a partial unique index.
   *
   * `isTerminal` alone cannot answer this, because a firm starts with two
   * terminal states and the other one is T3.3's `resolved` — the end of a
   * deadline already missed, which a partner chose. A filing nobody had to
   * decide anything about does not belong there.
   */
  readonly isFiled: boolean;
  /**
   * Where an obligation lands when its statutory date passes undischarged
   * (0055). At most one per firm, enforced by a partial unique index.
   *
   * A DESTINATION, and that is why `needsDecision` could not do this job.
   * `needsDecision` is a description — this state is waiting on a person — and
   * a firm may well end up with two such states, `missed` and later `disputed`.
   * With two, "where does the sweep put an overdue filing" is a coin toss. The
   * same argument 0054 made about `isTerminal`, one flag later.
   */
  readonly isMissed: boolean;
  /**
   * Where an obligation lands when a partner decides it will never be filed
   * (0055). At most one per firm.
   *
   * The mirror of `isFiled`, and it exists for the reason `isFiled` does: a
   * firm has two terminal states, and "terminal and not filed" is a definition
   * by subtraction that stops being true the moment a firm adds a third.
   */
  readonly isResolution: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/** The one state a generated obligation may start in, or null if the firm has
 *  none — which the service refuses to generate without, by name. */
export function initialState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isInitial && s.isActive) ?? null;
}

/**
 * Where a finished filing lands, or null if this firm has nowhere for one to go.
 *
 * The mirror of `initialState`, and it reads a FLAG for the same reason: a firm
 * that renames Filed to "Submitted" must not thereby switch the whole closing
 * mechanism off. Retired states are skipped — a firm that retires its filed
 * state has said it no longer moves work there, and the service says so by name
 * rather than filing into a state nobody uses.
 */
export function filedState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isFiled && s.isActive) ?? null;
}

/**
 * Where an overdue obligation goes, or null if this firm has nowhere to put one.
 *
 * A FLAG, for the reason the whole module reads flags: the demo this was built
 * from found this state with `stateByCode('missed')`, alongside `'pending'` and
 * `'in_progress'` — so a firm renaming Missed to "Late" would have switched the
 * entire sweep off in silence, on the rows that matter most. Retired states are
 * skipped: a firm that retires its missed state has said it no longer sends
 * work there, and the sweep says so by name rather than filing rows into a
 * state nobody looks at.
 */
export function missedState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isMissed && s.isActive) ?? null;
}

/** Where an obligation ends when a partner decides it will never be filed, or
 *  null if the firm has nowhere for one to go. */
export function resolutionState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isResolution && s.isActive) ?? null;
}

/**
 * Whether an obligation in this state can still be MISSED.
 *
 * Derived from the two flags rather than stored as a third, so a firm adding a
 * ninth state does not have to reason about a flag whose meaning is already
 * implied. T3.3 is what acts on it; it lives here because the definition
 * belongs beside the states.
 */
export function canStillBeMissed(state: ObligationState): boolean {
  return !state.isTerminal && !state.needsDecision;
}

export interface StateDefinition {
  readonly code: string;
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly needsDecision: boolean;
  readonly isFiled: boolean;
  readonly isMissed: boolean;
  readonly isResolution: boolean;
  readonly sortOrder: number;
}

/**
 * What a brand-new firm starts with.
 *
 * MUST stay identical to the `@default-obligation-states-seed` literal in the
 * NEWEST migration carrying it (0052, then 0054) —
 * `tests/obligation/seed-parity.test.ts` fails the build if they drift. SQL
 * cannot import TypeScript, so the duplication is unavoidable and the drift is
 * what the test prevents.
 *
 * Five names, carried across the rebuild from a previous vendor's list, and
 * STILL UNCONFIRMED including for 10x itself. `missed` is deliberately not
 * terminal: a missed deadline is a state a partner resolves, not an ending.
 */
export const DEFAULT_OBLIGATION_STATES: readonly StateDefinition[] = [
  { code: "pending", name: "Pending", isInitial: true, isTerminal: false, needsDecision: false, isFiled: false, isMissed: false, isResolution: false, sortOrder: 10 },
  { code: "in_progress", name: "In Progress", isInitial: false, isTerminal: false, needsDecision: false, isFiled: false, isMissed: false, isResolution: false, sortOrder: 20 },
  { code: "filed", name: "Filed", isInitial: false, isTerminal: true, needsDecision: false, isFiled: true, isMissed: false, isResolution: false, sortOrder: 30 },
  { code: "missed", name: "Missed", isInitial: false, isTerminal: false, needsDecision: true, isFiled: false, isMissed: true, isResolution: false, sortOrder: 40 },
  { code: "resolved", name: "Resolved", isInitial: false, isTerminal: true, needsDecision: false, isFiled: false, isMissed: false, isResolution: true, sortOrder: 50 },
];

// ── what a partner may choose about a deadline already missed ──────────────

/**
 * One entry in the firm's own list of answers to "the date passed — now what?"
 *
 * ROWS, and the reason is not the usual one. Renaming matters, but what matters
 * more is that a closed list can be COUNTED: "how many did we accept a late fee
 * on this quarter" is a `GROUP BY` over a column and free text cannot answer it,
 * which is the question a partner actually asks. The reason stays free text
 * beside the option, because no list will ever contain "the client's accountant
 * was on leave and the books arrived on the 19th".
 */
export interface ResolutionOption {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle. Never compared by any rule here. */
  readonly code: string;
  readonly name: string;
  /**
   * WHAT HAPPENS TO THE OBLIGATION, and the only branch this whole feature has.
   *
   * False — "file it provisionally", "accept the late fee", "file a nil return"
   * — the filing still has to happen. The obligation goes back to the firm's
   * initial state and the task is raised again; when that work finishes, 0054's
   * `reconcileFiling` records it filed, late, with `daysLate` on the event.
   * Nothing in this module has to know how that ends.
   *
   * True — "it never applied to this entity" — the filing will never happen and
   * the obligation ends in the firm's resolution state.
   *
   * A COLUMN rather than a branch on `code`, so a firm adding "client
   * deregistered mid-year" says which of the two it means without a deploy.
   */
  readonly closesWithoutFiling: boolean;
  /** Whether the FIRM has confirmed this option belongs on its list. See
   *  `RuleStatus` — same word, same reason, and these four came from the same
   *  previous vendor's document. */
  readonly status: RuleStatus;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface ResolutionOptionDefinition {
  readonly code: string;
  readonly name: string;
  readonly closesWithoutFiling: boolean;
  readonly sortOrder: number;
}

/**
 * What a brand-new firm starts with.
 *
 * MUST stay identical to the `@default-resolution-options-seed` literal in the
 * NEWEST migration carrying it (0055) — `tests/obligation/seed-parity.test.ts`
 * fails the build if they drift.
 *
 * Four options, carried across the rebuild from a previous vendor's app, where
 * they were a hardcoded TypeScript literal in a form component. They match what
 * the firm described its practice to be, and they are STILL UNCONFIRMED as a
 * LIST — described in a conversation is not the same as checked against these
 * four, and the firm's own open-questions file has carried that distinction
 * since before the rebuild.
 *
 * There is deliberately no option meaning "ignore". A passed statutory date is
 * a fork with consequences either way, and a list that let one be dismissed
 * would hide the thing this queue exists to surface.
 */
export const DEFAULT_RESOLUTION_OPTIONS: readonly ResolutionOptionDefinition[] = [
  { code: "provisional_filing", name: "File provisionally", closesWithoutFiling: false, sortOrder: 10 },
  { code: "late_fee", name: "Accept the late fee", closesWithoutFiling: false, sortOrder: 20 },
  { code: "nil_return", name: "Nil return", closesWithoutFiling: false, sortOrder: 30 },
  { code: "not_applicable", name: "Not applicable to this entity", closesWithoutFiling: true, sortOrder: 40 },
];

/**
 * Whether this obligation is one the sweep should be flagging.
 *
 * Every condition the decision queue depends on, in one place so the sweep, the
 * screen and the tests cannot disagree:
 *
 *   · the statutory date has passed — the LAW's date, never the firm's own
 *     internal target. Missing T–X means the firm is behind and the work board
 *     already shows it; missing this one costs the client money.
 *   · nothing was filed. 0054 owns `filedOn`, and un-filing a reopened item is
 *     what lets this sweep correct itself rather than needing a second rule.
 *   · nobody has decided about it yet. An obligation sent BACK to work after a
 *     partner chose "file it late" still has a statutory date in the past
 *     forever, so without this it would be re-flagged every single night.
 *   · the state it is in can still be missed.
 *   · it falls on or after the firm's go-live floor, when the firm has set one.
 *
 * `floor` is null when the firm has published no `compliance_policy`, and null
 * means NO floor rather than "today" — a firm that has not answered has not
 * asked us to hide anything.
 */
export function shouldBeFlaggedMissed(
  o: {
    readonly statutoryDueOn: IsoDate;
    readonly filedOn: IsoDate | null;
    readonly resolvedAt: string | null;
  },
  state: ObligationState,
  today: IsoDate,
  floor: IsoDate | null,
): boolean {
  if (o.statutoryDueOn >= today) return false;
  if (o.filedOn !== null) return false;
  if (o.resolvedAt !== null) return false;
  if (floor !== null && o.statutoryDueOn < floor) return false;
  return canStillBeMissed(state);
}

/**
 * A code is a lowercase handle, 2-40 chars.
 *
 * Duplicated from `domain/workitem/model.ts` rather than imported, and the arch
 * wall requires it: the two domains are siblings and neither may import the
 * other. The same duplication `isIsoDate` already carries, three times over.
 */
export function isValidVocabularyCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(code);
}

export function normalizeVocabularyCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Which single DESTINATION a state is, or null for an ordinary working state.
 *
 * The four destination flags are mutually exclusive — 0055 checks it — so this
 * collapses them to the one answer a screen and a refusal both want. Named here
 * rather than written out at each call site so "what are the destinations" has
 * one definition, and adding a fifth is one edit.
 */
export type StateDestination = "initial" | "filed" | "missed" | "resolution";

export const STATE_DESTINATIONS: readonly StateDestination[] = [
  "initial",
  "filed",
  "missed",
  "resolution",
];

export function destinationOf(flags: {
  readonly isInitial: boolean;
  readonly isFiled: boolean;
  readonly isMissed: boolean;
  readonly isResolution: boolean;
}): StateDestination | null {
  if (flags.isInitial) return "initial";
  if (flags.isFiled) return "filed";
  if (flags.isMissed) return "missed";
  if (flags.isResolution) return "resolution";
  return null;
}

// ── periods ────────────────────────────────────────────────────────────────

export interface Period {
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** What a human reads: "Aug 2026", "Q2 FY2026-27", "FY2026-27". */
  readonly label: string;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function iso(year: number, month1: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days in a month, 1-indexed. `Date.UTC(y, m, 0)` is day zero of the NEXT
 *  month, which is the last day of this one — February without a library. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Month arithmetic in absolute months, so December + 1 crosses the year
 *  without a special case. Returns `[year, month1]`. */
function addMonths(year: number, month1: number, months: number): [number, number] {
  const zero = year * 12 + (month1 - 1) + months;
  return [Math.floor(zero / 12), (zero % 12) + 1];
}

/** Day arithmetic on a date STRING. Goes through epoch milliseconds at UTC
 *  midnight and comes straight back out, so no local zone ever touches it. */
export function addDays(d: IsoDate, days: number): IsoDate {
  const t = Date.parse(`${d}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * The same UTC-midnight trick as `addDays`, and for the same reason: both ends
 * are DAYS, so no zone and no daylight saving may touch the subtraction. Used
 * to say how late a filing was, which is the one number a partner asks about
 * afterwards.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Every period of a recurrence that overlaps a window.
 *
 * `fiscalYearStartMonth` matters more than it looks. India's financial year
 * starts in April, so an Indian QUARTER is Apr–Jun, not Jan–Mar. Computing
 * quarters on the calendar would put every Indian quarterly filing in the wrong
 * period, and the due date that follows would be wrong too — which is the first
 * half of T3.2's acceptance line.
 *
 * Monthly is exempt from the fiscal year: a month is a month in every country,
 * and aligning it to April would produce the same twelve periods with worse
 * arithmetic.
 *
 * Returns nothing for `event`: no period means nothing to enumerate.
 */
export function periodsBetween(
  recurrence: ObligationRecurrence,
  fiscalYearStartMonth: number,
  from: IsoDate,
  to: IsoDate,
): readonly Period[] {
  if (recurrence === "event") return [];
  if (from > to) return [];

  const fromYear = Number(from.slice(0, 4));
  const fromMonth = Number(from.slice(5, 7));
  const out: Period[] = [];

  if (recurrence === "monthly") {
    let [y, m] = [fromYear, fromMonth];
    while (iso(y, m, 1) <= to) {
      out.push({
        start: iso(y, m, 1),
        end: iso(y, m, daysInMonth(y, m)),
        label: `${MONTHS[m - 1]} ${y}`,
      });
      [y, m] = addMonths(y, m, 1);
    }
    return out;
  }

  // Quarters, half-years and years all hang off the fiscal year, so all three
  // start by finding which fiscal period the window's first month falls into
  // and stepping back to that period's own first month.
  const step = MONTHS_PER_PERIOD[recurrence];
  const offsetInYear = (fromMonth - fiscalYearStartMonth + 12) % 12;
  let [y, m] = addMonths(fromYear, fromMonth, -(offsetInYear % step));

  while (iso(y, m, 1) <= to) {
    const [endYear, endMonth] = addMonths(y, m, step - 1);
    const end = iso(endYear, endMonth, daysInMonth(endYear, endMonth));
    // A period that ended before the window began is not in the window — it can
    // only be produced by the step-back above.
    if (end >= from) {
      out.push({ start: iso(y, m, 1), end, label: periodLabel(recurrence, y, m, fiscalYearStartMonth) });
    }
    [y, m] = addMonths(y, m, step);
  }
  return out;
}

/**
 * What the period is called.
 *
 * A calendar year is written "2026". A fiscal year that straddles two of them is
 * written the way the country writes it — "FY2026-27" in India — because a
 * filing labelled "2026" while covering Apr 2026 to Mar 2027 is exactly the
 * ambiguity that gets the wrong period filed.
 */
function periodLabel(
  recurrence: ObligationRecurrence,
  year: number,
  month1: number,
  fiscalYearStartMonth: number,
): string {
  const straddles = fiscalYearStartMonth !== 1;
  const fyStart = month1 >= fiscalYearStartMonth ? year : year - 1;
  const fyName = straddles
    ? `FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`
    : `${fyStart}`;

  if (recurrence === "annual") return fyName;

  const monthsIn = (month1 - fiscalYearStartMonth + 12) % 12;
  if (recurrence === "half_yearly") return `H${Math.floor(monthsIn / 6) + 1} ${fyName}`;
  return `Q${Math.floor(monthsIn / 3) + 1} ${fyName}`;
}

// ── the dates ──────────────────────────────────────────────────────────────

/**
 * Which rule actually governs this period.
 *
 * Matched on the month the PERIOD ends in rather than the month it is due,
 * because the due month is exactly what the exception changes — keying on it
 * would mean asking the answer to find the question.
 *
 * Pure, and separate from `statutoryDueDate`, so that function stays a
 * transform over one rule and does not have to know exceptions exist.
 */
export function effectiveDueRule(
  base: DueRule,
  exceptions: readonly DueRuleException[],
  period: Period,
): DueRule {
  const endsIn = Number(period.end.slice(5, 7));
  return exceptions.find((e) => e.periodEndMonth === endsIn) ?? base;
}

/**
 * When the law wants it, given the period it covers.
 *
 * The day is CLAMPED to the length of the month: a rule reading "the 30th"
 * lands on 28 February rather than rolling silently into March, which is what
 * date arithmetic does if you let it.
 */
export function statutoryDueDate(rule: DueRule, period: Period): IsoDate {
  if (rule.kind === "days_after") {
    return addDays(period.end, rule.dueDaysAfter ?? 0);
  }
  const endYear = Number(period.end.slice(0, 4));
  const endMonth = Number(period.end.slice(5, 7));
  const [y, m] = addMonths(endYear, endMonth, rule.dueMonthOffset ?? 0);
  const day = Math.min(rule.dueDayOfMonth ?? 1, daysInMonth(y, m));
  return iso(y, m, day);
}

/**
 * When the FIRM wants it — T–X.
 *
 * Never after the statutory date, which is the only clamp there is.
 *
 * A TARGET BEFORE THE PERIOD ENDS IS ALLOWED, and that is deliberate rather
 * than an oversight. The obvious-looking second clamp — "you cannot start
 * before the month you are reporting on is over" — is wrong on the firm's own
 * sheet: Advance Tax for Apr–Jun is due 15 JUNE, inside its own quarter,
 * because it is an estimate. Adding that clamp would have silently cancelled
 * the lead time on every such rule. A firm that sets 30 days on a monthly
 * filing has asked to start before month end, and that is its call to make.
 */
export function internalTargetDate(statutoryDue: IsoDate, leadTimeDays: number): IsoDate {
  if (leadTimeDays <= 0) return statutoryDue;
  return addDays(statutoryDue, -leadTimeDays);
}

// ── the generated row ──────────────────────────────────────────────────────

export interface ObligationInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly entityPartyId: string;
  readonly engagementId: string | null;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
  readonly stateId: string;
  readonly workItemId: string | null;
  readonly filedOn: IsoDate | null;
  /** What the partner chose when the statutory date passed unfiled, and why.
   *  All three together or all three null — 0055 checks it in the database
   *  because a decision with no reason is what this feature exists to prevent. */
  readonly resolutionOptionId: string | null;
  readonly resolutionReason: string | null;
  /** An instant, not a day: unlike `filedOn` this is not a claim about a
   *  statutory date, it is when a person clicked. */
  readonly resolvedAt: string | null;
}

/**
 * Everything one rule says about one entity in one period, computed.
 *
 * The single place a template plus a period becomes dates, so the generator,
 * the "what would this rule do" preview on the rules screen, and every test
 * agree by construction rather than by two people writing the same arithmetic.
 */
export function scheduleFor(
  template: ObligationTemplate,
  exceptions: readonly DueRuleException[],
  period: Period,
): { readonly statutoryDueOn: IsoDate; readonly internalTargetOn: IsoDate } | null {
  if (template.dueRule === null) return null;
  const statutoryDueOn = statutoryDueDate(
    effectiveDueRule(template.dueRule, exceptions, period),
    period,
  );
  return {
    statutoryDueOn,
    internalTargetOn: internalTargetDate(statutoryDueOn, template.leadTimeDays),
  };
}
