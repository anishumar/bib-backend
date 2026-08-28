// The proposal use case — quoting rules against ports. No I/O, no SQL, no HTTP.
//
// The shape of it, and why each part is where it is:
//
//   A LINE IS QUOTED FROM A PIN. `addLine` resolves the catalogue version id
//   before writing anything, and refuses a draft version — a price the firm
//   never put in force must not reach a client's document. An ARCHIVED version
//   is accepted, deliberately: that is precisely what a pin is supposed to
//   resolve to once the catalogue moves on.
//
//   THE DISCOUNT LIMIT IS THE FIRM'S, READ LIVE. `send` asks the policy
//   directory what the limit is now, compares it to the largest discount on any
//   line, and refuses to send until somebody holding `proposal:approve` has
//   signed it off. The permission itself is checked by the route guard, not
//   here — gate 3 is middleware in this codebase and a rule a handler remembers
//   to apply is one a new handler forgets.
//
//   EXPIRY IS LAZY. Nothing in this system runs on a timer, so a proposal past
//   its date becomes `expired` the first time somebody tries to act on it,
//   rather than sitting in `sent` forever or being pretended-expired by a read
//   that leaves the row saying otherwise.
//
// There is no timeline table. The timeline IS the ledger: drafting, approving,
// sending and the decision all write events against the proposal's id.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  Proposal,
  ProposalDecision,
  ProposalLine,
  ProposalStatus,
} from "../../domain/proposal/model";
import {
  canTransition,
  composeShareToken,
  isPastValidity,
  isProposalDecision,
  largestDiscount,
  needsDiscountApproval,
  parseShareToken,
} from "../../domain/proposal/model";
import { isAmount, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import {
  AlreadyApproved,
  ApprovalNotNeeded,
  DiscountNeedsApproval,
  EmptyProposal,
  InvalidDecision,
  InvalidDiscount,
  InvalidFxRate,
  InvalidQuantity,
  InvalidQuoteCurrency,
  InvalidTransition,
  InvalidUnitAmount,
  LineNotFound,
  NotADraft,
  NotAService,
  ProposalExpired,
  ProposalNotFound,
  ServiceNotFound,
  ShareLinkUnknown,
  ServiceNotPublished,
} from "../../domain/proposal/errors";
import type {
  PolicyDirectory,
  ProposalFilters,
  ProposalRecord,
  ProposalRepository,
  ProposalSummary,
  ServiceCatalogue,
  ShareLinkTokens,
  SharedProposal,
} from "./ports";

export interface Deps {
  readonly proposals: ProposalRepository;
  /** The configuration registry, behind this use case's own narrow interface. */
  readonly catalogue: ServiceCatalogue;
  readonly policies: PolicyDirectory;
  /** Mints the share link and hashes it. Only the digest is ever stored. */
  readonly shareTokens: ShareLinkTokens;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface DraftProposalInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly leadId?: string | undefined;
  readonly title: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly validUntil?: string | undefined;
}

/**
 * What sending returns: the proposal, and the link — ONCE.
 *
 * The token is not readable again, because only its digest is stored. A firm
 * that loses it re-sends, which issues a new one; that is the same trade
 * sessions and magic links make, and it is the reason a leaked backup contains
 * no link anyone can open.
 */
export interface SendResult {
  readonly proposal: Proposal;
  readonly shareToken: string;
}

export interface AddLineInput {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly discountPercent: string;
}

export class ProposalService {
  constructor(private readonly deps: Deps) {}

  /**
   * Start a quote.
   *
   * The currency and the FX rate are fixed HERE, at the top of the document,
   * and every line inherits the currency through a composite foreign key. A
   * proposal whose lines each converted at their own rate would have a total
   * that depends on the order somebody added them.
   */
  async draft(input: DraftProposalInput, actor: Actor): Promise<Proposal> {
    const currency = normalizeCurrency(input.currency);
    if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(input.currency);
    // Positive, not merely non-negative: a rate of zero would make every
    // converted total zero and nothing would look wrong until a report did.
    if (!isAmount(input.fxRate) || Number(input.fxRate) <= 0) {
      throw new InvalidFxRate(input.fxRate);
    }

    const proposal = await this.deps.proposals.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId: input.partyId,
      leadId: input.leadId ?? null,
      title: input.title,
      currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      validUntil: input.validUntil ?? null,
    });

    await this.deps.events.recordEvent({
      tenantId: proposal.tenantId,
      verb: "proposal.drafted",
      objectId: proposal.id,
      actor,
      // Ids and machine facts. The TITLE is deliberately absent: a proposal is
      // routinely titled "Acme Ltd — FY26 audit", and the ledger cannot be
      // erased. The party is here by id, which is erasable where this is not.
      payload: {
        partyId: proposal.partyId,
        leadId: proposal.leadId,
        currency: proposal.currency,
        fxRate: proposal.fxRate,
        fxRateDate: proposal.fxRateDate,
      },
    });
    return proposal;
  }

  /** Quote one thing, from one frozen catalogue version. */
  async addLine(input: AddLineInput): Promise<ProposalLine> {
    const proposal = await this.draftOrThrow(input.tenantId, input.proposalId);

    if (!isAmount(input.quantity) || Number(input.quantity) <= 0) {
      throw new InvalidQuantity(input.quantity);
    }
    if (!isAmount(input.unitAmount)) throw new InvalidUnitAmount(input.unitAmount);
    if (!isAmount(input.discountPercent) || Number(input.discountPercent) > 100) {
      throw new InvalidDiscount(input.discountPercent);
    }

    // Resolve the pin BEFORE writing, so a bad version id is a 400 naming the
    // id rather than a foreign-key violation surfacing as a 500.
    const pinned = await this.deps.catalogue.readPinnedService(
      input.tenantId,
      input.serviceVersionId,
    );
    if (pinned === null) throw new ServiceNotFound(input.serviceVersionId);
    if (pinned.kind !== "service") throw new NotAService(input.serviceVersionId, pinned.kind);
    if (pinned.status === "draft") throw new ServiceNotPublished(input.serviceVersionId);

    return this.deps.proposals.addLine({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      proposalId: proposal.id,
      serviceVersionId: input.serviceVersionId,
      description: input.description,
      quantity: input.quantity,
      unitAmount: input.unitAmount,
      // The proposal's, never the caller's: the composite key would refuse a
      // different one anyway, and a 400 explaining the rule beats a 500.
      currency: proposal.currency,
      discountPercent: input.discountPercent,
    });
  }

  /** Pull a line from a draft. Soft — the row stays, `removed_at` is set. */
  async removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void> {
    await this.draftOrThrow(tenantId, proposalId);
    const lines = await this.deps.proposals.listLines(tenantId, proposalId);
    if (!lines.some((l) => l.id === lineId)) throw new LineNotFound(lineId);
    await this.deps.proposals.removeLine(tenantId, proposalId, lineId);
  }

  async describe(tenantId: string, proposalId: string): Promise<ProposalRecord> {
    const record = await this.deps.proposals.describe(tenantId, proposalId);
    if (record === null) throw new ProposalNotFound(proposalId);
    return record;
  }

  async list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]> {
    return this.deps.proposals.list(tenantId, filters);
  }

  /**
   * Sign off a discount past the firm's limit.
   *
   * The PERMISSION is checked by the route guard; what this method owns is
   * whether there is anything to approve. Recording an approval on a proposal
   * that never needed one is refused rather than accepted as a harmless no-op:
   * it would put a signature in an append-only log for a decision nobody was
   * asked to make, and that log cannot be corrected afterwards.
   */
  async approveDiscount(
    tenantId: string,
    proposalId: string,
    approverUserId: string,
    actor: Actor,
  ): Promise<Proposal> {
    const proposal = await this.draftOrThrow(tenantId, proposalId);
    if (proposal.discountApprovedAt !== null) {
      throw new AlreadyApproved(proposal.discountApprovedAt);
    }
    const lines = await this.deps.proposals.listLines(tenantId, proposalId);
    if (lines.length === 0) throw new EmptyProposal();

    const limit = await this.deps.policies.maxDiscountPercent(tenantId);
    const largest = largestDiscount(lines);
    if (!needsDiscountApproval(lines, limit)) {
      throw new ApprovalNotNeeded(largest, limit ?? "0");
    }

    const at = this.deps.clock.now().toISOString();
    const approved = await this.deps.proposals.recordDiscountApproval(
      tenantId,
      proposalId,
      approverUserId,
      at,
    );
    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.discount_approved",
      objectId: proposal.id,
      actor,
      // The approver by id, and the two numbers that made it necessary. This is
      // the record somebody goes looking for when a margin is queried a year
      // later, so the limit AS IT WAS is recorded rather than re-derived from a
      // policy that may since have changed.
      payload: {
        approvedByUserId: approverUserId,
        largestDiscountPercent: largest,
        limitPercent: limit,
      },
    });
    return approved;
  }

  /**
   * Send it. The gate the acceptance criteria names: an over-limit discount
   * blocks here until it has been approved.
   */
  async send(tenantId: string, proposalId: string, actor: Actor): Promise<SendResult> {
    const proposal = await this.draftOrThrow(tenantId, proposalId);
    const lines = await this.deps.proposals.listLines(tenantId, proposalId);
    if (lines.length === 0) throw new EmptyProposal();

    if (proposal.discountApprovedAt === null) {
      const limit = await this.deps.policies.maxDiscountPercent(tenantId);
      if (needsDiscountApproval(lines, limit)) {
        throw new DiscountNeedsApproval(largestDiscount(lines), limit);
      }
    }

    const sent = await this.moveTo(proposal, "sent");

    // The link is minted HERE, at the moment of sending, and returned exactly
    // once. Only its digest is stored, so this is the only time anybody can
    // read it — the same contract as a magic link, for the same reason: a
    // leaked backup then contains nothing anyone can open.
    //
    // The tenant travels inside the token so that opening it is still a
    // tenant-scoped read. See composeShareToken.
    const shareToken = composeShareToken(tenantId, this.deps.shareTokens.newToken());
    await this.deps.proposals.attachShareToken(
      tenantId,
      proposalId,
      this.deps.shareTokens.hash(shareToken),
    );
    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.sent",
      objectId: proposal.id,
      actor,
      payload: {
        partyId: proposal.partyId,
        lineCount: lines.length,
        largestDiscountPercent: largestDiscount(lines),
        discountApproved: proposal.discountApprovedAt !== null,
        validUntil: proposal.validUntil,
      },
    });
    return { proposal: sent, shareToken };
  }

  /**
   * Open a share link. The one path in this product with no session behind it.
   *
   * Three things it deliberately does NOT do:
   *
   *   It does not distinguish a malformed token, an unknown one, and a
   *   proposal that has gone. One answer for all three, because telling them
   *   apart lets somebody probing learn which firms exist and which links used
   *   to — and a real recipient cannot act on the difference anyway.
   *
   *   It does not let the recipient ACCEPT. Binding a firm to a client's click
   *   on an unauthenticated link is a bigger decision than this task; staff
   *   record the decision, and the board says so rather than this quietly
   *   deciding it.
   *
   *   It does not return the staff read model with fields nulled. `SharedProposal`
   *   is its own shape, so a field added for colleagues cannot reach a client's
   *   screen by default.
   */
  async viewShared(token: string, actor: Actor): Promise<SharedProposal> {
    const parsed = parseShareToken(token);
    if (parsed === null) throw new ShareLinkUnknown();

    const digest = this.deps.shareTokens.hash(token);
    const shared = await this.deps.proposals.findShared(parsed.tenantId, digest);
    if (shared === null) throw new ShareLinkUnknown();

    const now = this.deps.clock.now().toISOString();
    if (shared.status === "sent" && isPastValidity(shared.validUntil, now)) {
      // Lazy expiry, the same rule the staff path uses — the link is simply the
      // other place somebody first touches a lapsed proposal.
      const proposal = await this.deps.proposals.findById(parsed.tenantId, shared.id);
      if (proposal !== null) await this.expire(proposal, actor);
      throw new ProposalExpired(shared.validUntil ?? now.slice(0, 10));
    }

    // Counted every time; recorded once. See the note on Proposal.viewCount.
    const wasFirst = await this.deps.proposals.recordView(parsed.tenantId, shared.id, now);
    if (wasFirst) {
      await this.deps.events.recordEvent({
        tenantId: parsed.tenantId,
        verb: "proposal.viewed",
        objectId: shared.id,
        // The recipient has no account, so there is no human to name. `system`
        // with the route in the payload is the honest answer; inventing a user
        // id for somebody who has never logged in would be worse.
        actor,
        payload: { via: "share_link" },
      });
    }
    return { ...shared, status: shared.status };
  }

  /**
   * Record what the client said.
   *
   * A proposal past its validity date is expired here rather than accepted
   * late: honouring a lapsed quote is a commercial decision, and making it
   * silently on the client's behalf is the wrong default for the side that
   * wrote the date.
   */
  async decide(
    tenantId: string,
    proposalId: string,
    decision: string,
    actor: Actor,
  ): Promise<Proposal> {
    if (!isProposalDecision(decision)) throw new InvalidDecision(decision);
    const proposal = await this.findOrThrow(tenantId, proposalId);

    const today = this.deps.clock.now().toISOString();
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, today)) {
      await this.expire(proposal, actor);
      // validUntil is non-null whenever isPastValidity is true.
      throw new ProposalExpired(proposal.validUntil ?? today.slice(0, 10));
    }

    if (!canTransition(proposal.status, decision)) {
      throw new InvalidTransition(proposal.status, decision);
    }

    const decided = await this.moveTo(proposal, decision);
    await this.deps.events.recordEvent({
      tenantId,
      verb: decision === "accepted" ? "proposal.accepted" : "proposal.rejected",
      objectId: proposal.id,
      actor,
      payload: { partyId: proposal.partyId, decision: decision satisfies ProposalDecision },
    });
    return decided;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async findOrThrow(tenantId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.deps.proposals.findById(tenantId, proposalId);
    if (proposal === null) throw new ProposalNotFound(proposalId);
    return proposal;
  }

  /** Everything that CHANGES a proposal's content requires it to still be a
   *  draft. One place, so a method added later cannot forget it. */
  private async draftOrThrow(tenantId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.findOrThrow(tenantId, proposalId);
    if (proposal.status !== "draft") throw new NotADraft(proposal.status);
    return proposal;
  }

  private async moveTo(proposal: Proposal, to: ProposalStatus): Promise<Proposal> {
    if (!canTransition(proposal.status, to)) {
      throw new InvalidTransition(proposal.status, to);
    }
    return this.deps.proposals.setStatus(
      proposal.tenantId,
      proposal.id,
      to,
      this.deps.clock.now().toISOString(),
    );
  }

  private async expire(proposal: Proposal, actor: Actor): Promise<void> {
    await this.moveTo(proposal, "expired");
    await this.deps.events.recordEvent({
      tenantId: proposal.tenantId,
      verb: "proposal.expired",
      objectId: proposal.id,
      actor,
      payload: { partyId: proposal.partyId, validUntil: proposal.validUntil },
    });
  }
}
