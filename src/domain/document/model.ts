// Rules a proposal and an engagement letter share (reference, issuing entity, line detail, prose),
// stated once so the two domains cannot drift. Pure: no counter, table or clock.
import { isCountryCode } from "../country";

/** Documents that carry a reference and issuing entity; also the `document_type` CHECK on
 *  crm.document_ref_series (0020). */
export type DocumentType = "proposal" | "engagement_letter";

export const DOCUMENT_TYPES: readonly DocumentType[] = ["proposal", "engagement_letter"];

/** Two letters a person reads down the phone; `PR`/`EL` are what the firm already says aloud. */
const REF_PREFIXES: Readonly<Record<DocumentType, string>> = {
  proposal: "PR",
  engagement_letter: "EL",
};

export function refPrefix(type: DocumentType): string {
  return REF_PREFIXES[type];
}

/** Mirrors the database CHECK so a bad reference is refused early. `{4,}`: the 10,000th document
 *  of a year gets a fifth digit, not an error. */
const REF_PATTERN = /^(?:PR|EL)-[0-9]{4}-[0-9]{4,}$/;

export function isDocumentRef(v: string): boolean {
  return REF_PATTERN.test(v);
}

/**
 * `PR-2026-0007` / `EL-2026-0007`. One series per firm, per type, per year (argued in 0020).
 * Padded to four digits so a year sorts as a column; never truncated past that.
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
 * The year a reference drawn now belongs to, in UTC so two pods in two regions cannot number from
 * different years. Cost (0020): a firm far east may see a late-31-December draft carry next year.
 */
export function refYear(now: Date): number {
  return now.getUTCFullYear();
}

// Who is contracting

/** The wildcard key: answers for every country the firm named no entity for. */
export const ANY_JURISDICTION = "*";

/**
 * Which of the firm's OWN entities serves clients in a country. `clientJurisdiction` is the
 * CLIENT's country, never the entity's ("jahan ka client hota hai, wahan ki entity").
 */
export interface FirmEntityPreference {
  readonly id: string;
  readonly tenantId: string;
  readonly clientJurisdiction: string;
  readonly firmEntityPartyId: string;
  /** Why the firm chose this; the reason outlives the memory of it. */
  readonly note: string | null;
}

/** ISO 3166-1 alpha-2, upper case, or the wildcard. */
export function normalizeJurisdictionKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isJurisdictionKey(v: string): boolean {
  return v === ANY_JURISDICTION || /^[A-Z]{2}$/.test(v);
}

/**
 * Which firm entity issues to a client in this country: the country's own row, else the wildcard
 * row (a choice somebody made, not an `if` in a service). A null country (prospect's location not
 * known yet) lands on the wildcard too. Null only when no wildcard exists: the caller must refuse,
 * since a document that cannot name who is contracting is not a document.
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

// Line detail (G1.6): a proposal line and a letter line are one line at two stages.

/**
 * How often THIS DEAL is billed. Same vocabulary as `ServiceRecurrence` so the default is a copy,
 * but a different fact: A1 is a monthly service some clients are billed quarterly for, so it is
 * never derived. Also the `billing_frequency` CHECK on both line tables (0023).
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
 * One of the four scope blocks, resolved. `tailored` = THIS document wrote it, so a screen can tell
 * standard scope from wording agreed with this client (else people edit the catalogue to fix one
 * letter). `text: null, tailored: false`: nobody wrote this block; print nothing, not an empty
 * heading. Never `tailored: true, text: null`: the DB refuses a blank override (0023).
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
 * Override, else the words of the catalogue version the line PINNED (not today's catalogue), so a
 * catalogue revision cannot change a signed letter. The one place both documents call; never
 * resolved in a repository or a screen.
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

/** ISO 3166-1 alpha-2, on both documents' head and lines; `domain/engagement/model.ts` re-exports. */
const JURISDICTION_PATTERN = /^[A-Z]{2}$/;

export function normalizeJurisdiction(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Two capitals AND a country ISO assigns today (F04): a retired code (DD, or UK for GB) is refused. */
export function isJurisdiction(v: string): boolean {
  return JURISDICTION_PATTERN.test(v) && isCountryCode(v);
}

/**
 * Out-of-pocket estimate: a RANGE in its own currency, reimbursed at actuals, never added to the
 * fee total. Never converted: the document's FX rate is for the fee currency, and a client quoted
 * in INR may still face a USD filing fee. All three or none, as `*_oop_is_whole_chk` (0023).
 */
export interface OutOfPocketEstimate {
  readonly min: string;
  readonly max: string;
  readonly currency: string;
}

/**
 * What is wrong with an out-of-pocket estimate, or null. Returns the reason so both use cases'
 * sentinel errors name the actual mistake. Shape only: the currency is routinely not the document's.
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
  // Bounded-precision non-negative decimals: a Number compare cannot reorder them (as in
  // `comparePercent`). Still STORED as strings.
  if (Number(estimate.max) < Number(estimate.min)) {
    return `"max" ${JSON.stringify(estimate.max)} is below "min" ${JSON.stringify(estimate.min)}`;
  }
  return null;
}

// Document prose (G1.7): exclusions, commercial notes and team on every proposal and letter. Not
// clauses (versioned, pinned contract terms): the document's own lines, edited one at a time.

/**
 * Which list a line belongs to; also the `kind` CHECK on both block tables (0025, widened 0083).
 * `cover` and `acceptance` (0083) are letter-only: the Annexure cover letter's opening paragraphs
 * and what the client accepts before signing.
 */
export type BlockKind = "exclusion" | "commercial" | "team" | "cover" | "acceptance";

/** Screen order; letter-only kinds are appended so documents seeded before 0083 list unchanged. */
export const BLOCK_KINDS: readonly BlockKind[] = [
  "exclusion",
  "commercial",
  "team",
  "cover",
  "acceptance",
];

export function isBlockKind(v: string): v is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(v);
}

/** Letter-only kinds (0083): a proposal has no cover letter and nobody signs it.
 *  `document_block_letter_only_kinds_chk` holds any writer to it. */
export const LETTER_ONLY_BLOCK_KINDS: readonly BlockKind[] = ["cover", "acceptance"];

/** The kinds a document of this type may carry. */
export function blockKindsFor(document: DocumentType): readonly BlockKind[] {
  return document === "engagement_letter"
    ? BLOCK_KINDS
    : BLOCK_KINDS.filter((k) => !LETTER_ONLY_BLOCK_KINDS.includes(k));
}

/** One line of the firm's STANDARD set, not of any document. */
export interface StandardBlock {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: BlockKind;
  readonly body: string;
  /** A section title, not an item (the team block is a table with headings). */
  readonly isHeading: boolean;
  readonly sortOrder: number;
  /** NULL prints everywhere; a code only on that country's documents ("exclusive of GST" is wrong
   *  on a UAE proposal, a mistake the firm caught in its own template). */
  readonly jurisdiction: string | null;
  /** The firm's own company this line belongs to (T6.18, 0312); null = firm-wide default. See `blocksFor`. */
  readonly issuingEntityPartyId: string | null;
  /** Retired, never deleted (as `staff_grade`): documents copied it and their source must resolve. */
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
  /** The standard line this was copied from, or null if hand-written. A breadcrumb, not an FK: the
   *  standard row may be retired or reworded later and this must not follow it. */
  readonly sourceId: string | null;
  /** Changed since it landed on the document. `sourceId` survives an edit, so alone it would show
   *  a reworded line as standard wording. Derived `updated_at > created_at` (the only UPDATE is an edit). */
  readonly isEdited: boolean;
}

/**
 * The standard lines a document for `jurisdiction` is seeded with, in print order (G1.7's
 * acceptance): inactive lines never copy, lines scoped to another country never copy, unscoped
 * lines always do. Sort (kind, sortOrder, id) is total: `sort_order` is deliberately not unique.
 */
export function blocksFor(
  standard: readonly StandardBlock[],
  jurisdiction: string,
  document: DocumentType,
  /**
   * The issuing company (T6.18, D5), PER KIND: if it has any active line of a kind, its lines are
   * that kind's set, else the default (null) lines. Another company's lines never reach it; null
   * reads the default set alone. The jurisdiction filter then applies inside the chosen set.
   */
  issuingEntityPartyId: string | null = null,
): readonly StandardBlock[] {
  // A proposal never carries the letter's cover or acceptance (0083).
  const kinds = blockKindsFor(document);
  const live = standard.filter((b) => kinds.includes(b.kind) && b.isActive);
  const ownKinds = new Set(
    live
      .filter((b) => issuingEntityPartyId !== null && b.issuingEntityPartyId === issuingEntityPartyId)
      .map((b) => b.kind),
  );
  return live
    .filter((b) =>
      ownKinds.has(b.kind)
        ? b.issuingEntityPartyId === issuingEntityPartyId
        : b.issuingEntityPartyId === null,
    )
    .filter((b) => b.jurisdiction === null || b.jurisdiction === jurisdiction)
    .slice()
    .sort(
      (a, b) =>
        BLOCK_KINDS.indexOf(a.kind) - BLOCK_KINDS.indexOf(b.kind) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    );
}

// The firm's own companies (T6.18)

/**
 * Default document currency from where the company is registered (D1): IN→INR, AE→AED, SG→SGD,
 * US→USD, else (or unregistered) the firm's reporting currency. Served on `GET /firm-entities` as
 * `defaultCurrency` so the builder keeps no copy. A default: a draft quoting nothing may change it.
 */
export const ENTITY_CURRENCY: Readonly<Record<string, string>> = {
  IN: "INR",
  AE: "AED",
  SG: "SGD",
  US: "USD",
};

export function defaultCurrencyFor(jurisdiction: string | null, reportingCurrency: string): string {
  if (jurisdiction === null) return reportingCurrency;
  return ENTITY_CURRENCY[jurisdiction] ?? reportingCurrency;
}

/**
 * A company's registered address as the lines it prints ("605 Geddes Street", "Wilmington,
 * Delaware 19805", "USA"); lines, not fields, because the firm's four countries disagree on fields.
 * Stored in `core.legal_entity.registered_address` (free-form jsonb since 0002); not printed yet (D15).
 */
export interface RegisteredAddress {
  readonly lines: readonly string[];
  /** State or region, which a tax invoice names on its own (audit 2026-10-03, B12): "Maharashtra".
   *  Absent on older addresses. */
  readonly region?: string | null | undefined;
  /** The postal code: "411001". */
  readonly postalCode?: string | null | undefined;
}

export const REGISTERED_ADDRESS_MAX_LINES = 8;
export const REGISTERED_ADDRESS_LINE_MAX = 200;
export const REGISTERED_ADDRESS_REGION_MAX = 100;
export const REGISTERED_ADDRESS_POSTAL_MAX = 20;

/** The stored jsonb in this shape, or null (an older row is not guessed at). */
export function readRegisteredAddress(raw: unknown): RegisteredAddress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { lines?: unknown; region?: unknown; postalCode?: unknown };
  const lines = r.lines;
  if (!Array.isArray(lines) || !lines.every((l): l is string => typeof l === "string")) return null;
  return {
    lines,
    ...(typeof r.region === "string" && r.region !== "" ? { region: r.region } : {}),
    ...(typeof r.postalCode === "string" && r.postalCode !== "" ? { postalCode: r.postalCode } : {}),
  };
}

/** Why an address cannot be stored, or null. The caller drops blank lines first. */
export function registeredAddressProblem(address: RegisteredAddress): string | null {
  if (address.lines.length === 0) return "an address needs at least one line";
  if (address.lines.length > REGISTERED_ADDRESS_MAX_LINES) {
    return `an address has at most ${String(REGISTERED_ADDRESS_MAX_LINES)} lines`;
  }
  if (address.lines.some((l) => l.length > REGISTERED_ADDRESS_LINE_MAX)) {
    return `each address line is at most ${String(REGISTERED_ADDRESS_LINE_MAX)} characters`;
  }
  if ((address.region ?? "").length > REGISTERED_ADDRESS_REGION_MAX) {
    return `the state or region is at most ${String(REGISTERED_ADDRESS_REGION_MAX)} characters`;
  }
  if ((address.postalCode ?? "").length > REGISTERED_ADDRESS_POSTAL_MAX) {
    return `the postal code is at most ${String(REGISTERED_ADDRESS_POSTAL_MAX)} characters`;
  }
  return null;
}
