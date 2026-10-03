// The engagement domain — the letter that creates obligations, and the work it
// sells. Nouns and pure rules; stdlib plus the money vocabulary it shares.
//
// A proposal is what the firm OFFERED. An engagement letter is what both sides
// AGREED. That single difference is why almost everything here is stricter than
// its proposal counterpart:
//
//   · signature FREEZES the document, enforced by a trigger (migration 0017),
//     because "what exactly did they sign" is a question a court asks and an
//     application-level rule cannot answer it against a psql session;
//   · a change after signature is a NEW LETTER, never an edit;
//   · the clauses are PINNED, so the wording resolves to what was agreed rather
//     than to what the library says today.
//
// Like the proposal domain, this file does not add up money — Postgres does,
// exactly once — and it does not know what the firm's clause library contains.
import type { Amount, CurrencyCode } from "../money/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../document/model";
import { isCalendarDay } from "../day";

/**
 * Where a letter has got to.
 *
 * Narrower than a proposal's, and the omissions are the design. There is no
 * `rejected`: a client who declines simply never signs, and the letter is
 * WITHDRAWN by the firm — recording a client's refusal as a state of our own
 * document is a fact we do not have. And there is no `expired`, because a
 * letter does not lapse; the offer that preceded it did.
 */
export type LetterStatus = "draft" | "sent" | "signed" | "withdrawn";

export const LETTER_STATUSES: readonly LetterStatus[] = ["draft", "sent", "signed", "withdrawn"];

/**
 * Whether a letter can be COPIED into a new draft (0316, decided 2026-09-30):
 * a WITHDRAWN one only, which includes one the client declined in DocuSign.
 * A draft is edited, a sent one is still with the client, and a signed one is
 * changed by a letter that supersedes it.
 */
export function isLetterCopyable(status: LetterStatus): boolean {
  return status === "withdrawn";
}

export function isLetterStatus(v: string): v is LetterStatus {
  return (LETTER_STATUSES as readonly string[]).includes(v);
}

/**
 * Whether a letter may move from one status to another.
 *
 * `signed` is terminal in the strongest sense in this codebase: the database
 * refuses to change the row at all afterwards. `withdrawn` is terminal because
 * a letter the firm pulled and then un-pulled would leave no record of the
 * interval in which it was not on the table.
 */
export function canTransition(from: LetterStatus, to: LetterStatus): boolean {
  if (from === "signed" || from === "withdrawn") return false;
  if (from === "draft") return to === "sent" || to === "withdrawn";
  return to === "signed" || to === "withdrawn";
}

/** A letter is editable only while nobody has been asked to sign it. */
export function isEditable(status: LetterStatus): boolean {
  return status === "draft";
}

/**
 * Why this letter may NOT be deleted, or null when it may (0086).
 *
 * Only a DRAFT, and nothing else is needed: nothing can depend on a draft
 * letter — an engagement needs a signature, a signature request needs a send,
 * and only a SIGNED letter is superseded. A letter the client has seen is
 * withdrawn; a signed one is the record of what they agreed.
 */
export type LetterDeletionBlock =
  | { readonly kind: "deleted" }
  | { readonly kind: "not_draft"; readonly status: LetterStatus };

export function letterDeletionBlock(
  letter: Pick<EngagementLetter, "status" | "deletedAt">,
): LetterDeletionBlock | null {
  if (letter.deletedAt !== null) return { kind: "deleted" };
  if (letter.status !== "draft") return { kind: "not_draft", status: letter.status };
  return null;
}

/**
 * Which layout a letter PRINTS in (0083).
 *
 * `classic` is the one-page-flow document every letter issued before 0083 went
 * out in; `annexure` is the firm's own format — a cover letter, Annexure 1
 * (scope, deliverables and a summary of fees by section) and Annexure 2 (the
 * terms). RECORDED on the letter rather than decided at render time, because a
 * rendered letter's bytes are evidence: an issued letter must re-render as the
 * document the client holds, whatever the product prints today.
 *
 * Presentation, not a term — it is not in `canonicalContent`.
 */
export type LetterLayout = "classic" | "annexure";

export const LETTER_LAYOUTS: readonly LetterLayout[] = ["classic", "annexure"];

/** What every letter drafted now is printed in — "switch everyone", 2026-09-26.
 *  The classic layout is kept for the letters issued in it, never offered. */
export const CURRENT_LETTER_LAYOUT: LetterLayout = "annexure";

export function isLetterLayout(v: string): v is LetterLayout {
  return (LETTER_LAYOUTS as readonly string[]).includes(v);
}

/**
 * Where an engagement has got to.
 *
 * `pending_advance` is the START state, not an exception — an engagement whose
 * letter needs no advance simply passes through it in the same transaction.
 * Making it the default means the fee gate is what has to be OPENED, rather
 * than a check somebody has to remember to apply.
 */
export type EngagementStatus =
  | "pending_advance"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = [
  "pending_advance",
  "active",
  "paused",
  "completed",
  "cancelled",
];

export function isEngagementStatus(v: string): v is EngagementStatus {
  return (ENGAGEMENT_STATUSES as readonly string[]).includes(v);
}

export interface EngagementLetter {
  readonly id: string;
  readonly tenantId: string;
  /**
   * What a client quotes back on the phone — `EL-2026-0007`.
   *
   * Unique per firm and never reused. On a letter it matters more than on a
   * proposal: this is the string that appears in the client's own records, in
   * an invoice's narration and in a court filing, and it is frozen with the
   * rest of the document at signature.
   */
  readonly ref: string;
  readonly partyId: string;
  /**
   * Which of the FIRM's own entities is contracting — not the client.
   *
   * The letter's `jurisdiction` says WHERE the work is; this says WHO on our
   * side is bound by it, and the two are not the same question. The letter that
   * started this review was issued by the US entity and printed Indian law,
   * and nothing in the schema could have caught it because nothing knew who had
   * issued it.
   *
   * STORED, not derived: the firm's rule for picking an entity may change, and
   * re-deriving this at read time would silently restate every document already
   * issued. Same argument as `jurisdiction`, and as the pinned clause versions.
   */
  readonly issuingEntityPartyId: string;
  /** The proposal it came from, or null — a renewal or a walk-in has none. */
  readonly proposalId: string | null;
  /** The letter's OWN jurisdiction, chosen when it is drafted. Not derived from
   *  the client's registrations at read time: a legal document records the
   *  jurisdiction it was WRITTEN for, permanently. */
  readonly jurisdiction: string;
  readonly title: string;
  readonly status: LetterStatus;
  /** Which layout it prints in — see `LetterLayout`. Frozen with the rest of a
   *  signed letter, so a re-render reproduces what the client holds. */
  readonly layout: LetterLayout;
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  readonly advanceRequired: boolean;
  readonly advanceAmount: Amount | null;
  readonly advanceRecordedAt: string | null;
  readonly advanceRecordedBy: string | null;
  readonly sentAt: string | null;
  readonly signedAt: string | null;
  /** Who signed, as attested. Personal data — it lives in this erasable row and
   *  must never reach the ledger, whose payloads carry ids only. */
  readonly signedByName: string | null;
  readonly signatureMethod: string | null;
  readonly signatureReference: string | null;
  /** SHA-256 of the canonical rendering at the moment of signing. The pins make
   *  the document reconstructible; this makes it verifiable. */
  readonly signedContentHash: string | null;
  /**
   * The capacity the CLIENT signed in — "Director", "Authorised Signatory".
   *
   * Optional, unlike the rest of the signature: it is not always known when a
   * wet signature is attested afterwards, and a letter recorded without it is
   * still verifiable. That is why it is not part of 0017's whole-signature
   * check.
   */
  readonly signedByTitle: string | null;
  readonly withdrawnAt: string | null;

  // ── The prose the client actually reads (G1.3) ────────────────────────────

  /**
   * The BACKGROUND paragraph — why THIS client is buying THIS, in prose.
   *
   * Every real letter opens with one, and it is the first thing the client
   * reads. It is a TERM in the sense that matters here: it frames what the firm
   * is agreeing to do, so it is inside `canonicalContent` and frozen with the
   * rest of the document at signature.
   */
  readonly background: string | null;
  /**
   * Who the letter is written TO — a named person, care-of the client
   * organization.
   *
   * NOT `partyId`, which is who is BILLED and is unchanged. Until G1.3 the API
   * exposed a computed `addressedTo` STRING (the party's display name), so the
   * document could not address an individual at all: there was no individual to
   * store.
   */
  readonly addressedToPartyId: string | null;
  /** The document's OWN date — what is printed under the letterhead. Distinct
   *  from `sentAt`, which is when this system transmitted it. */
  readonly issuedOn: string | null;
  /**
   * The signed letter this one REPLACES.
   *
   * The model has always refused to edit a signed letter and told the caller to
   * "supersede it with a new letter instead"; this is where that instruction is
   * finally recorded. Only a SIGNED letter may be superseded (a draft is
   * edited, an unsigned sent letter is withdrawn), which is enforced by a
   * trigger in migration 0022 and is also what makes a lineage cycle
   * impossible — every edge points at a row that was already frozen.
   */
  readonly supersedesId: string | null;

  // ── When the work begins (G1.5) ───────────────────────────────────────────

  /** When the engagements this letter opens actually begin. NULL means the
   *  signature date, which is the ordinary case. A line may override it. */
  readonly effectiveFrom: string | null;

  // ── The firm's own signature block (G1.4) ─────────────────────────────────

  /**
   * Who bound the FIRM, in what capacity, and when — the "Yours sincerely,
   * <name>, Director" half that was never modelled.
   *
   * A SNAPSHOT taken when the letter goes out, copied from the firm's standing
   * signatory on `tenancy.tenant`. Snapshot for the same reason
   * `issuingEntityPartyId` is one: naming a successor next year must not
   * restate who signed a letter in 2026.
   *
   * All three or none of them (`el_firm_signature_is_whole_chk`, 0022) — half a
   * signature block is worse than none, because it looks complete.
   *
   * This is a different fact from WHO OPERATED THE SYSTEM. The ledger records
   * the operator as the event's actor and keeps doing so; authority to bind is
   * an audit question about the firm, not about the session.
   */
  readonly firmSignatoryUserId: string | null;
  readonly firmSignatoryTitle: string | null;
  readonly firmSignedAt: string | null;
  /**
   * The firm's signature IMAGE as it stood when this letter went out (0081).
   *
   * A `files.document_version` id, pinned by `markSent` beside the three columns
   * above and for the same reason: replacing the firm's signature must not
   * restate a letter already issued. Resolving it live would mean a successor's
   * mark appearing over a predecessor's printed name the next time an old letter
   * was re-rendered.
   *
   * Deliberately NOT part of `canonicalContent`, alongside `firmSignedAt`: it is
   * presentation of an authority the letter records elsewhere, not a term. The
   * same agreement drawn with a re-scanned signature is the same agreement.
   */
  readonly firmSignatureVersionId: string | null;

  // ── Deleted as a mistake (0086) ───────────────────────────────────────────

  /**
   * When this DRAFT was deleted as made by mistake, or null — before it went out
   * for signature, so no client ever saw it. Not `withdrawn`, which is a letter
   * the client HAS seen and the firm pulled. Off the list of letters, still
   * readable by id, and FINAL. Never a term: absent from `canonicalContent`, and
   * a signed letter can never carry one (the freeze, 0019, covers it).
   */
  readonly deletedAt: string | null;
  /** Who deleted it, for the page. The ledger's `engagement_letter.deleted`
   *  names the actor either way. */
  readonly deletedByUserId: string | null;
  /** The withdrawn letter this draft was COPIED from (0316), or null. Not
   *  `supersedesId`, which names a SIGNED letter this one replaces. */
  readonly copiedFromId: string | null;
}

/**
 * WHEN A RECURRING FEE IS INVOICED, as the letter agrees it (0319): after each
 * period (the firm's default), at its start, or from a date the firm chose.
 * Null on a letter written before 0319 or a line nobody chose for; billing
 * reads that as after each period. The billing domain has the same three words
 * (`BillingTiming`); domains do not import each other, so it is stated twice.
 */
export const LETTER_BILLING_TIMINGS = ["arrears", "advance", "on_date"] as const;
export type LetterBillingTiming = (typeof LETTER_BILLING_TIMINGS)[number];

export function isLetterBillingTiming(value: unknown): value is LetterBillingTiming {
  return typeof value === "string" && (LETTER_BILLING_TIMINGS as readonly string[]).includes(value);
}

/** The frequencies a billing timing means anything for: one billed per period. */
export const TIMED_FREQUENCIES: readonly string[] = ["monthly", "quarterly", "annually"];

export interface LetterLine {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  /**
   * WHOSE entity the work is delivered to — the other half of the line, and the
   * one this model went four tasks without.
   *
   * An engagement is `service × ONE LEGAL ENTITY` (the firm's own "Per Company"
   * rule), so vCFO for a group of four companies is four lines, not one. It is
   * NOT the client: `EngagementLetter.partyId` is who is billed, this is who the
   * work is done for, and the compliance calendar keys on the second because an
   * entity owes GSTR-3B and a client does not.
   */
  readonly entityPartyId: string;
  /** The frozen catalogue version. The agreed price may differ from the quoted
   *  one — which is why the money is here — but the SERVICE is the same row. */
  readonly serviceVersionId: string;
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  /**
   * The price agreed, per unit of the service's billing basis — or NULL.
   *
   * NULLABLE since G1.6, and on a LETTER that is the sharper case: "as mutually
   * agreed" is a term two parties signed, and the column being `NOT NULL CHECK
   * (>= 0)` meant it had to be recorded as ZERO, which is a different agreement.
   *
   * NULL IS NOT ZERO ANYWHERE DOWNSTREAM: an unpriced line contributes nothing
   * to the letter's totals and is COUNTED instead — see the totals on
   * `LetterRecord`. `pricingNote` is required when this is null (0023).
   */
  readonly unitAmount: Amount | null;
  readonly currency: CurrencyCode;
  /** Zero when there is no price — a discount off "as mutually agreed" is not a
   *  number, and the database refuses one (0023). */
  readonly discountPercent: Amount;
  /**
   * WHERE THE WORK IS. On a letter this is the entity's own jurisdiction,
   * carried so a letter and the proposal it came from print and group the same
   * way. Stated rather than derived — see the note on `ProposalLine`.
   */
  readonly jurisdiction: string | null;
  /** How often THIS DEAL is billed. Defaulted from the pinned service's
   *  `recurrence` and freely different from it: a monthly service billed
   *  quarterly is an arrangement the firm has today. */
  readonly billingFrequency: BillingFrequency | null;
  /** When it is invoiced (0319); null = not chosen (after each period). Only
   *  for a monthly, quarterly or yearly fee. A grouped line is billed with its
   *  group, whose timing is the one that counts. */
  readonly billingTiming: LetterBillingTiming | null;
  /** The first invoice date, with `on_date` and only with it. */
  readonly billingOn: string | null;
  /** This service's OWN advance, before tax (0320), or null. Never on a grouped
   *  line, and never on a letter that asks for one advance for the whole of it:
   *  the engagement it becomes waits for this advance alone. */
  readonly advanceAmount: Amount | null;
  /**
   * THE FOUR OVERRIDES — this letter's own wording for the four scope blocks,
   * or null to print the pinned catalogue version's words.
   *
   * WHAT MAKES A SIGNED LETTER REPRODUCIBLE, and the reason this matters more
   * here than on a proposal: the letter carries the words, so a catalogue
   * revision next year cannot change what the client agreed to. The signature
   * commits to them — they are in `canonicalContent` — and the freeze then makes
   * them unwritable.
   */
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  /** The out-of-pocket range, in its own currency: reimbursed at ACTUALS,
   *  separate from the fee, never summed into a total. */
  readonly oopEstimate: OutOfPocketEstimate | null;
  /** WHY there is no amount. Required when `unitAmount` is null (0023) — a
   *  signed line that says neither a price nor why is a term nobody can read —
   *  unless the line is in a fee group, whose fee is the reason. */
  readonly pricingNote: string | null;
  /**
   * When THIS line's work begins, when it differs from the rest of the letter.
   *
   * Null means "whatever the letter says". Per line as well as per document
   * because per line can express a single shared date and the reverse cannot:
   * an Incorporation line starts the day it is signed while the GST line beside
   * it starts next period.
   */
  readonly effectiveFrom: string | null;
  /**
   * The FEE GROUP that prices this line, or null for a line priced on its own
   * (0083).
   *
   * A grouped line carries no price and no discount of its own — the group's
   * fee covers it and every other service in the group, stated once. The
   * database refuses anything else (`el_line_grouped_is_unpriced_chk`), because
   * a price on both would be counted twice.
   */
  readonly feeGroupId: string | null;
}

/**
 * ONE FEE FOR SEVERAL SERVICES — a section of the letter's Annexure 1 (0083).
 *
 * "USD 5,000 per month" for accounting, tax and payroll across four companies is
 * one fee on twelve lines: an engagement is one service for one legal entity
 * (G0.1), and before this the only way to write the retainer down was twelve
 * prices nobody agreed to. The group states the fee; its lines state the work.
 *
 * It is also the SECTION the letter prints: its title is the heading ("B.
 * Ongoing recurring services"), its prose is what the section says about
 * itself, and its fee is the section's row in the Summary of Fees. Its letter —
 * A, B, … — is its rank among the letter's live groups, derived when it is read
 * (`sectionCode`) so that striking one out never leaves a gap.
 *
 * A TERM. The signature commits to all of it (`canonicalContent`) and the
 * freeze makes it unwritable once the letter is signed.
 */
export interface FeeGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  readonly position: number;
  readonly title: string;
  /** How often the fee is billed. Required — a fee with no period is not one
   *  anybody can invoice. */
  readonly billingFrequency: BillingFrequency;
  /** When the group's fee is invoiced (0319), as on a line. */
  readonly billingTiming: LetterBillingTiming | null;
  readonly billingOn: string | null;
  /** PER BILLING PERIOD: 5,000 on a monthly group is 5,000 a month. */
  readonly amount: Amount;
  readonly currency: CurrencyCode;
  /** "40% advance, 60% on completion" — how the fee is paid, as the firm
   *  writes it. */
  readonly paymentTerms: string | null;
  /** What the Summary of Fees says this row is for. Null prints the title and
   *  the services the group covers. */
  readonly feeDescription: string | null;
  /** The paragraph under the section's heading. */
  readonly intro: string | null;
  /** What the section delivers, as a whole. */
  readonly deliverables: string | null;
  /** What the client must do for the section as a whole. Each service's own
   *  responsibilities stay on its line. */
  readonly clientObligations: string | null;
}

/**
 * A section's letter from its rank among the letter's live groups: 0 → "A",
 * 25 → "Z", 26 → "AA". Derived, never stored, so a section struck out of a
 * draft does not leave the letter starting at B.
 */
export function sectionCode(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`a section index is a non-negative integer, got ${String(index)}`);
  }
  let n = index;
  let code = "";
  do {
    code = String.fromCharCode(65 + (n % 26)) + code;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return code;
}

export interface LetterClause {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  /** The PINNED clause version — what was agreed, not what the library says
   *  today. */
  readonly clauseVersionId: string;
  readonly position: number;
}

export interface Engagement {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  readonly engagementLetterLineId: string;
  /** Who is BILLED — the client the letter was written to. */
  readonly partyId: string;
  /**
   * Who the work is DELIVERED TO, carried across from the line it fanned out
   * from. Both, deliberately: invoicing (T3.4) reads the first, the compliance
   * calendar (T3.2) reads the second, and collapsing them is what left
   * `core.legal_entity` reachable from nothing downstream.
   */
  readonly entityPartyId: string;
  /**
   * The COMMERCIAL gates: `pending_advance` until the letter's advance is
   * recorded, then `active`. It does NOT say whether work has begun — see
   * `effectiveFrom` and `engagementState`.
   */
  readonly status: EngagementStatus;
  /** When the commercial gates opened — signature, or the moment the advance
   *  was recorded. Not when work starts. */
  readonly activatedAt: string | null;
  /**
   * When work on this engagement BEGINS, resolved once at signature from
   * line → letter → signature date and then stored.
   *
   * Stored rather than re-derived through two joins because it is a term of a
   * FROZEN contract: the letter can never change, so neither can the answer,
   * and the delivery lane should not have to reconstruct it. It travels on
   * `contract.activated` for exactly that reason.
   */
  readonly effectiveFrom: string;
  /** The LAST day the firm serves it (inclusive), once it has been ended
   *  (V2.3, 0314). Periods starting after it get no job and no filing. */
  readonly endsOn: string | null;
  /** Why it ended, in the firm's words. On the row only, never the ledger. */
  readonly endReason: string | null;
  /** When the end was recorded. */
  readonly endedAt: string | null;
  /** When it was paused, while it is paused. */
  readonly pausedAt: string | null;
  /** The firm's day it last resumed after a pause. A recurring period that
   *  ended before it fell inside the pause and is never spawned. */
  readonly resumedOn: string | null;
  /** The firm's day the LAST pause began (0318). Kept after the resume, unlike
   *  `pausedAt`, so a period half served before a pause is billed pro-rata. */
  readonly pausedOn: string | null;
  /** The first day of the FIRST period billed (0318). Nothing before it is
   *  billed, which makes it this client's billing go-live. Null with
   *  `firstInvoiceOn`: billing not set up. */
  readonly billingFrom: string | null;
  /** The date the invoice for the period starting `billingFrom` falls due;
   *  each later period one billing span after it (0318). */
  readonly firstInvoiceOn: string | null;
}

/** The longest reason an end may carry, as the database's CHECK says (0314). */
export const END_REASON_MAX = 1000;

/**
 * The status an ended engagement takes (V2.3). `completed` when the firm
 * served it for at least a day; `cancelled` when the end falls BEFORE the day
 * its work was to begin, so nothing was ever delivered. Days are ISO, so the
 * comparison is chronological.
 */
export function endStatusFor(
  engagement: Pick<Engagement, "effectiveFrom">,
  endsOn: string,
): "completed" | "cancelled" {
  return endsOn < engagement.effectiveFrom ? "cancelled" : "completed";
}

/** Still running or able to run: an end, a pause or a resume applies to it. */
export function isLive(status: EngagementStatus): boolean {
  return status === "pending_advance" || status === "active" || status === "paused";
}

// ── Pure rules ───────────────────────────────────────────────────────────────
//
// (The fee gate `mayActivate` lived here until 0322: a letter that required an
// advance released its engagements only once it was recorded. Since 0322 the
// signature starts the work and the advance is chased, not waited for.)

/**
 * What an engagement is doing TODAY.
 *
 * `EngagementStatus` is what is STORED, and it answers the commercial
 * question — has the client signed, and has the advance been paid. Whether work
 * has BEGUN is a different question, answered by the calendar: an engagement
 * whose letter says the work starts in October is agreed, paid for and not
 * started.
 *
 * `pending_start` is therefore a state and never a status: it is computed, it
 * is never written to a row, and nothing has to transition out of it. That is
 * deliberate. A stored `pending_start` would need something to move it to
 * `active` on the day, and nothing in this service runs on a timer — the same
 * constraint that makes `proposal.expired` lazy. A stored state nothing can
 * leave would silently strand every future-dated engagement, which is worse
 * than the problem it was added to fix.
 */
export type EngagementState = EngagementStatus | "pending_start";

/**
 * The stored status, narrowed by the effective date.
 *
 * Only `active` narrows: an engagement still waiting on its advance is
 * `pending_advance` whatever the calendar says (the money gate comes first, and
 * saying "starting soon" about work nobody has paid for would be the wrong
 * reassurance), and paused / completed / cancelled are decisions that outrank a
 * date.
 *
 * Dates are ISO days, so a lexicographic comparison IS a chronological one.
 */
export function engagementState(
  engagement: Pick<Engagement, "status" | "effectiveFrom">,
  today: string,
): EngagementState {
  if (engagement.status === "active" && engagement.effectiveFrom > today) return "pending_start";
  return engagement.status;
}

/**
 * When one line's work begins: the line, or the letter, or the signature.
 *
 * Stated here rather than inline at the fan-out because it is the rule G1.5 is
 * about, and because "null on the line means the letter, null on the letter
 * means the signature date" is the kind of two-level default that gets written
 * differently the second time somebody needs it.
 */
export function resolveEffectiveFrom(
  lineEffectiveFrom: string | null,
  letterEffectiveFrom: string | null,
  signatureDay: string,
): string {
  return lineEffectiveFrom ?? letterEffectiveFrom ?? signatureDay;
}

/**
 * An ISO calendar day that EXISTS, as this product stores and compares one.
 *
 * It took 2026-02-31 until 2026-10-03 (B43): V8 parses it and rolls it into
 * March, Postgres then refused the cast (22008) and the caller got a 500. Both
 * names are the shared rule in `domain/day.ts` now; `isCalendarDay` was the
 * strict one V2.3 added beside it.
 */
export function isDay(v: string): boolean {
  return isCalendarDay(v);
}

export { isCalendarDay };

/** The billing timing as a hash field, or nothing at all when none was
 *  chosen, so a letter from before 0319 keeps its hash. */
function timingField(x: {
  readonly billingTiming: LetterBillingTiming | null;
  readonly billingOn: string | null;
}): string[] {
  if (x.billingTiming === null) return [];
  return [`billing:${x.billingTiming}${x.billingOn === null ? "" : ` ${x.billingOn}`}`];
}

/**
 * The canonical rendering of a letter, for hashing.
 *
 * Deterministic and boring on purpose: this is what `signedContentHash`
 * commits to, so it has to produce identical bytes for identical terms on any
 * machine, today and in five years. Sorted by position, tab-separated, no JSON
 * — a serialiser that might one day reorder keys would silently invalidate
 * every signature ever taken.
 *
 * It commits to the TERMS, not to presentation: the money, the pinned service
 * and clause versions, the entity each line is for, the jurisdiction, the
 * currency. A firm restyling its letter template does not and must not change
 * what the client agreed to.
 *
 * The REFERENCE and the ISSUING ENTITY are in here for the same reason the
 * line's entity is. The reference is how the client identifies the document
 * they signed, so a hash that did not cover it would verify a document nobody
 * could name. The issuing entity is WHO they contracted with — the most basic
 * term there is, and the one the original letter got wrong.
 *
 * The ENTITY is in here because it is a term, and one of the most material: the
 * same service for a different company of the same group is a different
 * agreement at a different price. A signature that did not commit to it would
 * leave the one dimension the delivery lane schedules against outside the thing
 * the hash proves.
 *
 * G1.6's LINE DETAIL joined the line's fields for the same reason, and the four
 * scope OVERRIDES are the ones that had to: they are the wording this client
 * agreed to, and a hash that did not cover them would verify a document whose
 * scope was whatever the catalogue happened to say. The cost is stated rather
 * than hidden: this rendering now produces different bytes than it did before
 * G1.6, so a hash taken earlier cannot be re-derived from it. Nothing in the
 * product re-derives one — the fingerprint is stored and the freeze (0017) is
 * what actually holds a signed letter still — and a signature that did not cover
 * the client's own scope wording was the worse of the two.
 *
 * FEE GROUPS (0083) are terms of the same weight as a line's price — the fee,
 * how often it is billed, how it is paid, and every word the section prints —
 * and WHICH lines a group covers is part of the fee's meaning. So each group is
 * a row of its own, naming its member lines by position.
 *
 * They are appended ONLY WHEN THERE ARE ANY, and a line's membership lives on
 * the group's row rather than as a new field on every line's. That is not
 * tidiness: DocuSign verifies a completed envelope against the hash this
 * function produces at signature, so a letter sent before 0083 and signed after
 * it must render to the same string at both moments. A letter with no groups
 * renders exactly as it did.
 */
export function canonicalContent(input: {
  readonly letter: Pick<
    EngagementLetter,
    | "ref"
    | "issuingEntityPartyId"
    | "jurisdiction"
    | "title"
    | "currency"
    | "fxRate"
    | "advanceRequired"
    | "advanceAmount"
    | "background"
    | "addressedToPartyId"
    | "issuedOn"
    | "supersedesId"
    | "effectiveFrom"
    | "firmSignatoryUserId"
    | "firmSignatoryTitle"
  >;
  readonly lines: readonly (Pick<
    LetterLine,
    | "position"
    | "entityPartyId"
    | "serviceVersionId"
    | "description"
    | "quantity"
    | "unitAmount"
    | "discountPercent"
    | "effectiveFrom"
    | "jurisdiction"
    | "billingFrequency"
    | "scopeOverride"
    | "clientObligationsOverride"
    | "volumeLimitsOverride"
    | "exclusionsOverride"
    | "oopEstimate"
    | "pricingNote"
    | "feeGroupId"
    | "billingTiming"
    | "billingOn"
  > &
    Partial<Pick<LetterLine, "advanceAmount">>)[];
  readonly feeGroups: readonly Pick<
    FeeGroup,
    | "id"
    | "position"
    | "title"
    | "billingFrequency"
    | "amount"
    | "paymentTerms"
    | "feeDescription"
    | "intro"
    | "deliverables"
    | "clientObligations"
    | "billingTiming"
    | "billingOn"
  >[];
  readonly clauses: readonly Pick<LetterClause, "position" | "clauseVersionId">[];
}): string {
  const head = [
    "letter",
    input.letter.ref,
    input.letter.issuingEntityPartyId,
    input.letter.title,
    input.letter.jurisdiction,
    input.letter.currency,
    input.letter.fxRate,
    String(input.letter.advanceRequired),
    input.letter.advanceAmount ?? "",
    // G1.3–G1.5, and every one of them is a TERM rather than presentation.
    // The background frames what the firm agreed to do; the addressee is who
    // the promise was made to; the issue date is the document's own date; the
    // superseded letter says which agreement this one replaces, which is as
    // material as anything on the page; the effective date is when the
    // obligations start. A signature that did not commit to them would verify
    // a document that could still have any of them changed underneath it.
    //
    // The firm's SIGNATORY and their CAPACITY are here for the same reason the
    // issuing entity is: who bound the firm, and on what authority. The
    // TIMESTAMP of that signature is deliberately absent — it is metadata about
    // the act, not a term, and the same letter signed a minute later is the
    // same agreement.
    input.letter.background ?? "",
    input.letter.addressedToPartyId ?? "",
    input.letter.issuedOn ?? "",
    input.letter.supersedesId ?? "",
    input.letter.effectiveFrom ?? "",
    input.letter.firmSignatoryUserId ?? "",
    input.letter.firmSignatoryTitle ?? "",
  ].join("\t");

  const lines = [...input.lines]
    .sort((a, b) => a.position - b.position)
    .map((l) =>
      [
        "line",
        String(l.position),
        l.entityPartyId,
        l.serviceVersionId,
        l.description,
        l.quantity,
        // Empty for an unpriced line. "As mutually agreed" and "agreed at zero"
        // are different terms, and `pricingNote` two fields down is what carries
        // the difference into the hash.
        l.unitAmount ?? "",
        l.discountPercent,
        // A line that starts three months after the rest of the letter is a
        // different agreement from one that starts with it.
        l.effectiveFrom ?? "",
        // G1.6's line detail, and every one of these is a TERM. THE FOUR
        // OVERRIDES ABOVE ALL: they are the wording this client agreed to, and
        // a signature that did not commit to them would verify a document whose
        // scope was whatever the catalogue happened to say. That is the exact
        // failure the overrides exist to prevent, so leaving them outside the
        // hash would have been the freeze protecting the wrong thing.
        //
        // The jurisdiction and the billing frequency are terms for the same
        // reason the currency is; the out-of-pocket range is what the client was
        // told to expect to reimburse; the pricing note is the sentence that
        // stands where a price would.
        l.jurisdiction ?? "",
        l.billingFrequency ?? "",
        l.scopeOverride ?? "",
        l.clientObligationsOverride ?? "",
        l.volumeLimitsOverride ?? "",
        l.exclusionsOverride ?? "",
        l.oopEstimate === null
          ? ""
          : `${l.oopEstimate.currency} ${l.oopEstimate.min} ${l.oopEstimate.max}`,
        l.pricingNote ?? "",
        // WHEN it is invoiced (0319) is a term too, and added ONLY WHEN SET, as
        // the fee-group rows were in 0083: a letter signed before 0319 hashes
        // exactly as it did.
        ...timingField(l),
        // The service's own advance (0320), the same way: only when set.
        ...(l.advanceAmount === undefined || l.advanceAmount === null ? [] : [`advance:${l.advanceAmount}`]),
      ].join("\t"),
    );

  const feeGroups = [...input.feeGroups]
    .sort((a, b) => a.position - b.position)
    .map((g) =>
      [
        "feegroup",
        String(g.position),
        g.title,
        g.billingFrequency,
        g.amount,
        g.paymentTerms ?? "",
        g.feeDescription ?? "",
        g.intro ?? "",
        g.deliverables ?? "",
        g.clientObligations ?? "",
        // The lines this fee pays for, by POSITION — the same identity the
        // line rows above use. Moving a service from one group to another
        // changes what each fee covers, and that is a different agreement.
        input.lines
          .filter((l) => l.feeGroupId === g.id)
          .map((l) => l.position)
          .sort((a, b) => a - b)
          .join(","),
        ...timingField(g),
      ].join("\t"),
    );

  const clauses = [...input.clauses]
    .sort((a, b) => a.position - b.position)
    .map((c) => ["clause", String(c.position), c.clauseVersionId].join("\t"));

  return [head, ...lines, ...feeGroups, ...clauses].join("\n");
}

/** A jurisdiction code, as this product stores it: ISO 3166-1 alpha-2.
 *
 *  ONE implementation, in `domain/document/model.ts`, since G1.6 put a
 *  jurisdiction on both documents' LINES as well as on this letter's head. Two
 *  copies of the rule is two places for it to drift. Re-exported rather than
 *  moved so every existing caller keeps importing it from the domain it belongs
 *  to. */
export { isJurisdiction, normalizeJurisdiction } from "../document/model";

/**
 * Whether a clause applies in a jurisdiction.
 *
 * An empty list means everywhere, matching the service catalogue's reading of
 * the same field. Deliberately permissive: a clause the firm wrote and did not
 * scope is one it means to use, and refusing to offer it would look like the
 * library was empty.
 */
export function clauseApplies(clauseJurisdictions: readonly string[], letter: string): boolean {
  return clauseJurisdictions.length === 0 || clauseJurisdictions.includes(letter);
}
