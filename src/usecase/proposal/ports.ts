// The ports the proposal use case needs from the world — the seams. Interfaces
// are owned by the use case that needs them, stated in our vocabulary; adapters
// in infrastructure/ implement them, and two of them are satisfied by other use
// cases at the composition root.
import type { Amount, CurrencyCode, Money } from "../../domain/money/model";
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
  ProposalLine,
  ProposalStatus,
  ProposalTotals,
} from "../../domain/proposal/model";


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
export interface DocumentIdentity {
  issuerFor(tenantId: string, clientJurisdiction: string | null): Promise<string>;
  nextRef(tenantId: string, type: DocumentType, now: Date): Promise<string>;
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
  ): Promise<unknown>;
  /**
   * What this document's prose says NOW — the copy it owns, not the firm's
   * standard set. A struck-off line is not returned.
   */
  listBlocks(
    tenantId: string,
    owner: { readonly kind: "proposal"; readonly id: string },
  ): Promise<readonly DocumentBlock[]>;
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
  readonly totals: ProposalTotals;
  /** Which of the firm's own entities is offering it, by NAME — this is what a
   *  letterhead prints, and a uuid prints as nothing. */
  readonly issuingEntity: { readonly id: string; readonly displayName: string };
  /** Who signed off an over-limit discount, for a screen that has to show it.
   *  Null when nobody has. */
  readonly approvedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
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
 * catalogue's beside them is two descriptions and no rule about which wins),
 * `category`, and `jurisdictions` (both are for FINDING a service in the
 * catalogue, not for printing one on a document).
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
  readonly totals: ProposalTotals;
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
 */
export interface SharedProposal {
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
    readonly discountPercent: Amount;
    readonly net: Amount | null;
    /**
     * WHY there is no figure. On the recipient's own document, because that is
     * the whole point of the field: a client looking at a blank price has to be
     * told it is deliberate.
     *
     * The four scope blocks deliberately do NOT travel here. This is the fourth
     * PUBLIC path and widening what an unauthenticated link exposes is its own
     * decision, not a side effect of G1.6.
     */
    readonly pricingNote: string | null;
    /** How often the client will be invoiced for this line. */
    readonly billingFrequency: BillingFrequency | null;
    /** What the client is told to expect to reimburse, separate from the fee
     *  and in its own currency. Never folded into the totals. */
    readonly oopEstimate: OutOfPocketEstimate | null;
  }[];
  readonly totals: ProposalTotals;
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

  addLine(l: NewProposalLine): Promise<ProposalLine>;
  /** Soft: sets removed_at. Nothing deletes a line — what the firm considered
   *  offering and pulled is part of the record. */
  removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void>;
  /** The live lines, in document order. */
  listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]>;

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
  findShared(tenantId: string, digest: string): Promise<SharedProposal | null>;

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
