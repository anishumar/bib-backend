// The proposal domain: what the firm offered, to whom, at what price.
// Deliberately NOT here: adding up money (totals come from Postgres `numeric`, once, so there is
// no second rounding to disagree with), and the firm's discount limit (a published `policy` config
// row, 0010, read live; only the comparison lives here).
import type { Amount, CurrencyCode, CurrencyRate } from "../money/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../document/model";

/**
 * Where a proposal has got to. `expired` is written LAZILY: nothing runs on a timer, so a
 * proposal past its date becomes expired the first time somebody acts on it (`isPastValidity`).
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

/** Never left. A client who comes back after a rejection is a new quote. */
export const TERMINAL_STATUSES: readonly ProposalStatus[] = ["accepted", "rejected", "expired"];

export function isTerminal(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** What a recipient can hand back; `expired` happens to a proposal, it is not a decision. */
export type ProposalDecision = "accepted" | "rejected";

export function isProposalDecision(v: string): v is ProposalDecision {
  return v === "accepted" || v === "rejected";
}

/**
 * How long after an open another open counts as the same reading. The share route is public, so
 * refreshes and chat-app link previews all hit it; with the last view recorded, `view_count`
 * counts SITTINGS. The ledger's `proposal.viewed` is written once, on the first view.
 */
export const VIEW_DEDUPE_MINUTES = 30;

export interface Proposal {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's quotable reference (`PR-2026-0007`): unique per firm, never reused, cited by audits. */
  readonly ref: string;
  readonly partyId: string;
  /**
   * The FIRM's entity offering this. A SNAPSHOT resolved at drafting (see
   * `domain/document/model.ts`); governing law, courts and tax follow from this column, never a
   * read-time lookup.
   */
  readonly issuingEntityPartyId: string;
  /** Null for an existing client quoted more work: no lead is invented. */
  readonly leadId: string | null;
  readonly title: string;
  readonly status: ProposalStatus;
  /** MAIN currency (from the issuing company) and its rate to the firm's reporting currency
   *  (tenancy.tenant.reportingCurrency); stored even when they match (1.0, dated). */
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  /** One rate per OTHER line currency (0344); empty when priced only in the main currency. */
  readonly rates: readonly CurrencyRate[];
  /** A DATE in the client's calendar, not an instant. */
  readonly validUntil: string | null;
  readonly sentAt: string | null;
  readonly decidedAt: string | null;
  /** Sign-off of a discount past the firm's limit: both or neither. */
  readonly discountApprovedBy: string | null;
  readonly discountApprovedAt: string | null;
  /** Only the FIRST view writes `proposal.viewed`; the count is commercial signal, not ledger. */
  readonly firstViewedAt: string | null;
  /** Written on EVERY view, unlike the count; see `VIEW_DEDUPE_MINUTES`. */
  readonly lastViewedAt: string | null;
  readonly viewCount: number;
  /**
   * WHY the client said no, free text (real reasons do not fit a picklist). Null on every other
   * status (`proposal_declined_reason_when_rejected_chk`, 0022).
   */
  readonly declinedReason: string | null;
  /** The proposal's BACKGROUND (0084), the same prose a letter carries; null leaves the heading out. */
  readonly background: string | null;
  /** The PERSON at the client printed on the cover (0084, F-10-1), or null. */
  readonly addressedToPartyId: string | null;
  /** "Prepared by" on the cover (0084): the drafter unless handed over; null if none resolves. */
  readonly preparedByUserId: string | null;
  /**
   * THE PDF OF RECORD (0085): the file the client was sent, and what an answer is recorded
   * against. Pinned the first time a SENT proposal needs its PDF and never re-rendered, because a
   * render reads today's brand assets.
   */
  readonly sentPdfVersionId: string | null;
  /**
   * A DRAFT deleted as a mistake (0086), so no client ever held it: off the list, readable by id,
   * FINAL. Its reference is not reused; the gap in the series is honest.
   */
  readonly deletedAt: string | null;
  /** For the page; the ledger's `proposal.deleted` names the actor either way. */
  readonly deletedByUserId: string | null;
  /** The rejected or expired proposal this draft was COPIED from (0316); the source never changes. */
  readonly copiedFromId: string | null;
}

/**
 * Statuses a proposal can be COPIED from (0316, decided 2026-09-30). Not `sent` (the client would
 * hold two live offers for the same work); an accepted one goes on to a letter.
 */
export const COPYABLE_STATUSES: readonly ProposalStatus[] = ["rejected", "expired"];

export function isCopyable(status: ProposalStatus): boolean {
  return COPYABLE_STATUSES.includes(status);
}

/**
 * A share link's token: `<tenant_id>.<secret>`. The tenant travels IN the token so opening a link
 * stays a tenant-scoped read (no cross-firm digest lookup RLS cannot scope). The whole string is
 * hashed, so the halves cannot be recombined into another proposal's link.
 */
export function composeShareToken(tenantId: string, secret: string): string {
  return `${tenantId}.${secret}`;
}

const TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Null for anything malformed; the caller answers exactly as for an unknown token, so a probe
 * cannot learn which firms exist.
 */
export function parseShareToken(token: string): { tenantId: string; secret: string } | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const tenantId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!TENANT_PATTERN.test(tenantId) || secret === "") return null;
  return { tenantId, secret };
}

export interface ProposalLine {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  /**
   * Nullable here, required on a letter line: a proposal is an OFFER, the prospect may hold no
   * entity yet (an Incorporation line's entity is its OUTPUT), while signing a letter creates an
   * engagement, which is `service × one legal entity`.
   */
  readonly entityPartyId: string | null;
  /** THE PIN: the frozen `config.version` quoted from, so the list price survives the catalogue. */
  readonly serviceVersionId: string;
  /** The client-facing words, often tailored; the pin says what was sold, this what was read. */
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  /**
   * Price per unit of the billing basis, or NULL for "as mutually agreed" (G1.6; was NOT NULL, so
   * unpriced lines were quoted as zero). NULL IS NOT ZERO downstream: it adds nothing to a total
   * and is counted in `ProposalTotals.unpricedLineCount`. `pricingNote` is required when null (0023).
   */
  readonly unitAmount: Amount | null;
  /** The main currency or one the proposal holds a rate for (0344); the database checks at commit. */
  readonly currency: CurrencyCode;
  /** Zero when unpriced (0023): a discount off "as mutually agreed" would also trip the approval gate. */
  readonly discountPercent: Amount;
  /**
   * WHERE THE WORK IS: the country the user picked. Stated, never derived from the entity (that
   * needs its registrations, a lookup nothing here makes; a letter uses the entity's own).
   */
  readonly jurisdiction: string | null;
  /**
   * How often THIS DEAL is billed; defaults to the pinned service's `recurrence` and may differ
   * (monthly service billed quarterly). Null when neither states one; never invented.
   */
  readonly billingFrequency: BillingFrequency | null;
  /**
   * THE FOUR OVERRIDES: this document's own wording for the scope blocks, or null for the pinned
   * version's words. They keep tailoring out of the catalogue, so an issued document stays
   * reproducible. Blank is refused by the database. Resolved by `resolveTerms`.
   */
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  /** Separate from the fee, at actuals, never in a total; see `OutOfPocketEstimate`. */
  readonly oopEstimate: OutOfPocketEstimate | null;
  /** WHY there is no amount. Required when `unitAmount` is null (0023); a priced line may carry one too. */
  readonly pricingNote: string | null;
}

/** What the lines come to, computed by the database. All three so screens never derive one. */
export interface ProposalTotals {
  readonly gross: Amount;
  readonly discount: Amount;
  /** gross − discount. */
  readonly net: Amount;
  readonly currency: CurrencyCode;
  /**
   * Live lines the figures do NOT cover (unpriced; `sum()` skips NULL). Non-zero means `net` is a
   * FLOOR (G1.6); a renderer that drops this prints a number that is not the document's price.
   */
  readonly unpricedLineCount: number;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** Forward only: `sent` means the client has it. A changed quote after sending is a new proposal. */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (isTerminal(from)) return false;
  if (from === "draft") return to === "sent";
  return to === "accepted" || to === "rejected" || to === "expired";
}

/**
 * Why this proposal may NOT be deleted, or null (0086). Only a DRAFT, and not while a live letter
 * cites it; deleting the letter first, then the quote, always works.
 */
export type ProposalDeletionBlock =
  | { readonly kind: "deleted" }
  | { readonly kind: "not_draft"; readonly status: ProposalStatus }
  | { readonly kind: "letters"; readonly refs: readonly string[] };

export function proposalDeletionBlock(
  proposal: Pick<Proposal, "status" | "deletedAt">,
  citingLetterRefs: readonly string[],
): ProposalDeletionBlock | null {
  if (proposal.deletedAt !== null) return { kind: "deleted" };
  if (proposal.status !== "draft") return { kind: "not_draft", status: proposal.status };
  if (citingLetterRefs.length > 0) return { kind: "letters", refs: citingLetterRefs };
  return null;
}

/**
 * Whole days: valid until the 30th is valid all day on the 30th. `on` must be the FIRM's
 * calendar day (`dayInZone`, audit 2026-10-03, B24), not a UTC instant.
 */
export function isPastValidity(validUntil: string | null, on: string): boolean {
  if (validUntil === null) return false;
  return on.slice(0, 10) > validUntil.slice(0, 10);
}

/** The MAXIMUM line discount: a 15% limit means nothing is sold at more than 15% off. */
export function largestDiscount(lines: readonly Pick<ProposalLine, "discountPercent">[]): Amount {
  let largest = "0";
  for (const line of lines) {
    if (comparePercent(line.discountPercent, largest) > 0) largest = line.discountPercent;
  }
  return largest;
}

/**
 * `Number` is exact here: a percentage is 0–100 with at most four decimals. Never compare
 * amounts this way; they have no such bound.
 */
export function comparePercent(a: Amount, b: Amount): number {
  const left = Number(a);
  const right = Number(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Whether sending needs `proposal:approve` sign-off. `maxPercent` null (no policy published)
 * reads as ZERO: fail-closed, and a one-publish fix.
 */
export function needsDiscountApproval(
  lines: readonly Pick<ProposalLine, "discountPercent">[],
  maxPercent: Amount | null,
): boolean {
  return comparePercent(largestDiscount(lines), maxPercent ?? "0") > 0;
}

/**
 * Whether a recorded sign-off LAPSES when one line's discount moves `before` → `after` (T6.18).
 * Only a raise past the limit lapses it (a new line is a raise from "0"); lapsing, not refusing
 * the edit, costs one more approval instead of a new quote. `maxPercent` null is zero.
 */
export function discountApprovalLapses(
  approved: boolean,
  before: Amount,
  after: Amount,
  maxPercent: Amount | null,
): boolean {
  if (!approved) return false;
  if (comparePercent(after, before) <= 0) return false;
  return comparePercent(after, maxPercent ?? "0") > 0;
}

// ── The proposal by email, and the client's own answer (0085) ────────────────

/**
 * The shape `crm.proposal_email.to_email` holds, stated here so the refusal is this use case's.
 * Deliberately loose; whether a mailbox exists is the mail server's to say.
 */
export function isEmailAddress(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

export const SIGNER_NAME_MAX = 200;

/** The colleague's own note above the standard letter. */
export const EMAIL_NOTE_MAX = 2000;

/**
 * THE SENTENCE AN ACCEPTANCE TICKS, shown on the link's page and stored with the answer; one
 * function so the two cannot disagree. It names the CLIENT the person accepts on behalf of.
 */
export function acceptanceStatement(ref: string, clientName: string): string {
  return `I accept proposal ${ref} on behalf of ${clientName}.`;
}
