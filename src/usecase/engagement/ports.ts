// The ports the engagement use case needs from the world. Interfaces are owned
// by the use case that needs them; adapters in infrastructure/ implement them,
// and two are satisfied by other use cases at the composition root.
import type { Amount, CurrencyCode } from "../../domain/money/model";
import type {
  Engagement,
  EngagementLetter,
  EngagementStatus,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";

export interface NewLetter {
  readonly id: string;
  readonly tenantId: string;
  readonly partyId: string;
  readonly proposalId: string | null;
  readonly jurisdiction: string;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  readonly advanceRequired: boolean;
  readonly advanceAmount: Amount | null;
}

export interface NewLetterLine {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  /** The entity this line's work is delivered to. Required, because signing
   *  turns the line into an engagement and an engagement is
   *  `service × one legal entity`. */
  readonly entityPartyId: string;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: Amount;
  readonly unitAmount: Amount;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
}

export interface NewLetterClause {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  readonly clauseVersionId: string;
}

/** What the SIGNATURE writes, in one transaction with the fan-out. */
export interface SignatureRecord {
  readonly signedAt: string;
  readonly signedByName: string;
  readonly signatureMethod: string;
  readonly signatureReference: string | null;
  readonly signedContentHash: string;
}

/** One engagement to create at signature — one per live line. */
export interface NewEngagement {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementLetterId: string;
  readonly engagementLetterLineId: string;
  /** Who is billed. */
  readonly partyId: string;
  /** Who the work is for, taken from the LINE rather than the letter — that is
   *  the whole point of G0.1. */
  readonly entityPartyId: string;
  /** `active` when the letter needs no advance, `pending_advance` when it does.
   *  Decided by the domain's `mayActivate`, never by the adapter. */
  readonly status: EngagementStatus;
  readonly activatedAt: string | null;
}

/**
 * A letter with everything a screen renders it from.
 *
 * The clauses carry their pinned TEXT, and that is the point of the whole
 * design: reading a signed letter must show the wording that was agreed, not
 * what the library says today.
 */
export interface LetterRecord {
  readonly letter: EngagementLetter;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly lines: readonly LetterLineRecord[];
  readonly clauses: readonly LetterClauseRecord[];
  readonly totals: {
    readonly gross: Amount;
    readonly discount: Amount;
    readonly net: Amount;
    readonly currency: CurrencyCode;
  };
  /** The engagements this letter created, once it has been signed. */
  readonly engagements: readonly Engagement[];
}

export interface LetterLineRecord {
  readonly line: LetterLine;
  /**
   * The entity by NAME, not just the id the line carries.
   *
   * The rule CLAUDE.md says has now been learnt five times: a screen that had to
   * fetch something per row to render it means the join belongs in the query.
   * A letter's lines are exactly where a group client's four companies have to
   * be told apart, so a column of uuids is the one thing this must not be.
   */
  readonly entity: { readonly id: string; readonly displayName: string } | null;
  readonly service: {
    readonly key: string;
    readonly version: number;
    readonly name: string;
  } | null;
  readonly net: Amount;
}

export interface LetterClauseRecord {
  readonly clause: LetterClause;
  /** As it was PINNED — the wording the client agreed to. */
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly text: string;
}

export interface LetterFilters {
  readonly status?: LetterStatus | undefined;
  readonly partyId?: string | undefined;
}

export interface LetterSummary {
  readonly letter: EngagementLetter;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly totals: LetterRecord["totals"];
  readonly lineCount: number;
}

export interface EngagementRepository {
  create(l: NewLetter): Promise<EngagementLetter>;
  findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null>;
  describeLetter(tenantId: string, letterId: string): Promise<LetterRecord | null>;
  listLetters(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]>;

  addLine(l: NewLetterLine): Promise<LetterLine>;
  removeLine(tenantId: string, letterId: string, lineId: string): Promise<void>;
  listLines(tenantId: string, letterId: string): Promise<readonly LetterLine[]>;

  addClause(c: NewLetterClause): Promise<LetterClause>;
  listClauses(tenantId: string, letterId: string): Promise<readonly LetterClause[]>;

  setStatus(
    tenantId: string,
    letterId: string,
    status: LetterStatus,
    at: string,
  ): Promise<EngagementLetter>;

  /**
   * THE FAN-OUT, and it is one transaction on purpose.
   *
   * The signature and the engagements it creates must not be separately
   * observable: a letter that is signed with no engagements is a client
   * committed to work nobody scheduled, and engagements with no signature are
   * work nobody agreed to. Both states are recoverable only by hand, so the
   * database is asked to make neither possible.
   */
  signAndFanOut(
    tenantId: string,
    letterId: string,
    signature: SignatureRecord,
    engagements: readonly NewEngagement[],
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }>;

  /** Records the advance and releases every engagement waiting on it, in one
   *  transaction for the same reason. */
  recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    at: string,
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }>;

  listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]>;
}

/**
 * The clause library and the catalogue, as letter drafting needs to see them.
 *
 * Narrow on purpose, and stated in this use case's vocabulary: engagement does
 * not want to know what a config entry is, only whether a version id names a
 * clause (or a service) this firm published and what it said. The config
 * adapter satisfies it, so neither module imports the other — the same seam
 * `ServiceCatalogue` gave proposals.
 */
export interface ClauseLibrary {
  /** RESOLVE A PIN. `status` comes back because a DRAFT was never in force and
   *  must not end up in a contract, while an ARCHIVED version is exactly what a
   *  pinned clause is supposed to resolve to. */
  readPinnedVersion(
    tenantId: string,
    versionId: string,
  ): Promise<{
    readonly kind: string;
    readonly status: string;
    readonly key: string;
    readonly version: number;
    readonly body: Record<string, unknown>;
  } | null>;
}

/**
 * Getting a letter signed.
 *
 * A PORT because the real thing is a vendor — DocuSign, Zoho Sign, Digio — and
 * the shape of that integration must not leak into the use case. The
 * implementation registered today records a signature that staff attest to
 * ("signed on paper", "signed via <provider>, ref X"), which is not a toy: it is
 * how most firms in this market actually sign, and it keeps the public surface
 * at four paths rather than adding an unauthenticated signing ceremony.
 *
 * HONEST REGISTRY: that implementation is a stub in the same sense the logging
 * mailer is, so it gets the same treatment — config-gated, and `validateServer`
 * refuses to boot a production-like environment with it.
 */
export interface ESignProvider {
  /** What this provider calls itself, recorded on the letter so a signature can
   *  always be traced back to how it was obtained. */
  readonly method: string;
  /**
   * Obtain a signature. Returns the provider's own reference when it has one.
   * Throws if it cannot — a letter must never be recorded as signed because a
   * provider call failed quietly.
   */
  sign(input: {
    readonly tenantId: string;
    readonly letterId: string;
    readonly signedByName: string;
    readonly contentHash: string;
    readonly reference?: string | undefined;
  }): Promise<{ readonly reference: string | null }>;
}

/** Hashing the canonical rendering. Its own port so the domain stays free of
 *  node:crypto, and one adapter serves this and the share tokens. */
export interface ContentHasher {
  hash(content: string): string;
}
