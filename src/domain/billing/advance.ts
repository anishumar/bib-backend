// The advance and the final bill (auto-invoice, phase 2, 0320) — pure rules over
// decimal strings and ISO days. Imports only the money domain, for exact
// arithmetic on the digits.
//
// ── THE FIRM'S RULES (Ashish and the user, 2026-10-01) ────────────────────
//
//   - EVERY ADVANCE IS A GST TAX INVOICE. One for the whole letter, or one per
//     service; a letter has one or the other, never both. The amount the letter
//     states is BEFORE tax: the invoice adds the GST.
//   - THE WORK STARTS WHEN THAT INVOICE IS PAID IN FULL. A part payment starts
//     it only when an admin approves (the dunning decision queue's pattern: a
//     machine may notice, a person decides).
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

// ── When the work starts ───────────────────────────────────────────────────

export type AdvanceStartState = "not_raised" | "on_draft" | "unpaid" | "part_paid" | "paid" | "started";

/**
 * Where an advance stands. `started` wins over everything, because work that
 * began is not stopped by a bounced cheque afterwards: the receivable is chased
 * instead, as any other.
 *
 * PAID means money arrived and nothing is left owed (0321). An invoice a credit
 * note took to zero with nothing paid is NOT paid: the credit note cancelled the
 * demand, and it would otherwise start the work and record "paid" in the audit
 * trail with no money received. Whether an unpaid advance may be waived is the
 * firm's open question (Ashish); until it is answered such work waits.
 */
export function advanceStartState(input: {
  readonly invoiceStatus: "draft" | "issued" | "cancelled" | null;
  readonly paid: Amount | null;
  readonly outstanding: Amount | null;
  readonly releasedAt: string | null;
}): AdvanceStartState {
  if (input.releasedAt !== null) return "started";
  if (input.invoiceStatus === null || input.invoiceStatus === "cancelled") return "not_raised";
  if (input.invoiceStatus === "draft") return "on_draft";
  const somethingPaid = compareAmounts(input.paid ?? "0", "0") > 0;
  if (compareAmounts(input.outstanding ?? "0", "0") <= 0 && somethingPaid) return "paid";
  return somethingPaid ? "part_paid" : "unpaid";
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

/** A one-time service's final bill is due when its job is done; a one-time fee
 *  group's when the job of every service in it is. */
export function finalBillReady(input: {
  readonly billingFrequency: string | null;
  readonly jobStatuses: readonly string[];
}): boolean {
  return (
    input.billingFrequency === "one_time" &&
    input.jobStatuses.length > 0 &&
    input.jobStatuses.every((s) => s === "done")
  );
}

/**
 * Whether a person may bill a one-time service now, by hand. Only where the
 * firm wrote no process for it: such a job waits forever and is never "done",
 * so the bill would never come. Where a process exists the bill comes when the
 * job is done. Null when allowed; otherwise the sentence saying why not.
 */
export function mayBillNow(input: {
  readonly billingFrequency: string | null;
  readonly status: string;
  readonly job: { readonly hasProcess: boolean } | null;
  readonly hasFinalBill: boolean;
}): string | null {
  if (input.billingFrequency !== "one_time") return "Only a one-time service is billed this way.";
  if (input.hasFinalBill) return "This service's final bill is already on the list.";
  if (input.status === "pending_advance") return "The work has not started: its advance is not paid yet.";
  if (!["active", "paused", "completed"].includes(input.status)) {
    return `This service is ${input.status.replace("_", " ")}, so there is nothing to bill.`;
  }
  if (input.job?.hasProcess === true) {
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
