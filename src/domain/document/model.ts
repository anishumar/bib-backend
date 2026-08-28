// What a document is CALLED, and WHO issues it — the two facts a proposal and
// an engagement letter answer identically, so they are stated once here rather
// than twice in two domains that would drift.
//
// Nouns and pure rules only; stdlib. Nothing in this file talks to a counter,
// a table or a clock: given a number it formats a reference, and given the
// firm's preference rows it names an entity. Both halves are decisions, and a
// decision is the thing worth testing without infrastructure.
/**
 * The two documents that carry a reference and an issuing entity. These string
 * literals are also the values in the `document_type` CHECK on
 * crm.document_ref_series (migration 0020) — one vocabulary, two enforcers.
 */
export type DocumentType = "proposal" | "engagement_letter";

export const DOCUMENT_TYPES: readonly DocumentType[] = ["proposal", "engagement_letter"];

/**
 * The prefix each document type's reference carries.
 *
 * Two letters, and they are what somebody reads down the phone. `PR` and `EL`
 * are also what the firm already says out loud, which is the only test that
 * matters for an identifier a human has to repeat.
 */
const REF_PREFIXES: Readonly<Record<DocumentType, string>> = {
  proposal: "PR",
  engagement_letter: "EL",
};

export function refPrefix(type: DocumentType): string {
  return REF_PREFIXES[type];
}

/** The shape the database CHECKs, restated here so a malformed reference is
 *  refused before it reaches a constraint. `{4,}` because a firm that issues
 *  ten thousand documents in a year should get a fifth digit, not an error. */
const REF_PATTERN = /^(?:PR|EL)-[0-9]{4}-[0-9]{4,}$/;

export function isDocumentRef(v: string): boolean {
  return REF_PATTERN.test(v);
}

/**
 * `PR-2026-0007` / `EL-2026-0007`.
 *
 * ONE SERIES PER FIRM, PER TYPE, PER YEAR — the decision is argued in migration
 * 0020. The number is padded to four digits so a year's documents sort and read
 * as a column, and is NOT truncated past that: the ten-thousandth document of a
 * year gets five digits rather than a collision.
 */
export function formatDocumentRef(input: {
  readonly type: DocumentType;
  readonly year: number;
  readonly number: number;
}): string {
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 9999) {
    throw new RangeError(
      `document reference year must be a four-digit year between 2000 and 9999, got ${String(input.year)}`,
    );
  }
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new RangeError(
      `document reference number must be a positive integer, got ${String(input.number)}`,
    );
  }
  return `${refPrefix(input.type)}-${String(input.year)}-${String(input.number).padStart(4, "0")}`;
}

/**
 * The calendar year a reference drawn NOW belongs to, in UTC.
 *
 * UTC and not the server's zone, so two pods in two regions cannot hand out
 * numbers from two different years for documents drafted a second apart. The
 * cost is stated in migration 0020: a firm far enough east may see a document
 * drafted late on 31 December carry the next year's number.
 */
export function refYear(now: Date): number {
  return now.getUTCFullYear();
}

// ── Who is contracting ───────────────────────────────────────────────────────

/** The wildcard key: the row that answers for every country the firm has named
 *  no entity for. */
export const ANY_JURISDICTION = "*";

/**
 * One row of the firm's rule: which of ITS OWN entities serves clients in a
 * given country.
 *
 * `clientJurisdiction` is the country of the CLIENT, never of the entity — the
 * firm's rule is "jahan ka client hota hai, wahan ki entity", so the client's
 * country is what is being looked up and the entity is the answer.
 */
export interface FirmEntityPreference {
  readonly id: string;
  readonly tenantId: string;
  readonly clientJurisdiction: string;
  readonly firmEntityPartyId: string;
  /** Why this row exists. A firm makes these decisions for reasons, and the
   *  reason outlives the memory of it. */
  readonly note: string | null;
}

/** A jurisdiction key as this table stores it: ISO 3166-1 alpha-2, upper case,
 *  or the wildcard. */
export function normalizeJurisdictionKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isJurisdictionKey(v: string): boolean {
  return v === ANY_JURISDICTION || /^[A-Z]{2}$/.test(v);
}

/**
 * Which of the firm's entities issues to a client in this country.
 *
 * THE RULE, stated once: the country's own row wins; failing that, the wildcard
 * row answers. A client in a country the firm has no entity in therefore
 * resolves through the FALLBACK — a row somebody chose — rather than through an
 * `if` in a service, which is the whole point of the table. `null` for the
 * client's country is a real input (a proposal need not say where the prospect
 * is yet) and lands on the same fallback, because "we do not know where they
 * are" and "we are not there" are the same answer from the firm's side.
 *
 * Returns null only when the firm has published no fallback at all, which the
 * caller must refuse loudly: a document that cannot name who is contracting is
 * not a document.
 */
export function resolveIssuingEntity(
  preferences: readonly FirmEntityPreference[],
  clientJurisdiction: string | null,
): FirmEntityPreference | null {
  if (clientJurisdiction !== null) {
    const key = normalizeJurisdictionKey(clientJurisdiction);
    const exact = preferences.find((p) => p.clientJurisdiction === key);
    if (exact !== undefined) return exact;
  }
  return preferences.find((p) => p.clientJurisdiction === ANY_JURISDICTION) ?? null;
}
