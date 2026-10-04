// The billing domain (auto-invoice, phase 1) — which periods of a recurring
// engagement are due to be billed, how much of each the firm served, and whose
// kitty the bill goes in. Pure rules over ISO date strings; imports nothing
// internal and nothing beyond the standard library (enforced by the arch test).
//
// ── A BILL DUE IS NOT AN INVOICE ───────────────────────────────────────────
//
// An invoice draws its number from the gapless GST series the moment its DRAFT
// is created (0027). A sweep that drafted invoices would leave a cancelled
// number in the series every time a manager decided not to bill, and an
// auditor reads a cancelled number as a question. So the sweep writes a DUE —
// "this client owes a bill for this service for this period" — and a person
// turns dues into an invoice. Nothing here knows an invoice exists.
//
// ── THE FIRM'S RULES, NOT OURS (Ashish, 2026-10-01) ────────────────────────
//
//   - A schedule is a FIRST INVOICE DATE plus the letter's billing frequency.
//     Arrears (October's work billed on 1 November), advance (billed on
//     1 October) and a yearly audit billed in October are the same rule with a
//     different first date. Nothing is billed before it, which is what makes it
//     each client's go-live: the firm has no single go-live day.
//   - A period cut short by the start, an end or a pause is billed PRO-RATA BY
//     DAYS. This file counts the days; the database does the money, because
//     money is never arithmetic in TypeScript here.
//   - Revenue belongs to the MANAGER the client's SPOC for that service reports
//     to. "Every SPOC has a manager above him."
//
// The periods themselves come from `domain/scheduler`'s `periodsFrom`, called by
// the use case: a domain module never imports another, so the shape is stated
// structurally here.

/** One billing period, as `periodsFrom` produces it. Both ends inclusive. */
export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

/**
 * The days the firm served an engagement: from its first day to its last
 * (inclusive, null = still running), less the last pause (from the day it began
 * up to, not including, the day it resumed; null = not resumed yet).
 */
export interface ServiceWindow {
  readonly from: string;
  readonly to: string | null;
  readonly pausedFrom: string | null;
  readonly pausedTo: string | null;
}

/** One period whose bill has fallen due. */
export interface BillingDuePlan {
  readonly period: BillingPeriod;
  readonly billOn: string;
  /** Days of the period inside the service window. Always at least 1. */
  readonly servedDays: number;
  readonly periodDays: number;
}

/**
 * A date moved by whole months, its day clamped to the length of the month it
 * lands in: 31 January plus one month is the last day of February, never
 * 3 March. A bill date must stay in the month the schedule says.
 */
export function addMonthsClamped(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return iso(y, m, Math.min(day, daysInMonth(y, m)));
}

// ── The schedule an engagement starts with (0319) ─────────────────────────

/**
 * When a recurring fee is invoiced, as the engagement letter says it (0319):
 * after each period (the firm's default), at its start, or on a date the firm
 * chose for the first one. A letter that says nothing is `null`, billed as
 * arrears.
 */
export type BillingTiming = "arrears" | "advance" | "on_date";

export const BILLING_TIMINGS: readonly BillingTiming[] = ["arrears", "advance", "on_date"];

/**
 * The day the first billed period must CONTAIN: the later of the engagement's
 * first day and the day billing went live for it (signed, or its advance
 * recorded). A letter backdated to July and signed in October was billed by hand
 * until October, so October is the first period the system bills; billing from
 * July would send the client a second bill for three months.
 */
export function goesLiveFrom(effectiveFrom: string, liveOn: string): string {
  return later(effectiveFrom, liveOn);
}

/**
 * The schedule for an engagement going live, from the first period billed (the
 * one containing `goesLiveFrom`) and the letter's timing. Arrears bills it the
 * day after it ends, advance on its first day, `on_date` on the letter's date;
 * every later period follows one span after (`billingDues`).
 *
 * AN `on_date` BEFORE THE FIRST PERIOD moves forward by whole spans until it is
 * not (0321). A letter drafted in July saying "first invoice 5 August", signed
 * in October, starts billing in October: 5 August as the first invoice date put
 * October's bill on 5 August, November's on 5 September and December's on
 * 5 October, so one sweep billed three months, one of them not yet begun. The
 * day of the month the letter chose is kept (the 5th).
 */
export function scheduleFor(
  period: BillingPeriod,
  timing: BillingTiming | null,
  billingOn: string | null,
): { readonly billingFrom: string; readonly firstInvoiceOn: string } {
  const firstInvoiceOn =
    timing === "advance"
      ? period.start
      : timing === "on_date" && billingOn !== null
        ? notBeforeStart(billingOn, period)
        : dayAfter(period.end);
  return { billingFrom: period.start, firstInvoiceOn };
}

/** The months one period spans (1, 3 or 12): its first day to the day after it. */
function spanMonths(period: BillingPeriod): number {
  const [y1 = 0, m1 = 1] = period.start.split("-").map(Number);
  const [y2 = 0, m2 = 1] = dayAfter(period.end).split("-").map(Number);
  return Math.max(1, y2 * 12 + m2 - (y1 * 12 + m1));
}

/** `day`, moved on by whole spans of `period` until it is not before it starts.
 *  Each step is counted from `day` itself, so a 31st clamped to a short month
 *  is not carried into the next one. */
function notBeforeStart(day: string, period: BillingPeriod): string {
  const span = spanMonths(period);
  let moved = day;
  for (let k = 1; moved < period.start; k += 1) moved = addMonthsClamped(day, k * span);
  return moved;
}

/**
 * The service window of one engagement, from the facts on its row (0314, 0318).
 *
 * The pause is the LAST one (`pausedOn`, kept after a resume). It is closed by
 * the resume only when that resume came after it; while paused, or when an
 * engagement was ended while paused, it runs on — an earlier resume says
 * nothing about a later pause.
 */
export function serviceWindowOf(e: {
  readonly status: string;
  readonly effectiveFrom: string;
  readonly endsOn: string | null;
  readonly pausedOn: string | null;
  readonly resumedOn: string | null;
}): ServiceWindow {
  const pausedTo =
    e.pausedOn !== null && e.status !== "paused" && e.resumedOn !== null && e.resumedOn >= e.pausedOn
      ? e.resumedOn
      : null;
  return { from: e.effectiveFrom, to: e.endsOn, pausedFrom: e.pausedOn, pausedTo };
}

/** How many days of `period` fall inside the service window. */
export function servedDays(period: BillingPeriod, window: ServiceWindow): number {
  const from = later(period.start, window.from);
  const to = window.to === null ? period.end : earlier(period.end, window.to);
  if (from > to) return 0;
  let days = dayCount(from, to);
  if (window.pausedFrom !== null) {
    // The pause covers [pausedFrom, pausedTo), so its last day is the one
    // before the resume; a pause not yet over runs past any period.
    const pauseFrom = later(from, window.pausedFrom);
    const pauseTo = window.pausedTo === null ? to : earlier(to, addDays(window.pausedTo, -1));
    if (pauseFrom <= pauseTo) days -= dayCount(pauseFrom, pauseTo);
  }
  return days;
}

/**
 * The periods whose bill has fallen due by `today`: period k (0-based) is
 * billed on `firstInvoiceOn` plus k spans, and a period nothing was served in
 * is never billed. `periods` is consecutive, starting with the one containing
 * the first day served.
 *
 * `windows` is one per engagement the bill covers: one for a service priced on
 * its own, several for a fee group (0083), whose ONE fee was earned by the
 * period as long as any of its services ran — so a group's days served are the
 * most any one of them was served, never a sum.
 */
export function billingDues(input: {
  readonly periods: readonly BillingPeriod[];
  readonly spanMonths: number;
  readonly firstInvoiceOn: string;
  readonly today: string;
  readonly windows: readonly ServiceWindow[];
}): readonly BillingDuePlan[] {
  const dues: BillingDuePlan[] = [];
  input.periods.forEach((period, k) => {
    // A period that has not begun is never billed, whatever the schedule says
    // (0321): there is nothing served in it yet to bill.
    if (period.start > input.today) return;
    const billOn = addMonthsClamped(input.firstInvoiceOn, k * input.spanMonths);
    if (billOn > input.today) return;
    const served = Math.max(0, ...input.windows.map((w) => servedDays(period, w)));
    if (served === 0) return;
    dues.push({ period, billOn, servedDays: served, periodDays: dayCount(period.start, period.end) });
  });
  return dues;
}

// ── Whose kitty ─────────────────────────────────────────────────────────────

/** A SPOC for the bill's Dept, with the person they report to (active staff
 *  only; null when nobody is recorded or that person has left). */
export interface SpocWithManager {
  readonly userId: string;
  readonly managerUserId: string | null;
  readonly managerName: string | null;
}

export type ManagerHow = "spoc_manager" | "key_manager" | "none";

export interface BillingManager {
  readonly userId: string | null;
  readonly how: ManagerHow;
  /** Why the bill is not with the SPOC's manager, for the person who has it.
   *  Null when it is. */
  readonly note: string | null;
}

/**
 * The manager whose kitty a bill goes in.
 *
 * The SPOC's manager when there is exactly ONE answer: one Dept, at least one
 * SPOC for it, and every SPOC reporting to the same person. Anything else is a
 * question this rule must not guess, so the bill goes to the client's Key
 * Manager to hand out, with a sentence saying what is missing — the owner
 * rule's arrangement (0311), and for its reason: a wrong kitty is worse than a
 * bill somebody is told to place.
 */
export function resolveBillingManager(input: {
  readonly deptCodes: readonly string[];
  readonly spocs: readonly SpocWithManager[];
  readonly keyManager: { readonly userId: string; readonly displayName: string | null } | null;
}): BillingManager {
  const why = whyNotSpocManager(input.deptCodes, input.spocs);
  if (why === null) {
    const managerUserId = input.spocs[0]?.managerUserId ?? null;
    if (managerUserId !== null) return { userId: managerUserId, how: "spoc_manager", note: null };
  }
  const reason = why ?? "The SPOC reports to nobody.";
  if (input.keyManager !== null) {
    return {
      userId: input.keyManager.userId,
      how: "key_manager",
      note: `${reason} Came to the Key Manager to place.`,
    };
  }
  return { userId: null, how: "none", note: `${reason} The client has no Key Manager either.` };
}

function whyNotSpocManager(
  deptCodes: readonly string[],
  spocs: readonly SpocWithManager[],
): string | null {
  const depts = [...new Set(deptCodes)];
  if (depts.length === 0) return "The service is filed under no Dept.";
  if (depts.length > 1) return `This fee covers services of several Depts (${depts.join(", ")}).`;
  if (spocs.length === 0) return `The client has no SPOC for ${depts[0]}.`;
  if (spocs.some((s) => s.managerUserId === null)) {
    return "A SPOC for this Dept reports to nobody (set who they report to on the team page).";
  }
  const managers = new Map(spocs.map((s) => [s.managerUserId, s.managerName ?? "a colleague"]));
  if (managers.size > 1) {
    return `The SPOCs for ${depts[0]} report to different managers (${[...managers.values()].join(", ")}).`;
  }
  return null;
}

// ── Day arithmetic: strings in, strings out ────────────────────────────────

function dayCount(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000) + 1;
}

function addDays(date: string, days: number): string {
  const shifted = new Date(utc(date) + days * 86_400_000);
  return iso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function utc(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** The calendar day after `date`, across month and year ends. */
function dayAfter(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  if (day < daysInMonth(year, month)) return iso(year, month, day + 1);
  return month === 12 ? iso(year + 1, 1, 1) : iso(year, month + 1, 1);
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** "3 October 2026" from an ISO day, on the string. */
function dayWords(iso: string): string {
  const [y = "", m = "", d = ""] = iso.split("-");
  return `${String(Number(d))} ${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

/**
 * What a person must be told when "Bill from" is earlier than the day the work
 * started (audit 2026-10-03, CA#35). A period is billed only for the days the
 * work ran (pro-rata by days, Ashish), so the months before the start get no
 * bill however early "Bill from" is set. That rule is not changed here (whether
 * a firm bills the months before it took a client over is the firm's question);
 * it is SAID, where the schedule is set. Null when there is nothing to say.
 */
export function scheduleNotice(billingFrom: string, workStartedOn: string): string | null {
  if (billingFrom >= workStartedOn) return null;
  return (
    `This work started on ${dayWords(workStartedOn)}, and a period is billed only for the days the work ran. ` +
    `So nothing before ${dayWords(workStartedOn)} is billed, even though billing is set from ${dayWords(billingFrom)}.`
  );
}
