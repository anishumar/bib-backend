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
}

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
  readonly unitAmount: Amount;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
  /**
   * When THIS line's work begins, when it differs from the rest of the letter.
   *
   * Null means "whatever the letter says". Per line as well as per document
   * because per line can express a single shared date and the reverse cannot:
   * an Incorporation line starts the day it is signed while the GST line beside
   * it starts next period.
   */
  readonly effectiveFrom: string | null;
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
  readonly endsOn: string | null;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Whether an engagement may start work.
 *
 * The fee gate, stated once. A letter that requires an advance releases its
 * engagements only when the advance has been recorded; one that does not
 * releases them at signature. Nothing else opens it — which is why this is a
 * function of the LETTER and not a flag somebody sets on the engagement.
 */
export function mayActivate(
  letter: Pick<EngagementLetter, "advanceRequired" | "advanceRecordedAt">,
): boolean {
  return !letter.advanceRequired || letter.advanceRecordedAt !== null;
}

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

/** An ISO calendar day, as this product stores and compares one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(v: string): boolean {
  return DAY_PATTERN.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/**
 * The UTC day of an instant.
 *
 * UTC and not the server's zone, for the same reason `refYear` is: two pods in
 * two regions must not disagree about which day a contract started. The cost is
 * the same and is equally visible — a letter signed late on 31 December in
 * Sydney starts on 1 January.
 */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
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
  readonly lines: readonly Pick<
    LetterLine,
    | "position"
    | "entityPartyId"
    | "serviceVersionId"
    | "description"
    | "quantity"
    | "unitAmount"
    | "discountPercent"
    | "effectiveFrom"
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
        l.unitAmount,
        l.discountPercent,
        // A line that starts three months after the rest of the letter is a
        // different agreement from one that starts with it.
        l.effectiveFrom ?? "",
      ].join("\t"),
    );

  const clauses = [...input.clauses]
    .sort((a, b) => a.position - b.position)
    .map((c) => ["clause", String(c.position), c.clauseVersionId].join("\t"));

  return [head, ...lines, ...clauses].join("\n");
}

/** A jurisdiction code, as this product stores it: ISO 3166-1 alpha-2. */
const JURISDICTION_PATTERN = /^[A-Z]{2}$/;

export function normalizeJurisdiction(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isJurisdiction(v: string): boolean {
  return JURISDICTION_PATTERN.test(v);
}

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
