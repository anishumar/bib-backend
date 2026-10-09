// Obligation domain (T3.2): what the LAW asks of an entity, and when. Pure; stdlib only.
// An obligation is not a task: it is what the entity must file (GSTR-3B for August by
// 20 September); the task (`domain/workitem`) is what the firm does about it. Merged, the
// calendar could only be typed, never generated (0052).
// Every date is a `YYYY-MM-DD` string, never a `Date`: "the 20th" in one zone is the 19th in
// another, a penalty on a statutory deadline (`toISOString()` gives yesterday in India).
// Nothing here reads a clock; the use case passes `today` in, so deadlines test exhaustively.

/** A calendar date, `YYYY-MM-DD`: names a day, not an instant. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

// ── the rule ───────────────────────────────────────────────────────────────

/**
 * How often the work comes round. `half_yearly` is not in the demo: MSME-1 is half-yearly on the
 * firm's sheet, and quarterly would file it four times a year. `event` (FC-GPR, DIR-12) has no
 * period and generates nothing, since nothing here knows the event happened; it exists so the
 * firm can see we know about them.
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

/** Months per period. `event` has none; `periodsBetween` returns nothing for it. */
const MONTHS_PER_PERIOD: Record<Exclude<ObligationRecurrence, "event">, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  annual: 12,
};

/**
 * How the statutory date is computed, as data. `day_of_month`: `dueMonthOffset` months after the
 * period ends, on `dueDayOfMonth` (offset 0 gives Advance Tax: Q1 Apr–Jun due 15 June, before the
 * period ends). `days_after`: `dueDaysAfter` days after it ends. No third kind (see 0052): a
 * conditional rule becomes a column, not a rewrite.
 */
export type DueRuleKind = "day_of_month" | "days_after";

export const DUE_RULE_KINDS: readonly DueRuleKind[] = ["day_of_month", "days_after"];

export function isDueRuleKind(v: string): v is DueRuleKind {
  return (DUE_RULE_KINDS as readonly string[]).includes(v);
}

/** Whose year a rule's quarters, half-years and years are cut on (Q070 Part B, 0358): its own
 *  (`rule_calendar`, every rule before 0358) or the client's FY end (`client_year_end`: UAE
 *  corporate tax, Singapore annual filings). See `period-basis.ts`. */
export type PeriodBasis = "rule_calendar" | "client_year_end" | "authority_assigned";

/** `authority_assigned` (Q073, 0359): the client's own return period for the
 *  rule's module, as the tax authority assigned it (the UAE VAT stagger). */
export const PERIOD_BASES: readonly PeriodBasis[] = ["rule_calendar", "client_year_end", "authority_assigned"];

export function isPeriodBasis(v: string): v is PeriodBasis {
  return (PERIOD_BASES as readonly string[]).includes(v);
}

/** What a row's period followed: the rule's basis, or `rule_fallback` when the rule wanted the
 *  client's year end and none was recorded (the rule's own month was used, and said so). */
export type InstancePeriodBasis = PeriodBasis | "rule_fallback";

/** Whether the FIRM has checked this rule against the statute. Every seed is `unconfirmed`, India
 *  too: the dates came from a previous vendor's document; the firm's practice may be earlier. */
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
  /** Why this period differs, in the firm's words. Mandatory: an unexplained one cannot be reviewed. */
  readonly note: string;
}

export interface ObligationTemplate {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 3166-1 alpha-2. */
  readonly jurisdiction: string;
  /** Null = every entity type, the common case (GST ignores the company's shape). */
  readonly entityType: string | null;
  /**
   * The supersession CHAIN id: the first rule's id, inherited by every successor (0303); set by
   * a trigger on insert, immutable. Catalogue services link to the chain (0309), so a link
   * survives supersession. Which services owe the filing is NOT on the rule: a nullable "NULL =
   * every service" column sent 98 GST filings to a bookkeeping-only client on 2026-09-18. Links
   * live in `delivery.obligation_rule_service`, written only from the catalogue.
   */
  readonly lineageId: string;
  /** The statute's grouping ("GST", "TDS", "MCA"), NOT `ServiceBody.module` (revenue axis). */
  readonly module: string | null;
  readonly name: string;
  readonly authority: string | null;
  readonly recurrence: ObligationRecurrence;
  /** 4 for India, 1 for a calendar year. On the rule because an Indian quarter is Apr–Jun. */
  readonly fiscalYearStartMonth: number;
  /** Whose year the periods are cut on (0358). Part of the period SHAPE with
   *  `recurrence` and `fiscalYearStartMonth`: locked once rows exist. */
  readonly periodBasis: PeriodBasis;
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
  /** First period START this rule governs; null = from the beginning. Half-open with
   *  `effectiveTo`, tested on period start: August's return is August's law, due 20 September. */
  readonly effectiveFrom: IsoDate | null;
  /** First period start this rule does NOT govern (its successor's); null = forever. */
  readonly effectiveTo: IsoDate | null;
}

// ── what a rule is actually doing, and why ─────────────────────────────────

/**
 * Whether a rule can produce dates and, if not, why. Derived, not stored, so a firm missing
 * GSTR-9C on its calendar is told which rule lacks what instead of suspecting a bug.
 *   `generating`     produces dates.
 *   `needs_formula`  real, but its timing cannot be derived (~40 of the firm's 55; reason on the
 *                    row). Not a bug and never shown as one.
 *   `event_driven`   no period; nothing here knows the event happened.
 *   `retired`        the firm moved on; past instances still read.
 *   `unlinked`       no catalogue service carries it (T6.16, 0309): generates nothing, since a
 *                    rule reaches a client only through a service it bought. Checked before
 *                    `unconfirmed`: linking it in the catalogue confirms it in the same act.
 *   `unconfirmed`    a pack-seeded formula the firm has not checked: generates nothing
 *                    (2026-09-18: a shipped rule naming no service reached every engagement in
 *                    its country, and a client's portal called filings it excluded "missed").
 * The link count is a parameter, not a field, so a caller cannot answer "reaches somebody"
 * without reading the links. One engagement: `generatesFor`.
 */
export type RuleCoverage =
  | "generating"
  | "needs_formula"
  | "event_driven"
  | "unlinked"
  | "unconfirmed"
  | "retired";

export function coverageOf(t: ObligationTemplate, linkedServices: number): RuleCoverage {
  if (!t.isActive) return "retired";
  if (t.dueRule === null) return "needs_formula";
  if (t.recurrence === "event") return "event_driven";
  // DECISION 1 (T6.16): no linked service, no dates. A NULL "every service" reading made a
  // filing a claim about every client.
  if (linkedServices <= 0) return "unlinked";
  // Confirmation gates generation (since 2026-09-17): a rule the firm writes is created
  // confirmed; a pack-seeded one stays off the calendar until a partner confirms it.
  if (t.status !== "confirmed") return "unconfirmed";
  return "generating";
}

/** The generator's own filter, named once so the screen and the sweep agree. */
export function generatesDates(t: ObligationTemplate, linkedServices: number): boolean {
  return coverageOf(t, linkedServices) === "generating";
}

/** A live link between a rule's CHAIN and one catalogue service (0309). */
export interface RuleServiceLink {
  readonly lineageId: string;
  readonly serviceEntryId: string;
}

/**
 * The generation predicate for one engagement, stated for readers; production does not call it.
 * True when `generatesDates` AND a live link on the chain names this engagement's service
 * (jurisdiction, entity type and window are `governsPeriod`'s half). The generator joins links
 * in SQL (`subjectsFor`, `gaps`, `listGenerating`, `obligation-coverage.ts`); the live guards are
 * `coverage.integration.test.ts`, `service-filings.integration.test.ts` and `service.test.ts`,
 * not this function's tests. A null `serviceEntryId` reaches nothing: the safe direction.
 */
export function generatesFor(
  t: ObligationTemplate,
  links: readonly RuleServiceLink[],
  serviceEntryId: string | null,
): boolean {
  const mine = links.filter((l) => l.lineageId === t.lineageId);
  if (!generatesDates(t, mine.length)) return false;
  return serviceEntryId !== null && mine.some((l) => l.serviceEntryId === serviceEntryId);
}

/**
 * Whether this rule governs a period beginning on `periodStart`. Half-open: `effectiveTo` is the
 * first day NOT in force, so a rule and its successor never share a period (inclusive gives two
 * filings under two template ids the re-run key cannot dedupe; the demo did this with SPOCs).
 * Tested on period START, not due date: a 1 September change must not restate August's return
 * (due 20 September); testing the due date shifts every date one period, plausibly.
 */
export function governsPeriod(t: ObligationTemplate, periodStart: IsoDate): boolean {
  if (t.effectiveFrom !== null && periodStart < t.effectiveFrom) return false;
  if (t.effectiveTo !== null && periodStart >= t.effectiveTo) return false;
  return true;
}

/** A chain read on one day: the row governing that day's period, the row
 *  that takes over next, and the first period that row governs. Either row
 *  may be null; `nextFirstPeriod` is set exactly when `next` is. */
export interface ChainOnDay<T extends ObligationTemplate> {
  readonly governing: T | null;
  readonly next: T | null;
  readonly nextFirstPeriod: IsoDate | null;
}

/**
 * Start of the first period a row governs, or null if its window holds none (T6.16 review,
 * 2026-09-26). `effectiveFrom` is not when a row takes over: a quarterly rule cut over 1 August
 * first governs October's quarter; an annual one cut over 1 January waits for April's FY.
 * Periods start within a year of any day, so a year and a day is enough to search. An event
 * rule's "period" is the day, as in `chainOnDay`.
 */
export function firstPeriodGoverned(t: ObligationTemplate): IsoDate | null {
  if (t.effectiveFrom === null) return null;
  if (t.recurrence === "event") return governsPeriod(t, t.effectiveFrom) ? t.effectiveFrom : null;
  const periods = periodsBetween(
    t.recurrence,
    t.fiscalYearStartMonth,
    t.effectiveFrom,
    addDays(t.effectiveFrom, 366),
  );
  return periods.find((p) => governsPeriod(t, p.start))?.start ?? null;
}

/**
 * Which row of a chain governs the period containing `day`, and which takes over next (T6.16
 * follow-up, 2026-09-26). Not the open-ended row: after "from April 2027, the 22nd", showing the
 * successor told the firm September was due the 22nd. Uses only `periodsBetween` +
 * `governsPeriod` with each row's own recurrence; an event rule's period is the day.
 * `governing` is null when no window covers the day. `next` is the row whose first governed
 * period (`firstPeriodGoverned`) comes soonest after the day's period starts; picking by cutover
 * named windows holding no period. Retired rows read like any other (hiding one makes its
 * predecessor look endless); `coverageOf` says what each does.
 */
export function chainOnDay<T extends ObligationTemplate>(
  chain: readonly T[],
  day: IsoDate,
): ChainOnDay<T> {
  const periodStart = (t: T): IsoDate =>
    periodsBetween(t.recurrence, t.fiscalYearStartMonth, day, day)[0]?.start ?? day;
  // Oldest window first, so two rows claiming one period (0057 forbids it) resolve to the later.
  const ordered = [...chain].sort((a, b) =>
    (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? "") || a.id.localeCompare(b.id),
  );
  const governing = ordered.filter((t) => governsPeriod(t, periodStart(t))).at(-1) ?? null;
  let next: T | null = null;
  let nextFirstPeriod: IsoDate | null = null;
  for (const t of ordered) {
    if (t.effectiveFrom === null || t.effectiveFrom <= periodStart(t)) continue;
    const first = firstPeriodGoverned(t);
    if (first === null) continue;
    // `<=`, so a tie goes to the later window, as `governing` does.
    if (nextFirstPeriod === null || first <= nextFirstPeriod) {
      next = t;
      nextFirstPeriod = first;
    }
  }
  return { governing, next, nextFirstPeriod };
}

// ── the state an obligation is in ──────────────────────────────────────────

/** The firm's vocabulary for where an obligation has got to. Rows (0050), and no rule compares
 *  `code`: the demo matched 'pending'/'in_progress' literally, so a rename disabled it. */
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
  /** Where finished work's obligation lands (0054); at most one per firm (partial unique index).
   *  Not `isTerminal`: the other terminal state is T3.3's `resolved`, a partner's choice. */
  readonly isFiled: boolean;
  /** Where an obligation lands when its statutory date passes unfiled (0055); at most one per
   *  firm. A destination, unlike `needsDecision` (a description several states may share). */
  readonly isMissed: boolean;
  /** Where it ends when a partner decides it will never be filed (0055); at most one per firm.
   *  Mirror of `isFiled`: "terminal and not filed" breaks once a third terminal state exists. */
  readonly isResolution: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/** The one state a generated obligation may start in, or null if the firm has
 *  none — which the service refuses to generate without, by name. */
export function initialState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isInitial && s.isActive) ?? null;
}

/** Where a finished filing lands, or null. A FLAG so renaming Filed cannot switch closing off;
 *  retired states are skipped and the service refuses by name. */
export function filedState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isFiled && s.isActive) ?? null;
}

/** Where an overdue obligation goes, or null. A flag: the demo used `stateByCode('missed')`, so
 *  renaming Missed to "Late" silently stopped the sweep. Retired states are skipped. */
export function missedState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isMissed && s.isActive) ?? null;
}

/** Where an obligation ends when a partner decides it will never be filed, or
 *  null if the firm has nowhere for one to go. */
export function resolutionState(states: readonly ObligationState[]): ObligationState | null {
  return states.find((s) => s.isResolution && s.isActive) ?? null;
}

/** Whether a state can still be MISSED (acted on by T3.3); derived from the two flags. */
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
 * What a new firm starts with. MUST match the `@default-obligation-states-seed` literal in the
 * newest migration carrying it (0052, then 0054); `tests/obligation/seed-parity.test.ts` checks.
 * Five names from a previous vendor, STILL UNCONFIRMED, 10x included. `missed` is not terminal:
 * a partner resolves it.
 */
export const DEFAULT_OBLIGATION_STATES: readonly StateDefinition[] = [
  { code: "pending", name: "Pending", isInitial: true, isTerminal: false, needsDecision: false, isFiled: false, isMissed: false, isResolution: false, sortOrder: 10 },
  { code: "in_progress", name: "In Progress", isInitial: false, isTerminal: false, needsDecision: false, isFiled: false, isMissed: false, isResolution: false, sortOrder: 20 },
  { code: "filed", name: "Filed", isInitial: false, isTerminal: true, needsDecision: false, isFiled: true, isMissed: false, isResolution: false, sortOrder: 30 },
  { code: "missed", name: "Missed", isInitial: false, isTerminal: false, needsDecision: true, isFiled: false, isMissed: true, isResolution: false, sortOrder: 40 },
  { code: "resolved", name: "Resolved", isInitial: false, isTerminal: true, needsDecision: false, isFiled: false, isMissed: false, isResolution: true, sortOrder: 50 },
];

// ── what a partner may choose about a deadline already missed ──────────────

/** One of the firm's answers to "the date passed, now what?". Rows so they can be COUNTED ("late
 *  fees accepted this quarter" is a GROUP BY); the reason stays free text beside it. */
export interface ResolutionOption {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle. Never compared by any rule here. */
  readonly code: string;
  readonly name: string;
  /**
   * The only branch this feature has. False (file provisionally, late fee, nil return): back to
   * the initial state and the task is raised again; 0054's `reconcileFiling` then records it
   * filed late with `daysLate`. True (never applied): ends in the firm's resolution state.
   * A column, not a branch on `code`, so a new option says which it means without a deploy.
   */
  readonly closesWithoutFiling: boolean;
  /** Whether the firm confirmed this option; see `RuleStatus` (same previous-vendor source). */
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
 * What a new firm starts with. MUST match `@default-resolution-options-seed` in the newest
 * migration carrying it (0055); `tests/obligation/seed-parity.test.ts` checks. From a previous
 * vendor's form literal; they match the firm's described practice but are STILL UNCONFIRMED as a
 * list. No "ignore" option on purpose: a passed statutory date has consequences either way.
 */
export const DEFAULT_RESOLUTION_OPTIONS: readonly ResolutionOptionDefinition[] = [
  { code: "provisional_filing", name: "File provisionally", closesWithoutFiling: false, sortOrder: 10 },
  { code: "late_fee", name: "Accept the late fee", closesWithoutFiling: false, sortOrder: 20 },
  { code: "nil_return", name: "Nil return", closesWithoutFiling: false, sortOrder: 30 },
  { code: "not_applicable", name: "Not applicable to this entity", closesWithoutFiling: true, sortOrder: 40 },
];

/**
 * Whether the sweep should flag this missed; one place so sweep, screen and tests agree. All of:
 * the STATUTORY date passed (never the T–X target); not filed (0054's `filedOn`; un-filing a
 * reopened item lets the sweep self-correct); not yet decided (a row sent back after "file it
 * late" would re-flag nightly); its state can still be missed; on or after the go-live `floor`.
 * A null floor (no `compliance_policy`) means no floor, not "today".
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

/** A lowercase handle, 2-40 chars. Duplicated from `domain/workitem/model.ts`: sibling domains
 *  may not import each other. */
export function isValidVocabularyCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(code);
}

export function normalizeVocabularyCode(code: string): string {
  return code.trim().toLowerCase();
}

/** Which single destination a state is, or null for a working state. The four flags are mutually
 *  exclusive (0055 checks), so this is the one definition of "the destinations". */
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

/** Days in a month, 1-indexed: `Date.UTC(y, m, 0)` is the last day of month m. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Absolute-month arithmetic, so December + 1 crosses the year. Returns `[year, month1]`. */
function addMonths(year: number, month1: number, months: number): [number, number] {
  const zero = year * 12 + (month1 - 1) + months;
  return [Math.floor(zero / 12), (zero % 12) + 1];
}

/** Day arithmetic through UTC-midnight epoch ms, so no local zone touches it. */
export function addDays(d: IsoDate, days: number): IsoDate {
  const t = Date.parse(`${d}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if earlier), at UTC midnight like `addDays`. Used
 *  for how late a filing was. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Every period of a recurrence overlapping a window; none for `event`. Quarters, halves and years
 * align to `fiscalYearStartMonth` (an Indian quarter is Apr–Jun; calendar quarters would misdate
 * every Indian quarterly filing, T3.2's acceptance line). Monthly ignores the fiscal year.
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

  // Step back to the first month of the fiscal period holding the window's first month.
  const step = MONTHS_PER_PERIOD[recurrence];
  const offsetInYear = (fromMonth - fiscalYearStartMonth + 12) % 12;
  let [y, m] = addMonths(fromYear, fromMonth, -(offsetInYear % step));

  while (iso(y, m, 1) <= to) {
    const [endYear, endMonth] = addMonths(y, m, step - 1);
    const end = iso(endYear, endMonth, daysInMonth(endYear, endMonth));
    // Only the step-back above can produce a period ending before the window.
    if (end >= from) {
      out.push({ start: iso(y, m, 1), end, label: periodLabel(recurrence, y, m, fiscalYearStartMonth) });
    }
    [y, m] = addMonths(y, m, step);
  }
  return out;
}

/** "2026" for a calendar year; "FY2026-27" for a straddling fiscal year, because "2026" for
 *  Apr 2026–Mar 2027 is how the wrong period gets filed. */
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

/** Which rule governs this period: matched on the month the PERIOD ends, not the due month (the
 *  thing an exception changes). Separate so `statutoryDueDate` knows only one rule. */
export function effectiveDueRule(
  base: DueRule,
  exceptions: readonly DueRuleException[],
  period: Period,
): DueRule {
  const endsIn = Number(period.end.slice(5, 7));
  return exceptions.find((e) => e.periodEndMonth === endsIn) ?? base;
}

/** When the law wants it. The day clamps to month length: "the 30th" is 28 February, not March. */
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
 * When the FIRM wants it (T–X): never after the statutory date, the only clamp. A target before
 * the period ends is deliberate: Advance Tax for Apr–Jun is due 15 June, inside its quarter, so
 * a "not before period end" clamp would cancel its lead time.
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
  /** The task whose completion filed this row (Q063, 0357): its own or its period job's.
   *  Reopening a task un-files only the rows naming it. Null while unfiled. */
  readonly filedByWorkItemId: string | null;
  /** The partner's choice when the date passed unfiled, and why: all three or none (0055). */
  readonly resolutionOptionId: string | null;
  readonly resolutionReason: string | null;
  /** An instant (when a person clicked), not a statutory day. */
  readonly resolvedAt: string | null;
  /** Taken off the calendar because its service stopped including it and nothing else covers it
   *  (T6.16, 0309). Marked, never deleted. Every reader that shows, raises, misses, nudges or
   *  escalates skips withdrawn rows; `findById` does not, so a restore can see it. */
  readonly withdrawnAt: string | null;
  readonly withdrawnByUserId: string | null;
  readonly withdrawnReason: WithdrawnReason | null;
  /** What this row's period followed (0358): the rule's year, the client's
   *  year end, or the rule's month because the client had none recorded. */
  readonly periodBasis: InstancePeriodBasis;
}

/** Why a filing was withdrawn, a closed set: its service dropped it (0309) or its engagement
 *  ended before the period began (0314). */
export type WithdrawnReason = "service_unlinked" | "engagement_ended";

/**
 * Whether removing a rule from a service may withdraw this filing (T6.16, decision 2): no task,
 * not filed, not decided (the 0303 handover columns); statutory date on or after the FIRM's today
 * (`dayInZone`), since a passed date may be a miss a partner must see; and, by state FLAGS, not
 * waiting on a decision or settled. Whether another linked service still covers it is the
 * adapter's half, in the removal's transaction.
 */
export function mayBeWithdrawn(
  row: Pick<ObligationInstance, "workItemId" | "filedOn" | "resolvedAt" | "statutoryDueOn" | "withdrawnAt">,
  state: Pick<ObligationState, "isTerminal" | "needsDecision">,
  firmToday: IsoDate,
): boolean {
  return (
    row.withdrawnAt === null &&
    row.workItemId === null &&
    row.filedOn === null &&
    row.resolvedAt === null &&
    row.statutoryDueOn >= firmToday &&
    !state.isTerminal &&
    !state.needsDecision
  );
}

/** One rule, one entity, one period, to dates. The single place, so the generator, the rules
 *  screen preview and the tests agree by construction. */
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
