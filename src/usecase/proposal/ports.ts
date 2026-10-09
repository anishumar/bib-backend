// The proposal use case's ports. Several are satisfied by other use cases' adapters at the
// composition root, so no two modules import each other.
import type { CompanyCalendars } from "../../domain/calendar/model";
import type { NewRecordedAcceptance, RecordedAcceptance } from "../../domain/acceptance/model";
import type { ProposalErrorCode } from "../../domain/proposal/errors";
import type { Amount, CurrencyCode, CurrencyRate, Money } from "../../domain/money/model";
import type { BillingBasis, ServiceRecurrence } from "../../domain/config/model";
import type {
  BillingFrequency,
  DocumentBlock,
  DocumentTerms,
  DocumentType,
  OutOfPocketEstimate,
} from "../../domain/document/model";
import type {
  Proposal,
  ProposalDecision,
  ProposalLine,
  ProposalStatus,
  ProposalTotals,
} from "../../domain/proposal/model";
import type { ClientStructure } from "../../domain/party/model";
import type { ProposalDept, ProposalPlan } from "../../domain/proposal/document";
import type { Actor } from "../../domain/ledger/model";
import type { ClientSender } from "../../domain/mail/model";


/**
 * Whether a party is archived (0305). The party repository's read-by-id never filters
 * `archived_at`, so the refusal can name it; 0305's triggers refuse the same reference underneath.
 */
export interface PartyStanding {
  findParty(
    tenantId: string,
    partyId: string,
  ): Promise<{
    readonly displayName: string;
    readonly archivedAt: string | null;
    /** "Prepared for" names a PERSON (0084), the letter's addressee rule. */
    readonly kind: "organization" | "person";
  } | null>;
  /** The country its registration records (Q076); null when an organization has none. A person
   *  is never asked. */
  registeredCountry(tenantId: string, partyId: string): Promise<string | null>;
}

/**
 * Whether the source lead was deleted (0086): a deleted lead gains no new proposal. The lead
 * repository's read-by-id never hides one; `trg_proposal_lead_not_deleted` is the wall.
 */
export interface LeadStanding {
  findById(
    tenantId: string,
    leadId: string,
  ): Promise<{ readonly deletedAt: string | null } | null>;
}

/**
 * Who issues the firm's documents and what the next is called; the document use case satisfies
 * it. `clientJurisdiction` may be null (prospect's country unknown), resolved through the same
 * fallback as "we are not there".
 */
export interface DocumentIdentity {
  issuerFor(tenantId: string, clientJurisdiction: string | null): Promise<string>;
  /** Whether a party is one of the firm's own companies (F-10-1). */
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
  nextRef(tenantId: string, type: DocumentType, now: Date): Promise<string>;
  /**
   * COPY the firm's standard prose onto this new document (G1.7); a copy, so editing the
   * standard changes only the NEXT document. Unscoped lines always, scoped ones only for their
   * own `jurisdiction` (GST wording never reaches a UAE document).
   */
  seedBlocks(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
    jurisdiction: string,
    /** The issuing company's own standard lines per kind, else the firm's default (T6.18). */
    issuingEntityPartyId: string,
  ): Promise<unknown>;
  /** Seed a copied draft with the source proposal's prose, whole (0316). Instead of `seedBlocks`. */
  seedBlocksCopied(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
    from: { readonly kind: "proposal"; readonly id: string },
  ): Promise<unknown>;
  /** The document's own prose now, struck-off lines excluded. */
  listBlocks(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
  ): Promise<readonly DocumentBlock[]>;
  /**
   * The standard prose as it WOULD land, composed but not written (T6.18): replaces a draft's
   * prose when its issuer changes, in the same transaction as the new issuer.
   */
  standardProse(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
    jurisdiction: string,
    issuingEntityPartyId: string,
  ): Promise<readonly ProseLine[]>;
  /** A firm company's name and registration country; null when it has no legal-entity record. */
  issuerJurisdiction(
    tenantId: string,
    firmEntityPartyId: string,
  ): Promise<{ readonly displayName: string; readonly jurisdiction: string | null }>;
}

export interface ProseLine {
  readonly id: string;
  readonly kind: DocumentBlock["kind"];
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
  /** The standard line it was copied from. */
  readonly sourceId: string | null;
}

export interface NewProposal {
  readonly id: string;
  readonly tenantId: string;
  readonly ref: string;
  readonly partyId: string;
  /** Resolved once and stored: a snapshot, not a lookup. */
  readonly issuingEntityPartyId: string;
  readonly leadId: string | null;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  /** YYYY-MM-DD, a day. */
  readonly fxRateDate: string;
  readonly validUntil: string | null;
  /** Blank has already become null (0084). */
  readonly background: string | null;
  /** Already held to the client's structure by the service. */
  readonly addressedToPartyId: string | null;
  /** The drafter, unless the caller named one. */
  readonly preparedByUserId: string | null;
  /** The closed proposal this draft copies (0316). */
  readonly copiedFromId?: string | null | undefined;
}

/**
 * A draft head change (0084). ABSENT means leave it, NULL means clear it. Title is never cleared.
 */
export interface ProposalRevision {
  readonly title?: string | undefined;
  readonly validUntil?: string | null | undefined;
  readonly background?: string | null | undefined;
  readonly addressedToPartyId?: string | null | undefined;
  readonly preparedByUserId?: string | null | undefined;
  /** T6.18: the issuing company; the three money fields travel together. */
  readonly issuingEntityPartyId?: string | undefined;
  readonly currency?: CurrencyCode | undefined;
  readonly fxRate?: Amount | undefined;
  readonly fxRateDate?: string | undefined;
}

export interface NewProposalLine {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  readonly entityPartyId: string | null;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: Amount;
  readonly unitAmount: Amount | null;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
  readonly jurisdiction: string | null;
  /** RESOLVED by the use case (caller's value, else the pin's `recurrence`, else null), so the
   *  default is fixed when the deal is struck, not re-derived from a moved catalogue. */
  readonly billingFrequency: BillingFrequency | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly pricingNote: string | null;
}

/**
 * A line as an edit leaves it (T6.18): merged with the old line and validated whole, because the
 * rules are about COMBINATIONS and the CHECKs judge the row. The pin, entity and position are not
 * editable (a different service is a different line); currency is since 0344.
 */
export interface LineEdit {
  readonly description: string;
  readonly quantity: Amount;
  readonly currency: CurrencyCode;
  readonly unitAmount: Amount | null;
  readonly discountPercent: Amount;
  readonly jurisdiction: string | null;
  readonly billingFrequency: BillingFrequency | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly pricingNote: string | null;
}

/**
 * A proposal joined for a screen: names not uuids, and each line's pinned service so a screen shows
 * "A1, list 25,000, quoted 22,500". Totals come from Postgres `numeric`.
 */
export interface ProposalRecord {
  readonly proposal: Proposal;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly lines: readonly ProposalLineRecord[];
  /** One row per live-line currency, main first, then by code (0344); currencies are never
   *  added together. No lines: one row, the main currency at zero. */
  readonly totals: readonly ProposalTotals[];
  /** By NAME, for the letterhead. */
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
  /** The issuer with its registration country (T6.18), for the builder's country chips and
   *  currency default. `jurisdiction` null when it has no `core.legal_entity` row (the seeded
   *  fallback has none). */
  readonly issuer: {
    readonly partyId: string;
    readonly name: string;
    readonly jurisdiction: string | null;
  };
  /** The document's date: sent, else drafted, as a UTC day. The PDF header prints it (0084). */
  readonly issuedOn: string;
  /**
   * Net per billing frequency (T6.18, D8), summed by the database, in reading order (monthly,
   * quarterly, annually, one-time, custom, none). What documents print instead of `totals.net`,
   * which mixes monthly with one-time fees.
   */
  readonly totalsByFrequency: readonly FrequencyTotal[];
  /**
   * Recurring fees over a YEAR (audit 2026-10-03, CA#42): monthly x 12, quarterly x 4, annually
   * x 1, by the database. One-off and custom fees excluded. One per currency, main first (0344);
   * empty when nothing priced recurs.
   */
  readonly annualValue: readonly Money[];
  /** The firm's Depts from `tenancy.service_axis`, retired included, as `planProposal` and the PDF read them. */
  readonly depts: readonly ProposalDept[];
  readonly approvedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The person it is prepared for (0084). `email` is where Send offers to email it (0085). */
  readonly addressee: {
    readonly id: string;
    readonly displayName: string;
    readonly email: string | null;
    /** Primary phone first: what "Send on WhatsApp" opens (T6.18, D13). */
    readonly phone: string | null;
  } | null;
  /** The cover's colleague (0084); email is the discriminator, display name may be absent. */
  readonly preparedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** What an email from the firm is signed and sent as. */
  readonly firmName: string;
  /** The PDF of record (0085). */
  readonly sentPdf: FiledPdf | null;
  /** Newest first (0085). */
  readonly emails: readonly ProposalEmailRecord[];
  /** Evidence of an answer the CLIENT gave on the link (0085); null if a colleague recorded it. */
  readonly clientDecision: ClientDecisionRecord | null;
  /** Acceptance given OUTSIDE the link, recorded under `acceptance:record` (0317). */
  readonly recordedAcceptance: RecordedAcceptance | null;
  /** Deleted as a mistake (0086), when the account still resolves. */
  readonly deletedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** 0316. */
  readonly copiedFrom: CopyLink | null;
  /** Drafts copied FROM this one, oldest first (0316); deleted copies left out. */
  readonly copies: readonly CopyLink[];
}

export interface CopyLink {
  readonly id: string;
  readonly ref: string;
  readonly status: ProposalStatus;
}

/** One currency, one frequency (0344). */
export interface FrequencyTotal {
  readonly currency: CurrencyCode;
  /** Null for lines that state no frequency. */
  readonly frequency: BillingFrequency | null;
  /** gross − discount of the PRICED lines, from `numeric`. */
  readonly net: Amount;
  readonly lineCount: number;
  readonly unpricedLineCount: number;
}

// ── The proposal by email, and the client's own answer (0085) ────────────────

/** A rendered proposal in the document store; `contentHash` is the lower-case SHA-256. */
export interface FiledPdf {
  readonly documentId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly filename: string;
}

export interface ProposalEmail {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  readonly toEmail: string;
  readonly note: string | null;
  readonly pdfVersionId: string;
  readonly sentBy: string | null;
  readonly sentAt: string;
}

export interface NewProposalEmail extends ProposalEmail {
  /** Never the link itself. */
  readonly linkDigest: string;
}

export interface ProposalEmailRecord {
  readonly id: string;
  readonly to: string;
  readonly note: string | null;
  readonly sentAt: string;
  /** Null for a system actor or an erased account. */
  readonly sentBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  readonly pdfContentHash: string;
}

/** The CLIENT's answer and its evidence; see `ProposalRepository.recordClientAnswer`. */
export interface NewClientAnswer {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  readonly decision: ProposalDecision;
  /** Null on an acceptance (0022 CHECK). */
  readonly declinedReason: string | null;
  readonly signerName: string;
  /** The sentence ticked; acceptances only. */
  readonly statement: string | null;
  /** Which of bib's emails carried the link, when one did. */
  readonly emailId: string | null;
  readonly pdfVersionId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly decidedAt: string;
}

export interface ClientDecisionRecord {
  readonly decision: ProposalDecision;
  readonly signerName: string;
  readonly statement: string | null;
  readonly decidedAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Null when the link reached the client some other way. */
  readonly emailedTo: string | null;
  /** The PDF of record when they answered. */
  readonly pdf: FiledPdf | null;
}

/** The email carrying the proposal: everything resolved by the use case; the adapter words it. */
export interface ProposalLetter {
  readonly to: string;
  /** The preparer, so a reply reaches a person; null replies to From. `sender` wins when set. */
  readonly replyTo: string | null;
  /** Q059: the SPOC of the proposal's one Dept, else the client's Key Manager. Null: from the
   *  firm, replies to the preparer. */
  readonly sender: ClientSender | null;
  readonly firmName: string;
  readonly preparedBy: string | null;
  /** The person it was prepared for, or null. */
  readonly greetingName: string | null;
  readonly clientName: string;
  readonly ref: string;
  readonly title: string;
  /** A day, or null for no end date. */
  readonly validUntil: string | null;
  /** The colleague's own words, above the standard letter. */
  readonly note: string | null;
  readonly viewUrl: string;
  readonly acceptUrl: string;
  readonly declineUrl: string;
  readonly pdf: { readonly filename: string; readonly bytes: Uint8Array };
}

/** The email a colleague gets when the client answers on the link. */
export interface DecisionNotice {
  readonly to: string;
  readonly clientName: string;
  readonly ref: string;
  readonly title: string;
  readonly decision: ProposalDecision;
  readonly signerName: string;
  /** An ISO instant. */
  readonly decidedAt: string;
  readonly declinedReason: string | null;
  readonly proposalUrl: string;
  /** The firm's zone, so "at 14:05" is the firm's clock (CA#50). */
  readonly timeZone?: string | null;
  /** Sent under the firm's name (CA#12); absent or null: the deployment's sender name. */
  readonly firmName?: string | null;
}

/** Who a proposal email is from (Q059). Satisfied by `PostgresClientSenders`. */
export interface ProposalSenders {
  senderForProposal(tenantId: string, proposalId: string): Promise<ClientSender | null>;
}

/** `SmtpMailer` satisfies it beside the identity letters, so one adapter owns all email wording. */
export interface ProposalMailer {
  /** Rejects if the mail server did not take it. */
  sendProposal(letter: ProposalLetter): Promise<void>;
  sendDecisionNotice(notice: DecisionNotice): Promise<void>;
}

/** The same render and filing as `POST /documents/render`, so the PDF of record is an ordinary document. */
export interface ProposalPdfs {
  file(tenantId: string, proposalId: string, actor: Actor): Promise<FiledPdf>;
  bytes(tenantId: string, pdf: FiledPdf): Promise<Uint8Array>;
}

/** From the deployment's own origin. */
export interface ProposalLinks {
  /** The client's page for a share token. */
  shareUrl(token: string): string;
  staffUrl(proposalId: string): string;
}

/**
 * The record plus the document's own prose (G1.7). `blocks` comes through `DocumentIdentity`
 * because the document use case owns `crm.document_block`; it travels WITH the record so no
 * renderer prints a proposal without its exclusions.
 */
export interface ProposalView extends ProposalRecord {
  readonly blocks: readonly DocumentBlock[];
  /** Sections and service codes from the SAME `planProposal` the PDF uses (T6.18). */
  readonly document: ProposalPlan;
  /** Why Delete would be refused now, in the DELETE's own words, or null (0086). */
  readonly deleteRefusal: { readonly code: ProposalErrorCode; readonly message: string } | null;
  /** Why "Copy as new draft" would be refused, or null (0316). A sent proposal past its date
   *  reads as copyable: the copy expires it first. */
  readonly copyRefusal: { readonly code: ProposalErrorCode; readonly message: string } | null;
}

/**
 * The catalogue row a line cites, read off its frozen pinned `config.version`, never today's
 * catalogue. Carries what documents print and work items copy, in the query, not a registry call
 * per line: `ref` (G2.1), `slaDays` (T3.1), `recurrence` (letter billing default), `module`/`group`
 * (revenue and delivery axes), and the four prose blocks (G2.2).
 *
 * The prose blocks are the CATALOGUE's words only; G1.6 overrides live in `terms` beside this.
 * Every field but `key`, `version` and `name` is nullable because published bodies are frozen and
 * predate later fields: null means "never stated", never a default to invent. Absent on purpose:
 * `description` (the line carries the client's words) and `category`; `jurisdictions` added in
 * T6.18 for the builder's country chips.
 */
export interface PinnedService {
  /** The registry key and version, the pin as a person cites it. Not the firm's code (`ref`). */
  readonly key: string;
  readonly version: number;
  /** THE FIRM'S OWN SERVICE CODE ("A1", "H1"), G2.1. Null when the firm's master never coded it. */
  readonly ref: string | null;
  readonly name: string;
  /** The Dept (REVENUE axis) and the delivery team: independent, never a hierarchy (`ServiceBody.group`). */
  readonly module: string | null;
  readonly group: string | null;
  /** ISO codes; empty means everywhere. */
  readonly jurisdictions: readonly string[];
  /** What `unitAmount` and `listPrice` are PER. */
  readonly billingBasis: BillingBasis | null;
  /** How often the work comes round, NOT how often it is billed (G1.6 `billingFrequency` defaults from it). */
  readonly recurrence: ServiceRecurrence | null;
  /** Days from signing AS THIS VERSION STATED; T3.1 copies it onto a work item so a later revision
   *  cannot make finished work late. Null is "no SLA", not zero. */
  readonly slaDays: number | null;
  /** The list price at quoting time. Null: quoted case by case, `pricingNote` says why. */
  readonly listPrice: Money | null;
  readonly pricingNote: string | null;
  readonly scope: string | null;
  readonly clientObligations: string | null;
  readonly volumeLimits: string | null;
  readonly exclusions: string | null;
}

export interface ProposalLineRecord {
  readonly line: ProposalLine;
  /** Null is a real answer on a proposal, not a missing join. */
  readonly entity: { readonly id: string; readonly displayName: string } | null;
  /** Null only if the pinned version is gone, which the composite FK makes impossible. */
  readonly service: PinnedService | null;
  /**
   * Dept and team with the firm's names from `tenancy.service_axis` (retired included). `name`
   * null when the firm keeps no row; the document then prints the code.
   */
  readonly dept: { readonly code: string; readonly name: string | null } | null;
  readonly team: { readonly code: string; readonly name: string | null } | null;
  /** The four scope blocks RESOLVED by `resolveTerms` (override else catalogue, flagged); in one place. */
  readonly terms: DocumentTerms;
  /** gross − discount, from the database. NULL when unpriced, never a zero that sums into a total. */
  readonly net: Amount | null;
}

/** A list row: totals and counterparty, not the lines (a list of thirty stays one query). */
export interface ProposalSummary {
  readonly proposal: Proposal;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
  /** Per currency, the main currency first (0344). */
  readonly totals: readonly ProposalTotals[];
  readonly lineCount: number;
}

export interface ProposalFilters {
  readonly status?: ProposalStatus | undefined;
  readonly partyId?: string | undefined;
}

/**
 * What the RECIPIENT sees: its own type, not a redaction of the staff model, so no lead, approver,
 * FX rate or catalogue pin can reach a client by default. `SharedProposal` adds the prose.
 */
export interface SharedProposalRecord {
  readonly id: string;
  /** The number the recipient quotes back. */
  readonly ref: string;
  readonly firmName: string;
  /** The contracting company's name on the letterhead; not always the group name. */
  readonly issuedBy: string;
  readonly addressedTo: string;
  readonly title: string;
  readonly status: ProposalStatus;
  readonly currency: CurrencyCode;
  readonly validUntil: string | null;
  readonly sentAt: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: Amount;
    /** Null for "as mutually agreed"; `pricingNote` is read in its place. */
    readonly unitAmount: Amount | null;
    /** 0344. */
    readonly currency: CurrencyCode;
    readonly discountPercent: Amount;
    readonly net: Amount | null;
    /**
     * Tells the client a blank price is deliberate. A line's four scope blocks (G1.6) do NOT
     * travel on this PUBLIC path (widening it is its own decision); the prose blocks do, on
     * `SharedProposal.blocks` (decided 2026-09-24).
     */
    readonly pricingNote: string | null;
    readonly billingFrequency: BillingFrequency | null;
    /** Separate from the fee, own currency, never in the totals. */
    readonly oopEstimate: OutOfPocketEstimate | null;
  }[];
  /** Per currency, the main currency first (0344). */
  readonly totals: readonly ProposalTotals[];
  /**
   * The answer given ON THIS PAGE (0085). Null when unanswered or recorded by a colleague (that
   * names a colleague, the firm's business). Address and browser stay with the firm.
   */
  readonly answer: {
    readonly decision: ProposalDecision;
    readonly signerName: string;
    readonly decidedAt: string;
  } | null;
}

/** Prose as the RECIPIENT reads it: no ids, no `sourceId`, no `isEdited` (the firm's business). */
export interface SharedProposalBlock {
  readonly kind: DocumentBlock["kind"];
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
}

/**
 * The recipient's view WITH exclusions, commercial notes and team block (G1.7, decided
 * 2026-09-24): an exclusion the client never read is not one. Composed in the use case, as
 * `ProposalView` is.
 */
export interface SharedProposal extends SharedProposalRecord {
  readonly blocks: readonly SharedProposalBlock[];
  /** Shown word for word, so what was shown is what is recorded (0085, `acceptanceStatement`). */
  readonly acceptanceStatement: string;
}

/**
 * Its own port so quoting does not import identity; one adapter satisfies both: 32 bytes from the
 * OS CSPRNG, only the digest at rest.
 */
export interface ShareLinkTokens {
  newToken(): string;
  hash(token: string): string;
}

export interface ProposalRepository {
  create(p: NewProposal): Promise<Proposal>;
  findById(tenantId: string, proposalId: string): Promise<Proposal | null>;
  /** The full read model in one query, not one per line. */
  describe(tenantId: string, proposalId: string): Promise<ProposalRecord | null>;
  list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]>;

  /** `lapseDiscountApproval` as for `updateLine` (T6.18). */
  addLine(l: NewProposalLine, lapseDiscountApproval?: boolean): Promise<ProposalLine>;
  /** Soft (removed_at): a pulled offer is part of the record. */
  removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void>;
  /** The live lines, in document order. */
  listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]>;

  /**
   * Edit a live line of a DRAFT (T6.18), clearing the discount sign-off in the SAME transaction
   * when `lapseDiscountApproval`. Null when the WHERE refused it (sent, deleted or line removed
   * since the read).
   */
  updateLine(
    tenantId: string,
    proposalId: string,
    lineId: string,
    edit: LineEdit,
    lapseDiscountApproval: boolean,
  ): Promise<ProposalLine | null>;

  /**
   * Status, its date and `declinedReason` in one statement: 0022's
   * `proposal_declined_reason_when_rejected_chk` would refuse them written separately.
   */
  setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
    declinedReason: string | null,
  ): Promise<Proposal>;

  /** At send, never at draft: an unsent quote never has a reachable link. */
  attachShareToken(tenantId: string, proposalId: string, digest: string): Promise<void>;

  /** Inside the tenant the token named; the recipient's view. */
  findShared(tenantId: string, digest: string): Promise<SharedProposalRecord | null>;

  /**
   * True on the FIRST open (only then is `proposal.viewed` recorded). `last_viewed_at` moves
   * every time; `view_count` only after `VIEW_DEDUPE_MINUTES`.
   */
  recordView(tenantId: string, proposalId: string, at: string): Promise<boolean>;

  recordDiscountApproval(
    tenantId: string,
    proposalId: string,
    approvedByUserId: string,
    at: string,
  ): Promise<Proposal>;

  /** Change a DRAFT's head (0084); the WHERE repeats `status = 'draft'`, so null after a race. */
  revise(
    tenantId: string,
    proposalId: string,
    change: ProposalRevision,
    /** T6.18 (D9): on an issuer change, live prose is replaced by THESE lines in the same
     *  transaction, so head and terms never name different companies. Null leaves it. */
    prose?: readonly ProseLine[] | null,
  ): Promise<Proposal | null>;

  /** Upsert one OTHER currency's rate on a DRAFT (0344); null when no longer a live draft. */
  setRate(tenantId: string, proposalId: string, rate: CurrencyRate): Promise<CurrencyRate | null>;
  /** False when there was none, or it is not a draft. */
  removeRate(tenantId: string, proposalId: string, currency: CurrencyCode): Promise<boolean>;

  // ── 0085 ──────────────────────────────────────────────────────────────────

  findIdByShareDigest(tenantId: string, digest: string): Promise<string | null>;

  /** Pin the PDF of record ONCE; returns whichever version won a race. Never replaced. */
  pinSentPdf(tenantId: string, proposalId: string, versionId: string): Promise<string>;

  findPdf(tenantId: string, versionId: string): Promise<FiledPdf | null>;

  recordEmail(email: NewProposalEmail): Promise<ProposalEmail>;

  /** The email of bib's that carried this link, if one did. */
  findEmailByLink(tenantId: string, proposalId: string, digest: string): Promise<ProposalEmail | null>;

  /**
   * The CLIENT's answer (status, date, reason, evidence) in ONE transaction, only while `sent`;
   * null otherwise, so a second answer can never overwrite the first.
   */
  recordClientAnswer(answer: NewClientAnswer): Promise<Proposal | null>;
  /**
   * Accept a SENT proposal on the client's behalf with evidence, one transaction (0317); null when
   * no longer sent. Refuses evidence filed elsewhere (`EvidenceNotFiledHere`).
   */
  recordAcceptance(
    proposalId: string,
    decidedAt: string,
    acceptance: NewRecordedAcceptance,
  ): Promise<Proposal | null>;

  // ── 0086 ──────────────────────────────────────────────────────────────────

  /** Live letters citing it: the same probe `trg_proposal_guard_deletion` makes. */
  liveLetterRefs(tenantId: string, proposalId: string): Promise<readonly string[]>;

  /**
   * Null when no longer a draft. The WHERE repeats `status = 'draft' AND deleted_at IS NULL`, so
   * the transition is its own lock and logs one `proposal.deleted`.
   */
  markDeleted(
    tenantId: string,
    proposalId: string,
    deletedByUserId: string | null,
  ): Promise<Proposal | null>;
}

/**
 * The client's structure on a day: whom a proposal may be prepared for (F-10-1, 0084). The
 * letter's port restated; one adapter satisfies both, so both documents accept the same people.
 */
export interface ClientStructureDirectory {
  structureOf(tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure>;
}

/** The firm's zone, for "today". `PostgresFirmTimeZone` satisfies it. */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
  /** Per-company zones (0337): a proposal lapses at the end of its last day on its issuer's calendar. */
  companyCalendars(tenantId: string): Promise<CompanyCalendars>;
}

/** Whether an account is active STAFF, so may be named as preparer. The membership adapter. */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/** The catalogue as quoting sees it; the config adapter satisfies it. */
export interface ServiceCatalogue {
  /** RESOLVE A PIN; null when not this firm's. `status` because a draft version must not be
   *  quoted while an ARCHIVED one is exactly what a pin resolves to. Same signature as the
   *  engagement use case's clause library port. */
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
 * The firm's rules read LIVE: a lowered discount limit applies this afternoon. An approved
 * proposal is not re-judged; approval is a column, not a re-derivation.
 */
export interface PolicyDirectory {
  /** Null when no discount policy is published, which is NOT "no limit" (`needsDiscountApproval`). */
  maxDiscountPercent(tenantId: string): Promise<Amount | null>;
}
