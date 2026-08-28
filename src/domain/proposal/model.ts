// The proposal domain — what the firm offered, to whom, at what price. Nouns
// and pure rules only; stdlib plus the money and config vocabulary it shares
// (domain may import domain).
//
// Two things this file deliberately does NOT do, and both are the design:
//
//   IT DOES NOT ADD UP MONEY. Totals come from Postgres `numeric`, computed in
//   the query that reads the lines. A second implementation here — in a
//   language whose only number type cannot hold 1499.50 — would be a rounding
//   disagreement waiting for a large enough invoice, and the two would differ
//   in the direction nobody checks. Amounts travel as decimal strings and are
//   summed once, by the database.
//
//   IT DOES NOT KNOW THE FIRM'S DISCOUNT LIMIT. That is a published `policy`
//   config row (0010), read live at the moment of the check. What lives here is
//   the COMPARISON and what it means, so the rule is stated once and the use
//   case only supplies the two numbers.
import type { Amount, CurrencyCode } from "../money/model";

/**
 * Where a proposal has got to.
 *
 * A closed set in code, like lead stages and for the same reason: the product
 * branches on these names. `expired` is written LAZILY — nothing in this system
 * runs on a timer yet, so a proposal past its date becomes expired the first
 * time somebody tries to act on it, and `isPastValidity` below is what decides
 * that. A status a scheduler was supposed to set, with no scheduler, would be a
 * state the data never reaches.
 */
export type ProposalStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
];

export function isProposalStatus(v: string): v is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(v);
}

/** The statuses a proposal never leaves. A client who comes back after a
 *  rejection is a new quote, not an edit to the one they turned down. */
export const TERMINAL_STATUSES: readonly ProposalStatus[] = ["accepted", "rejected", "expired"];

export function isTerminal(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The decisions a recipient can hand back. Narrower than the status set:
 *  `expired` is something that HAPPENS to a proposal, not a decision. */
export type ProposalDecision = "accepted" | "rejected";

export function isProposalDecision(v: string): v is ProposalDecision {
  return v === "accepted" || v === "rejected";
}

export interface Proposal {
  readonly id: string;
  readonly tenantId: string;
  /** Who it is for. A party, like everything with a counterparty here. */
  readonly partyId: string;
  /** The opportunity it came out of, or null — a firm quoting an existing
   *  client for more work has no lead, and inventing one would put rows in the
   *  pipeline nobody is working. */
  readonly leadId: string | null;
  readonly title: string;
  readonly status: ProposalStatus;
  /** What it is quoted in, and the rate back to the firm's reporting currency
   *  (tenancy.tenant.reportingCurrency). Struck once for the whole document, so
   *  its total does not depend on the order lines were added. Stored even when
   *  the two currencies match (1.0, dated). */
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  /** The day the offer lapses, in the client's calendar. A date, not an
   *  instant: "valid until 30 September" is not midnight UTC. */
  readonly validUntil: string | null;
  readonly sentAt: string | null;
  readonly decidedAt: string | null;
  /** Who signed off a discount past the firm's limit, and when. Both or
   *  neither — an approval with no approver answers nothing. */
  readonly discountApprovedBy: string | null;
  readonly discountApprovedAt: string | null;
}

export interface ProposalLine {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  /** THE PIN: the frozen `config.version` this line was quoted from, so the
   *  list price at the time survives the catalogue moving on. */
  readonly serviceVersionId: string;
  /** What the document says on this line — the client's words, which a firm
   *  routinely tailors. The pin answers what was sold; this answers what was
   *  read. */
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  readonly unitAmount: Amount;
  /** Always equal to the proposal's, held there by a composite foreign key.
   *  Carried on the line anyway so an amount and its currency are never
   *  separated. */
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
}

/**
 * What the lines come to. Computed by the database, never here.
 *
 * All three, rather than just the payable figure, because "what did we discount
 * this by" is the question a partner asks about a quote and deriving it from two
 * of the three on a screen is how two screens end up disagreeing.
 */
export interface ProposalTotals {
  /** Before discount. */
  readonly gross: Amount;
  readonly discount: Amount;
  /** What the client would pay: gross − discount. */
  readonly net: Amount;
  readonly currency: CurrencyCode;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Whether a proposal may move from one status to another.
 *
 * Stricter than the lead pipeline, which lets an opportunity go backwards,
 * because these transitions are not internal bookkeeping — `sent` means a
 * client has the document, and un-sending it is not a thing that can happen.
 * A quote that needs changing after it went out is a new proposal, which is
 * also what leaves the old one readable as what they were actually shown.
 */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (isTerminal(from)) return false;
  if (from === "draft") return to === "sent";
  return to === "accepted" || to === "rejected" || to === "expired";
}

/**
 * Whether a date has passed, in whole days.
 *
 * `validUntil` is a DATE and `on` is compared as one, so a proposal valid until
 * the 30th is still valid all day on the 30th in whoever's calendar is reading
 * it. Comparing an instant against a date would expire it at midnight UTC,
 * which is the previous afternoon in half the world.
 */
export function isPastValidity(validUntil: string | null, on: string): boolean {
  if (validUntil === null) return false;
  return on.slice(0, 10) > validUntil.slice(0, 10);
}

/**
 * The largest discount on any line — the number the firm's limit is checked
 * against.
 *
 * The MAXIMUM rather than the average or the total: a limit of 15% means no
 * single thing is sold at more than 15% off. Averaging would let a 40% discount
 * through beside a full-price line, which is exactly the trade somebody would
 * make to avoid asking.
 */
export function largestDiscount(lines: readonly Pick<ProposalLine, "discountPercent">[]): Amount {
  let largest = "0";
  for (const line of lines) {
    if (comparePercent(line.discountPercent, largest) > 0) largest = line.discountPercent;
  }
  return largest;
}

/**
 * Compare two percentages given as decimal strings.
 *
 * `Number` is exact HERE and would not be for money. A percentage in this
 * product is 0–100 with at most four decimal places — seven significant digits,
 * far inside what a double represents exactly — so parsing and comparing cannot
 * reorder two distinct values. An AMOUNT has no such bound, which is why
 * amounts are never compared or summed this way.
 */
export function comparePercent(a: Amount, b: Amount): number {
  const left = Number(a);
  const right = Number(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Whether this proposal needs somebody holding `proposal:approve` to sign it
 * off before it can be sent.
 *
 * `maxPercent` of null means the firm has published no discount policy, and
 * that is read as ZERO — any discount at all needs approval. Fail-closed on
 * purpose: a firm that never set a limit has not decided that anything goes,
 * and the fail-open reading of that silence is the one nobody can audit. It is
 * also a one-publish fix, and the error says so.
 */
export function needsDiscountApproval(
  lines: readonly Pick<ProposalLine, "discountPercent">[],
  maxPercent: Amount | null,
): boolean {
  return comparePercent(largestDiscount(lines), maxPercent ?? "0") > 0;
}
