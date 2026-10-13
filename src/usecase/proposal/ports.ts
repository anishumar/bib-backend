// The ports the proposal use case needs from the world — the seams. Interfaces
// are owned by the use case that needs them, stated in our vocabulary; adapters
// in infrastructure/ implement them, and two of them are satisfied by other use
// cases at the composition root.
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
  LineBillingTiming,
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
    /** "Prepared for" names a PERSON (0084), the letter's addressee rule. */
    readonly kind: "organization" | "person";
  } | null>;
  /** The country its registration records (Q076); null when an organization
   *  has none. A person is never asked. */
  registeredCountry(tenantId: string, partyId: string): Promise<string | null>;
}

/**
 * Whether the lead a proposal would be drafted from was deleted (0086) — a
 * deleted lead gains no new proposal, 0305's rule for an archived client
 * reached from the other side.
 *
 * Satisfied structurally by the lead repository's own read-one-by-id, which
 * never hides a deleted lead, so the refusal can say what happened rather than
 * "no such lead". The trigger `trg_proposal_lead_not_deleted` refuses the same
 * reference underneath.
 */
export interface LeadStanding {
  findById(
    tenantId: string,
    leadId: string,
  ): Promise<{ readonly deletedAt: string | null } | null>;
}

export interface DocumentIdentity {
  issuerFor(tenantId: string, clientJurisdiction: string | null): Promise<string>;
  /** Whether a party is one of the firm's own companies (F-10-1). */
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
  nextRef(tenantId: string, type: DocumentType, issuingEntityPartyId: string, now: Date): Promise<string>;
  /** A draft's number once its issuer changes: new when the country does (0392). */
  refAfterIssuerChange(
    tenantId: string,
    type: DocumentType,
    currentRef: string,
    newIssuerPartyId: string,
    now: Date,
  ): Promise<string>;
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
    owner: { readonly kind: "proposal"; readonly id: string },
    jurisdiction: string,
    /** The issuing company (T6.18): its own standard lines, per kind, where it
     *  has any, and the firm's default lines where it has none. */
    issuingEntityPartyId: string,
  ): Promise<unknown>;
  /**
   * Seed a new draft with another proposal's prose, whole (0316) — the copy
   * of a rejected or expired quote. Instead of `seedBlocks`, never after it.
   */
  seedBlocksCopied(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
    from: { readonly kind: "proposal"; readonly id: string },
  ): Promise<unknown>;
  /**
   * What this document's prose says NOW — the copy it owns, not the firm's
   * standard set. A struck-off line is not returned.
   */
  listBlocks(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
  ): Promise<readonly DocumentBlock[]>;
  /**
   * The firm's standard prose as it WOULD land on this document, composed but
   * not written (T6.18) — what replaces a draft's prose when its issuer
   * changes, written by the proposal's own adapter in the same transaction as
   * the new issuer.
   */
  standardProse(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
    jurisdiction: string,
    issuingEntityPartyId: string,
  ): Promise<readonly ProseLine[]>;
  /** One of the firm's companies by name, and where it is registered — null
   *  when it has no legal-entity record. */
  issuerJurisdiction(
    tenantId: string,
    firmEntityPartyId: string,
  ): Promise<{ readonly displayName: string; readonly jurisdiction: string | null }>;
}

/** One line of prose, ready to be written onto a document. */
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
  /** Allocated before the row is written — see `DocumentIdentity`. */
  readonly ref: string;
  readonly partyId: string;
  /** Which of the firm's own entities is offering this. Resolved once, here,
   *  and stored: it is a snapshot, not a lookup. */
  readonly issuingEntityPartyId: string;
  readonly leadId: string | null;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  /** ISO date (YYYY-MM-DD). A day, not an instant — see the note on Proposal. */
  readonly fxRateDate: string;
  readonly validUntil: string | null;
  /** The Background paragraph (0084). Blank has already become null. */
  readonly background: string | null;
  /** The person at the client it is prepared for — already held to the
   *  client's structure by the service. */
  readonly addressedToPartyId: string | null;
  /** The colleague the cover names — the drafter, unless the caller named one. */
  readonly preparedByUserId: string | null;
  /** The closed proposal this draft copies (0316). Absent on every other draft. */
  readonly copiedFromId?: string | null | undefined;
}

/**
 * What a draft's head may be changed to (0084). ABSENT means "leave it"; NULL
 * means "clear it" — which is why each field is `T | null | undefined` rather
 * than optional alone. Title is never cleared: a proposal always has one.
 */
export interface ProposalRevision {
  readonly title?: string | undefined;
  readonly validUntil?: string | null | undefined;
  readonly background?: string | null | undefined;
  readonly addressedToPartyId?: string | null | undefined;
  readonly preparedByUserId?: string | null | undefined;
  /** T6.18: which of the firm's companies issues it, and in what money. The
   *  three money fields travel together. */
  readonly issuingEntityPartyId?: string | undefined;
  /** A new number when the new issuer is in another country (0392). */
  readonly ref?: string | undefined;
  readonly currency?: CurrencyCode | undefined;
  readonly fxRate?: Amount | undefined;
  readonly fxRateDate?: string | undefined;
}

export interface NewProposalLine {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  /** The entity this line is for, when the prospect has one. Null is a real
   *  answer on a proposal — see the note on `ProposalLine`. */
  readonly entityPartyId: string | null;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: Amount;
  /** Null for a line that is genuinely "as mutually agreed". `pricingNote` is
   *  then required — see `ProposalLine.unitAmount`. */
  readonly unitAmount: Amount | null;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
  readonly jurisdiction: string | null;
  /** RESOLVED before it gets here: the caller's value, else the pinned
   *  service's `recurrence`, else null. The use case does that once so the
   *  default is a property of the deal at the moment it was struck rather than
   *  something re-derived from a catalogue that has since moved. */
  readonly billingFrequency: BillingFrequency | null;
  readonly billingTiming: LineBillingTiming | null;
  readonly billingOn: string | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly pricingNote: string | null;
}

/**
 * A line as an edit leaves it (T6.18) — every changeable column, already merged
 * with what the line said and validated as a whole by the use case, because the
 * rules are about COMBINATIONS (no price needs a reason, no price takes no
 * discount) and the database CHECKs judge the row, not the change.
 *
 * Not here, on purpose: the pin, the entity and the position. A different
 * service is a different line (remove this one, add that one). The CURRENCY is
 * here since 0344: a line is priced in the proposal's main currency or in one
 * the proposal holds a rate for, which the use case checks first and the
 * database again at commit.
 */
export interface LineEdit {
  readonly description: string;
  readonly quantity: Amount;
  readonly currency: CurrencyCode;
  readonly unitAmount: Amount | null;
  readonly discountPercent: Amount;
  readonly jurisdiction: string | null;
  readonly billingFrequency: BillingFrequency | null;
  readonly billingTiming: LineBillingTiming | null;
  readonly billingOn: string | null;
  readonly scopeOverride: string | null;
  readonly clientObligationsOverride: string | null;
  readonly volumeLimitsOverride: string | null;
  readonly exclusionsOverride: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly pricingNote: string | null;
}

/**
 * A proposal with everything a screen renders it from.
 *
 * The joined read model this codebase learnt to build the first time (see
 * CLAUDE.md): a bare `Proposal` carries `partyId` and each line carries a
 * `serviceVersionId`, which is right for the aggregate and renders as a column
 * of uuids. `service` comes from the pinned catalogue version, so a screen can
 * show "A1 — list 25,000, quoted 22,500" without resolving pins itself, which is
 * the commercial question the pin exists to answer.
 *
 * Totals are computed in Postgres `numeric` by the query that reads the lines —
 * never summed in TypeScript.
 */
export interface ProposalRecord {
  readonly proposal: Proposal;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly lines: readonly ProposalLineRecord[];
  /** One row per currency the live lines are in, the main currency first, then
   *  by code (0344). Amounts in two currencies are never added together, so
   *  there is no single total. A proposal with no line has one row, its main
   *  currency at zero, as before. */
  readonly totals: readonly ProposalTotals[];
  /** Which of the firm's own entities is offering it, by NAME — this is what a
   *  letterhead prints, and a uuid prints as nothing. */
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
  /**
   * The same company with the country it is registered in (T6.18) — what the
   * builder's country chips and currency default start from. `jurisdiction` is
   * null for a firm entity with no `core.legal_entity` row (the fallback every
   * firm is seeded with has none).
   */
  readonly issuer: {
    readonly partyId: string;
    readonly name: string;
    readonly jurisdiction: string | null;
  };
  /**
   * The day the document is dated — when it was sent, else when it was drafted,
   * as a UTC day. The PDF's running header prints this one (0084), so the
   * preview does not compute its own.
   */
  readonly issuedOn: string;
  /**
   * THE MONEY PER BILLING FREQUENCY (T6.18, D8) — summed by the database, one
   * row per frequency the live lines carry, in reading order (monthly,
   * quarterly, annually, one-time, custom, then lines that state none).
   *
   * `totals.net` adds a monthly fee to a one-time one, which is a number no
   * reader should be shown as "the total"; this is what the document and the
   * builder print instead. `unpricedLineCount` is per row, for `totals`' reason.
   */
  readonly totalsByFrequency: readonly FrequencyTotal[];
  /**
   * What the recurring fees come to over a YEAR (audit 2026-10-03, CA#42):
   * monthly x 12, quarterly x 4, annually x 1, summed by the database. A
   * one-off or custom fee is not in it (it is not a yearly figure), and an
   * unpriced line is counted beside it in `totalsByFrequency`. Null when no
   * priced line recurs. "What is this client worth a year?" One per currency
   * (0344), the main currency first; empty when nothing priced recurs.
   */
  readonly annualValue: readonly Money[];
  /**
   * The firm's Depts as `tenancy.service_axis` holds them, retired ones
   * included — what `planProposal` letters the sections by, read the way the
   * PDF's render source reads them.
   */
  readonly depts: readonly ProposalDept[];
  /** Who signed off an over-limit discount, for a screen that has to show it.
   *  Null when nobody has. */
  readonly approvedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The person it is prepared for, by NAME (0084). Null when none is named.
   *  `email` is that person's email identifier in the firm's records, when
   *  they have one — where Send offers to email it (0085). */
  readonly addressee: {
    readonly id: string;
    readonly displayName: string;
    readonly email: string | null;
    /** That person's phone identifier, the primary one first — what "Send on
     *  WhatsApp" opens a chat with (T6.18, D13). */
    readonly phone: string | null;
  } | null;
  /** The colleague the cover names, with the address it prints (0084). The
   *  email is the discriminator — an account may have no display name. */
  readonly preparedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The firm's own name — what an email from it is signed and sent as. */
  readonly firmName: string;
  /** The PDF of record (0085), once a sent proposal has one. */
  readonly sentPdf: FiledPdf | null;
  /** Every email bib sent it in, newest first (0085). */
  readonly emails: readonly ProposalEmailRecord[];
  /** The evidence behind an answer the CLIENT gave on the link (0085). Null
   *  when it is unanswered, and when a colleague recorded the answer. */
  readonly clientDecision: ClientDecisionRecord | null;
  /** An acceptance the client gave OUTSIDE the link, recorded by a colleague
   *  holding `acceptance:record` (0317). Null otherwise. */
  readonly recordedAcceptance: RecordedAcceptance | null;
  /** Who deleted it, when it was deleted as a mistake (0086) and the account
   *  still resolves. */
  readonly deletedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The closed proposal this draft was copied from (0316), or null. */
  readonly copiedFrom: CopyLink | null;
  /** The drafts copied FROM this one, oldest first (0316). A copy deleted as a
   *  mistake is left out, as it is from every list. */
  readonly copies: readonly CopyLink[];
}

/** One end of a copy (0316): enough to link to it and say where it stands. */
export interface CopyLink {
  readonly id: string;
  readonly ref: string;
  readonly status: ProposalStatus;
}

/** One row of `ProposalRecord.totalsByFrequency`: one currency, one frequency
 *  (0344). */
export interface FrequencyTotal {
  readonly currency: CurrencyCode;
  /** Null for the lines that state no billing frequency. */
  readonly frequency: BillingFrequency | null;
  /** gross − discount of the PRICED lines at this frequency, from `numeric`. */
  readonly net: Amount;
  readonly lineCount: number;
  readonly unpricedLineCount: number;
}

// ── The proposal by email, and the client's own answer (0085) ────────────────

/** A rendered proposal, filed in the document store. `contentHash` is its
 *  fingerprint — the lower-case SHA-256 every stored file carries. */
export interface FiledPdf {
  readonly documentId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly filename: string;
}

/** An email bib sent a proposal in, as the repository keeps it. */
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
  /** The digest of the link this email carried — never the link. */
  readonly linkDigest: string;
}

/** An email as the proposal page lists it. */
export interface ProposalEmailRecord {
  readonly id: string;
  readonly to: string;
  readonly note: string | null;
  readonly sentAt: string;
  /** Who pressed the button. Null for a system actor or an erased account. */
  readonly sentBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The fingerprint of the PDF it attached. */
  readonly pdfContentHash: string;
}

/**
 * The CLIENT's answer and the evidence behind it, written in the same
 * statement that moves the status — see `ProposalRepository.recordClientAnswer`.
 */
export interface NewClientAnswer {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string;
  readonly decision: ProposalDecision;
  /** Why, on a decline. Null on an acceptance, which the 0022 CHECK insists on. */
  readonly declinedReason: string | null;
  readonly signerName: string;
  /** The sentence they ticked — an acceptance's, and only an acceptance's. */
  readonly statement: string | null;
  /** Which of bib's emails carried the link, when one did. */
  readonly emailId: string | null;
  readonly pdfVersionId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly decidedAt: string;
}

/** The evidence behind an answer the client gave, as a colleague reads it. */
export interface ClientDecisionRecord {
  readonly decision: ProposalDecision;
  readonly signerName: string;
  readonly statement: string | null;
  readonly decidedAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Where bib emailed the link that was used. Null when the link reached
   *  the client some other way. */
  readonly emailedTo: string | null;
  /** The PDF of record when they answered. */
  readonly pdf: FiledPdf | null;
}

/**
 * The letter a client receives with the proposal attached.
 *
 * Everything the adapter needs to write it and nothing it would have to look
 * up: the use case resolves the names, the addresses and the links, and the
 * adapter decides how the letter reads — the split `Mailer` already has.
 */
export interface ProposalLetter {
  readonly to: string;
  /** The colleague who prepared it, so a reply reaches a person. Null sends
   *  replies to the From address. The SENDER below wins when there is one. */
  readonly replyTo: string | null;
  /** Who the email is from (Q059): the SPOC of the proposal's one Dept, else
   *  the client's Key Manager. Null: from the firm, replies to the preparer. */
  readonly sender: ClientSender | null;
  /** Who the email is FROM, by name, and who signs it. */
  readonly firmName: string;
  readonly preparedBy: string | null;
  /** Whom it greets — the person it was prepared for — or null. */
  readonly greetingName: string | null;
  readonly clientName: string;
  readonly ref: string;
  readonly title: string;
  /** A day (YYYY-MM-DD), or null for an offer with no end date. */
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
  /** The firm's name, which the notice is sent under (CA#12). Absent or null:
   *  the deployment's sender name. */
  readonly firmName?: string | null;
}

/**
 * Sending the two letters. `SmtpMailer` satisfies it structurally beside the
 * identity letters, so one adapter still owns everything an email says.
 */
/** Who a proposal email is from (Q059). Satisfied by `PostgresClientSenders`. */
export interface ProposalSenders {
  senderForProposal(tenantId: string, proposalId: string): Promise<ClientSender | null>;
}

export interface ProposalMailer {
  /** Rejects if the mail server did not take it. */
  sendProposal(letter: ProposalLetter): Promise<void>;
  sendDecisionNotice(notice: DecisionNotice): Promise<void>;
}

/**
 * The proposal as a PDF, through the document store — the same render and the
 * same filing `POST /documents/render` does, so the PDF of record is an
 * ordinary document on the proposal's page.
 */
export interface ProposalPdfs {
  /** Render the proposal as it stands and file it. */
  file(tenantId: string, proposalId: string, actor: Actor): Promise<FiledPdf>;
  bytes(tenantId: string, pdf: FiledPdf): Promise<Uint8Array>;
}

/** The two addresses a letter links to, from the deployment's own origin. */
export interface ProposalLinks {
  /** The client's page for a share token. */
  shareUrl(token: string): string;
  /** A colleague's page for a proposal. */
  staffUrl(proposalId: string): string;
}

/**
 * A proposal as a SCREEN or a renderer gets it: the record, plus the document's
 * own prose (G1.7).
 *
 * `blocks` is not on `ProposalRecord` because the repository does not own that
 * table — the document use case does, and quoting reaches it through the same
 * `DocumentIdentity` seam it already uses for references and issuing entities.
 * The alternative was a second join in the proposal adapter, which would put
 * knowledge of `crm.document_block` in two places and let them drift.
 *
 * It travels WITH the document rather than behind a second call because it is
 * part of what the document says. A renderer that fetched lines and then had to
 * remember a third request would print a proposal with no exclusions on it,
 * which reads as the firm asserting no limits at all on the work it quoted for.
 */
export interface ProposalView extends ProposalRecord {
  readonly blocks: readonly DocumentBlock[];
  /**
   * How the document is ORGANISED — its sections and the code each service
   * prints under (T6.18) — from the SAME `planProposal` the PDF is rendered
   * from, over the same inputs, so the in-app preview cannot letter a section
   * differently from the file the client receives.
   */
  readonly document: ProposalPlan;
  /**
   * Why Delete would be refused right now (0086), in the words a DELETE would
   * be refused with — or null when it would work. "A caller is told what it may
   * do": the page offers the button only when it will work.
   */
  readonly deleteRefusal: { readonly code: ProposalErrorCode; readonly message: string } | null;
  /**
   * Why "Copy as new draft" would be refused right now (0316), in the words the
   * copy would be refused with, or null when it would work. A sent proposal
   * past its date reads as copyable: the copy expires it first.
   */
  readonly copyRefusal: { readonly code: ProposalErrorCode; readonly message: string } | null;
}

/**
 * THE CATALOGUE ROW A LINE CITES, as it was PINNED — read off the frozen
 * `config.version` the line stores, never off the catalogue as it stands today.
 *
 * It carries what a DOCUMENT prints and what a WORK ITEM copies, because those
 * are the two consumers of a pin and both were making a registry call per line
 * to get here — the per-row lookup CLAUDE.md names as the sign that a join
 * belongs in the query. Concretely: `ref` is G2.1's acceptance ("a proposal
 * cites the firm's own service code"), `slaDays` is what T3.1 snapshots onto a
 * work item at creation, `recurrence` is what a letter line's billing frequency
 * defaults from, `module` and `group` are the revenue and delivery axes a
 * document groups by, and the four prose blocks are what an engagement letter is
 * assembled from (G2.2).
 *
 * THE FOUR PROSE BLOCKS ARE THE CATALOGUE'S WORDS AND ONLY EVER THOSE. G1.6 adds
 * a per-document OVERRIDE of each of them, and the override does NOT land here:
 * `service` means "the catalogue row this line was quoted from", and a field
 * that silently held the tailored wording instead would make that sentence
 * false — a screen could no longer tell a standard scope from an edited one, and
 * "what does our catalogue say" would have no answer left on the read model. The
 * resolved wording is its own thing beside this one, and it says which of the
 * two won.
 *
 * Every field but `key`, `version` and `name` is NULLABLE, and that is the
 * catalogue's own shape rather than laziness: a published version is frozen, so
 * a body published before a field existed can never be edited to carry it, and
 * null here means "the firm never stated this" — never a default a consumer may
 * invent. `slaDays: null` in particular is not zero; see `ServiceBody`.
 *
 * DELIBERATELY ABSENT: the catalogue's `description` (the LINE carries the words
 * the client actually reads, and a firm tailors them per document — printing the
 * catalogue's beside them is two descriptions and no rule about which wins) and
 * `category`. `jurisdictions` was absent for the same reason until T6.18: the
 * builder shows a quoted line under the country chip it was picked from, and
 * that needs "Offered in" off the pin rather than a catalogue call per line.
 */
export interface PinnedService {
  /** The registry key and the version number — the pin, as a person cites it.
   *  Not the firm's code: see `ref`. */
  readonly key: string;
  readonly version: number;
  /** THE FIRM'S OWN SERVICE CODE — "A1", "H1", "R7". G2.1's acceptance in one
   *  field: this is what a proposal has to print, and getting it meant a
   *  registry call per line. Null for a service the firm's master never coded. */
  readonly ref: string | null;
  readonly name: string;
  /** The Dept — the REVENUE reporting axis — and the delivery team. Independent
   *  dimensions, never a hierarchy (see `ServiceBody.group`). */
  readonly module: string | null;
  readonly group: string | null;
  /** Where the service is offered — ISO codes, empty meaning everywhere. */
  readonly jurisdictions: readonly string[];
  /** What `unitAmount` and `listPrice` are PER — per hour, per month, per item,
   *  or for the whole engagement. Without it an amount on a document is a number
   *  with no unit. Null only for a stored body that somehow has none. */
  readonly billingBasis: BillingBasis | null;
  /** How often the work comes round. NOT how often it is billed — G1.6's
   *  `billingFrequency` is a fact about this deal and defaults FROM this. */
  readonly recurrence: ServiceRecurrence | null;
  /** The turnaround the firm committed to, in whole days from signing, AS THIS
   *  VERSION STATED IT. T3.1 copies it onto a work item at creation, which is
   *  the whole reason the line pins a version rather than reading the catalogue
   *  live: a revision next quarter must not make finished work retroactively
   *  late. Null is "no SLA stated" and is not zero. */
  readonly slaDays: number | null;
  /** What the firm ASKED for this service when the line was quoted — the other
   *  half of "list 25,000, quoted 22,500". Null means the firm quotes it case by
   *  case, and `pricingNote` is where it says why. */
  readonly listPrice: Money | null;
  readonly pricingNote: string | null;
  /** THE FOUR SCOPE BLOCKS, as the catalogue stated them — see the note above on
   *  why the override is not folded into these. */
  readonly scope: string | null;
  readonly clientObligations: string | null;
  readonly volumeLimits: string | null;
  readonly exclusions: string | null;
}

export interface ProposalLineRecord {
  readonly line: ProposalLine;
  /** The entity by NAME. Null when the line names none — which on a proposal is
   *  a real answer, not a missing join. */
  readonly entity: { readonly id: string; readonly displayName: string } | null;
  /** The service as it was PINNED. Null only if the pinned version has somehow
   *  gone, which the composite foreign key makes impossible; the type is honest
   *  about the join anyway. */
  readonly service: PinnedService | null;
  /**
   * The pinned version's Dept and delivery team, with the names the firm keeps
   * for them in `tenancy.service_axis` (retired rows included, as the PDF reads
   * them). Null when the service names none; `name` null when the firm keeps no
   * row for the code, which the document then prints as the code itself.
   */
  readonly dept: { readonly code: string; readonly name: string | null } | null;
  readonly team: { readonly code: string; readonly name: string | null } | null;
  /**
   * THE FOUR SCOPE BLOCKS, RESOLVED — this line's override where it has one,
   * the pinned catalogue version's words where it does not, and a flag saying
   * which of the two won.
   *
   * Resolved by `resolveTerms` in the domain, in ONE place, because the
   * alternative is every screen resolving it and the second one getting it
   * wrong. `service` still carries the CATALOGUE's words untouched beside this,
   * so an editor can show what the standard scope says and what this document
   * changed it to — which is the comparison somebody makes before tailoring.
   */
  readonly terms: DocumentTerms;
  /** gross − discount for this line, in the proposal's currency. From the
   *  database, like every other sum here.
   *
   *  NULL when the line has no price — there is no net of an amount that does
   *  not exist, and the alternative is a zero that sums into the document's
   *  total as though the client agreed to pay nothing for this. */
  readonly net: Amount | null;
}

/**
 * A proposal as a LIST shows it: the money, the client, and how many lines —
 * not the lines themselves.
 *
 * Its own type rather than a `ProposalRecord` with an empty `lines`, because
 * that would be a read model that lies about what it contains. A list screen
 * needs the total and the counterparty; opening one is what fetches the lines,
 * and pretending otherwise turns a list of thirty into thirty-one queries.
 */
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
 * What the RECIPIENT sees — a different read model from the staff one, and
 * deliberately not a redaction of it.
 *
 * A client opening a proposal must not learn the firm's internal shape: which
 * lead it came from, which colleague signed off a discount, what exchange rate
 * the firm books it at, or which catalogue version it was quoted from. Those
 * are all on `ProposalRecord`, which is why this is its own type rather than
 * the same one with fields nulled — a field added to the staff model then
 * cannot reach a client's screen by default.
 *
 * This is what the REPOSITORY returns. `SharedProposal` below adds the
 * document's own prose, which the proposal table does not own.
 */
export interface SharedProposalRecord {
  readonly id: string;
  /** The number the recipient quotes back. The whole reason it exists is this
   *  screen and the phone call that follows it. */
  readonly ref: string;
  /** Who sent it. A document with no sender is not a document. */
  readonly firmName: string;
  /** Which of the firm's entities is offering — the name on the letterhead. A
   *  client needs to know which company they would be contracting with, and it
   *  is not always the group name above. */
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
    /** Null for "as mutually agreed" — and then `pricingNote` is what the
     *  recipient reads where the figure would be. */
    readonly unitAmount: Amount | null;
    /** What this line is priced in (0344). */
    readonly currency: CurrencyCode;
    readonly discountPercent: Amount;
    readonly net: Amount | null;
    /**
     * WHY there is no figure. On the recipient's own document, because that is
     * the whole point of the field: a client looking at a blank price has to be
     * told it is deliberate.
     *
     * The four scope blocks (a line's own scope wording, G1.6) still do NOT
     * travel here. This is a PUBLIC path and widening what an unauthenticated
     * link exposes is its own decision. The document's PROSE blocks do travel,
     * on `SharedProposal.blocks` — that decision was taken on 2026-09-24.
     */
    readonly pricingNote: string | null;
    /** How often the client will be invoiced for this line. */
    readonly billingFrequency: BillingFrequency | null;
    /** What the client is told to expect to reimburse, separate from the fee
     *  and in its own currency. Never folded into the totals. */
    readonly oopEstimate: OutOfPocketEstimate | null;
  }[];
  /** Per currency, the main currency first (0344). */
  readonly totals: readonly ProposalTotals[];
  /**
   * The answer given ON THIS PAGE, by name (0085) — so the page can say who
   * accepted it and when. Null when unanswered, and when a colleague recorded
   * the answer: that record names a colleague, and a colleague is the firm's
   * business, not the reader's. The address and browser stay with the firm.
   */
  readonly answer: {
    readonly decision: ProposalDecision;
    readonly signerName: string;
    readonly decidedAt: string;
  } | null;
}

/**
 * One line of the document's own prose as the RECIPIENT reads it. No ids, no
 * `sourceId`, no `isEdited`: whether a line is the firm's house wording or was
 * written for this client is the firm's business, not the reader's.
 */
export interface SharedProposalBlock {
  readonly kind: DocumentBlock["kind"];
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
}

/**
 * What the recipient sees, WITH the exclusions, commercial notes and team
 * block the document carries (G1.7).
 *
 * Decided 2026-09-24: the staff screen says "this quote is sent, so its
 * wording is the record of what the client was shown", and until now the
 * client was shown the prices and none of the wording. An exclusion the client
 * never read is not an exclusion. The team block goes too — a proposal names
 * who will do the work.
 *
 * Composed in the use case, not the repository, for the same reason
 * `ProposalView` is: the proposal adapter does not own `crm.document_block`.
 */
export interface SharedProposal extends SharedProposalRecord {
  readonly blocks: readonly SharedProposalBlock[];
  /** The sentence an acceptance ticks, word for word (0085). The page shows
   *  THIS text rather than composing its own, so what was shown is what is
   *  recorded — see `acceptanceStatement`. */
  readonly acceptanceStatement: string;
}

/**
 * Minting and hashing a share token.
 *
 * Its own port rather than reaching into identity's `TokenFactory`, so quoting
 * does not import the identity use case for a type. The composition root
 * satisfies both with one adapter — which is right, because the two want the
 * same guarantee: 32 bytes from the OS CSPRNG, and only the digest at rest.
 */
export interface ShareLinkTokens {
  newToken(): string;
  hash(token: string): string;
}

export interface ProposalRepository {
  create(p: NewProposal): Promise<Proposal>;
  findById(tenantId: string, proposalId: string): Promise<Proposal | null>;
  /** The full read model: proposal, party, lines with their pinned services,
   *  and the totals — one query, not one per line. */
  describe(tenantId: string, proposalId: string): Promise<ProposalRecord | null>;
  list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]>;

  /** `lapseDiscountApproval` as for `updateLine`: a line added past the limit
   *  after the sign-off clears it, in the same transaction (T6.18). */
  addLine(l: NewProposalLine, lapseDiscountApproval?: boolean): Promise<ProposalLine>;
  /** Soft: sets removed_at. Nothing deletes a line — what the firm considered
   *  offering and pulled is part of the record. */
  removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void>;
  /** The live lines, in document order. */
  listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]>;

  /**
   * Write an edit to a live line of a DRAFT (T6.18), and — when
   * `lapseDiscountApproval` — clear the proposal's discount sign-off in the
   * SAME transaction, so a raised discount can never sit under an approval
   * given for the old one.
   *
   * Null when the WHERE clause refused it: the proposal was sent or deleted, or
   * the line removed, between the use case's read and this write.
   */
  updateLine(
    tenantId: string,
    proposalId: string,
    lineId: string,
    edit: LineEdit,
    lapseDiscountApproval: boolean,
  ): Promise<ProposalLine | null>;

  /**
   * Move the status and stamp whichever date goes with it, in one statement, so
   * a row can never claim to be sent with no sent_at.
   *
   * `declinedReason` travels with the status for the same reason the dates do:
   * `proposal_declined_reason_when_rejected_chk` (0022) ties the two together,
   * so writing them separately would not merely be untidy — the first statement
   * would be refused. Null for every transition but a rejection.
   */
  setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
    declinedReason: string | null,
  ): Promise<Proposal>;

  /** Attach the share link's digest as part of sending. Never at draft: a quote
   *  that never went out should never have had a reachable link. */
  attachShareToken(tenantId: string, proposalId: string, digest: string): Promise<void>;

  /** Resolve a share link, inside the tenant the token named. Returns the
   *  recipient's view, not the staff one. */
  findShared(tenantId: string, digest: string): Promise<SharedProposalRecord | null>;

  /**
   * Record an open. Returns true when it was the FIRST — the caller records
   * `proposal.viewed` only then, because the ledger holds state transitions and
   * a client refreshing a page is not fifty facts about the business.
   *
   * `last_viewed_at` moves every time; `view_count` advances only when the
   * previous open was more than `VIEW_DEDUPE_MINUTES` ago. The link is public,
   * so without that the count is a number anybody holding it can turn — see the
   * constant.
   */
  recordView(tenantId: string, proposalId: string, at: string): Promise<boolean>;

  recordDiscountApproval(
    tenantId: string,
    proposalId: string,
    approvedByUserId: string,
    at: string,
  ): Promise<Proposal>;

  /**
   * Change a DRAFT's head (0084). The WHERE clause repeats `status = 'draft'`,
   * so a proposal sent between the service's read and this write is not
   * changed — null comes back, and the service says it is no longer a draft.
   */
  revise(
    tenantId: string,
    proposalId: string,
    change: ProposalRevision,
    /**
     * T6.18 (D9): when the issuer changes, the draft's live prose is struck off
     * and THESE lines written in its place, in the SAME transaction as the new
     * issuer — so a draft can never say one company in its head and another's
     * standard terms below it. Null leaves the prose alone.
     */
    prose?: readonly ProseLine[] | null,
  ): Promise<Proposal | null>;

  /**
   * Set the rate of one OTHER currency on a DRAFT (0344): insert, or replace
   * the rate already there. Null when the proposal is no longer a live draft.
   */
  setRate(tenantId: string, proposalId: string, rate: CurrencyRate): Promise<CurrencyRate | null>;
  /** Take one off a DRAFT. False when there was none, or it is not a draft. */
  removeRate(tenantId: string, proposalId: string, currency: CurrencyCode): Promise<boolean>;

  // ── 0085 ──────────────────────────────────────────────────────────────────

  /** Which proposal a share link opens, inside the tenant its token named. */
  findIdByShareDigest(tenantId: string, digest: string): Promise<string | null>;

  /**
   * Pin the PDF of record — ONCE. Returns the version that IS pinned
   * afterwards: this one, or the one a concurrent caller pinned first, which
   * then stands. A pinned PDF is never replaced.
   */
  pinSentPdf(tenantId: string, proposalId: string, versionId: string): Promise<string>;

  /** A filed PDF by its version, with the document it belongs to. */
  findPdf(tenantId: string, versionId: string): Promise<FiledPdf | null>;

  recordEmail(email: NewProposalEmail): Promise<ProposalEmail>;

  /** The email of bib's that carried this link, if one did. */
  findEmailByLink(tenantId: string, proposalId: string, digest: string): Promise<ProposalEmail | null>;

  /**
   * Record the CLIENT's answer: the status, its date and a decline's reason,
   * and the evidence row — in ONE transaction, and only while the proposal is
   * still `sent`. Returns null when it is not (answered a moment ago in another
   * tab, or expired), so two answers cannot both land and the second cannot
   * overwrite the first.
   */
  recordClientAnswer(answer: NewClientAnswer): Promise<Proposal | null>;
  /**
   * Accept a SENT proposal on the client's behalf, with the evidence, in ONE
   * transaction (0317): null when it is no longer sent. Refuses evidence not
   * filed against this proposal (`EvidenceNotFiledHere`).
   */
  recordAcceptance(
    proposalId: string,
    decidedAt: string,
    acceptance: NewRecordedAcceptance,
  ): Promise<Proposal | null>;

  // ── 0086 ──────────────────────────────────────────────────────────────────

  /**
   * The references of the LIVE engagement letters citing this proposal — what
   * stops it being deleted. The same probe `trg_proposal_guard_deletion` makes,
   * so the page's answer and the wall's cannot disagree.
   */
  liveLetterRefs(tenantId: string, proposalId: string): Promise<readonly string[]>;

  /**
   * Mark a DRAFT deleted, or return null when it was not one any more — sent,
   * or deleted by somebody else a moment ago. The WHERE clause repeats
   * `status = 'draft' AND deleted_at IS NULL`, so the transition is its own
   * lock and the log gets one `proposal.deleted`, never two.
   */
  markDeleted(
    tenantId: string,
    proposalId: string,
    deletedByUserId: string | null,
  ): Promise<Proposal | null>;
}

/**
 * The client's structure on a day — whom a proposal may be prepared for
 * (F-10-1, 0084). The letter's port, stated again here so neither use case
 * imports the other; the relationship repository satisfies both, so the two
 * documents accept exactly the same people.
 */
export interface ClientStructureDirectory {
  structureOf(tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure>;
}

/** Which zone the firm keeps its calendar in — "today", for the day that
 *  structure is read on. `PostgresFirmTimeZone` satisfies it. */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
  /** The companies that keep their own zone (0337): a proposal lapses at the
   *  end of its last day on its issuing company's calendar. */
  companyCalendars(tenantId: string): Promise<CompanyCalendars>;
}

/**
 * Whether an account is an active member of this firm's STAFF — who may be
 * named as having prepared a proposal. The membership adapter satisfies it, as
 * it does the lead pipeline's identical question.
 */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/**
 * The catalogue, as quoting needs to see it.
 *
 * Narrow on purpose: the proposal use case does not want to know what a config
 * entry is, only whether this version id names a service this firm published
 * and what it said. Declared here in proposal's own vocabulary; the config
 * adapter satisfies it, so neither module imports the other — the same shape
 * tenancy's `RoleDirectory` uses.
 */
export interface ServiceCatalogue {
  /** RESOLVE A PIN. Returns null when the id is not this firm's. `status` comes
   *  back because a draft was never in force and must not be quoted, while an
   *  ARCHIVED version is exactly what a pin is supposed to resolve to.
   *
   *  The same signature the engagement use case declares for its clause
   *  library — two use cases arriving independently at one question about one
   *  pair of tables, which is why the config adapter implements it once. */
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
 * The firm's own rules, read LIVE.
 *
 * Live rather than pinned, and that is the consumer's decision as the registry
 * insists it should be: a firm that lowers its discount limit expects the new
 * one to apply this afternoon. A proposal already approved is not re-judged,
 * because the check happens once, at approval, and its outcome is a column on
 * the proposal rather than a re-derivation.
 */
export interface PolicyDirectory {
  /** The published `maxDiscountPercent`, or null when the firm has published no
   *  discount policy at all. Null is NOT "no limit" — see
   *  `needsDiscountApproval` in the domain, which reads it as zero. */
  maxDiscountPercent(tenantId: string): Promise<Amount | null>;
}
