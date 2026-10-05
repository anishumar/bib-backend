// The ad-hoc advance (0363, Q044-Q048): an advance invoice raised BEFORE there
// is an engagement letter, kept on "Advances to be adjusted" until it is mapped
// to the work it pays for. Pure rules over decimal strings and ISO days.
//
// ── THE FIRM'S RULES (Ashish, 2026-10-04; the user, 2026-10-05) ───────────
//
//   - Q044: in 5-10% of cases the money comes before the letter. Raise an
//     advance invoice now (a tax invoice like any other, BEFORE tax as every
//     advance is); it shows under "advance to be adjusted" until mapped.
//   - Q045: "Should have an option to adjust later with different
//     services/Jobs or diff managers": one advance is split across services
//     (and a job of one), and re-mapped later. Always THROUGH a service, never
//     to a manager alone (the user, 2026-10-05): the manager follows the
//     service, so the revenue split is the services' managers.
//   - Q046: "Managers and above" raise and map it (`advance:manage`).
//   - Q047: "monthly basis to the person who have generated it and admin".
//   - Q048: "Both options": the letter names the advance (mapped to the letter
//     when it is signed, FIFO over its bills like the letter's own advance), or
//     an admin maps it by hand. A letter that names one still raises its own
//     "advance required" invoice: that is further money (the user, 2026-10-05).
//
// ── WHAT A MAP IS ──────────────────────────────────────────────────────────
//
// An allocation points part of the advance's pre-tax money at a target. Its
// EFFECTIVE amount is what it still holds: all of it while live, and once ended
// only what bills had already taken (frozen as `keptAmount`). The advance's
// UNMAPPED balance is its invoice's net, less credit notes at their pre-tax
// share, less every allocation's effective amount. The database derives both
// (`crm.advance_pool`); these functions check what a person asks for against
// the figures it read.
import { compareAmounts, isAmount, subtractAmounts, type Amount } from "../money/model";

/** `a + b`, exactly, on the digits (a - (0 - b)). */
export function addAmounts(a: Amount, b: Amount): string {
  return subtractAmounts(a, subtractAmounts("0", b));
}

export function sumAmounts(amounts: readonly Amount[]): string {
  return amounts.reduce<string>((total, a) => addAmounts(total, a), "0");
}

/** The smaller of two amounts. */
export function minAmount(a: Amount, b: Amount): Amount {
  return compareAmounts(a, b) <= 0 ? a : b;
}

// ── Mapping ────────────────────────────────────────────────────────────────

export type AllocationProblem =
  | { readonly kind: "none" }
  | { readonly kind: "not_an_amount"; readonly amount: string }
  | { readonly kind: "not_above_zero"; readonly amount: string }
  | { readonly kind: "same_target_twice" }
  | { readonly kind: "over"; readonly asked: string; readonly unmapped: string };

/**
 * What is wrong with mapping these amounts out of an advance with `unmapped`
 * left, or nothing. Each is a decimal string above zero with at most four
 * places; one request names a target once; together they fit in what is left.
 */
export function allocationProblem(input: {
  readonly unmapped: Amount;
  readonly targets: readonly { readonly key: string; readonly amount: string }[];
}): AllocationProblem {
  if (input.targets.length === 0) return { kind: "none" };
  for (const t of input.targets) {
    if (!isAmount(t.amount)) return { kind: "not_an_amount", amount: t.amount };
    if (compareAmounts(t.amount, "0") <= 0) return { kind: "not_above_zero", amount: t.amount };
  }
  if (new Set(input.targets.map((t) => t.key)).size !== input.targets.length) return { kind: "same_target_twice" };
  const asked = sumAmounts(input.targets.map((t) => t.amount));
  if (compareAmounts(asked, input.unmapped) > 0) return { kind: "over", asked, unmapped: input.unmapped };
  return { kind: "none" };
}

/** What an allocation holds: all of it while live, what bills took once ended. */
export function effectiveAmount(input: { readonly amount: Amount; readonly keptAmount: Amount | null }): Amount {
  return input.keptAmount ?? input.amount;
}

/**
 * Ending an allocation (to map it elsewhere, or to give it back): what bills
 * have taken from it stays mapped, the rest is freed. Null when nothing would
 * be freed: the bills have taken all of it, so it cannot move.
 */
export function endAllocation(input: {
  readonly amount: Amount;
  readonly taken: Amount;
}): { readonly kept: Amount; readonly freed: string } | null {
  const kept = minAmount(input.taken, input.amount);
  const freed = subtractAmounts(input.amount, kept);
  if (compareAmounts(freed, "0") <= 0) return null;
  return { kept, freed };
}

/**
 * What a signed letter maps of an advance it named: the figure it named, or
 * less when part was mapped elsewhere before it was signed. Null: nothing is
 * left to map (the letter still printed it; the advance's list says so).
 */
export function letterMapAmount(input: { readonly named: Amount; readonly unmapped: Amount }): Amount | null {
  if (compareAmounts(input.unmapped, "0") <= 0) return null;
  return minAmount(input.named, input.unmapped);
}

// ── Where an ad-hoc advance stands ─────────────────────────────────────────

/** `draft`: raised, not issued (no number, nothing to map yet). `open`: issued,
 *  some of it mapped nowhere. `mapped`: every rupee is pointed at work.
 *  `cancelled`: its invoice was withdrawn. */
export type AdhocAdvanceStatus = "draft" | "open" | "mapped" | "cancelled";

export const ADHOC_ADVANCE_STATUSES: readonly AdhocAdvanceStatus[] = ["draft", "open", "mapped", "cancelled"];

export function adhocAdvanceStatus(input: {
  readonly invoiceStatus: "draft" | "issued" | "cancelled";
  readonly unmapped: Amount | null;
}): AdhocAdvanceStatus {
  if (input.invoiceStatus === "draft") return "draft";
  if (input.invoiceStatus === "cancelled") return "cancelled";
  return compareAmounts(input.unmapped ?? "0", "0") > 0 ? "open" : "mapped";
}

// ── The invoice line ───────────────────────────────────────────────────────

/** The line's words. No amount (0321: the description reaches logins the fee
 *  axis hides prices from); the firm's note after, when there is one. */
export function adhocAdvanceLineText(note: string | null): string {
  const base = "Advance, to be adjusted against services";
  const n = note?.trim() ?? "";
  return n === "" ? base : `${base}: ${n}`;
}

// ── The monthly reminder (Q047) ────────────────────────────────────────────

/** The day of the month a firm reminds by default, and the range it may pick:
 *  up to the 28th, so every month has it. */
export const DEFAULT_UNMAPPED_REMINDER_DAY = 1;

export function isUnmappedReminderDay(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 28;
}

/**
 * The month whose reminder is due at `now`, as "YYYY-MM", or null before it.
 * Due from the firm's day of the month at its hour, in its zone, and for the
 * rest of that month: unlike the weekly summary (which waits for its weekday
 * rather than arrive on another), a monthly reminder missed on the 1st because
 * the worker was down still goes on the 2nd. Once per person per month is the
 * notification's own key, so a later run sends nothing twice.
 */
export function unmappedReminderDue(input: {
  readonly now: string;
  readonly timeZone: string;
  readonly day: number;
  readonly hour: number;
}): string | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(input.now));
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const day = Number(read("day"));
  const hour = Number(read("hour"));
  if (day < input.day || (day === input.day && hour < input.hour)) return null;
  return `${read("year")}-${read("month")}`;
}
