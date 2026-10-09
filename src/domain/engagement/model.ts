// Engagement domain: the letter that creates obligations, and the work it sells. A proposal is
// what the firm OFFERED; a letter is what both sides AGREED, so it is stricter: signature
// FREEZES it by trigger (0017; "what exactly did they sign" must hold even against psql), a
// change after signature is a NEW letter, and clauses are PINNED to the agreed wording.
// Postgres adds up the money; this file does not know the clause library's contents.
import type { Amount, CurrencyCode, CurrencyRate } from "../money/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../document/model";
import { isCalendarDay } from "../day";

/**
 * Where a letter has got to. No `rejected`: a client who declines never signs and the firm
 * WITHDRAWS it (their refusal is not a fact we hold). No `expired`: the offer lapses, not the letter.
 */
export type LetterStatus = "draft" | "sent" | "signed" | "withdrawn";

export const LETTER_STATUSES: readonly LetterStatus[] = ["draft", "sent", "signed", "withdrawn"];

/** Only a WITHDRAWN letter (incl. one declined in DocuSign) is copied into a new draft (0316,
 *  2026-09-30); a draft is edited, a sent one is with the client, a signed one is superseded. */
export function isLetterCopyable(status: LetterStatus): boolean {
  return status === "withdrawn";
}

export function isLetterStatus(v: string): v is LetterStatus {
  return (LETTER_STATUSES as readonly string[]).includes(v);
}

/** `signed` is terminal (the database refuses any change to the row); `withdrawn` is terminal
 *  so a pulled-then-restored letter cannot hide the interval it was off the table. */
export function canTransition(from: LetterStatus, to: LetterStatus): boolean {
  if (from === "signed" || from === "withdrawn") return false;
  if (from === "draft") return to === "sent" || to === "withdrawn";
  return to === "signed" || to === "withdrawn";
}

/** A letter is editable only while nobody has been asked to sign it. */
export function isEditable(status: LetterStatus): boolean {
  return status === "draft";
}

/** Why a letter may NOT be deleted, or null (0086): only a DRAFT may be, as nothing depends on
 *  one. A letter the client has seen is withdrawn; a signed one is the record. */
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
 * Which layout a letter prints in (0083): `classic` (one-page flow, letters before 0083) or
 * `annexure` (cover letter, Annexure 1 scope/deliverables/fee summary by section, Annexure 2
 * terms). RECORDED, not decided at render, so an issued letter re-renders as the client holds it.
 * Presentation, not a term: not in `canonicalContent`.
 */
export type LetterLayout = "classic" | "annexure";

export const LETTER_LAYOUTS: readonly LetterLayout[] = ["classic", "annexure"];

/** What every new letter prints in ("switch everyone", 2026-09-26); classic is kept for the
 *  letters issued in it, never offered. */
export const CURRENT_LETTER_LAYOUT: LetterLayout = "annexure";

export function isLetterLayout(v: string): v is LetterLayout {
  return (LETTER_LAYOUTS as readonly string[]).includes(v);
}

/** `pending_advance` is the START state (a letter with no advance passes through it in the same
 *  transaction), so the fee gate is something to OPEN, not a check to remember. */
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
  /** `EL-2026-0007`: unique per firm, never reused, frozen at signature (it appears in client
   *  records, invoice narration and court filings). */
  readonly ref: string;
  readonly partyId: string;
  /**
   * Which of the FIRM's entities contracts (not the client). `jurisdiction` is WHERE the work is;
   * this is WHO on our side is bound (a US-entity letter once printed Indian law). STORED, not
   * derived, so a changed picking rule never restates issued documents.
   */
  readonly issuingEntityPartyId: string;
  /** The proposal it came from, or null — a renewal or a walk-in has none. */
  readonly proposalId: string | null;
  /** The letter's OWN jurisdiction, chosen at draft and recorded permanently; not derived from
   *  the client's registrations. */
  readonly jurisdiction: string;
  readonly title: string;
  readonly status: LetterStatus;
  /** See `LetterLayout`; frozen with a signed letter. */
  readonly layout: LetterLayout;
  /** The MAIN currency, and `fxRate` its rate to the firm's reporting
   *  currency. Since 0344 a line or a section may be priced in another one the
   *  letter holds a rate for, in `rates` (never one for the main currency). */
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  readonly rates: readonly CurrencyRate[];
  readonly advanceRequired: boolean;
  readonly advanceAmount: Amount | null;
  readonly advanceRecordedAt: string | null;
  readonly advanceRecordedBy: string | null;
  readonly sentAt: string | null;
  readonly signedAt: string | null;
  /** Personal data: lives on this erasable row, never in the ledger (ids only). */
  readonly signedByName: string | null;
  readonly signatureMethod: string | null;
  readonly signatureReference: string | null;
  /** SHA-256 of the canonical rendering at signing: the pins make it reconstructible, this verifiable. */
  readonly signedContentHash: string | null;
  /** The CLIENT signatory's capacity ("Director"). Optional, so outside 0017's whole-signature
   *  check: often unknown when a wet signature is attested afterwards. */
  readonly signedByTitle: string | null;
  readonly withdrawnAt: string | null;

  // The prose the client reads (G1.3).

  /** The opening BACKGROUND paragraph (why this client buys this). A TERM: in
   *  `canonicalContent`, frozen at signature. */
  readonly background: string | null;
  /** The named person the letter is written TO, care of the client. Not `partyId` (who is BILLED). */
  readonly addressedToPartyId: string | null;
  /** The document's own printed date; `sentAt` is when this system transmitted it. */
  readonly issuedOn: string | null;
  /** The SIGNED letter this one replaces. Only a signed letter may be superseded (trigger, 0022),
   *  which also rules out a lineage cycle: every edge points at a frozen row. */
  readonly supersedesId: string | null;

  // When the work begins (G1.5).

  /** When the engagements this letter opens actually begin. NULL means the
   *  signature date, which is the ordinary case. A line may override it. */
  readonly effectiveFrom: string | null;

  // The firm's own signature block (G1.4).

  /**
   * Who bound the FIRM, in what capacity, and when: a SNAPSHOT at send from the firm's standing
   * signatory on `tenancy.tenant`, so a successor never restates a 2026 letter. All three or none
   * (`el_firm_signature_is_whole_chk`, 0022): half a block looks complete. Not the system
   * operator, who is the ledger event's actor.
   */
  readonly firmSignatoryUserId: string | null;
  readonly firmSignatoryTitle: string | null;
  readonly firmSignedAt: string | null;
  /** The firm's signature IMAGE at send (0081): a `files.document_version` id pinned by
   *  `markSent` so a replaced signature never restates an issued letter. Presentation, not in
   *  `canonicalContent`. */
  readonly firmSignatureVersionId: string | null;

  // Deleted as a mistake (0086).

  /** When this DRAFT was deleted as a mistake (no client saw it; not `withdrawn`). Off the list,
   *  readable by id, FINAL; never a term, and a signed letter cannot carry one (0019). */
  readonly deletedAt: string | null;
  /** Who deleted it, for the page; the ledger's `engagement_letter.deleted` names the actor. */
  readonly deletedByUserId: string | null;
  /** The withdrawn letter this draft was COPIED from (0316), or null. Not
   *  `supersedesId`, which names a SIGNED letter this one replaces. */
  readonly copiedFromId: string | null;
  /** The drafter's choice of firm signatory (0343, Q005), or null for the default at send, so the
   *  preview prints the right name; `send` snapshots it into the columns above. Not in
   *  `canonicalContent`: that would move every in-flight letter's hash. */
  readonly chosenSignatoryId: string | null;
}

/**
 * When a recurring fee is invoiced (0319): at period end on its last day (the default; Q042), at
 * its start, or from a chosen date. Null (pre-0319 or not chosen) bills at period end. Billing's
 * `BillingTiming` has the same words; domains do not import each other.
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
  /** WHOSE entity the work is for. An engagement is service x ONE legal entity ("Per Company"),
   *  so four companies are four lines. Not the client (`partyId` is billed); the compliance
   *  calendar keys on this, as an entity owes GSTR-3B and a client does not. */
  readonly entityPartyId: string;
  /** The frozen catalogue version. The agreed price may differ from the quoted
   *  one — which is why the money is here — but the SERVICE is the same row. */
  readonly serviceVersionId: string;
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  /** The agreed price per billing-basis unit, or NULL for "as mutually agreed" (G1.6; zero is a
   *  different agreement). NULL is not zero downstream: unpriced lines are COUNTED, not summed
   *  (see `LetterRecord` totals); `pricingNote` is required when null (0023). */
  readonly unitAmount: Amount | null;
  readonly currency: CurrencyCode;
  /** Zero when unpriced: a discount off "as mutually agreed" is not a number (0023). */
  readonly discountPercent: Amount;
  /** WHERE THE WORK IS: the entity's own jurisdiction, stated not derived (see `ProposalLine`). */
  readonly jurisdiction: string | null;
  /** How often this deal is billed; defaults from the service's `recurrence` but may differ
   *  (a monthly service billed quarterly). */
  readonly billingFrequency: BillingFrequency | null;
  /** When it is invoiced (0319); null = at each period's end. Monthly, quarterly or yearly fees
   *  only; a grouped line follows its group's timing. */
  readonly billingTiming: LetterBillingTiming | null;
  /** The first invoice date, with `on_date` and only with it. */
  readonly billingOn: string | null;
  /** This service's own advance before tax (0320), or null. Never on a grouped line or on a
   *  letter with one advance for the whole; its engagement waits for this advance alone. */
  readonly advanceAmount: Amount | null;
  /** This letter's own wording for the four scope blocks, or null for the pinned catalogue
   *  version's. Hashed and frozen, so a catalogue revision cannot change what the client signed. */
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  /** The out-of-pocket range, in its own currency: reimbursed at ACTUALS,
   *  separate from the fee, never summed into a total. */
  readonly oopEstimate: OutOfPocketEstimate | null;
  /** WHY there is no amount; required when `unitAmount` is null (0023) unless the line is in a
   *  fee group, whose fee is the reason. */
  readonly pricingNote: string | null;
  /** When THIS line's work begins, or null for the letter's: an Incorporation line starts at
   *  signature while the GST line beside it starts next period. */
  readonly effectiveFrom: string | null;
  /** The FEE GROUP pricing this line (0083), or null. A grouped line has no price or discount of
   *  its own (`el_line_grouped_is_unpriced_chk`), or it would be counted twice. */
  readonly feeGroupId: string | null;
}

/**
 * One fee for several services: a section of Annexure 1 (0083). "USD 5,000 per month" for
 * accounting, tax and payroll across four companies is one fee on twelve lines (an engagement is
 * one service x one entity, G0.1). Its title heads the section, its fee is the Summary of Fees
 * row, its letter (A, B, ...) is derived on read (`sectionCode`). A TERM: hashed and frozen.
 */
export interface FeeGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  readonly position: number;
  readonly title: string;
  /** Required: a fee with no period cannot be invoiced. */
  readonly billingFrequency: BillingFrequency;
  /** When the group's fee is invoiced (0319), as on a line. */
  readonly billingTiming: LetterBillingTiming | null;
  readonly billingOn: string | null;
  /** PER BILLING PERIOD: 5,000 on a monthly group is 5,000 a month. */
  readonly amount: Amount;
  readonly currency: CurrencyCode;
  /** How the fee is paid, in the firm's words ("40% advance, 60% on completion"). */
  readonly paymentTerms: string | null;
  /** The Summary of Fees row text; null prints the title and the services covered. */
  readonly feeDescription: string | null;
  /** The paragraph under the section's heading. */
  readonly intro: string | null;
  /** What the section delivers, as a whole. */
  readonly deliverables: string | null;
  /** What the client must do for the section as a whole. Each service's own
   *  responsibilities stay on its line. */
  readonly clientObligations: string | null;
}

/** A section's letter from its rank among live groups: 0 -> "A", 25 -> "Z", 26 -> "AA". Never
 *  stored, so striking a section out leaves no gap. */
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
  /** The PINNED clause version: what was agreed, not what the library says today. */
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
  /** Who the work is DELIVERED TO, from the line. Invoicing (T3.4) reads `partyId`; the
   *  compliance calendar (T3.2) reads this. */
  readonly entityPartyId: string;
  /** The COMMERCIAL gate: `pending_advance` until the advance is recorded, then `active`. Not
   *  whether work began (see `effectiveFrom`, `engagementState`). */
  readonly status: EngagementStatus;
  /** When the commercial gates opened (signature or advance recorded); not when work starts. */
  readonly activatedAt: string | null;
  /** When work BEGINS: resolved once at signature (line -> letter -> signature date) and stored,
   *  as the frozen contract cannot change it. Travels on `contract.activated`. */
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
  /** First day of the FIRST billed period (0318): this client's billing go-live. Null with
   *  `firstInvoiceOn`: billing not set up. */
  readonly billingFrom: string | null;
  /** The date the invoice for the period starting `billingFrom` falls due;
   *  each later period one billing span after it (0318). */
  readonly firstInvoiceOn: string | null;
}

/** The longest reason an end may carry, as the database's CHECK says (0314). */
export const END_REASON_MAX = 1000;

/** `completed` if served at least a day; `cancelled` if the end falls BEFORE work was to begin
 *  (V2.3). ISO days compare chronologically. */
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

// Pure rules. Since 0322 the signature starts the work; an advance is chased, not waited for.

/**
 * What an engagement is doing TODAY. The stored status answers the commercial question; whether
 * work has BEGUN is the calendar's. `pending_start` is computed, never stored: nothing runs on a
 * timer to move it to `active` (like lazy `proposal.expired`), so a stored one would strand every
 * future-dated engagement.
 */
export type EngagementState = EngagementStatus | "pending_start";

/** Only `active` narrows to `pending_start`: `pending_advance` stays (money comes first), and
 *  paused/completed/cancelled outrank a date. ISO days compare lexicographically. */
export function engagementState(
  engagement: Pick<Engagement, "status" | "effectiveFrom">,
  today: string,
): EngagementState {
  if (engagement.status === "active" && engagement.effectiveFrom > today) return "pending_start";
  return engagement.status;
}

/** When a line's work begins: line, else letter, else signature day (G1.5). The one statement of
 *  this two-level default. */
export function resolveEffectiveFrom(
  lineEffectiveFrom: string | null,
  letterEffectiveFrom: string | null,
  signatureDay: string,
): string {
  return lineEffectiveFrom ?? letterEffectiveFrom ?? signatureDay;
}

/** An ISO calendar day that EXISTS. 2026-02-31 passed until B43 (2026-10-03): V8 rolled it into
 *  March, Postgres refused the cast (22008), a 500. Both names are `domain/day.ts`'s rule. */
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
 * The canonical rendering `signedContentHash` commits to: identical bytes for identical terms on
 * any machine, for years. Sorted by position, tab-separated, no JSON (a serialiser that reorders
 * keys would void every signature). TERMS, not presentation: money, pinned service and clause
 * versions, each line's entity (same service, other company = other agreement), jurisdiction,
 * currency, the ref (how the client names it) and the issuing entity (who they contracted with).
 * G1.6 added line detail incl. the four scope overrides, so pre-G1.6 hashes cannot be re-derived;
 * nothing re-derives one (it is stored; 0017 freezes the letter). Everything added since (fee
 * groups 0083, timing 0319, line advance 0320, other currencies 0344, advances received 0363) is
 * appended ONLY WHEN PRESENT: DocuSign verifies a completed envelope against this hash, so a
 * letter sent before a change and signed after must hash the same.
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
  > &
    Partial<Pick<EngagementLetter, "rates">>;
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
    Partial<Pick<LetterLine, "advanceAmount" | "currency">>)[];
  readonly feeGroups: readonly (Pick<
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
  > &
    Partial<Pick<FeeGroup, "currency">>)[];
  readonly clauses: readonly Pick<LetterClause, "position" | "clauseVersionId">[];
  /** Advances named as already received (0363, Q048): a term, adjusted against these fees. */
  readonly advancesReceived?: readonly { readonly adhocAdvanceId: string; readonly amount: string }[];
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
    // G1.3-G1.5 fields and the firm's signatory and capacity are TERMS; the signing timestamp is not.
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
        // Empty when unpriced; `pricingNote` carries "as agreed" vs zero into the hash.
        l.unitAmount ?? "",
        l.discountPercent,
        l.effectiveFrom ?? "",
        // G1.6 line detail. Without the overrides the hash would verify whatever scope the catalogue said.
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
        // Timing (0319) only when set, so a pre-0319 letter hashes unchanged.
        ...timingField(l),
        // The line's own advance (0320), only when set.
        ...(l.advanceAmount === undefined || l.advanceAmount === null ? [] : [`advance:${l.advanceAmount}`]),
        // Its own currency (0344), only when it is not the letter's.
        ...otherCurrency(l.currency, input.letter.currency),
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
        // Covered lines by POSITION: moving a service between groups changes the agreement.
        input.lines
          .filter((l) => l.feeGroupId === g.id)
          .map((l) => l.position)
          .sort((a, b) => a - b)
          .join(","),
        ...timingField(g),
        ...otherCurrency(g.currency, input.letter.currency),
      ].join("\t"),
    );

  const clauses = [...input.clauses]
    .sort((a, b) => a.position - b.position)
    .map((c) => ["clause", String(c.position), c.clauseVersionId].join("\t"));

  const rates = [...(input.letter.rates ?? [])]
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((r) => ["rate", r.currency, r.fxRate].join("\t"));

  // Advances received (0363), only when any, so other letters hash unchanged.
  const received = [...(input.advancesReceived ?? [])]
    .sort((a, b) => (a.adhocAdvanceId < b.adhocAdvanceId ? -1 : a.adhocAdvanceId > b.adhocAdvanceId ? 1 : 0))
    .map((r) => ["received", r.adhocAdvanceId, r.amount].join("\t"));

  return [head, ...lines, ...feeGroups, ...rates, ...clauses, ...received].join("\n");
}

function otherCurrency(currency: CurrencyCode | undefined, main: CurrencyCode): string[] {
  return currency === undefined || currency === main ? [] : [`currency:${currency}`];
}

/** ISO 3166-1 alpha-2 jurisdiction code. One implementation in `domain/document/model.ts`
 *  (G1.6), re-exported for existing callers. */
export { isJurisdiction, normalizeJurisdiction } from "../document/model";

/** An empty list means everywhere, as in the catalogue: an unscoped clause is meant to be used. */
export function clauseApplies(clauseJurisdictions: readonly string[], letter: string): boolean {
  return clauseJurisdictions.length === 0 || clauseJurisdictions.includes(letter);
}
