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
import type { BillingFrequency, OutOfPocketEstimate } from "../document/model";

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

/**
 * How long after an open another open counts as the same reading.
 *
 * ── WHAT `view_count` WAS ACTUALLY COUNTING ────────────────────────────────
 *
 * Requests. The share route is public by design — a proposal goes to somebody
 * who has no login and will not get one — so every open incremented it: a
 * refresh, a link preview unfurled by a chat app, a back button, a bored
 * recipient. A partner reads "the client looked at this four times" and acts on
 * it; the number could say anything, and only a per-address rate limit stood
 * between it and nonsense.
 *
 * With the LAST view recorded, the count can advance only when the previous one
 * was long enough ago to be a separate act of reading. Half an hour makes the
 * number mean SITTINGS, which is what it was always read as.
 *
 * The ledger half was already right: `proposal.viewed` is recorded once, on the
 * first view, so the audit trail was never spammed.
 */
export const VIEW_DEDUPE_MINUTES = 30;

export interface Proposal {
  readonly id: string;
  readonly tenantId: string;
  /**
   * What a client quotes back on the phone — `PR-2026-0007`.
   *
   * Unique per firm and never reused, allocated once when the proposal is
   * drafted. The id is the system's name for this document; this is the
   * firm's, and the two are not interchangeable: a uuid is neither quotable nor
   * citable, and an audit cites the reference.
   */
  readonly ref: string;
  /** Who it is for. A party, like everything with a counterparty here. */
  readonly partyId: string;
  /**
   * Which of the FIRM's own entities is offering this — not the client.
   *
   * A SNAPSHOT, resolved once at drafting from the firm's rule (see
   * `domain/document/model.ts`) and stored, because the rule may change and an
   * issued document must always say who actually issued it. Everything that
   * follows from it — governing law, courts, tax treatment, who the client's
   * counterparty is — follows from this column and not from a lookup done at
   * read time.
   */
  readonly issuingEntityPartyId: string;
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
  /**
   * When the recipient first opened it, and how many times they have.
   *
   * The count rises on every open because "they have looked at it four times"
   * is real commercial signal; only the FIRST view writes a `proposal.viewed`
   * event, because the ledger holds state transitions and a client refreshing a
   * page is not fifty facts about the business.
   */
  readonly firstViewedAt: string | null;
  /** When the share link was last opened. Null until it has been. Written on
   *  EVERY view, unlike the count — see `VIEW_DEDUPE_MINUTES`. */
  readonly lastViewedAt: string | null;
  readonly viewCount: number;
  /**
   * WHY the client said no.
   *
   * `status = 'rejected'` records THAT they did, which is the half of a lost
   * quote worth nothing later: a pipeline that can only count losses cannot say
   * whether the firm loses on price, on scope or on timing. Free text, because
   * the real reasons ("went with their existing CA", "budget pulled in the
   * restructure") do not fit a picklist anybody could guess at now.
   *
   * Null on every other status, and the database says so
   * (`proposal_declined_reason_when_rejected_chk`, 0022): a reason on an
   * accepted proposal reads as fact to whoever finds it.
   */
  readonly declinedReason: string | null;
  /**
   * The firm's paragraph about the client's business — the proposal's
   * BACKGROUND (0084), and the same prose a letter carries. Null when nobody
   * has written one, and then the document leaves the heading out rather than
   * printing it over nothing.
   */
  readonly background: string | null;
  /**
   * The PERSON at the client this is prepared for, printed on the cover above
   * the client's own name (0084). A person in the client's structure (F-10-1),
   * or null — a proposal to a company with no named contact yet is ordinary.
   */
  readonly addressedToPartyId: string | null;
  /**
   * The colleague the cover names under "Prepared by" (0084) — whoever drafted
   * it, unless a draft was handed to somebody else. Null only on a proposal
   * drafted by no person, or whose drafter's account no longer resolves.
   */
  readonly preparedByUserId: string | null;
  /**
   * THE PDF OF RECORD (0085) — the one rendered file the client was sent: the
   * email's attachment, the link's download, and what an answer is recorded
   * against. Pinned the first time a SENT proposal needs its PDF and never
   * re-rendered after, because a render reads the firm's brand assets as they
   * stand today. Null on a draft, and on a sent proposal nothing has asked for
   * a PDF of yet.
   */
  readonly sentPdfVersionId: string | null;
  /**
   * When this DRAFT was deleted as made by mistake (0086), or null — before it
   * went out, so no client ever held it. Off the list of quotes, still readable
   * by id, and FINAL: a deleted draft never changes again. Its reference is not
   * reused, and a gap in the series is one of the honest reasons for one.
   */
  readonly deletedAt: string | null;
  /** Who deleted it, for the page. The ledger's `proposal.deleted` names the
   *  actor either way. */
  readonly deletedByUserId: string | null;
  /**
   * The rejected or expired proposal this draft was COPIED from (0316), or
   * null. Set once, when the copy is drafted; the source is never changed by
   * being copied, so it stays exactly what the client turned down.
   */
  readonly copiedFromId: string | null;
}

/**
 * The statuses a proposal can be COPIED from into a new draft (0316, decided
 * 2026-09-30). Closed ones only: the client said no, or the offer lapsed. A
 * sent quote still waiting for an answer is not copied, because then one
 * client would hold two live offers for the same work; an accepted one goes on
 * to a letter instead.
 */
export const COPYABLE_STATUSES: readonly ProposalStatus[] = ["rejected", "expired"];

export function isCopyable(status: ProposalStatus): boolean {
  return COPYABLE_STATUSES.includes(status);
}

/**
 * A share link's token: `<tenant_id>.<secret>`.
 *
 * The tenant travels IN the token so that opening a link is still a tenant-
 * scoped read. Looking a proposal up by digest across every firm would need a
 * query RLS does not scope — on a table that holds money — and the tenant wall
 * exists precisely to have no such query. The uuid half is not a secret:
 * whoever holds the token already holds a capability into that firm.
 *
 * The whole string is what gets hashed, so the two halves cannot be recombined
 * into a link for a different proposal.
 */
export function composeShareToken(tenantId: string, secret: string): string {
  return `${tenantId}.${secret}`;
}

const TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Split a share token back into the tenant it belongs to and the rest.
 *
 * Returns null for anything malformed, and the caller answers exactly as it
 * would for a token that is well-formed and unknown — a link that tells the
 * difference tells somebody probing which firms exist.
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
   * Which of the client's entities this line is for, or null.
   *
   * NULLABLE here and required on an engagement letter line, and the asymmetry
   * is the design: a proposal is an OFFER, the prospect may hold no entity yet,
   * and an Incorporation line's entity is that line's own OUTPUT. A letter has
   * to name one because signing it creates an engagement, and an engagement is
   * `service × one legal entity`.
   */
  readonly entityPartyId: string | null;
  /** THE PIN: the frozen `config.version` this line was quoted from, so the
   *  list price at the time survives the catalogue moving on. */
  readonly serviceVersionId: string;
  /** What the document says on this line — the client's words, which a firm
   *  routinely tailors. The pin answers what was sold; this answers what was
   *  read. */
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  /**
   * The price asked, per unit of the service's billing basis — or NULL, which is
   * a real and common state: several lines are genuinely "as mutually agreed".
   *
   * NULLABLE since G1.6, and the relaxation is the point of that task. The
   * column was `NOT NULL CHECK (>= 0)`, so an unpriced line had to be quoted as
   * ZERO — a completely different statement to a client, and one that reads as a
   * commitment to work for nothing.
   *
   * NULL IS NOT ZERO ANYWHERE DOWNSTREAM. A line with no price contributes
   * nothing to a total and is COUNTED instead: see
   * `ProposalTotals.unpricedLineCount`, which travels beside every figure so
   * that "₹4,80,000" can never be read as the price of a document that also
   * contains two lines nobody has priced. `pricingNote` is required when this is
   * null (0023) — a blank where a price belongs is indistinguishable from data
   * somebody forgot to type.
   */
  readonly unitAmount: Amount | null;
  /** Always equal to the proposal's, held there by a composite foreign key.
   *  Carried on the line anyway so an amount and its currency are never
   *  separated. */
  readonly currency: CurrencyCode;
  /** Zero when there is no price: a discount off "as mutually agreed" is not a
   *  number, and the database refuses one (0023). It would also reach
   *  `needsDiscountApproval` and hold the proposal at the approval gate over a
   *  discount that does not exist. */
  readonly discountPercent: Amount;
  /**
   * WHERE THE WORK IS. A proposal is built by picking countries and then the
   * services offered in them, so this is the thing the user actually chose.
   *
   * Stated, never derived. On a letter it is the entity's own jurisdiction, and
   * resolving that would need the entity's registrations — a lookup nothing here
   * makes, and a jurisdiction invented from a null is indistinguishable from one
   * somebody chose.
   */
  readonly jurisdiction: string | null;
  /**
   * How often THIS DEAL is billed — defaulted from the pinned service's
   * `recurrence` when the caller says nothing, and freely different from it.
   * A monthly service billed quarterly is an arrangement the firm has today.
   *
   * Null when the caller stated none AND the pinned version stated no
   * recurrence. Not invented: a billing frequency nobody chose is one nobody can
   * trace.
   */
  readonly billingFrequency: BillingFrequency | null;
  /**
   * THE FOUR OVERRIDES — this document's own wording for the four scope blocks,
   * or null to print the pinned catalogue version's words.
   *
   * WHAT MAKES AN ISSUED DOCUMENT REPRODUCIBLE. Without them, tailoring one
   * client's scope means editing the catalogue, which silently rewrites the
   * standard scope for every document issued afterwards. Blank is refused by the
   * database: null means "we did not tailor this", and a document that means to
   * print nothing writes the sentence.
   *
   * Resolved against the catalogue by `resolveTerms` — one place, and it reports
   * which of the two won.
   */
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  /** The out-of-pocket range, in its own currency. Separate from the fee,
   *  reimbursed at actuals, and never summed into a total — see
   *  `OutOfPocketEstimate`. */
  readonly oopEstimate: OutOfPocketEstimate | null;
  /**
   * WHY there is no amount — "As mutually agreed", "Quoted on receipt of the
   * registrar's schedule". REQUIRED when `unitAmount` is null (0023), which is
   * the acceptance in one constraint: a line may say "as mutually agreed" with a
   * REASON instead of a price.
   *
   * A priced line may carry one too — "plus statutory fees at actuals" — so the
   * rule is one-directional.
   */
  readonly pricingNote: string | null;
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
  /**
   * HOW MANY LIVE LINES THE THREE FIGURES ABOVE DO NOT COVER.
   *
   * A line with no price contributes nothing to a sum — `numeric` NULL times a
   * quantity is NULL and `sum()` skips it — so without this the total would
   * quietly understate the document and nothing on it would say so. That is the
   * one outcome G1.6 refused: a total is a claim about what a client owes, and
   * when a line has no price the honest claim is "this much, PLUS whatever is
   * agreed for N further lines". Two values, not one, and they travel together
   * from the view to the wire.
   *
   * Non-zero therefore means `net` is a FLOOR rather than the price of the
   * document. Zero means the figures are complete. A renderer that drops this
   * field prints a number that is not the price of this document.
   */
  readonly unpricedLineCount: number;
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
 * Why this proposal may NOT be deleted, or null when it may (0086).
 *
 * Only a DRAFT is deleted: once sent, the client holds the document and it is
 * something to answer, not a mistake to take back. And not while a live
 * engagement letter cites it — delete that draft letter first if it was a
 * mistake too, so deleting in order, the letter and then the quote, always
 * works.
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

/**
 * Whether a sign-off already on a draft stops covering it once one line's
 * discount moves from `before` to `after` (T6.18).
 *
 * An approval is a partner saying yes to the discounts the draft carried THEN.
 * Before lines could be edited that was the whole story: `send` asks for an
 * approval only when none is recorded, so a discount raised past the limit
 * after the sign-off went out unapproved. It LAPSES, rather than the edit being
 * refused, because refusing leaves the author no way to fix the quote short of
 * a new one, and a lapse costs one more press by somebody holding
 * `proposal:approve`.
 *
 * Only a RAISE past the limit lapses it. Lowering a discount, or raising one
 * that stays within the firm's limit, changes nothing anybody signed off. A
 * new line is a raise from "0". `maxPercent` null is zero, as everywhere.
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
 * Whether a string is an email address — the shape the database holds a
 * recipient to (`crm.proposal_email.to_email`), stated once here so the
 * refusal a colleague reads is this use case's and not a CHECK's.
 *
 * Deliberately loose: something@something.something. Whether a mailbox exists
 * is the mail server's to say, and a stricter pattern refuses real addresses.
 */
export function isEmailAddress(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

/** How long a name the client types may be. A person's full name, with room. */
export const SIGNER_NAME_MAX = 200;

/** How long the colleague's own note above the standard letter may be. */
export const EMAIL_NOTE_MAX = 2000;

/**
 * THE SENTENCE AN ACCEPTANCE TICKS — word for word, beside the box on the
 * link's page, and stored with the answer.
 *
 * One function, so the page and the record cannot disagree: the page shows the
 * text the API sent it, and the API records the text it composed here. It names
 * the CLIENT, because a person accepting a quote for a company is accepting it
 * on that company's behalf, and the tick is what says so.
 */
export function acceptanceStatement(ref: string, clientName: string): string {
  return `I accept proposal ${ref} on behalf of ${clientName}.`;
}
