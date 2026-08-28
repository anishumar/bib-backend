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
  readonly partyId: string;
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
  readonly withdrawnAt: string | null;
}

export interface LetterLine {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  /** The frozen catalogue version. The agreed price may differ from the quoted
   *  one — which is why the money is here — but the SERVICE is the same row. */
  readonly serviceVersionId: string;
  readonly description: string;
  readonly position: number;
  readonly quantity: Amount;
  readonly unitAmount: Amount;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
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
  readonly partyId: string;
  readonly status: EngagementStatus;
  readonly activatedAt: string | null;
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
 * The canonical rendering of a letter, for hashing.
 *
 * Deterministic and boring on purpose: this is what `signedContentHash`
 * commits to, so it has to produce identical bytes for identical terms on any
 * machine, today and in five years. Sorted by position, tab-separated, no JSON
 * — a serialiser that might one day reorder keys would silently invalidate
 * every signature ever taken.
 *
 * It commits to the TERMS, not to presentation: the money, the pinned service
 * and clause versions, the jurisdiction, the currency. A firm restyling its
 * letter template does not and must not change what the client agreed to.
 */
export function canonicalContent(input: {
  readonly letter: Pick<
    EngagementLetter,
    "jurisdiction" | "title" | "currency" | "fxRate" | "advanceRequired" | "advanceAmount"
  >;
  readonly lines: readonly Pick<
    LetterLine,
    "position" | "serviceVersionId" | "description" | "quantity" | "unitAmount" | "discountPercent"
  >[];
  readonly clauses: readonly Pick<LetterClause, "position" | "clauseVersionId">[];
}): string {
  const head = [
    "letter",
    input.letter.title,
    input.letter.jurisdiction,
    input.letter.currency,
    input.letter.fxRate,
    String(input.letter.advanceRequired),
    input.letter.advanceAmount ?? "",
  ].join("\t");

  const lines = [...input.lines]
    .sort((a, b) => a.position - b.position)
    .map((l) =>
      [
        "line",
        String(l.position),
        l.serviceVersionId,
        l.description,
        l.quantity,
        l.unitAmount,
        l.discountPercent,
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
