// The advance and the final bill (auto-invoice, phase 2, 0320) — pure rules over
// decimal strings and ISO days. Imports only the money domain, for exact
// arithmetic on the digits.
//
// ── THE FIRM'S RULES (Ashish and the user, 2026-10-01 and 10-02) ──────────
//
//   - EVERY ADVANCE IS A GST TAX INVOICE. One for the whole letter, or one per
//     service; a letter has one or the other, never both. The amount the letter
//     states is BEFORE tax: the invoice adds the GST.
//   - THE ADVANCE DOES NOT HOLD THE WORK (Ashish, 2026-10-02, replacing the
//     "paid in full starts the work" gate of 0320): "practically we are not and
//     don't want to be so strict about the advance receipt, generally it comes
//     within 5 to 15 days of starting of work". Signing starts the work and
//     drafts the advance invoice; the SPOC, the Key Manager and the partner are
//     reminded while it is a draft or unpaid, and the admins once a week.
//   - A ONE-TIME SERVICE IS BILLED WHEN ITS JOB IS DONE, for the BALANCE after
//     the advance. A letter-wide advance comes off the letter's EARLIEST bills
//     first, monthly ones included (FIFO), before tax.
//   - AN ADVANCE LEFT OVER, once the work it covered is finished, is given back
//     by a credit note; a client who leaves early is the same case.
import { compareAmounts, subtractAmounts, type Amount } from "../money/model";

export type BillKind = "period" | "advance" | "final";

export const BILL_KINDS: readonly BillKind[] = ["period", "advance", "final"];

// ── Which advance bills a signed letter owes ───────────────────────────────

export interface AdvanceTerms {
  readonly advanceRequired: boolean;
  readonly advanceAmount: Amount | null;
  /** One per engagement the letter created, with its line's own advance and
   *  the Dept its work is filed under. */
  readonly lines: readonly {
    readonly engagementId: string;
    readonly advanceAmount: Amount | null;
    readonly deptCode: string | null;
  }[];
}

export interface PlannedAdvance {
  /** Null for the letter's own advance, which covers every service. */
  readonly engagementId: string | null;
  readonly amount: Amount;
  /** The Depts of the work it covers: whose kitty the bill goes in. */
  readonly deptCodes: readonly string[];
}

/**
 * The advance bills a letter owes once it is signed: the letter's one, or one
 * per service that has its own. The database refuses a letter with both; if one
 * ever appeared, the letter's gate is what holds every engagement, so its
 * advance is the one billed.
 */
export function advancesOwed(terms: AdvanceTerms): readonly PlannedAdvance[] {
  if (terms.advanceRequired) {
    if (terms.advanceAmount === null) return [];
    const depts = [...new Set(terms.lines.flatMap((l) => (l.deptCode === null ? [] : [l.deptCode])))].sort();
    return [{ engagementId: null, amount: terms.advanceAmount, deptCodes: depts }];
  }
  return terms.lines.flatMap((l) =>
    l.advanceAmount === null
      ? []
      : [{ engagementId: l.engagementId, amount: l.advanceAmount, deptCodes: l.deptCode === null ? [] : [l.deptCode] }],
  );
}

// ── FIFO: taking a bill off the advance ────────────────────────────────────

/**
 * One bill taken off what is left of an advance: all of it when the advance
 * covers it, else what is left. Before tax on both sides, exact on the digits.
 */
export function takeFromAdvance(
  remaining: Amount,
  bill: Amount,
): { readonly applied: Amount; readonly balance: Amount; readonly remaining: Amount } {
  if (compareAmounts(remaining, "0") <= 0) return { applied: "0", balance: bill, remaining };
  const applied = compareAmounts(remaining, bill) >= 0 ? bill : remaining;
  return { applied, balance: subtractAmounts(bill, applied), remaining: subtractAmounts(remaining, applied) };
}

// ── Where an advance stands ────────────────────────────────────────────────

/** `not_raised`: no invoice yet (no tax rate to draft it with, or its draft
 *  was cancelled). `on_draft`: drafted, waiting for an admin to issue it.
 *  `unpaid` / `part_paid`: issued, money still owed. `paid`: settled. */
export type AdvanceStage = "not_raised" | "on_draft" | "unpaid" | "part_paid" | "paid";

export const ADVANCE_STAGES: readonly AdvanceStage[] = ["not_raised", "on_draft", "unpaid", "part_paid", "paid"];

/**
 * Where an advance stands, from its invoice and the money on it. Nothing waits
 * on it any more (0322): this is what the reminders and the Advances list read.
 *
 * PAID means money arrived and nothing is left owed (0321). An invoice a credit
 * note took to zero with nothing paid is NOT paid: the credit note cancelled
 * the demand.
 */
export function advanceStage(input: {
  readonly invoiceStatus: "draft" | "issued" | "cancelled" | null;
  readonly paid: Amount | null;
  readonly outstanding: Amount | null;
}): AdvanceStage {
  if (input.invoiceStatus === null || input.invoiceStatus === "cancelled") return "not_raised";
  if (input.invoiceStatus === "draft") return "on_draft";
  const somethingPaid = compareAmounts(input.paid ?? "0", "0") > 0;
  if (compareAmounts(input.outstanding ?? "0", "0") <= 0 && somethingPaid) return "paid";
  return somethingPaid ? "part_paid" : "unpaid";
}

// ── Who is reminded, and when (0322) ───────────────────────────────────────

/**
 * The firm's advance reminder policy (`tenancy.tenant`, 0322). Every firm may
 * change it; the defaults are the user's answers for the first firm, and the
 * column defaults must say the same (`DEFAULT_ADVANCE_POLICY`).
 */
export interface AdvancePolicy {
  /** A DRAFT advance turns Overdue this many days after signing. */
  readonly draftOverdueDays: number;
  /** An issued, UNPAID (or part-paid) one this many days after issue. */
  readonly unpaidOverdueDays: number;
  /** The partner reminded: the first person above the client's Key Manager
   *  whose grade rank is at least this. */
  readonly partnerMinRank: number;
  /** The weekly summary to the admins: ISO weekday (1 = Monday) and hour
   *  (0-23), in the firm's own time zone. */
  readonly digestWeekday: number;
  readonly digestHour: number;
}

export const DEFAULT_ADVANCE_POLICY: AdvancePolicy = {
  draftOverdueDays: 3,
  unpaidOverdueDays: 15,
  partnerMinRank: 9,
  digestWeekday: 1,
  digestHour: 10,
};

/** The admins (Ashish: the CEO and the COO, both admins) hear about an advance
 *  still pending this many days after signing: the weekly summary lists it,
 *  and it is on their My day as escalated. */
export const ADVANCE_ESCALATE_AFTER_DAYS = 7;

/** A policy's numbers are in range, or the sentence saying which is not. */
export function advancePolicyProblem(p: AdvancePolicy): string | null {
  const whole = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;
  if (!whole(p.draftOverdueDays, 1, 90)) return "Days before a draft advance is overdue must be a whole number from 1 to 90.";
  if (!whole(p.unpaidOverdueDays, 1, 180)) return "Days before an unpaid advance is overdue must be a whole number from 1 to 180.";
  if (!whole(p.partnerMinRank, 1, 100)) return "The partner's grade must be one of the firm's grades.";
  if (!whole(p.digestWeekday, 1, 7)) return "The weekly summary's day must be Monday to Sunday.";
  if (!whole(p.digestHour, 0, 23)) return "The weekly summary's hour must be from 0 to 23.";
  return null;
}

export interface AdvanceReminder {
  /** Still a draft, not raised, or money owed. */
  readonly pending: boolean;
  /** Since when it has waited for the step it is at: signing (not raised or a
   *  draft), or issue (unpaid). Null once paid. */
  readonly pendingSince: string | null;
  readonly daysPending: number | null;
  /** Past the firm's days for the step it is at. */
  readonly overdue: boolean;
  /** The day it turns (or turned) Overdue at the step it is at: what My day
   *  dates the reminder by. Null once paid. */
  readonly overdueOn: string | null;
  /** Still pending a week or more after signing: the admins hear about it. */
  readonly escalated: boolean;
}

/** What an advance that is not chased (paid, or skipped) reads. */
export const NOT_CHASED: AdvanceReminder = {
  pending: false,
  pendingSince: null,
  daysPending: null,
  overdue: false,
  overdueOn: null,
  escalated: false,
};

/** How an advance's reminder reads today, on the firm's calendar. */
export function advanceReminder(input: {
  readonly stage: AdvanceStage;
  /** The day the letter was signed (the advance bill's date). */
  readonly billOn: string;
  /** The advance invoice's date, once issued. */
  readonly issuedOn: string | null;
  readonly today: string;
  readonly policy: Pick<AdvancePolicy, "draftOverdueDays" | "unpaidOverdueDays">;
}): AdvanceReminder {
  if (input.stage === "paid") return NOT_CHASED;
  const issued = input.stage === "unpaid" || input.stage === "part_paid";
  const since = issued ? (input.issuedOn ?? input.billOn) : input.billOn;
  const days = Math.max(0, daysFrom(since, input.today));
  const allowed = issued ? input.policy.unpaidOverdueDays : input.policy.draftOverdueDays;
  return {
    pending: true,
    pendingSince: since,
    daysPending: days,
    overdue: days >= allowed,
    overdueOn: plusDays(since, allowed),
    escalated: daysFrom(input.billOn, input.today) >= ADVANCE_ESCALATE_AFTER_DAYS,
  };
}

// ── The weekly summary's slot (0322) ───────────────────────────────────────

/**
 * Whether this week's summary is due now, and for which day: the firm's own
 * weekday, once its hour has come, in its own zone. Null on any other day, or
 * before the hour. Only ON the day: a summary the worker missed for a whole
 * day is not sent late on another weekday (the firm picked a day so the
 * summary arrives on it), and the first one after a deploy waits for the day
 * rather than arriving at whatever hour the deploy happened.
 */
export function digestDueOn(input: {
  readonly now: string;
  readonly timeZone: string;
  readonly weekday: number;
  readonly hour: number;
}): string | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(input.now));
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const isoWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(read("weekday")) + 1;
  if (isoWeekday !== input.weekday || Number(read("hour")) < input.hour) return null;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** Whole days from `from` to `to` (ISO days), negative when `to` is earlier. */
function daysFrom(from: string, to: string): number {
  const ms = (s: string): number => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** An ISO day plus `days`, on the calendar (no clock, no zone). */
function plusDays(day: string, days: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ── Giving it back ─────────────────────────────────────────────────────────

/** An advance is given back when some is left, everything it covered is
 *  finished (so no later bill can use it), and the firm has not kept it. */
export function shouldRefund(input: {
  readonly remaining: Amount;
  readonly finished: boolean;
  readonly waived: boolean;
}): boolean {
  return input.finished && !input.waived && compareAmounts(input.remaining, "0") > 0;
}

// ── The final bill ─────────────────────────────────────────────────────────

/**
 * A one-time service's final bill is due when its job is done; a one-time fee
 * group's when the job of every service in it is.
 *
 * A CANCELLED JOB IS LEFT OUT (review item 11, 2026-10-02): a group whose other
 * services were done is billed once the rest are done, and a service whose
 * only job was cancelled is never billed automatically (nothing was
 * delivered); a person may still Bill it now (`mayBillNow`), for a
 * cancellation fee say. Before, one cancelled job stopped the final bill for
 * good, with no way to raise it.
 */
export function finalBillReady(input: {
  readonly billingFrequency: string | null;
  readonly jobStatuses: readonly string[];
}): boolean {
  const live = input.jobStatuses.filter((s) => s !== "cancelled");
  return input.billingFrequency === "one_time" && live.length > 0 && live.every((s) => s === "done");
}

/**
 * Whether a person may bill a one-time service now, by hand. Where the firm
 * wrote no process for it (such a job waits forever and is never "done", so
 * the bill would never come), or where every job that had a process was
 * CANCELLED (item 11: the automatic bill will never come, and the firm decides
 * whether anything is owed). Where a live process exists the bill comes when
 * the job is done. Null when allowed; otherwise the sentence saying why not.
 */
export function mayBillNow(input: {
  readonly billingFrequency: string | null;
  readonly status: string;
  readonly job: { readonly hasProcess: boolean; readonly cancelled?: boolean | undefined } | null;
  readonly hasFinalBill: boolean;
}): string | null {
  if (input.billingFrequency !== "one_time") return "Only a one-time service is billed this way.";
  if (input.hasFinalBill) return "This service's final bill is already on the list.";
  if (!["active", "paused", "completed", "pending_advance"].includes(input.status)) {
    return `This service is ${input.status.replace("_", " ")}, so there is nothing to bill.`;
  }
  if (input.job?.hasProcess === true && input.job.cancelled !== true) {
    return "This service has a process: its final bill comes when the job's last step is done.";
  }
  return null;
}

// ── What the invoice line says ─────────────────────────────────────────────

/**
 * The invoice line's text for a bill: the letter's own words (phase 1), what
 * kind of bill it is, and, when an advance was taken off it, which advance
 * invoice it came from.
 *
 * NO AMOUNTS IN THE WORDS (0321). The text is the line's description, which
 * every login that may read an invoice reads, fees or not; "fee INR 1,00,000
 * less advance INR 20,000" put the price in front of staff the fee axis hides it
 * from. The balance is the line's amount (the final invoice shows only the
 * balance, Ashish), and the advance invoice named here carries the rest.
 */
export function billLineText(input: {
  readonly kind: BillKind;
  readonly serviceName: string;
  readonly periodLabel: string;
  readonly servedDays: number;
  readonly periodDays: number;
  readonly letterRef: string;
  /** An advance for one service, rather than the letter's. */
  readonly perService: boolean;
  readonly advance: { readonly invoiceNumber: string } | null;
}): string {
  let text: string;
  if (input.kind === "advance") {
    return input.perService ? `Advance for ${input.serviceName} (${input.letterRef})` : `Advance under ${input.letterRef}`;
  } else if (input.kind === "final") {
    text = `${input.serviceName}, final bill`;
  } else {
    const part =
      input.servedDays < input.periodDays ? ` (${String(input.servedDays)} of ${String(input.periodDays)} days)` : "";
    text = `${input.serviceName}, ${input.periodLabel}${part}`;
  }
  if (input.advance === null) return text;
  return `${text}, less advance (${input.advance.invoiceNumber})`;
}
