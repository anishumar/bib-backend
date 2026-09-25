// The ports the engagement use case needs from the world. Interfaces are owned
// by the use case that needs them; adapters in infrastructure/ implement them,
// and two are satisfied by other use cases at the composition root.
import type { Amount, CurrencyCode, Money } from "../../domain/money/model";
import type { ClientStructure } from "../../domain/party/model";
import type {
  BillingBasis,
  JurisdictionalTerm,
  ServiceRecurrence,
} from "../../domain/config/model";
import type {
  BillingFrequency,
  DocumentBlock,
  DocumentTerms,
  DocumentType,
  OutOfPocketEstimate,
} from "../../domain/document/model";
import type {
  Engagement,
  EngagementLetter,
  EngagementState,
  EngagementStatus,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";


/**
 * Who issues this firm's documents, and what the next one is called.
 *
 * Narrow on purpose and stated in this use case's vocabulary: quoting does not
 * want to know what a preference row is or how a counter works, only which of
 * the firm's entities is offering this and what the document is called. The
 * document use case satisfies it, so neither module imports the other — the
 * same seam `ServiceCatalogue` gives the catalogue.
 *
 * `clientJurisdiction` may be null: a prospect's country is not always known at
 * drafting, and "we do not know where they are" resolves through the same
 * fallback as "we are not there".
 */
/**
 * Whether a party is one the firm has put away (0305).
 *
 * Satisfied structurally by the party repository's own read-one-by-id, which
 * never filters on `archived_at` — so an archived party is FOUND, and this use
 * case can refuse it with its name rather than as "no such party". The
 * database refuses the same reference underneath (0305's triggers); this is
 * what a person is told first.
 */
export interface PartyStanding {
  findParty(
    tenantId: string,
    partyId: string,
  ): Promise<{
    readonly displayName: string;
    readonly archivedAt: string | null;
    /** A letter is addressed to a PERSON (F-10-1). */
    readonly kind: "organization" | "person";
  } | null>;
}

/**
 * The client's structure on a day — who a letter for them may name (F-10-1).
 *
 * Satisfied structurally by the relationship repository, so neither module
 * imports the other. The SAME read fills the letter's pickers (through
 * `EngagementService.structureFor`) and decides the refusal, which is what
 * keeps the screen from offering a company the API then refuses.
 */
export interface ClientStructureDirectory {
  structureOf(tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure>;
}

/**
 * Which zone the firm keeps its calendar in — "today", for the day a client's
 * structure is read on. Structural: `PostgresFirmTimeZone` satisfies it.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

export interface DocumentIdentity {
  issuerFor(tenantId: string, clientJurisdiction: string | null): Promise<string>;
  /** Whether a party is one of the firm's own companies (F-10-1). */
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
  nextRef(tenantId: string, type: DocumentType, now: Date): Promise<string>;
  /**
   * Where the issuing entity is REGISTERED — G1.8's mismatch check.
   *
   * A null `jurisdiction` means the entity exists and has no registration
   * recorded, which is the state of every firm's seeded default entity. It is
   * not an error here; `addClause` decides what it means, and says so out loud.
   *
   * The NAME travels with it because the refusal has to be actionable: "issued
   * by an entity with no registered jurisdiction" sends somebody to look up a
   * uuid before they can act on it.
   */
  issuerJurisdiction(tenantId: string, firmEntityPartyId: string): Promise<IssuingEntity>;
  /**
   * COPY the firm's standard prose onto this new document (G1.7).
   *
   * A copy, not a reference: editing the standard exclusions changes the NEXT
   * document and never one already issued. `jurisdiction` decides which lines
   * come — an unscoped line always, a scoped one only for its own country, so
   * "All fees are exclusive of GST as applicable" cannot reach a UAE document.
   */
  seedBlocks(
    tenantId: string,
    owner: { readonly kind: "engagement_letter"; readonly id: string },
    jurisdiction: string,
  ): Promise<unknown>;
  /**
   * What this document's prose says NOW — the copy it owns, not the firm's
   * standard set. A struck-off line is not returned.
   */
  listBlocks(
    tenantId: string,
    owner: { readonly kind: "engagement_letter"; readonly id: string },
  ): Promise<readonly DocumentBlock[]>;
}

/** The issuing entity, as the mismatch check needs it: what to call it, and
 *  where it is registered. */
export interface IssuingEntity {
  readonly displayName: string;
  readonly jurisdiction: string | null;
}

/**
 * Who signs the firm's letters — "unki ek hi signature rahegi".
 *
 * ONE signatory for the whole firm, whichever of its entities issues the
 * document, held as a row on `tenancy.tenant` so that a successor is an UPDATE
 * rather than a deploy. Tenancy satisfies this port at the composition root, so
 * neither module imports the other — the same seam `DocumentIdentity` is.
 *
 * Null is a real answer and not an error: a firm that has not named a signatory
 * yet still sends letters, and the block simply does not print. Refusing to
 * send would lock every existing firm out of the flow they use today, which is
 * a bigger decision than this task (see the note on `EngagementService.send`).
 */
export interface FirmSignatory {
  firmSignatory(
    tenantId: string,
  ): Promise<{ readonly userId: string; readonly title: string } | null>;
}

export interface NewLetter {
  readonly id: string;
  readonly tenantId: string;
  /** Allocated before the row is written — see `DocumentIdentity`. */
  readonly ref: string;
  readonly partyId: string;
  /** Which of the firm's own entities is contracting. Resolved once, here, and
   *  stored: it is a snapshot, not a lookup. */
  readonly issuingEntityPartyId: string;
  readonly proposalId: string | null;
  readonly jurisdiction: string;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  readonly advanceRequired: boolean;
  readonly advanceAmount: Amount | null;
  /** The opening paragraph, the addressee and the document's own date — the
   *  three things a letter is written with and this model went four tasks
   *  without. All optional; all frozen at signature like everything else. */
  readonly background: string | null;
  readonly addressedToPartyId: string | null;
  readonly issuedOn: string | null;
  /** The SIGNED letter this one replaces, checked before it gets here. */
  readonly supersedesId: string | null;
  /** When the engagements it opens begin. Null means the signature date. */
  readonly effectiveFrom: string | null;
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
  /** Null for a line that is genuinely "as mutually agreed". `pricingNote` is
   *  then required — see `LetterLine.unitAmount`. */
  readonly unitAmount: Amount | null;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
  /** When THIS line starts, when it is not the letter's date. */
  readonly effectiveFrom: string | null;
  readonly jurisdiction: string | null;
  /** RESOLVED before it gets here: the caller's value, else the pinned
   *  service's `recurrence`, else null. */
  readonly billingFrequency: BillingFrequency | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly pricingNote: string | null;
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
  /** The capacity the client signed in. Optional — see the note on the
   *  field: it is not always known when a wet signature is attested. */
  readonly signedByTitle: string | null;
  readonly signatureMethod: string;
  readonly signatureReference: string | null;
  readonly signedContentHash: string;
}

/**
 * The FIRM's half of the signature block, written when the letter goes out.
 *
 * All three together or not at all, mirroring `el_firm_signature_is_whole_chk`
 * (0022): the type makes the same statement the constraint does, so a caller
 * cannot assemble half a block and find out at the database.
 */
export interface FirmSignatureRecord {
  readonly userId: string;
  readonly title: string;
  readonly signedAt: string;
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
  /** Resolved once, here, from line → letter → signature date. NOT NULL in the
   *  schema: an engagement that cannot say when it starts is one the delivery
   *  lane has to guess about. */
  readonly effectiveFrom: string;
}

/**
 * An engagement, plus what it is doing TODAY.
 *
 * The state is COMPUTED against the clock (`engagementState`), never stored, so
 * an engagement effective in October reads as `pending_start` today and as
 * `active` on the day with nothing having to run in between. The service owns
 * the clock; the repository returns rows.
 */
export interface EngagementRecord {
  readonly engagement: Engagement;
  readonly state: EngagementState;
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
  /** Which of the firm's own entities is contracting, by NAME — this is what
   *  the letterhead and the signature block print. */
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
  /** The addressee by NAME — "Mr R Sharma", care-of `party` above. Null when
   *  the letter names no individual, which is a real answer and not a missing
   *  join. */
  readonly addressedTo: { readonly id: string; readonly displayName: string } | null;
  /**
   * Who bound the firm, by NAME and capacity — the "Yours sincerely" block.
   *
   * The name is a JOIN, not a stored field, for the reason the ledger's actor
   * name is: an erased account stops resolving and the letter survives. The
   * TITLE is stored on the letter, because it is what the document said at the
   * time and a promotion must not restate it.
   */
  readonly firmSignatory: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly title: string;
    readonly signedAt: string;
  } | null;
  /** The signed letter this one replaces, by REFERENCE — a uuid is not lineage
   *  anybody can follow. Null for an original. */
  readonly supersedes: { readonly id: string; readonly ref: string } | null;
  /** And the other direction: the live letter that replaced THIS one, if there
   *  is one. Without it, "is this still the agreement?" is a question the
   *  screen showing the agreement cannot answer. */
  readonly supersededBy: { readonly id: string; readonly ref: string } | null;
  readonly lines: readonly LetterLineRecord[];
  readonly clauses: readonly LetterClauseRecord[];
  readonly totals: {
    readonly gross: Amount;
    readonly discount: Amount;
    readonly net: Amount;
    readonly currency: CurrencyCode;
    /**
     * HOW MANY LIVE LINES THE THREE FIGURES ABOVE DO NOT COVER — the lines with
     * no price. Non-zero means the totals are a FLOOR rather than what this
     * letter commits the client to, and a screen that prints the figure without
     * this one prints a number that is not the price of the document. Same
     * reasoning, and the same field, as `ProposalTotals.unpricedLineCount`.
     */
    readonly unpricedLineCount: number;
  };
  /** The engagements this letter created, once it has been signed. Rows, as the
   *  repository read them; the service narrows each one against the clock
   *  before it leaves the use case — see `LetterView`. */
  readonly engagements: readonly Engagement[];
}

/**
 * A letter as the USE CASE hands it out: the repository's read model with each
 * engagement narrowed against today's date.
 *
 * The split is where the clock lives. A repository returns what is stored; "is
 * this engagement started yet" is a rule, it needs a clock, and rules with
 * clocks belong in the use case. Screens get `state`, so an engagement that
 * begins in October reads as `pending_start` today without any row having been
 * written to say so.
 */
export interface LetterView extends Omit<LetterRecord, "engagements"> {
  readonly engagements: readonly EngagementRecord[];
  /**
   * How this letter is being signed. `provider` is the deployment's, so a
   * DRAFT's screen knows whether sending will ask for a signer; `request` is
   * this letter's own, once it has been sent through a provider that sends.
   */
  readonly signing: {
    readonly provider: string;
    /** True when sending raises an envelope, and therefore needs a signer. */
    readonly sends: boolean;
    readonly request: SignatureRequest | null;
  };
  /**
   * The letter's own prose — its exclusions, commercial notes and team block
   * (G1.7).
   *
   * A COPY, taken at drafting from the firm's standard set, and this letter's
   * from then on; frozen with everything else once it is signed. It is on the
   * view rather than behind a second call because it is part of what the client
   * agreed to, and a renderer that had to remember a third request would print
   * an agreement missing its exclusions.
   */
  readonly blocks: readonly DocumentBlock[];
}

/**
 * THE CATALOGUE ROW A LINE CITES, as it was PINNED — read off the frozen
 * `config.version` the line stores, never off the catalogue as it stands today.
 *
 * DECLARED HERE AND AGAIN IN `usecase/proposal/ports.ts`, deliberately, the same
 * way `DocumentIdentity` is: a port is owned by the use case that needs it, and
 * the two documents are free to diverge — a letter will grow resolved wording
 * that a proposal has no use for. What they must not do is share a type through
 * a package neither owns.
 *
 * It carries what a DOCUMENT prints and what a WORK ITEM copies, because those
 * are the two consumers of a pin and both were making a registry call per line
 * to get here — the per-row lookup CLAUDE.md names as the sign that a join
 * belongs in the query. Concretely: `ref` is G2.1's acceptance ("a document
 * cites the firm's own service code"), `slaDays` is what T3.1 snapshots onto a
 * work item at creation and is why an engagement letter pins at all, `recurrence`
 * is what a line's billing frequency defaults from, `module` and `group` are the
 * revenue and delivery axes a document groups by, and the four prose blocks are
 * what an engagement letter is ASSEMBLED from (G2.2).
 *
 * THE FOUR PROSE BLOCKS ARE THE CATALOGUE'S WORDS AND ONLY EVER THOSE. G1.6 adds
 * a per-document OVERRIDE of each of them, and the override does NOT land here:
 * `service` means "the catalogue row this line was agreed from", and a field
 * that silently held the tailored wording instead would make that sentence
 * false — a screen could no longer tell a standard scope from an edited one, and
 * on a SIGNED letter the two are the difference between what the firm sells and
 * what this client actually agreed to. The resolved wording is its own thing
 * beside this one, and it says which of the two won.
 *
 * Every field but `key`, `version` and `name` is NULLABLE, and that is the
 * catalogue's own shape rather than laziness: a published version is frozen, so
 * a body published before a field existed can never be edited to carry it, and
 * null here means "the firm never stated this" — never a default a consumer may
 * invent. `slaDays: null` in particular is not zero; see `ServiceBody`.
 *
 * DELIBERATELY ABSENT: the catalogue's `description` (the LINE carries the words
 * the client actually agreed to), `category`, and `jurisdictions` (both are for
 * FINDING a service in the catalogue, not for printing one on a document).
 */
export interface PinnedService {
  /** The registry key and the version number — the pin, as a person cites it.
   *  Not the firm's code: see `ref`. */
  readonly key: string;
  readonly version: number;
  /** THE FIRM'S OWN SERVICE CODE — "A1", "H1", "R7". Null for a service the
   *  firm's master never coded. */
  readonly ref: string | null;
  readonly name: string;
  /** The Dept — the REVENUE reporting axis — and the delivery team. Independent
   *  dimensions, never a hierarchy (see `ServiceBody.group`). */
  readonly module: string | null;
  readonly group: string | null;
  /** What `unitAmount` and `listPrice` are PER. Without it an amount on a
   *  document is a number with no unit. */
  readonly billingBasis: BillingBasis | null;
  /** How often the work comes round. NOT how often it is billed — G1.6's
   *  `billingFrequency` is a fact about this deal and defaults FROM this. */
  readonly recurrence: ServiceRecurrence | null;
  /** The turnaround the firm committed to, in whole days from signing of THIS
   *  letter, as the pinned version stated it. T3.1 copies it onto a work item at
   *  creation. Null is "no SLA stated" and is not zero. */
  readonly slaDays: number | null;
  /** What the firm ASKED for this service when the letter was drafted — the
   *  other half of "list 25,000, agreed 22,500", which is the question migration
   *  0017 says the letter's pin exists to answer. */
  readonly listPrice: Money | null;
  readonly pricingNote: string | null;
  /** THE FOUR SCOPE BLOCKS, as the catalogue stated them — see the note above on
   *  why the override is not folded into these. */
  readonly scope: string | null;
  readonly clientObligations: string | null;
  readonly volumeLimits: string | null;
  readonly exclusions: string | null;
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
  /** The service as it was PINNED. Null only if the pinned version has somehow
   *  gone, which the composite foreign key makes impossible. */
  readonly service: PinnedService | null;
  /**
   * THE FOUR SCOPE BLOCKS, RESOLVED — this line's override where it has one,
   * the pinned catalogue version's words where it does not, and a flag saying
   * which of the two won.
   *
   * Resolved by `resolveTerms` in the domain, in ONE place. On a SIGNED letter
   * this is the wording the client agreed to and nothing can change it: the
   * override is a column on a frozen row, and the catalogue's half is a frozen
   * config version. `service` carries the catalogue's own words untouched
   * beside this, so a reader can see what was standard and what this client
   * negotiated.
   */
  readonly terms: DocumentTerms;
  /** NULL when the line has no price — there is no net of an amount that does
   *  not exist. */
  readonly net: Amount | null;
}

export interface LetterClauseRecord {
  readonly clause: LetterClause;
  /** As it was PINNED — the wording the client agreed to. */
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly text: string;
  /**
   * The STRUCTURED terms, beside the prose that prints them.
   *
   * This record used to carry `text` and stop, which meant the two fields G1.8
   * added to `ClauseBody` could be stored and validated and then reached
   * nothing: a document renderer asking "whose law does this letter name" had
   * only a paragraph to read, which is the exact position the firm's original
   * letter was written from. Both null is the ordinary case — most clauses name
   * no law — and both are read from the PINNED version, so a signed letter's
   * answer is the one the client agreed to and cannot move.
   */
  readonly governingLaw: JurisdictionalTerm | null;
  readonly courts: JurisdictionalTerm | null;
}

export interface LetterFilters {
  readonly status?: LetterStatus | undefined;
  readonly partyId?: string | undefined;
}

export interface LetterSummary {
  readonly letter: EngagementLetter;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
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
   * Send it: the status, the date the document carries, and the firm's own
   * signature — in ONE statement.
   *
   * Its own method rather than a flag on `setStatus`, because sending is the
   * moment the firm commits itself and three separate writes could leave a
   * letter that went out with a blank signature block or a date it never had.
   * `issuedOn` is the fallback: a letter the drafter dated keeps its date, and
   * one they did not is dated the day it went out.
   */
  markSent(
    tenantId: string,
    letterId: string,
    at: string,
    issuedOnFallback: string,
    firm: FirmSignatureRecord | null,
  ): Promise<EngagementLetter>;

  /** The live letter that supersedes this one, if any. Read before drafting a
   *  replacement so that a second one is refused by name rather than by a
   *  unique index surfacing as a 500. */
  findSuccessor(tenantId: string, letterId: string): Promise<EngagementLetter | null>;

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

  /**
   * Every engagement of one CLIENT, with the terms its letter line agreed.
   *
   * Joined in the QUERY and not looked up per row: a screen offering these has
   * to show the price beside each one, and a lookup per engagement is the
   * per-row join this codebase keeps being caught by.
   */
  listBillable(tenantId: string, partyId: string): Promise<readonly BillableEngagement[]>;
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

// ── ASKING FOR A SIGNATURE, AND LEARNING THE ANSWER (0080) ─────────────────
//
// `ESignProvider` above VERIFIES a signature that already exists. These ports
// are the other half, which a provider like DocuSign needs and an attested
// signature does not: raising an envelope when the letter is sent, and finding
// out later whether the client signed it.
//
// The letter stays `sent` while its envelope is out (decided 2026-09-23 — no
// fifth state). What the state alone cannot say — which provider asked, whom,
// and whether the asking has happened yet — is a `SignatureRequest`, read
// beside the letter.

/** How a signature request ended. `completed` signs the letter; the other two
 *  withdraw it. */
export type SignatureOutcome = "completed" | "declined" | "voided";

/** Who the provider asks to sign. Personal data: it lives in the request row
 *  and never in the ledger. */
export interface SignatureSigner {
  readonly name: string;
  readonly email: string;
}

export interface SignatureRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly letterId: string;
  readonly provider: string;
  readonly signer: SignatureSigner;
  readonly requestedBy: string | null;
  /** Null until the provider accepts an envelope. */
  readonly envelopeId: string | null;
  readonly raisedAt: string | null;
  /** The provider's own words for why the last attempt failed. Null once one
   *  succeeds. */
  readonly lastFailure: string | null;
  readonly attempts: number;
  readonly outcome: SignatureOutcome | null;
  readonly settledAt: string | null;
  /** When the provider's signed PDF and certificate were filed in bib's own
   *  document store. Null on a completed request means still to fetch. */
  readonly copiesFiledAt: string | null;
  readonly createdAt: string;
}

export interface NewSignatureRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly letterId: string;
  readonly provider: string;
  readonly signer: SignatureSigner;
  readonly requestedBy: string | null;
}

export interface SignatureRequestRepository {
  /**
   * Record whom to ask. Written BEFORE the letter is marked sent, so a letter
   * can never be `sent` through a provider with nobody on record to ask. A
   * second call for the same letter replaces the signer while no envelope
   * exists — a send that failed half way and is pressed again — and changes
   * nothing once one does.
   */
  open(request: NewSignatureRequest): Promise<SignatureRequest>;
  findForLetter(tenantId: string, letterId: string): Promise<SignatureRequest | null>;
  /**
   * Take the right to raise the envelope. Null when there is nothing to raise
   * (already raised, or settled) or somebody else holds a claim newer than
   * `staleBefore`. This is what stops a double-click and the retry route from
   * sending the client two envelopes.
   */
  claim(
    tenantId: string,
    requestId: string,
    at: string,
    staleBefore: string,
  ): Promise<SignatureRequest | null>;
  recordRaised(
    tenantId: string,
    requestId: string,
    envelopeId: string,
    at: string,
  ): Promise<SignatureRequest>;
  /** Releases the claim and keeps the provider's words for the letter page. */
  recordFailure(tenantId: string, requestId: string, failure: string): Promise<SignatureRequest>;
  /** Every raised request still waiting on the client, for the sweep. */
  listAwaiting(tenantId: string): Promise<readonly SignatureRequest[]>;
  settle(
    tenantId: string,
    requestId: string,
    outcome: SignatureOutcome,
    at: string,
  ): Promise<void>;
  /** Completed requests whose signed copies are not yet in bib's store. */
  listUnfiled(tenantId: string): Promise<readonly SignatureRequest[]>;
  recordCopiesFiled(tenantId: string, requestId: string, at: string): Promise<void>;
}

/** Where an envelope has got to, reduced to the answers the sweep acts on.
 *  `missing` is the provider holding no such envelope — most likely this
 *  deployment pointed at the wrong account — and is never acted on by the
 *  sweep. `detail` is the provider's own status word, for logs and reports. */
export interface EnvelopeProgress {
  readonly state: "out" | "completed" | "declined" | "voided" | "missing";
  readonly detail: string;
}

/**
 * The provider, asked to SEND.
 *
 * Null in `Deps` when the configured provider does not send anything — an
 * attested signature is recorded by a person after the fact, so there is no
 * envelope to raise and nothing for a sweep to watch.
 */
export interface SignatureDispatch {
  /** Must equal the `method` of the `ESignProvider` that verifies what this
   *  raised, and is what the request row records as its provider. */
  readonly method: string;
  /**
   * The envelope already raised for this letter, if the provider holds one.
   * Asked before raising, because the reply to a create can be lost after the
   * provider acted on it — and a retry that did not ask would email the client
   * a second copy of the same contract.
   */
  findForLetter(letterId: string, since: string): Promise<string | null>;
  raise(input: {
    readonly letterId: string;
    readonly ref: string;
    readonly title: string;
    readonly contentHash: string;
    readonly signer: SignatureSigner;
    readonly document: LetterDocument;
  }): Promise<{ readonly envelopeId: string }>;
  progress(envelopeId: string): Promise<EnvelopeProgress>;
  /** Cancel an envelope still out, so a client cannot go on to sign a letter
   *  the firm has withdrawn. `reason` is shown to the client by the provider. */
  void(envelopeId: string, reason: string): Promise<void>;
  /**
   * The COMPLETED envelope's own documents: the signed letter as the client
   * holds it (signature, date, the provider's stamp) and the provider's
   * certificate of completion — its record of who opened and signed, when,
   * from where. Both are evidence bib cannot re-create, which is why they are
   * fetched and filed rather than left in the provider's retention policy.
   */
  signedCopies(
    envelopeId: string,
  ): Promise<{ readonly signed: LetterDocument; readonly certificate: LetterDocument }>;
}

/**
 * Where the signed copies are filed — bib's own document store, satisfied at
 * the composition root by the file store, so this use case never learns what
 * a blob is. Null where no store is composed.
 */
export interface SignedCopyFiler {
  file(input: {
    readonly tenantId: string;
    readonly letterId: string;
    /** The client the letter binds — whose documents these are. */
    readonly partyId: string;
    readonly title: string;
    /** `signed` is the client's copy and client-visible; `certificate` is the
     *  firm's audit record and is not. */
    readonly which: "signed" | "certificate";
    readonly document: LetterDocument;
  }): Promise<void>;
}

/** The letter as the client will read it. */
export interface LetterDocument {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

/**
 * The letter's PDF, rendered for the envelope. Its own port so this use case
 * never learns what a renderer is — satisfied at the composition root by the
 * render source and the renderer T3.8 built. Null in the worker, which settles
 * envelopes and never raises one.
 */
export interface LetterPdf {
  render(tenantId: string, letterId: string): Promise<LetterDocument>;
}

/** Every firm the sweep visits. The same one-method port the other sweeps
 *  declare beside themselves. */
export interface SignatureTenants {
  activeTenantIds(): Promise<readonly string[]>;
}

/** Hashing the canonical rendering. Its own port so the domain stays free of
 *  node:crypto, and one adapter serves this and the share tokens. */
export interface ContentHasher {
  hash(content: string): string;
}

// ── THE QUOTE A LETTER IS WRITTEN UP FROM (T3.5b) ──────────────────────────
//
// Declared in THIS use case's vocabulary rather than imported from
// `usecase/proposal`, so no use case imports another — the arrangement
// `usecase/lead` has with `PartyService` through `ProspectDirectory`, and
// `usecase/portalinvite` has with `TenancyService`. Satisfied structurally by
// `ProposalService.findQuote`.
//
// It asks for the LINES and not the totals, deliberately: a total is a number
// the database computed for a document that is about to be replaced by another
// document. What carries across is what was agreed, line by line, and the new
// document computes its own.

export interface QuotedLine {
  readonly id: string;
  /** NULLABLE here and REQUIRED on a letter line, and that asymmetry is the
   *  whole difficulty of this hop: a proposal may quote a prospect that holds
   *  no entity yet. See `draftFromQuote`. */
  readonly entityPartyId: string | null;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string | null;
  readonly discountPercent: string;
  readonly jurisdiction: string | null;
  readonly billingFrequency: string | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: {
    readonly min: string;
    readonly max: string;
    readonly currency: string;
  } | null;
  readonly pricingNote: string | null;
}

/**
 * The header, exactly as `Proposal` spells it — so `ProposalService.findQuote`
 * satisfies this without a mapping step. A mapping would be a second place for
 * the quote and the letter to drift apart, on the one path whose entire job is
 * that they do not.
 */
export interface QuotedProposalHeader {
  readonly id: string;
  /** `PR-2026-0007` — what every refusal on this path quotes back, because a
   *  uuid is not something anybody can look up on a screen. */
  readonly ref: string;
  readonly partyId: string;
  readonly issuingEntityPartyId: string;
  readonly title: string;
  readonly status: string;
  /** The letter INHERITS all three and there is no override. Reinterpreting
   *  ₹1,75,000 as $1,75,000 by changing the currency underneath copied amounts
   *  is precisely the class of mistake this whole hop exists to end. */
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
}

export interface QuotedProposal {
  readonly proposal: QuotedProposalHeader;
  readonly lines: readonly QuotedLine[];
}

export interface AcceptedQuoteDirectory {
  findQuote(tenantId: string, proposalId: string): Promise<QuotedProposal | null>;
}

/**
 * WHAT A CLIENT CAN BE BILLED FOR, and the terms already agreed for it (T3.5b).
 *
 * ── WHY THIS IS A READ AND NOT A "MAKE AN INVOICE FROM THIS LETTER" WRITE ──
 *
 * An invoice is not a letter. A letter is the whole contract; an invoice bills
 * a PERIOD of it, and which period, which of the client's companies and which
 * of its services go on one document are decisions a person takes every month.
 * A bulk "invoice this letter" would produce a document nobody chose the shape
 * of, and the firm would edit it back down — which is more typing than it saved.
 *
 * So the fix for "the letter's agreed price does not reach the invoice" is that
 * the invoice LINE knows what was agreed. `crm.invoice_line.engagement_id` has
 * existed since T3.4 with nothing offering it; this is the read that lets a
 * screen offer it, with the price beside it.
 *
 * ── AND THE PRICE IS THE LETTER LINE'S, NOT THE CATALOGUE'S ────────────────
 *
 * The catalogue says what the firm asks; the letter says what this client
 * agreed, which is routinely less. Reading the list price here would quietly
 * bill a discount away.
 */
export interface BillableEngagement {
  readonly engagementId: string;
  /** Who the work is DELIVERED TO — an engagement is one service for one legal
   *  entity, so a group of four companies bills as four of these. */
  readonly entityPartyId: string;
  readonly entityName: string;
  /** The letter this term came from, so a screen can say where the figure is
   *  from and link to the document the client signed. */
  readonly letterId: string;
  readonly letterRef: string;
  /** The line's own wording — what the client read and agreed to, not the
   *  catalogue's standard description. */
  readonly description: string;
  readonly quantity: string;
  /** NULL is a real answer and must not render as zero: "as mutually agreed" is
   *  a term two parties signed, and `pricingNote` says why. An invoice LINE
   *  cannot be unpriced — it is a demand for a specific sum — so a screen has
   *  to ask for the figure here rather than prefill one. */
  readonly unitAmount: string | null;
  readonly pricingNote: string | null;
  readonly currency: string;
  readonly discountPercent: string;
  readonly billingFrequency: string | null;
  /** The commercial gate. `pending_advance` means the letter asked for an
   *  advance nobody has recorded, and billing before that is the firm invoicing
   *  work it has not been cleared to start. */
  readonly status: string;
  readonly effectiveFrom: string;
  readonly endsOn: string | null;
}
