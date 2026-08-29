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

// ── Line detail (G1.6) — the facts a DOCUMENT LINE carries about this deal ───
//
// Stated once here, for the same reason the reference and the issuing entity
// are: a proposal line and an engagement letter line are the same document line
// at two stages of its life, and two copies of these rules in two domains would
// drift in the direction nobody checks.

/**
 * How often THIS DEAL is billed.
 *
 * The same vocabulary as the catalogue's `ServiceRecurrence`, deliberately, so
 * that defaulting a line's billing frequency from the service's recurrence is a
 * copy rather than a mapping table nobody can keep in step. It is a DIFFERENT
 * FACT: `recurrence` says how often the work comes round, this says how often
 * the client is invoiced, and A1 is a monthly service that some clients are
 * billed quarterly for. Deriving one from the other at read time would make that
 * arrangement — which the firm has today — impossible to write down.
 *
 * These literals are the `billing_frequency` CHECK on both line tables
 * (migration 0023): one vocabulary, two enforcers.
 */
export type BillingFrequency = "one_time" | "monthly" | "quarterly" | "annually" | "custom";

export const BILLING_FREQUENCIES: readonly BillingFrequency[] = [
  "one_time",
  "monthly",
  "quarterly",
  "annually",
  "custom",
];

export function isBillingFrequency(v: string): v is BillingFrequency {
  return (BILLING_FREQUENCIES as readonly string[]).includes(v);
}

/**
 * ONE OF THE FOUR SCOPE BLOCKS, resolved.
 *
 * `text` is what the document actually says; `tailored` is whether THIS document
 * said it. Both, because a screen showing tailored wording has to be able to say
 * it was tailored — an editor that cannot tell "our standard scope" from "what
 * we agreed with this client" is one where somebody edits the catalogue to fix a
 * single letter, which is the failure the overrides exist to prevent.
 *
 * `text: null` with `tailored: false` is a real answer: neither the document nor
 * the catalogue version it pinned states this block. It is not an error and not
 * an empty block — the firm never wrote one, and a renderer should print
 * nothing rather than a heading with nothing under it.
 *
 * There is no `tailored: true, text: null`: an override is either wording or it
 * is absent, and the database refuses a blank one (0023). "This document has no
 * exclusions" is a sentence somebody writes, not an empty string.
 */
export interface ResolvedTerm {
  readonly text: string | null;
  readonly tailored: boolean;
}

/** The four scope blocks of one line, each resolved. */
export interface DocumentTerms {
  readonly scope: ResolvedTerm;
  readonly clientObligations: ResolvedTerm;
  readonly volumeLimits: ResolvedTerm;
  readonly exclusions: ResolvedTerm;
}

/**
 * OVERRIDE ELSE CATALOGUE — the resolution, in the one place both documents
 * call.
 *
 * A per-document override wins over the pinned catalogue version's words, and
 * that is what makes an issued document reproducible: the document carries its
 * own wording, so a catalogue revision cannot change what a signed letter says.
 * Where the document said nothing, the CATALOGUE's words print — and they are
 * the words of the version the line PINNED, not of the catalogue as it reads
 * today, which is the other half of the same guarantee.
 *
 * Here rather than in either repository because the two would eventually differ
 * on the one case that matters, and here rather than in a screen because a
 * screen resolving it means every screen resolving it, and the second one gets
 * it wrong.
 */
export function resolveTerm(override: string | null, catalogue: string | null): ResolvedTerm {
  if (override !== null) return { text: override, tailored: true };
  return { text: catalogue, tailored: false };
}

export function resolveTerms(
  overrides: {
    readonly scope: string | null;
    readonly clientObligations: string | null;
    readonly volumeLimits: string | null;
    readonly exclusions: string | null;
  },
  catalogue: {
    readonly scope: string | null;
    readonly clientObligations: string | null;
    readonly volumeLimits: string | null;
    readonly exclusions: string | null;
  } | null,
): DocumentTerms {
  return {
    scope: resolveTerm(overrides.scope, catalogue?.scope ?? null),
    clientObligations: resolveTerm(overrides.clientObligations, catalogue?.clientObligations ?? null),
    volumeLimits: resolveTerm(overrides.volumeLimits, catalogue?.volumeLimits ?? null),
    exclusions: resolveTerm(overrides.exclusions, catalogue?.exclusions ?? null),
  };
}

/** A jurisdiction code, as this product stores it: ISO 3166-1 alpha-2.
 *
 *  Here rather than in either document's own domain because BOTH documents now
 *  carry one on the head and one per line, and two copies of a two-letter regex
 *  is two places for it to become three letters. `domain/engagement/model.ts`
 *  re-exports these so its own callers did not have to move. */
const JURISDICTION_PATTERN = /^[A-Z]{2}$/;

export function normalizeJurisdiction(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isJurisdiction(v: string): boolean {
  return JURISDICTION_PATTERN.test(v);
}

/**
 * An OUT-OF-POCKET estimate: a RANGE, in its own currency.
 *
 * Separate from the professional fee and never added into a total. It is
 * reimbursed at ACTUALS — "approx. USD 5,000–6,000" is what the firm expects to
 * spend on the client's behalf, not what it is charging — and its currency is
 * routinely not the document's, because a client quoted in INR still faces a
 * filing fee in USD. The document's FX rate is struck for the FEE currency and
 * says nothing about a third one, so there is no honest conversion available and
 * none is attempted.
 *
 * All three together or none, mirroring `*_oop_is_whole_chk` (0023): a range
 * with one end is not a range, and an amount without a currency is the one shape
 * this codebase never stores.
 */
export interface OutOfPocketEstimate {
  readonly min: string;
  readonly max: string;
  readonly currency: string;
}

/**
 * What is WRONG with an out-of-pocket estimate, or null when nothing is.
 *
 * A validator that returns the REASON rather than a boolean, because the two
 * use cases throw their own sentinel errors and the explanation is the same
 * sentence in both — "min is not an amount" and "max is below min" are
 * different mistakes and a caller fixing one should not be told the other.
 *
 * Shape only. It does not compare the currency to the document's, deliberately:
 * an out-of-pocket estimate is routinely in a third currency (see
 * `OutOfPocketEstimate`), which is the whole reason it carries one.
 */
export function outOfPocketProblem(
  estimate: { readonly min: string; readonly max: string; readonly currency: string },
  isAmount: (v: string) => boolean,
  isCurrencyCode: (v: string) => boolean,
): string | null {
  if (!isAmount(estimate.min)) return `"min" ${JSON.stringify(estimate.min)} is not an amount`;
  if (!isAmount(estimate.max)) return `"max" ${JSON.stringify(estimate.max)} is not an amount`;
  if (!isCurrencyCode(estimate.currency)) {
    return `"currency" ${JSON.stringify(estimate.currency)} is not an ISO 4217 code`;
  }
  // Both are non-negative decimal strings of bounded precision by the time they
  // get here, so comparing them as numbers cannot reorder two distinct values —
  // the same argument `comparePercent` makes. They are still STORED as strings.
  if (Number(estimate.max) < Number(estimate.min)) {
    return `"max" ${JSON.stringify(estimate.max)} is below "min" ${JSON.stringify(estimate.min)}`;
  }
  return null;
}

// ── The prose a document carries besides its priced lines (G1.7) ───────────
//
// Three lists appear on every proposal and every engagement letter: the general
// scope EXCLUSIONS, the COMMERCIAL notes, and the TEAM the firm will deploy.
// They are not clauses — a clause is a term of the contract, drawn from a
// versioned library and pinned — they are the document's own prose, edited a
// line at a time.

/**
 * Which of the three lists a line belongs to. Also the values in the `kind`
 * CHECK on both block tables (migration 0025) — one vocabulary, two enforcers.
 */
export type BlockKind = "exclusion" | "commercial" | "team";

export const BLOCK_KINDS: readonly BlockKind[] = ["exclusion", "commercial", "team"];

export function isBlockKind(v: string): v is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(v);
}

/** One line of the firm's STANDARD set — what it maintains, not what any
 *  document says. */
export interface StandardBlock {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: BlockKind;
  readonly body: string;
  /** A section title rather than an item. Without it the team block — which is
   *  a table with headings — either goes back into one text blob or needs a
   *  second table. */
  readonly isHeading: boolean;
  readonly sortOrder: number;
  /** NULL prints everywhere; a code prints only on documents written for that
   *  country. "All fees are exclusive of GST as applicable" is wrong on a UAE
   *  proposal, which is a mistake the firm already caught in its own template. */
  readonly jurisdiction: string | null;
  /** Retired, never deleted — the same distinction `staff_grade` draws. A line
   *  the firm has moved on from stays readable, because documents issued while
   *  it was in force copied it and a reader asking where a line came from needs
   *  it to resolve. */
  readonly isActive: boolean;
}

/** One line of what a DOCUMENT says. A copy, owned by that document. */
export interface DocumentBlock {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: BlockKind;
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
  /** Which standard line this was copied from, or null for one written by hand
   *  on this document. A breadcrumb and not a foreign key: the standard row may
   *  be retired or rewritten years later, and this must neither stop that nor
   *  acquire its new wording. */
  readonly sourceId: string | null;
}

/**
 * Which standard lines a document written for `jurisdiction` should be seeded
 * with, in the order they print.
 *
 * THE WHOLE RULE, in one pure function, because it is the acceptance of G1.7:
 * an inactive line is never copied (the firm has moved on), and a line scoped
 * to another country is never copied (the GST note must not reach a UAE
 * proposal) while an unscoped line always is.
 *
 * The sort is (kind, sortOrder, id) — total, so two lines the firm gave the
 * same order end up in a stable sequence rather than whatever the database
 * returned that afternoon. `sort_order` is deliberately not unique (inserting
 * between two lines would otherwise renumber the list), so ties are ordinary
 * and the tiebreak is not a detail.
 */
export function blocksFor(
  standard: readonly StandardBlock[],
  jurisdiction: string,
): readonly StandardBlock[] {
  return standard
    .filter((b) => b.isActive && (b.jurisdiction === null || b.jurisdiction === jurisdiction))
    .slice()
    .sort(
      (a, b) =>
        BLOCK_KINDS.indexOf(a.kind) - BLOCK_KINDS.indexOf(b.kind) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    );
}
