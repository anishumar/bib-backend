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
import { isAmount, isExchangeRate, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import { readServiceBody } from "../../domain/config/model";
import {
  isBillingFrequency,
  isJurisdiction,
  ANY_JURISDICTION,
  normalizeJurisdiction,
  outOfPocketProblem,
  BILLING_FREQUENCIES,
} from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
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
  InvalidLineBillingFrequency,
  InvalidLineJurisdiction,
  InvalidOutOfPocketEstimate,
  InvalidTransition,
  InvalidUnitAmount,
  LineNotFound,
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
  NotADraft,
  NotAService,
  ProposalExpired,
  ProposalNotFound,
  ServiceNotFound,
  ShareLinkUnknown,
  ServiceNotPublished,
} from "../../domain/proposal/errors";
import type {
  DocumentIdentity,
  PolicyDirectory,
  ProposalFilters,
  ProposalRepository,
  ProposalView,
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
  /** The firm's document reference series, and its rule for which of its own
   *  entities is offering. Both are shared with engagement letters, so both
   *  live behind one seam rather than being answered twice. */
  readonly documents: DocumentIdentity;
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
  /**
   * Which of the firm's own entities is offering this — the "flexibility to
   * choose" half of the firm's rule.
   *
   * OPTIONAL, and absent is the ordinary case: the firm's preference rows
   * answer it, keyed on where the client is. Naming one here overrides that for
   * this document only, which is what a partner does when a group wants to
   * contract with a particular company of ours.
   */
  readonly issuingEntityPartyId?: string | undefined;
  /**
   * Where the CLIENT is, when it is known — the key the firm's rule is looked
   * up on ("jahan ka client hota hai, wahan ki entity").
   *
   * Not stored: what gets stored is the DECISION it produced. A prospect's
   * country is often unknown when a quote is drafted, and absent resolves
   * through the same fallback as a country the firm has no entity in, because
   * from the firm's side those are the same answer.
   */
  readonly clientJurisdiction?: string | undefined;
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
  /** Which of the client's entities this line is for. OPTIONAL, unlike the
   *  engagement letter's: a prospect may hold none yet, and Incorporation is a
   *  line whose entity is its own output. */
  readonly entityPartyId?: string | undefined;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: string;
  /**
   * OPTIONAL since G1.6. Absent means "as mutually agreed", and then
   * `pricingNote` is required — a blank price with no reason is
   * indistinguishable from a figure somebody forgot to type.
   *
   * Absent is NOT "0". Zero is a price the firm committed to, and quoting an
   * unpriced line as zero was the only thing the old schema allowed.
   */
  readonly unitAmount?: string | undefined;
  readonly discountPercent: string;
  /** Where the WORK is. Stated, never derived — see `ProposalLine`. */
  readonly jurisdiction?: string | undefined;
  /** How often this DEAL is billed. Absent falls back to the PINNED service's
   *  `recurrence`, resolved here, once, and stored. */
  readonly billingFrequency?: string | undefined;
  /** This document's own wording for any of the four scope blocks. Absent
   *  prints the pinned catalogue version's words. */
  readonly scopeOverride?: string | undefined;
  readonly clientObligationsOverride?: string | undefined;
  readonly volumeLimitsOverride?: string | undefined;
  readonly exclusionsOverride?: string | undefined;
  /** Out-of-pocket expenses: a range, in its own currency, separate from the
   *  fee and never summed into a total. */
  readonly oopEstimate?:
    | { readonly min: string; readonly max: string; readonly currency: string }
    | undefined;
  /** WHY there is no amount, and REQUIRED when there is none. */
  readonly pricingNote?: string | undefined;
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
    // A RATE, not a price: `numeric(20,10)` on this column, so a stored
    // rate read back at full scale ("1.0000000000") has to be acceptable
    // input. `isAmount` allows four places and refused it — see
    // `isExchangeRate`.
    if (!isExchangeRate(input.fxRate) || Number(input.fxRate) <= 0) {
      throw new InvalidFxRate(input.fxRate);
    }

    // WHO is offering, before anything is written. Named by the caller, or
    // resolved from the firm's own rule — never guessed here, and never left
    // out: a document that cannot say who is contracting is not a document.
    const issuingEntityPartyId =
      input.issuingEntityPartyId ??
      (await this.deps.documents.issuerFor(input.tenantId, input.clientJurisdiction ?? null));

    // The reference is drawn BEFORE the row is written, and its counter commits
    // on its own — so a draft that fails after this line burns its number. That
    // is what a document reference wants (a gap is honest) and the opposite of
    // what an invoice number will need. See migration 0020.
    const ref = await this.deps.documents.nextRef(
      input.tenantId,
      "proposal",
      this.deps.clock.now(),
    );

    const proposal = await this.deps.proposals.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      ref,
      partyId: input.partyId,
      issuingEntityPartyId,
      leadId: input.leadId ?? null,
      title: input.title,
      currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      validUntil: input.validUntil ?? null,
    });

    // The firm's standard prose, COPIED onto this document (G1.7). After the
    // row exists, because the blocks hang off it; before the event, because a
    // drafted proposal is one that already says what the firm always says.
    //
    // The jurisdiction is the CLIENT's when it is known, and `*` when it is
    // not. That is not a shrug: `blocksFor` copies an unscoped line always and
    // a scoped line only for its own country, so an unknown country takes the
    // lines that are true everywhere and leaves out the ones that might not be.
    // The alternative — copying everything — is how "exclusive of GST" reaches
    // a UAE proposal.
    await this.deps.documents.seedBlocks(
      proposal.tenantId,
      { kind: "proposal", id: proposal.id },
      input.clientJurisdiction ?? ANY_JURISDICTION,
    );

    await this.deps.events.recordEvent({
      tenantId: proposal.tenantId,
      verb: "proposal.drafted",
      objectId: proposal.id,
      actor,
      // Ids and machine facts. The TITLE is deliberately absent: a proposal is
      // routinely titled "Acme Ltd — FY26 audit", and the ledger cannot be
      // erased. The party is here by id, which is erasable where this is not.
      payload: {
        ref: proposal.ref,
        partyId: proposal.partyId,
        issuingEntityPartyId: proposal.issuingEntityPartyId,
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
    // THE UNPRICED LINE. Absent is a real answer — "as mutually agreed" — and
    // the two rules that go with it are here rather than only in the CHECKs
    // (0023) so a caller is told what to send instead of reading a constraint
    // name out of a 500.
    const unitAmount = input.unitAmount ?? null;
    if (unitAmount !== null && !isAmount(unitAmount)) throw new InvalidUnitAmount(unitAmount);
    const pricingNote = blankToNull(input.pricingNote);
    if (unitAmount === null && pricingNote === null) throw new UnpricedLineNeedsReason();
    if (!isAmount(input.discountPercent) || Number(input.discountPercent) > 100) {
      throw new InvalidDiscount(input.discountPercent);
    }
    // A percentage off "as mutually agreed" is not a number — and it would
    // reach `largestDiscount` and hold the whole proposal at the approval gate.
    if (unitAmount === null && Number(input.discountPercent) !== 0) {
      throw new UnpricedLineHasDiscount(input.discountPercent);
    }

    const jurisdiction = this.lineJurisdiction(input.jurisdiction);
    const billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    const oopEstimate = this.outOfPocket(input.oopEstimate);

    // Resolve the pin BEFORE writing, so a bad version id is a 400 naming the
    // id rather than a foreign-key violation surfacing as a 500.
    const pinned = await this.deps.catalogue.readPinnedVersion(
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
      entityPartyId: input.entityPartyId ?? null,
      serviceVersionId: input.serviceVersionId,
      description: input.description,
      quantity: input.quantity,
      unitAmount,
      // The proposal's, never the caller's: the composite key would refuse a
      // different one anyway, and a 400 explaining the rule beats a 500.
      currency: proposal.currency,
      discountPercent: input.discountPercent,
      jurisdiction,
      // DEFAULTED FROM THE PIN, ONCE, AND STORED. The catalogue says how often
      // the WORK comes round; this says how often the client is INVOICED, and
      // they are free to differ — a monthly service billed quarterly is an
      // arrangement the firm has today. Resolving it here rather than at read
      // time is what makes the stored value a fact about the deal as it was
      // struck; deriving it later would let a catalogue revision restate how a
      // client is billed. Null stays null: a version that states no recurrence
      // has not decided this, and inventing `one_time` would put a billing
      // frequency on the document that nobody chose.
      billingFrequency: billingFrequency ?? readServiceBody(pinned.body).recurrence,
      scopeOverride: blankToNull(input.scopeOverride),
      clientObligationsOverride: blankToNull(input.clientObligationsOverride),
      volumeLimitsOverride: blankToNull(input.volumeLimitsOverride),
      exclusionsOverride: blankToNull(input.exclusionsOverride),
      oopEstimate,
      pricingNote,
    });
  }

  /** The line's jurisdiction, normalised. Refused rather than silently dropped:
   *  "in" and "IN" are the same country and "INR" is not one. */
  private lineJurisdiction(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === "") return null;
    const normalised = normalizeJurisdiction(raw);
    if (!isJurisdiction(normalised)) throw new InvalidLineJurisdiction(raw);
    return normalised;
  }

  private statedBillingFrequency(raw: string | undefined): BillingFrequency | null {
    if (raw === undefined || raw.trim() === "") return null;
    if (!isBillingFrequency(raw)) throw new InvalidLineBillingFrequency(raw, BILLING_FREQUENCIES);
    return raw;
  }

  /** The out-of-pocket range, whole or absent. Its currency is normalised but
   *  NOT compared to the document's — see `OutOfPocketEstimate`. */
  private outOfPocket(
    raw: { readonly min: string; readonly max: string; readonly currency: string } | undefined,
  ): OutOfPocketEstimate | null {
    if (raw === undefined) return null;
    const estimate = { min: raw.min, max: raw.max, currency: normalizeCurrency(raw.currency) };
    const problem = outOfPocketProblem(estimate, isAmount, isCurrencyCode);
    if (problem !== null) throw new InvalidOutOfPocketEstimate(problem);
    return estimate;
  }

  /** Pull a line from a draft. Soft — the row stays, `removed_at` is set. */
  async removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void> {
    await this.draftOrThrow(tenantId, proposalId);
    const lines = await this.deps.proposals.listLines(tenantId, proposalId);
    if (!lines.some((l) => l.id === lineId)) throw new LineNotFound(lineId);
    await this.deps.proposals.removeLine(tenantId, proposalId, lineId);
  }

  async describe(tenantId: string, proposalId: string): Promise<ProposalView> {
    const record = await this.deps.proposals.describe(tenantId, proposalId);
    if (record === null) throw new ProposalNotFound(proposalId);
    // The one thing the proposal repository does not own: the document's own
    // prose lives in the document module's table, reached through the same seam
    // this use case already asks for references and issuing entities.
    const blocks = await this.deps.documents.listBlocks(tenantId, {
      kind: "proposal",
      id: proposalId,
    });
    return { ...record, blocks };
  }

  async list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]> {
    return this.deps.proposals.list(tenantId, filters);
  }

  /**
   * The quote, flat, for whoever is writing it up as a contract (T3.5b).
   *
   * NULL rather than a throw, unlike `describe`: the caller is
   * `EngagementService.draftFromQuote`, and it has its own sentence to say
   * about a proposal that is not there — one that talks about drafting a
   * letter rather than about reading a proposal.
   *
   * The LINES, unwrapped, and no totals. A total is a number the database
   * computed for a document that is about to be replaced by a different one;
   * what carries across is what was agreed, line by line, and the letter
   * computes its own. Every field a letter line needs is already on
   * `ProposalLine` under the same name, which is why this returns the rows
   * rather than a mapped shape — a mapping here would be a second place for
   * the two documents to drift apart.
   */
  async findQuote(
    tenantId: string,
    proposalId: string,
  ): Promise<{ readonly proposal: Proposal; readonly lines: readonly ProposalLine[] } | null> {
    const record = await this.deps.proposals.describe(tenantId, proposalId);
    if (record === null) return null;
    return { proposal: record.proposal, lines: record.lines.map((l) => l.line) };
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
    // The document's own prose, from the module that owns it — the same seam
    // `describe` uses. Only the words travel: a recipient is not told which
    // lines are house wording and which were written for them.
    const blocks = await this.deps.documents.listBlocks(parsed.tenantId, {
      kind: "proposal",
      id: shared.id,
    });
    return {
      ...shared,
      status: shared.status,
      blocks: blocks.map((b) => ({
        kind: b.kind,
        body: b.body,
        isHeading: b.isHeading,
        sortOrder: b.sortOrder,
      })),
    };
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
    // WHY, when the answer is no. Last and optional rather than beside
    // `decision`, so the four existing call sites read unchanged — and it is
    // meaningless on an acceptance, which is what the schema says too.
    declinedReason?: string,
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

    // A reason is recorded only on a rejection. Attaching one to an acceptance
    // would put a sentence about why the client declined onto a proposal they
    // signed, and the CHECK in 0022 refuses it anyway.
    const reason = decision === "rejected" ? blankToNull(declinedReason) : null;
    const decided = await this.moveTo(proposal, decision, reason);
    await this.deps.events.recordEvent({
      tenantId,
      verb: decision === "accepted" ? "proposal.accepted" : "proposal.rejected",
      objectId: proposal.id,
      actor,
      // WHETHER a reason was given, never the reason itself. It is free text a
      // person wrote about a client relationship, this log cannot be erased,
      // and the row keeps it somewhere it can be — the same call the
      // firm-entity preference's `note` gets. The boolean is still worth
      // recording: "we stopped writing down why we lose" is a real finding.
      payload: {
        partyId: proposal.partyId,
        decision: decision satisfies ProposalDecision,
        declinedReasonRecorded: reason !== null,
      },
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

  private async moveTo(
    proposal: Proposal,
    to: ProposalStatus,
    declinedReason: string | null = null,
  ): Promise<Proposal> {
    if (!canTransition(proposal.status, to)) {
      throw new InvalidTransition(proposal.status, to);
    }
    return this.deps.proposals.setStatus(
      proposal.tenantId,
      proposal.id,
      to,
      this.deps.clock.now().toISOString(),
      declinedReason,
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

/**
 * Optional prose, as a nullable column wants it.
 *
 * "" and "   " are somebody clearing a field, not a reason — and the database
 * refuses blank prose outright (`proposal_declined_reason_not_blank_chk`, and
 * since G1.6 the line's override and pricing-note CHECKs too). For an OVERRIDE
 * the distinction is load-bearing: null means "we did not tailor this, print
 * the catalogue's words", so a caller clearing the box gets the catalogue back
 * rather than a document with an empty heading on it.
 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
