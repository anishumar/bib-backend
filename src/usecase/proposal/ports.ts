// The ports the proposal use case needs from the world — the seams. Interfaces
// are owned by the use case that needs them, stated in our vocabulary; adapters
// in infrastructure/ implement them, and two of them are satisfied by other use
// cases at the composition root.
import type { Amount, CurrencyCode } from "../../domain/money/model";
import type {
  Proposal,
  ProposalLine,
  ProposalStatus,
  ProposalTotals,
} from "../../domain/proposal/model";

export interface NewProposal {
  readonly id: string;
  readonly tenantId: string;
  readonly partyId: string;
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
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: Amount;
  readonly unitAmount: Amount;
  readonly currency: CurrencyCode;
  readonly discountPercent: Amount;
}

/**
 * A proposal with everything a screen renders it from.
 *
 * The joined read model this codebase learnt to build the first time (see
 * CLAUDE.md): a bare `Proposal` carries `partyId` and each line carries a
 * `serviceVersionId`, which is right for the aggregate and renders as a column
 * of uuids. `listPrice` comes from the pinned catalogue version, so a screen can
 * show "list 25,000 — quoted 22,500" without resolving pins itself, which is the
 * commercial question the pin exists to answer.
 *
 * Totals are computed in Postgres `numeric` by the query that reads the lines —
 * never summed in TypeScript.
 */
export interface ProposalRecord {
  readonly proposal: Proposal;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly lines: readonly ProposalLineRecord[];
  readonly totals: ProposalTotals;
  /** Who signed off an over-limit discount, for a screen that has to show it.
   *  Null when nobody has. */
  readonly approvedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
}

export interface ProposalLineRecord {
  readonly line: ProposalLine;
  /** The service as it was PINNED — its name then, and its list price then.
   *  Null only if the pinned version has somehow gone, which the composite
   *  foreign key makes impossible; the type is honest about the join anyway. */
  readonly service: {
    readonly key: string;
    readonly version: number;
    readonly name: string;
    readonly listPrice: { readonly amount: Amount; readonly currency: CurrencyCode } | null;
  } | null;
  /** gross − discount for this line, in the proposal's currency. From the
   *  database, like every other sum here. */
  readonly net: Amount;
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
  /** Who sent it. A document with no sender is not a document. */
  readonly firmName: string;
  readonly addressedTo: string;
  readonly title: string;
  readonly status: ProposalStatus;
  readonly currency: CurrencyCode;
  readonly validUntil: string | null;
  readonly sentAt: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: Amount;
    readonly unitAmount: Amount;
    readonly discountPercent: Amount;
    readonly net: Amount;
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

  /** Move the status and stamp whichever date goes with it, in one statement,
   *  so a row can never claim to be sent with no sent_at. */
  setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
  ): Promise<Proposal>;

  /** Attach the share link's digest as part of sending. Never at draft: a quote
   *  that never went out should never have had a reachable link. */
  attachShareToken(tenantId: string, proposalId: string, digest: string): Promise<void>;

  /** Resolve a share link, inside the tenant the token named. Returns the
   *  recipient's view, not the staff one. */
  findShared(tenantId: string, digest: string): Promise<SharedProposal | null>;

  /**
   * Count an open. Returns true when it was the FIRST — the caller records
   * `proposal.viewed` only then, because the ledger holds state transitions and
   * a client refreshing a page is not fifty facts about the business.
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
