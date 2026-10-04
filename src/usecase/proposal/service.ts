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
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  Proposal,
  ProposalDecision,
  ProposalLine,
  ProposalStatus,
} from "../../domain/proposal/model";
import {
  acceptanceStatement,
  canTransition,
  composeShareToken,
  discountApprovalLapses,
  isCopyable,
  isEmailAddress,
  isPastValidity,
  isProposalDecision,
  largestDiscount,
  needsDiscountApproval,
  parseShareToken,
  proposalDeletionBlock,
} from "../../domain/proposal/model";
import { isAmount, isExchangeRate, isCurrencyCode, normalizeCurrency, rateFor } from "../../domain/money/model";
import type { CurrencyRate } from "../../domain/money/model";
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
  NothingToChangeOnLine,
  InvalidLineDescription,
  CurrencyLockedByLines,
  CurrencyNeedsARate,
  RateInUse,
  RateIsMainCurrency,
  InvalidCurrencyChange,
  ProseEdited,
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
  ServiceHasNoListPrice,
  NotADraft,
  NotAService,
  ProposalExpired,
  ProposalNotCallersToday,
  ProposalNotFound,
  ProposalPartyArchived,
  ProposalClientIsOwnCompany,
  ServiceNotFound,
  ShareLinkUnknown,
  ServiceNotPublished,
  ProposalIssuerNotAFirmEntity,
  ProposalAddresseeNotAPerson,
  ProposalAddresseeNotLinked,
  PreparerNotStaff,
  NothingToRevise,
  AcceptanceNotConfirmed,
  AlreadyAnswered,
  EmailUnavailable,
  InvalidRecipient,
  NotOutForAnswer,
  SignerNameRequired,
  ProposalDeleted,
  ProposalError,
  ProposalNotCopyable,
  ProposalLeadDeleted,
  proposalDeletionRefusal,
} from "../../domain/proposal/errors";
import { zoneOfCompany } from "../../domain/calendar/model";
import { dayInZone, isCallersToday } from "../../domain/scheduler/zone";
import { checkAcceptance } from "../../domain/acceptance/model";
import type { AcceptanceStatement } from "../../domain/acceptance/model";
import { planProposal } from "../../domain/proposal/document";
import type { ProposalPlan } from "../../domain/proposal/document";
import type {
  ClientStructureDirectory,
  DocumentIdentity,
  FiledPdf,
  FirmTimeZone,
  LeadStanding,
  PartyStanding,
  PolicyDirectory,
  ProposalFilters,
  ProposalLinks,
  ProposalMailer,
  ProposalSenders,
  ProposalPdfs,
  ProposalRecord,
  ProposalRepository,
  ProposalRevision,
  ProposalView,
  ProposalSummary,
  ProseLine,
  ServiceCatalogue,
  ShareLinkTokens,
  SharedProposal,
  SharedProposalRecord,
  StaffDirectory,
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
  /** Whether a client or an entity has been archived (0305). */
  readonly parties: PartyStanding;
  /** Whether the lead a proposal is drafted from was deleted (0086). */
  readonly leads: LeadStanding;
  /** Mints the share link and hashes it. Only the digest is ever stored. */
  readonly shareTokens: ShareLinkTokens;
  /** The client's structure — whom "Prepared for" may name (F-10-1, 0084). */
  readonly structure: ClientStructureDirectory;
  /** The firm's zone, for the day that structure is read on. */
  readonly timeZones: FirmTimeZone;
  /** Whether "Prepared by" names a colleague (0084). */
  readonly staff: StaffDirectory;
  /**
   * The two letters of 0085 — the proposal to the client, and the notice to
   * the colleague who prepared it when the client answers.
   *
   * NULLABLE, and null in exactly one place: the worker, which composes this
   * service so the letter use case can read a quote and never sends one. It
   * holds no SMTP password (infra/terraform/run_worker.tf), so it is given no
   * mailer, and an email asked of it is refused by name before anything moves
   * rather than logged as sent.
   */
  readonly mailer: ProposalMailer | null;
  /** Who a proposal email is from (Q059). Absent: from the firm, as before. */
  readonly senders?: ProposalSenders;
  /** The proposal as a PDF, rendered and filed through the document store. */
  readonly pdfs: ProposalPdfs;
  /** Where a letter's links point. */
  readonly links: ProposalLinks;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/**
 * An email a colleague asked Send to write (0085): where to, and their own
 * words above the standard letter.
 */
export interface EmailRequest {
  readonly to: string;
  readonly note?: string | undefined;
}

/**
 * What happened to that email.
 *
 * `failed` is an ordinary answer, not an exception, because by the time a
 * letter is written the proposal HAS been sent and its link DOES work — both
 * facts the person who pressed Send needs, together with the one that went
 * wrong. Throwing would lose the link, which is readable exactly once.
 */
export type EmailOutcome =
  | {
      readonly status: "sent";
      readonly to: string;
      readonly emailId: string;
      readonly sentAt: string;
    }
  | { readonly status: "failed"; readonly to: string; readonly reason: string };

/**
 * The client's answer, as their page sends it (0085).
 *
 * `confirmed` is the tick against `acceptanceStatement`; an acceptance without
 * it is refused, which is what makes the answer a statement rather than a
 * click. The address and browser are as the API derived them — evidence, never
 * checked against anything.
 */
export interface SharedAnswerInput {
  readonly token: string;
  readonly decision: string;
  readonly signerName: string;
  readonly confirmed: boolean;
  readonly declinedReason?: string | undefined;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
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
  /** The Background paragraph — what the firm says about the client's
   *  business. Blank is "none". */
  readonly background?: string | undefined;
  /** The PERSON at the client it is prepared for: a person recorded in the
   *  client's structure (F-10-1), the letter's addressee rule. */
  readonly addressedToPartyId?: string | undefined;
  /**
   * The colleague the cover names under "Prepared by". ABSENT means whoever is
   * drafting — which is what "prepared by" means — and a system actor drafts
   * with nobody named.
   */
  readonly preparedByUserId?: string | undefined;
}

/**
 * A change to a draft's head (0084). Absent leaves a field as it is; `null`
 * clears it. The title cannot be cleared — a proposal always has one.
 */
export interface ReviseProposalInput {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly title?: string | undefined;
  readonly validUntil?: string | null | undefined;
  readonly background?: string | null | undefined;
  readonly addressedToPartyId?: string | null | undefined;
  readonly preparedByUserId?: string | null | undefined;
  /**
   * T6.18: another of the FIRM's companies to issue this draft. Its prose is
   * replaced with that company's standard set (D9) — refused with
   * `PROSE_EDITED` while any line was edited for this client, unless
   * `replaceEditedProse` says to go ahead.
   */
  readonly issuingEntityPartyId?: string | undefined;
  readonly replaceEditedProse?: boolean | undefined;
  /** Where the client is, for which country's standard lines the new prose
   *  takes — as on drafting. Absent: where the new issuer is registered. */
  readonly clientJurisdiction?: string | undefined;
  /** T6.18: the money, all three together. The currency changes only while the
   *  draft quotes nothing; the rate and its day may be corrected any time. */
  readonly currency?: string | undefined;
  readonly fxRate?: string | undefined;
  readonly fxRateDate?: string | undefined;
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
  /** What happened to the email, when one was asked for — null when the
   *  colleague took the link to send themselves (0085). */
  readonly email: EmailOutcome | null;
}

/** A line of the source that did not come across to the copy, and why. */
export interface SkippedCopyLine {
  readonly lineId: string;
  readonly description: string;
  readonly reason: string;
}

/** What copying a closed proposal made (0316). */
export interface ProposalCopy {
  readonly proposal: Proposal;
  readonly source: { readonly id: string; readonly ref: string };
  readonly linesCopied: number;
  readonly skipped: readonly SkippedCopyLine[];
  /** The addressee was left off: no longer a person in the client's structure. */
  readonly addresseeDropped: boolean;
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
  /** What this line is priced in (0344). Absent: the catalogue price's currency
   *  when the fee is taken from it and the proposal holds that currency, else
   *  the proposal's main currency. Any currency but the main one needs its rate
   *  on the proposal first. */
  readonly currency?: string | undefined;
}

/**
 * The rate of one OTHER currency on a draft (0344). The main currency's rate
 * is the head's, changed with the currency itself.
 */
export interface SetRateInput {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  /** "typed" unless a rate service supplied it. */
  readonly source?: string | undefined;
}

/**
 * An edit to one line of a draft (T6.18). ABSENT leaves a field as it is;
 * NULL means something per field, and each is the natural "undo":
 *
 *   - the four overrides: back to the pinned catalogue version's words;
 *   - `billingFrequency`: back to the pinned service's recurrence;
 *   - `unitAmount`: "as mutually agreed" — `pricingNote` is then required;
 *   - `pricingNote`, `jurisdiction`, `oopEstimate`: cleared.
 *
 * Blank prose is null too, as on adding a line: an override typed as "" is
 * somebody emptying the box, which reads as "print the standard words".
 */
export interface UpdateLineInput {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly lineId: string;
  readonly description?: string | undefined;
  readonly quantity?: string | undefined;
  readonly unitAmount?: string | null | undefined;
  readonly discountPercent?: string | undefined;
  readonly jurisdiction?: string | null | undefined;
  readonly billingFrequency?: string | null | undefined;
  readonly scopeOverride?: string | null | undefined;
  readonly clientObligationsOverride?: string | null | undefined;
  readonly volumeLimitsOverride?: string | null | undefined;
  readonly exclusionsOverride?: string | null | undefined;
  readonly oopEstimate?:
    | { readonly min: string; readonly max: string; readonly currency: string }
    | null
    | undefined;
  readonly pricingNote?: string | null | undefined;
  /** Move the line to another currency (0344): the main one or one the
   *  proposal holds a rate for. The amount is not converted; it is restated. */
  readonly currency?: string | undefined;
}

/** The fields of `UpdateLineInput` that are a change, as opposed to its address. */
const LINE_EDIT_FIELDS = [
  "currency",
  "description",
  "quantity",
  "unitAmount",
  "discountPercent",
  "jurisdiction",
  "billingFrequency",
  "scopeOverride",
  "clientObligationsOverride",
  "volumeLimitsOverride",
  "exclusionsOverride",
  "oopEstimate",
  "pricingNote",
] as const satisfies readonly (keyof UpdateLineInput)[];

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
    return this.draftProposal(input, actor, null);
  }

  /**
   * COPY a closed proposal into a new draft (0316, decided 2026-09-30).
   *
   * A client who says no usually wants it changed, not gone: a lower fee, one
   * service fewer. Without this the firm typed the whole quote again. The
   * source must be REJECTED or EXPIRED (a sent one past its date is expired
   * here, lazily, the way every other act on it expires it), and it does not
   * change: it stays exactly what the client turned down.
   *
   * WHAT IS COPIED is everything the document says, exactly as it said it: the
   * client, the issuing company, the currency and its rate, the title, the
   * Background, the person it is addressed to, every live line with its
   * service pin, wording, quantity, price, discount, country, billing, four
   * scope overrides, out-of-pocket range and pricing note, and the prose
   * (exclusions, commercials, team) as it stood. What is NOT: the status, the
   * dates it was sent and answered, the share link, the PDF of record, the
   * client's answer and the discount approval. A discount past the firm's limit
   * needs approving again, because the approval was for the old document.
   *
   * EVERY LINE GOES THROUGH `addLine`, the door a hand-built draft uses, so a
   * copy meets every check one would: a company archived since the quote went
   * out is refused. Such a line is SKIPPED AND REPORTED rather than failing the
   * whole copy, because the other fourteen lines are still worth having. The
   * validity date comes across only while it is still ahead; an expired
   * quote's date is the reason it expired. An addressee no longer linked to the
   * client is left off and reported, for the same reason as a line.
   */
  async copyAsDraft(tenantId: string, proposalId: string, actor: Actor): Promise<ProposalCopy> {
    let source = await this.deps.proposals.findById(tenantId, proposalId);
    if (source === null) throw new ProposalNotFound(proposalId);
    if (source.deletedAt !== null) throw new ProposalDeleted(source.ref);
    const today = await this.companyToday(tenantId, source.issuingEntityPartyId);
    if (source.status === "sent" && isPastValidity(source.validUntil, today)) {
      await this.expire(source, actor);
      source = { ...source, status: "expired" };
    }
    if (!isCopyable(source.status)) throw new ProposalNotCopyable(source.ref, source.status);
    const lines = await this.deps.proposals.listLines(tenantId, source.id);

    let addressedToPartyId = source.addressedToPartyId ?? undefined;
    let addresseeDropped = false;
    if (addressedToPartyId !== undefined) {
      try {
        await this.requireContact(tenantId, source.partyId, addressedToPartyId);
      } catch (err) {
        if (!(err instanceof ProposalError)) throw err;
        addressedToPartyId = undefined;
        addresseeDropped = true;
      }
    }

    const copy = await this.draftProposal(
      {
        tenantId,
        partyId: source.partyId,
        issuingEntityPartyId: source.issuingEntityPartyId,
        ...(source.leadId === null ? {} : { leadId: source.leadId }),
        title: source.title,
        currency: source.currency,
        fxRate: source.fxRate,
        fxRateDate: source.fxRateDate,
        ...(source.validUntil !== null && !isPastValidity(source.validUntil, today)
          ? { validUntil: source.validUntil }
          : {}),
        ...(source.background === null ? {} : { background: source.background }),
        ...(addressedToPartyId === undefined ? {} : { addressedToPartyId }),
      },
      actor,
      source,
    );

    // THE OTHER CURRENCIES' RATES (0344), as they stood on the closed one: the
    // copy is a starting point, and each line below needs its currency's rate
    // before it can go on. A person can change any of them before sending.
    for (const rate of source.rates) {
      await this.deps.proposals.setRate(tenantId, copy.id, rate);
    }

    let linesCopied = 0;
    const skipped: SkippedCopyLine[] = [];
    // IN ORDER, one at a time: `addLine` takes each line's position from what
    // is already on the draft.
    for (const line of lines) {
      try {
        await this.addLine(
          {
            tenantId,
            proposalId: copy.id,
            ...(line.entityPartyId === null ? {} : { entityPartyId: line.entityPartyId }),
            serviceVersionId: line.serviceVersionId,
            description: line.description,
            quantity: line.quantity,
            currency: line.currency,
            ...(line.unitAmount === null ? {} : { unitAmount: line.unitAmount }),
            discountPercent: line.discountPercent,
            ...(line.jurisdiction === null ? {} : { jurisdiction: line.jurisdiction }),
            ...(line.billingFrequency === null ? {} : { billingFrequency: line.billingFrequency }),
            ...(line.scopeOverride === null ? {} : { scopeOverride: line.scopeOverride }),
            ...(line.clientObligationsOverride === null
              ? {}
              : { clientObligationsOverride: line.clientObligationsOverride }),
            ...(line.volumeLimitsOverride === null
              ? {}
              : { volumeLimitsOverride: line.volumeLimitsOverride }),
            ...(line.exclusionsOverride === null ? {} : { exclusionsOverride: line.exclusionsOverride }),
            ...(line.oopEstimate === null ? {} : { oopEstimate: line.oopEstimate }),
            ...(line.pricingNote === null ? {} : { pricingNote: line.pricingNote }),
          },
          actor,
        );
        linesCopied += 1;
      } catch (err) {
        if (!(err instanceof ProposalError)) throw err;
        skipped.push({ lineId: line.id, description: line.description, reason: err.message });
      }
    }

    const prose = await this.deps.documents.listBlocks(tenantId, { kind: "proposal", id: copy.id });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.copied",
      objectId: source.id,
      actor,
      // Ids and counts. Which lines did not come across is on the answer the
      // person is looking at; their descriptions are the client's own words.
      payload: {
        copyId: copy.id,
        copyRef: copy.ref,
        linesCopied,
        linesSkipped: skipped.length,
        proseLinesCopied: prose.length,
        addresseeDropped,
      },
    });
    return {
      proposal: copy,
      source: { id: source.id, ref: source.ref },
      linesCopied,
      skipped,
      addresseeDropped,
    };
  }

  private async draftProposal(
    input: DraftProposalInput,
    actor: Actor,
    copyFrom: Proposal | null,
  ): Promise<Proposal> {
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
    // Before the reference is drawn, so a refusal spends no number (0305).
    await this.refuseArchived(input.tenantId, input.partyId, "client");
    // Nor to one of the firm's own companies: the invoice refuses to bill one
    // (BILLS_THE_FIRM), and a quote to one is where that invoice would start.
    if (await this.deps.documents.isFirmEntity(input.tenantId, input.partyId)) {
      const named = await this.deps.parties.findParty(input.tenantId, input.partyId);
      throw new ProposalClientIsOwnCompany(named?.displayName ?? input.partyId);
    }
    // A lead deleted as a mistake gains no proposal (0086): there was never a
    // prospect to offer it to. A lead that does not exist is the foreign key's.
    if (input.leadId !== undefined) {
      const lead = await this.deps.leads.findById(input.tenantId, input.leadId);
      if (lead !== null && lead.deletedAt !== null) throw new ProposalLeadDeleted();
    }
    // The two names on the cover (0084), before the number too.
    if (input.addressedToPartyId !== undefined) {
      await this.requireContact(input.tenantId, input.partyId, input.addressedToPartyId);
    }
    if (input.preparedByUserId !== undefined) {
      await this.requireStaff(input.tenantId, input.preparedByUserId);
    }

    // WHO is offering, before anything is written. Named by the caller, or
    // resolved from the firm's own rule — never guessed here, and never left
    // out: a document that cannot say who is contracting is not a document.
    // A caller's choice is one of the FIRM's companies (F-10-1); the rule's
    // own answer always is.
    if (
      input.issuingEntityPartyId !== undefined &&
      !(await this.deps.documents.isFirmEntity(input.tenantId, input.issuingEntityPartyId))
    ) {
      const named = await this.deps.parties.findParty(input.tenantId, input.issuingEntityPartyId);
      throw new ProposalIssuerNotAFirmEntity(named?.displayName ?? input.issuingEntityPartyId);
    }
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
      background: blankToNull(input.background),
      addressedToPartyId: input.addressedToPartyId ?? null,
      // Prepared by whoever is preparing it, unless the caller named somebody.
      preparedByUserId: input.preparedByUserId ?? (actor.type === "human" ? actor.id : null),
      copiedFromId: copyFrom?.id ?? null,
    });

    // The firm's standard prose, COPIED onto this document (G1.7). After the
    // row exists, because the blocks hang off it; before the event, because a
    // drafted proposal is one that already says what the firm always says.
    //
    // WHOSE lines and WHICH country's (T6.18). The ISSUER's own standard
    // lines where it has any of a kind, the firm's default ones where it has
    // none (D5). The country is the CLIENT's when it is known, else where the
    // issuer is registered, else `*` — `blocksFor` copies an unscoped line
    // always and a scoped one only for its own country, so an unknown country
    // takes the lines that are true everywhere. Before T6.18 an unknown client
    // country was always `*`, and the builder never sends one, so an Indian
    // company's India-only lines never reached a proposal it issued.
    //
    // A COPY takes the source's prose instead, whole (0316): the wording the
    // firm had already tailored for this client is what the next draft starts
    // from.
    if (copyFrom === null) {
      const registered = await this.deps.documents.issuerJurisdiction(
        proposal.tenantId,
        issuingEntityPartyId,
      );
      await this.deps.documents.seedBlocks(
        proposal.tenantId,
        { kind: "proposal", id: proposal.id },
        this.proseJurisdiction(input.clientJurisdiction, registered.jurisdiction),
        issuingEntityPartyId,
      );
    } else {
      await this.deps.documents.seedBlocksCopied(
        proposal.tenantId,
        { kind: "proposal", id: proposal.id },
        { kind: "proposal", id: copyFrom.id },
      );
    }

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
        // Ids, erasable where they point; the names stay out of the log.
        addressedToPartyId: proposal.addressedToPartyId,
        preparedByUserId: proposal.preparedByUserId,
        // Where it came from, when it is a copy of a closed quote (0316).
        copiedFromId: proposal.copiedFromId,
      },
    });
    return proposal;
  }

  /**
   * Change what a DRAFT says about itself (0084) — its title, how long it is
   * valid, its Background, and the two names on its cover.
   *
   * A draft only, like every other change to a proposal's content: once it has
   * been sent, the client holds what it said. No event, deliberately, the same
   * as adding or removing a line — the ledger records what happened TO a
   * proposal (drafted, sent, viewed, decided), and a draft being written is not
   * a transition. What went out is recorded by `proposal.sent` and by the PDF
   * the store keeps.
   */
  async revise(input: ReviseProposalInput, actor: Actor = SYSTEM_ACTOR): Promise<Proposal> {
    const proposal = await this.draftOrThrow(input.tenantId, input.proposalId);
    const change: {
      title?: string;
      validUntil?: string | null;
      background?: string | null;
      addressedToPartyId?: string | null;
      preparedByUserId?: string | null;
      issuingEntityPartyId?: string;
      currency?: string;
      fxRate?: string;
      fxRateDate?: string;
    } = {};
    if (input.title !== undefined) change.title = input.title.trim();
    if (input.validUntil !== undefined) change.validUntil = input.validUntil;
    if (input.background !== undefined) change.background = blankToNull(input.background ?? undefined);
    if (input.addressedToPartyId !== undefined) {
      if (input.addressedToPartyId !== null) {
        await this.requireContact(input.tenantId, proposal.partyId, input.addressedToPartyId);
      }
      change.addressedToPartyId = input.addressedToPartyId;
    }
    if (input.preparedByUserId !== undefined) {
      if (input.preparedByUserId !== null) await this.requireStaff(input.tenantId, input.preparedByUserId);
      change.preparedByUserId = input.preparedByUserId;
    }

    // THE MONEY (T6.18). Three fields or none: a rate belongs to one currency on
    // one day. A different MAIN currency only while no live line is in the old
    // one (0344): lines keep their own currency, and one left in a currency
    // with no rate would drop out of every converted figure.
    const money = [input.currency, input.fxRate, input.fxRateDate];
    if (money.some((v) => v !== undefined)) {
      if (money.some((v) => v === undefined)) throw new InvalidCurrencyChange();
      const currency = normalizeCurrency(input.currency ?? "");
      if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(input.currency ?? "");
      const fxRate = input.fxRate ?? "";
      if (!isExchangeRate(fxRate) || Number(fxRate) <= 0) throw new InvalidFxRate(fxRate);
      if (currency !== proposal.currency) {
        const live = await this.deps.proposals.listLines(input.tenantId, input.proposalId);
        const inOld = live.filter((l) => l.currency === proposal.currency).length;
        if (inOld > 0) throw new CurrencyLockedByLines(inOld, proposal.currency);
      }
      change.currency = currency;
      change.fxRate = fxRate;
      change.fxRateDate = input.fxRateDate ?? "";
    }

    // THE ISSUER (T6.18, D9). One of the firm's own companies; its standard
    // prose replaces the draft's, and what was edited for this client is not
    // thrown away without the caller saying so.
    let prose: readonly ProseLine[] | null = null;
    let editedReplaced = 0;
    const newIssuer = input.issuingEntityPartyId;
    if (newIssuer !== undefined && newIssuer !== proposal.issuingEntityPartyId) {
      if (!(await this.deps.documents.isFirmEntity(input.tenantId, newIssuer))) {
        const named = await this.deps.parties.findParty(input.tenantId, newIssuer);
        throw new ProposalIssuerNotAFirmEntity(named?.displayName ?? newIssuer);
      }
      const owner = { kind: "proposal" as const, id: proposal.id };
      const registered = await this.deps.documents.issuerJurisdiction(input.tenantId, newIssuer);
      const current = await this.deps.documents.listBlocks(input.tenantId, owner);
      // Written for this client either way: a house line reworded, or a line
      // added by hand that no standard row stands behind.
      editedReplaced = current.filter((b) => b.isEdited || b.sourceId === null).length;
      if (editedReplaced > 0 && input.replaceEditedProse !== true) {
        throw new ProseEdited(editedReplaced, registered.displayName);
      }
      prose = await this.deps.documents.standardProse(
        input.tenantId,
        owner,
        this.proseJurisdiction(input.clientJurisdiction, registered.jurisdiction),
        newIssuer,
      );
      change.issuingEntityPartyId = newIssuer;
    }

    if (Object.keys(change).length === 0) throw new NothingToRevise();

    const revision: ProposalRevision = change;
    const revised = await this.deps.proposals.revise(
      input.tenantId,
      input.proposalId,
      revision,
      prose,
    );
    if (revised === null) {
      // Sent or deleted between the read above and the write, or a line was
      // quoted a moment ago under a currency change: the WHERE refused it, and
      // the proposal as it now stands says which.
      await this.draftOrThrow(input.tenantId, input.proposalId);
      const live = await this.deps.proposals.listLines(input.tenantId, input.proposalId);
      throw new CurrencyLockedByLines(live.length, proposal.currency);
    }

    // The ledger records who would contract and in what money — a commercial
    // and legal fact even on a draft. Titles and names stay out.
    if (change.issuingEntityPartyId !== undefined) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "proposal.issuer_changed",
        objectId: proposal.id,
        actor,
        payload: {
          fromIssuingEntityPartyId: proposal.issuingEntityPartyId,
          toIssuingEntityPartyId: change.issuingEntityPartyId,
          proseReplaced: true,
          editedLinesReplaced: editedReplaced,
        },
      });
    }
    if (
      change.currency !== undefined &&
      (change.currency !== proposal.currency ||
        change.fxRate !== proposal.fxRate ||
        change.fxRateDate !== proposal.fxRateDate)
    ) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "proposal.currency_changed",
        objectId: proposal.id,
        actor,
        payload: {
          fromCurrency: proposal.currency,
          toCurrency: revised.currency,
          fromFxRate: proposal.fxRate,
          toFxRate: revised.fxRate,
          fxRateDate: revised.fxRateDate,
        },
      });
    }
    return revised;
  }

  /**
   * Which country's standard lines a proposal's prose takes: the CLIENT's when
   * it is known, else where the ISSUER is registered, else `*` — the lines that
   * are true everywhere. `blocksFor` copies an unscoped line always and a scoped
   * one only for its own country, so an unknown country is the safe direction.
   */
  private proseJurisdiction(client: string | undefined, issuer: string | null): string {
    if (client !== undefined && client.trim() !== "") return normalizeJurisdiction(client);
    return issuer ?? ANY_JURISDICTION;
  }

  /** "Prepared for" is a PERSON with a recorded role in the client's structure
   *  — the letter's addressee rule, on the same read (F-10-1). */
  private async requireContact(
    tenantId: string,
    clientPartyId: string,
    personPartyId: string,
  ): Promise<void> {
    const person = await this.deps.parties.findParty(tenantId, personPartyId);
    if (person !== null && person.kind !== "person") {
      throw new ProposalAddresseeNotAPerson(person.displayName);
    }
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    const today = dayInZone(this.deps.clock.now().toISOString(), zone);
    const structure = await this.deps.structure.structureOf(tenantId, clientPartyId, today);
    if (structure.people.some((p) => p.id === personPartyId)) return;
    const client = await this.deps.parties.findParty(tenantId, clientPartyId);
    throw new ProposalAddresseeNotLinked(
      person?.displayName ?? personPartyId,
      client?.displayName ?? clientPartyId,
    );
  }

  /** "Prepared by" is somebody who works here: the key points at a GLOBAL
   *  account table and would accept anybody. */
  private async requireStaff(tenantId: string, userId: string): Promise<void> {
    if (await this.deps.staff.isActiveStaff(tenantId, userId)) return;
    throw new PreparerNotStaff(userId);
  }

  /** Quote one thing, from one frozen catalogue version. */
  /** A client or an entity the firm put away is not written onto a new
   *  document (0305). A party that does not exist at all is left to the
   *  foreign key, as it always was. */
  private async refuseArchived(
    tenantId: string,
    partyId: string,
    as: "client" | "entity",
  ): Promise<void> {
    const party = await this.deps.parties.findParty(tenantId, partyId);
    if (party !== null && party.archivedAt !== null) {
      throw new ProposalPartyArchived(party.displayName, as);
    }
  }

  async addLine(input: AddLineInput, actor: Actor = SYSTEM_ACTOR): Promise<ProposalLine> {
    const proposal = await this.draftOrThrow(input.tenantId, input.proposalId);
    if (input.entityPartyId !== undefined) {
      await this.refuseArchived(input.tenantId, input.entityPartyId, "entity");
    }

    checkQuantity(input.quantity);
    const pricingNote = blankToNull(input.pricingNote);

    // Resolve the pin BEFORE writing, so a bad version id is a 400 naming the
    // id rather than a foreign-key violation surfacing as a 500.
    const pinned = await this.deps.catalogue.readPinnedVersion(
      input.tenantId,
      input.serviceVersionId,
    );
    if (pinned === null) throw new ServiceNotFound(input.serviceVersionId);
    if (pinned.kind !== "service") throw new NotAService(input.serviceVersionId, pinned.kind);
    if (pinned.status === "draft") throw new ServiceNotPublished(input.serviceVersionId);

    // NEITHER A FEE NOR A REASON: quoted at the pinned version's list price in
    // the proposal's currency (B09, audit 2026-10-03). A login that cannot see
    // fees reads every list price as null, and the builder used to fill the
    // fee in from it; the API does that now, so the drafter is never shown the
    // price and the quote is the same. With no price to quote, the refusal says
    // what to send.
    //
    // THE LINE'S CURRENCY (0344): the caller's; else, when the fee comes from
    // the list price, the list price's currency if the proposal holds it; else
    // the main currency. Whatever it is, the proposal must hold its rate.
    let unitAmount = input.unitAmount ?? null;
    const listPrice = readServiceBody(pinned.body).listPrice;
    const fromList = unitAmount === null && pricingNote === null;
    const currency =
      input.currency !== undefined
        ? this.lineCurrency(input.currency)
        : fromList && listPrice !== null && rateFor(proposal, listPrice.currency) !== null
          ? listPrice.currency
          : proposal.currency;
    if (rateFor(proposal, currency) === null) throw new CurrencyNeedsARate(currency);
    if (fromList) {
      const service = readServiceBody(pinned.body);
      if (listPrice === null || listPrice.currency !== currency) {
        throw new ServiceHasNoListPrice(service.name === "" ? input.description : service.name, currency);
      }
      unitAmount = listPrice.amount;
    }
    checkPricing(unitAmount, pricingNote, input.discountPercent);

    const jurisdiction = this.lineJurisdiction(input.jurisdiction);
    const billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    const oopEstimate = this.outOfPocket(input.oopEstimate);

    // A new line is a discount raised from nothing: past the limit after a
    // sign-off, the sign-off no longer covers the draft (T6.18).
    const lapse = await this.approvalLapses(proposal, "0", input.discountPercent);

    const line = await this.deps.proposals.addLine({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      proposalId: proposal.id,
      entityPartyId: input.entityPartyId ?? null,
      serviceVersionId: input.serviceVersionId,
      description: input.description,
      quantity: input.quantity,
      unitAmount,
      currency,
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
    }, lapse.lapses);
    if (lapse.lapses) await this.recordLapse(proposal, line, lapse.limit, actor);
    return line;
  }

  /**
   * Change a line already on a DRAFT (T6.18) — its fee, how often it is billed,
   * its wording, its four scope blocks — without pulling it and quoting it
   * again, which lost its place and its pin.
   *
   * The same rules as adding one, judged on the line AS IT WILL BE: the change
   * merged over what the line says now, so "no price" and "no reason" cannot
   * each be allowed on their own and meet on the row. The currency is the
   * proposal's and is not a field here. The discount limit is checked the way
   * `send` checks it: a line past it simply needs a sign-off before sending,
   * and a sign-off already given LAPSES when this raises a discount past the
   * limit (`discountApprovalLapses`), in the same transaction as the edit.
   *
   * No event for the edit itself, like adding or removing a line: a draft being
   * written is not a transition. A lapsed sign-off IS one, and is recorded.
   */
  async updateLine(input: UpdateLineInput, actor: Actor): Promise<ProposalLine> {
    const proposal = await this.draftOrThrow(input.tenantId, input.proposalId);
    if (LINE_EDIT_FIELDS.every((f) => input[f] === undefined)) throw new NothingToChangeOnLine();
    const lines = await this.deps.proposals.listLines(input.tenantId, input.proposalId);
    const current = lines.find((l) => l.id === input.lineId);
    if (current === undefined) throw new LineNotFound(input.lineId);

    let description = current.description;
    if (input.description !== undefined) {
      description = input.description.trim();
      if (description === "") throw new InvalidLineDescription();
    }
    const quantity = input.quantity ?? current.quantity;
    checkQuantity(quantity);
    const currency = input.currency === undefined ? current.currency : this.lineCurrency(input.currency);
    if (currency !== current.currency && rateFor(proposal, currency) === null) {
      throw new CurrencyNeedsARate(currency);
    }
    const unitAmount = input.unitAmount === undefined ? current.unitAmount : input.unitAmount;
    const pricingNote =
      input.pricingNote === undefined ? current.pricingNote : blankToNull(input.pricingNote ?? undefined);
    const discountPercent = input.discountPercent ?? current.discountPercent;
    checkPricing(unitAmount, pricingNote, discountPercent);

    const jurisdiction =
      input.jurisdiction === undefined
        ? current.jurisdiction
        : this.lineJurisdiction(input.jurisdiction ?? undefined);
    const oopEstimate =
      input.oopEstimate === undefined
        ? current.oopEstimate
        : this.outOfPocket(input.oopEstimate ?? undefined);

    // Null is "back to what the service says", read off the SAME pin the line
    // was quoted from — never today's catalogue.
    let billingFrequency = current.billingFrequency;
    if (input.billingFrequency === null) {
      const pinned = await this.deps.catalogue.readPinnedVersion(
        input.tenantId,
        current.serviceVersionId,
      );
      billingFrequency = pinned === null ? null : readServiceBody(pinned.body).recurrence;
    } else if (input.billingFrequency !== undefined) {
      billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    }

    const override = (next: string | null | undefined, now: string | null): string | null =>
      next === undefined ? now : blankToNull(next ?? undefined);

    const lapse = await this.approvalLapses(proposal, current.discountPercent, discountPercent);
    const updated = await this.deps.proposals.updateLine(
      input.tenantId,
      input.proposalId,
      input.lineId,
      {
        description,
        quantity,
        currency,
        unitAmount,
        discountPercent,
        jurisdiction,
        billingFrequency,
        scopeOverride: override(input.scopeOverride, current.scopeOverride),
        clientObligationsOverride: override(
          input.clientObligationsOverride,
          current.clientObligationsOverride,
        ),
        volumeLimitsOverride: override(input.volumeLimitsOverride, current.volumeLimitsOverride),
        exclusionsOverride: override(input.exclusionsOverride, current.exclusionsOverride),
        oopEstimate,
        pricingNote,
      },
      lapse.lapses,
    );
    if (updated === null) {
      // Sent, deleted or pulled between the read above and the write: the
      // proposal as it now stands says which.
      await this.draftOrThrow(input.tenantId, input.proposalId);
      throw new LineNotFound(input.lineId);
    }
    if (lapse.lapses) await this.recordLapse(proposal, updated, lapse.limit, actor);
    return updated;
  }

  /** Whether moving one line's discount from `before` to `after` lapses the
   *  draft's sign-off, and the limit it was judged against — read LIVE, the
   *  way `send` reads it. The policy is asked only when there is a sign-off. */
  private async approvalLapses(
    proposal: Proposal,
    before: string,
    after: string,
  ): Promise<{ readonly lapses: boolean; readonly limit: string | null }> {
    if (proposal.discountApprovedAt === null) return { lapses: false, limit: null };
    const limit = await this.deps.policies.maxDiscountPercent(proposal.tenantId);
    return { lapses: discountApprovalLapses(true, before, after, limit), limit };
  }

  private async recordLapse(
    proposal: Proposal,
    line: ProposalLine,
    limit: string | null,
    actor: Actor,
  ): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId: proposal.tenantId,
      verb: "proposal.discount_approval_lapsed",
      objectId: proposal.id,
      actor,
      // Who had signed off, and the two numbers that undid it — the record
      // somebody reads when asking why a quote needed approving twice.
      payload: {
        previouslyApprovedByUserId: proposal.discountApprovedBy,
        lineId: line.id,
        discountPercent: line.discountPercent,
        limitPercent: limit,
      },
    });
  }

  /** The line's jurisdiction, normalised. Refused rather than silently dropped:
   *  "in" and "IN" are the same country and "INR" is not one. */
  /**
   * Give a DRAFT the rate of one of its OTHER currencies, or change it (0344).
   * The main currency's rate is the head's (`revise`). Recorded, like the main
   * rate: it is a commercial fact even on a draft.
   */
  async setRate(input: SetRateInput, actor: Actor): Promise<CurrencyRate> {
    const proposal = await this.draftOrThrow(input.tenantId, input.proposalId);
    const currency = this.lineCurrency(input.currency);
    if (currency === proposal.currency) throw new RateIsMainCurrency(currency);
    if (!isExchangeRate(input.fxRate) || Number(input.fxRate) <= 0) throw new InvalidFxRate(input.fxRate);
    const source = (input.source ?? "typed").trim() === "" ? "typed" : (input.source ?? "typed").trim();
    const rate = await this.deps.proposals.setRate(input.tenantId, proposal.id, {
      currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      source,
    });
    if (rate === null) {
      await this.draftOrThrow(input.tenantId, input.proposalId);
      throw new RateIsMainCurrency(currency);
    }
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "proposal.rate_set",
      objectId: proposal.id,
      actor,
      payload: { currency, fxRate: rate.fxRate, fxRateDate: rate.fxRateDate, source: rate.source },
    });
    return rate;
  }

  /** Take a rate off a DRAFT: only while no live line is priced in it. */
  async removeRate(tenantId: string, proposalId: string, raw: string, actor: Actor): Promise<void> {
    const proposal = await this.draftOrThrow(tenantId, proposalId);
    const currency = this.lineCurrency(raw);
    if (currency === proposal.currency) throw new RateIsMainCurrency(currency);
    const using = (await this.deps.proposals.listLines(tenantId, proposalId)).filter((l) => l.currency === currency);
    if (using.length > 0) throw new RateInUse(currency, using.length);
    if (await this.deps.proposals.removeRate(tenantId, proposalId, currency)) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "proposal.rate_removed",
        objectId: proposal.id,
        actor,
        payload: { currency },
      });
    }
  }

  /** A line's or a rate's currency: three letters, upper-cased (0344). */
  private lineCurrency(raw: string): string {
    const currency = normalizeCurrency(raw);
    if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(raw);
    return currency;
  }

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
    // Whether Delete would work (0086), asked only of a live draft: nothing
    // else can be deleted, and saying why needs no query.
    const { proposal } = record;
    const citing =
      proposal.status === "draft" && proposal.deletedAt === null
        ? await this.deps.proposals.liveLetterRefs(tenantId, proposalId)
        : [];
    const block = proposalDeletionBlock(proposal, citing);
    const refusal = block === null ? null : proposalDeletionRefusal(proposal.ref, block);
    // Whether Copy would work (0316): the same test `copyAsDraft` makes, a sent
    // proposal past its date counting as the expired one it is about to become.
    const lapsed =
      proposal.status === "sent" &&
      isPastValidity(proposal.validUntil, await this.companyToday(tenantId, proposal.issuingEntityPartyId));
    const copyRefusal =
      proposal.deletedAt !== null
        ? new ProposalDeleted(proposal.ref)
        : isCopyable(proposal.status) || lapsed
          ? null
          : new ProposalNotCopyable(proposal.ref, proposal.status);
    return {
      ...record,
      blocks,
      document: planOf(record),
      deleteRefusal: refusal === null ? null : { code: refusal.code, message: refusal.message },
      copyRefusal:
        copyRefusal === null ? null : { code: copyRefusal.code, message: copyRefusal.message },
    };
  }

  /**
   * Delete a DRAFT made by mistake (0086) — off the list of quotes, still
   * readable by id, and final.
   *
   * Only a draft: once sent, the client holds the document, and it is answered
   * or it expires. Not while a live letter cites it. The reference is not
   * reused — a proposal reference may gap, and this is one of the reasons. The
   * trigger under this (`trg_proposal_guard_deletion`) holds the same rule for
   * the writers that do not come through here.
   */
  async delete(tenantId: string, proposalId: string, actor: Actor): Promise<Proposal> {
    const proposal = await this.findOrThrow(tenantId, proposalId);
    const citing =
      proposal.status === "draft" && proposal.deletedAt === null
        ? await this.deps.proposals.liveLetterRefs(tenantId, proposalId)
        : [];
    const block = proposalDeletionBlock(proposal, citing);
    if (block !== null) throw proposalDeletionRefusal(proposal.ref, block);

    const deleted = await this.deps.proposals.markDeleted(
      tenantId,
      proposalId,
      actor.type === "human" ? actor.id : null,
    );
    if (deleted === null) {
      // Sent, or deleted by somebody else, between the read and the write: the
      // WHERE clause refused it, and the proposal as it now stands says which.
      const current = await this.findOrThrow(tenantId, proposalId);
      const late = proposalDeletionBlock(current, []);
      throw late === null
        ? new ProposalDeleted(current.ref)
        : proposalDeletionRefusal(current.ref, late);
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.deleted",
      objectId: proposal.id,
      actor,
      // The reference and the party — never the title, which is routinely
      // "Acme Ltd — FY26 audit" and this log cannot be erased.
      payload: { ref: proposal.ref, partyId: proposal.partyId },
    });
    return deleted;
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
   *
   * With `email` (0085), bib also emails it: the PDF of record attached, and
   * Accept and Decline buttons that open the link's page. The address is
   * checked BEFORE anything moves, so a typo is a refusal and not a sent
   * proposal nobody received. What can fail AFTER the proposal moved — the
   * render, the mail server — comes back as `email.status = "failed"` beside
   * the link, never as an exception that would lose the link.
   */
  async send(
    tenantId: string,
    proposalId: string,
    actor: Actor,
    email?: EmailRequest,
  ): Promise<SendResult> {
    const proposal = await this.draftOrThrow(tenantId, proposalId);
    const request = email === undefined ? null : this.checkEmail(email);
    const lines = await this.deps.proposals.listLines(tenantId, proposalId);
    if (lines.length === 0) throw new EmptyProposal();

    if (proposal.discountApprovedAt === null) {
      const limit = await this.deps.policies.maxDiscountPercent(tenantId);
      if (needsDiscountApproval(lines, limit)) {
        throw new DiscountNeedsApproval(largestDiscount(lines), limit);
      }
    }

    const sent = await this.moveTo(proposal, "sent");
    const shareToken = await this.issueLink(tenantId, proposalId);
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
    if (request === null) {
      // THE PDF OF RECORD, filed the moment it goes out (2026-09-28), not the
      // first time something asks for it: a proposal sent by WhatsApp or as a
      // bare link used to have none until the client downloaded it, so the
      // staff page had no file to show and the client's copy could carry a
      // logo uploaded after it was sent. Best-effort, as the email's render
      // is: a render that fails leaves the proposal sent, and the next reader
      // that needs the file files it (`pdfOfRecord`).
      const pinned = await this.pdfOfRecord(sent, actor).catch(() => null);
      return {
        proposal: pinned === null ? sent : await this.findOrThrow(tenantId, proposalId),
        shareToken,
        email: null,
      };
    }

    const outcome = await this.deliver(sent, shareToken, request, actor);
    return { proposal: await this.findOrThrow(tenantId, proposalId), shareToken, email: outcome };
  }

  /**
   * A NEW LINK for a proposal that is out, and — with `email` — a new email
   * carrying it (0085).
   *
   * The link is readable once, so a firm that lost it, or a client who lost
   * the email, needs another; the old one stops working the moment this one
   * exists, because a proposal has one live link (0014's digest column). That
   * is the trade the staff page states before anybody presses it.
   *
   * Only while the proposal is `sent`: an answered proposal is final and an
   * expired one is a new quote, so neither has anything a new link could do.
   */
  async reissue(
    tenantId: string,
    proposalId: string,
    actor: Actor,
    email?: EmailRequest,
  ): Promise<SendResult> {
    const proposal = await this.findOrThrow(tenantId, proposalId);
    const request = email === undefined ? null : this.checkEmail(email);

    const now = this.deps.clock.now().toISOString();
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, await this.companyToday(tenantId, proposal.issuingEntityPartyId))) {
      await this.expire(proposal, actor);
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }
    if (proposal.status !== "sent") throw new NotOutForAnswer(proposal.status);

    const shareToken = await this.issueLink(tenantId, proposalId);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.link_reissued",
      objectId: proposal.id,
      actor,
      payload: { partyId: proposal.partyId, emailed: request !== null },
    });
    if (request === null) return { proposal, shareToken, email: null };

    const outcome = await this.deliver(proposal, shareToken, request, actor);
    return { proposal: await this.findOrThrow(tenantId, proposalId), shareToken, email: outcome };
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
   *   It does not ANSWER. Opening is reading; the answer is `answerShared`, a
   *   separate request with a name typed and — for an acceptance — a statement
   *   ticked. Mail scanners open every link in an email to check it, so an
   *   answer that happened on opening would be given by a scanner (0085).
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
    if (shared.status === "sent" && isPastValidity(
        shared.validUntil,
        await this.companyToday(
          parsed.tenantId,
          (await this.deps.proposals.findById(parsed.tenantId, shared.id))?.issuingEntityPartyId ?? null,
        ),
      )) {
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
    return this.withProse(parsed.tenantId, shared);
  }

  /**
   * The CLIENT answers, on the link's page (0085).
   *
   * ── WHY THIS IS SAFE ON A LINK WITH NO SESSION ──────────────────────────
   *
   * The link is the capability the firm handed this client on purpose, and
   * the one act it now authorises is the one the firm sent it to invite: yes
   * or no, once, while the offer stands. It cannot change a price, a line or
   * a date, and it cannot be undone into a different answer — the status is
   * terminal and the repository writes it only while the proposal is `sent`.
   * It is a POST with a typed name, so the mail scanners that open every link
   * in an email cannot give it; an acceptance also needs the statement ticked.
   *
   * ── WHAT IS KEPT ────────────────────────────────────────────────────────
   *
   * The name, the statement word for word, the email whose link was used, the
   * PDF of record, and the address and browser — in the erasable evidence row,
   * never the ledger. The events say only that the answer came through the
   * link, with the PDF's fingerprint.
   *
   * A render failing does not refuse the answer: the client answered what they
   * were shown, and the evidence row records that no PDF could be filed.
   */
  async answerShared(input: SharedAnswerInput, actor: Actor): Promise<SharedProposal> {
    const decision = input.decision;
    if (!isProposalDecision(decision)) throw new InvalidDecision(decision);
    const { tenantId, digest, proposal } = await this.openLink(input.token);

    if (proposal.status === "accepted" || proposal.status === "rejected") {
      throw new AlreadyAnswered(proposal.status);
    }
    const now = this.deps.clock.now().toISOString();
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, await this.companyToday(tenantId, proposal.issuingEntityPartyId))) {
      await this.expire(proposal, actor);
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }
    if (proposal.status === "expired") {
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }

    const signerName = input.signerName.trim();
    if (signerName === "") throw new SignerNameRequired();
    if (decision === "accepted" && !input.confirmed) throw new AcceptanceNotConfirmed();

    const record = await this.recordOrThrow(tenantId, proposal.id);
    const statement =
      decision === "accepted" ? acceptanceStatement(proposal.ref, record.party.displayName) : null;
    const pdf = await this.pdfOfRecord(proposal, actor).catch(() => null);
    const email = await this.deps.proposals.findEmailByLink(tenantId, proposal.id, digest);
    const reason = decision === "rejected" ? blankToNull(input.declinedReason) : null;

    const decided = await this.deps.proposals.recordClientAnswer({
      id: this.deps.ids.newId(),
      tenantId,
      proposalId: proposal.id,
      decision,
      declinedReason: reason,
      signerName,
      statement,
      emailId: email?.id ?? null,
      pdfVersionId: pdf?.versionId ?? null,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      decidedAt: now,
    });
    if (decided === null) {
      // Answered a moment ago — another tab, another person holding the link.
      // The first answer stands, and this one is told what it was.
      const current = await this.findOrThrow(tenantId, proposal.id);
      if (current.status === "accepted" || current.status === "rejected") {
        throw new AlreadyAnswered(current.status);
      }
      throw new ProposalExpired(current.validUntil ?? now.slice(0, 10));
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: decision === "accepted" ? "proposal.accepted" : "proposal.rejected",
      objectId: proposal.id,
      actor,
      // The shape `decide` records, plus WHERE it came from. The name, the
      // address and the browser are personal and stay in the evidence row.
      payload: {
        partyId: proposal.partyId,
        decision: decision satisfies ProposalDecision,
        declinedReasonRecorded: reason !== null,
        via: "share_link",
        emailId: email?.id ?? null,
        pdfContentHash: pdf?.contentHash ?? null,
      },
    });
    await this.tellPreparer(record, decided, signerName, reason);

    const shared = await this.deps.proposals.findShared(tenantId, digest);
    if (shared === null) throw new ShareLinkUnknown();
    return this.withProse(tenantId, shared);
  }

  /**
   * The PDF of record, for the link's Download button (0085).
   *
   * The same file the email attached, and filed now if nothing has asked for
   * it yet — a proposal sent before 0085, or one sent without an email. An
   * answered proposal still downloads: it is the client's copy of what they
   * answered. An expired one does not, for the reason its page does not open.
   */
  async sharedPdf(
    token: string,
    actor: Actor,
  ): Promise<{ readonly filename: string; readonly bytes: Uint8Array }> {
    const { tenantId, proposal } = await this.openLink(token);
    const now = this.deps.clock.now().toISOString();
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, await this.companyToday(tenantId, proposal.issuingEntityPartyId))) {
      await this.expire(proposal, actor);
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }
    if (proposal.status === "expired") {
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }
    const pdf = await this.pdfOfRecord(proposal, actor);
    return { filename: pdf.filename, bytes: await this.deps.pdfs.bytes(tenantId, pdf) };
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
    if (proposal.deletedAt !== null) throw new ProposalDeleted(proposal.ref);

    const today = await this.companyToday(tenantId, proposal.issuingEntityPartyId);
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, today)) {
      await this.expire(proposal, actor);
      // validUntil is non-null whenever isPastValidity is true.
      throw new ProposalExpired(proposal.validUntil ?? today);
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

  /**
   * The client accepted OUTSIDE the link — by email, on a call, in a meeting —
   * and a colleague holding `acceptance:record` says so (0317, decided
   * 2026-09-30). The route carries the permission; this carries the rules.
   *
   * Only a SENT proposal, and never a lapsed one: one past its validity date is
   * expired here exactly as every other act on it expires it, and the answer is
   * a copy as a new draft (0316), not an old price accepted late. How, when,
   * who and a note are required; the client's email is optional here (the
   * letter that follows needs one). The status and the evidence are written in
   * ONE transaction, so neither stands without the other, and a client's own
   * answer on the link landing first wins.
   */
  async recordAcceptance(
    tenantId: string,
    proposalId: string,
    statement: AcceptanceStatement,
    recordedByUserId: string,
    actor: Actor,
    /** The recorder's today (their screen's), held to the company's day or
     *  one either side (0337); absent = the company's day. */
    asOf?: string,
  ): Promise<Proposal> {
    const proposal = await this.findOrThrow(tenantId, proposalId);
    if (proposal.deletedAt !== null) throw new ProposalDeleted(proposal.ref);
    const now = this.deps.clock.now().toISOString();
    if (proposal.status === "sent" && isPastValidity(proposal.validUntil, await this.companyToday(tenantId, proposal.issuingEntityPartyId))) {
      await this.expire(proposal, actor);
      throw new ProposalExpired(proposal.validUntil ?? now.slice(0, 10));
    }
    if (proposal.status !== "sent") throw new InvalidTransition(proposal.status, "accepted");

    const zone = await this.companyZone(tenantId, proposal.issuingEntityPartyId);
    // THE RECORDER'S DAY: a partner in Delhi at 09:00 on 1 November records a
    // New York company's quote as accepted today, though New York is still on
    // 31 October (final review). Held to the company's day or one either side.
    const companyDay = dayInZone(now, zone);
    if (asOf !== undefined && !isCallersToday(asOf, companyDay)) throw new ProposalNotCallersToday(asOf, companyDay);
    const evidence = checkAcceptance(statement, {
      today: asOf ?? companyDay,
      sentOn: proposal.sentAt === null ? null : dayInZone(proposal.sentAt, zone),
      needsEvidence: false,
    });
    const id = this.deps.ids.newId();
    const accepted = await this.deps.proposals.recordAcceptance(proposalId, now, {
      ...evidence,
      id,
      tenantId,
      recordedByUserId,
    });
    if (accepted === null) {
      // The client answered on the link, or a colleague did, a moment ago.
      const fresh = await this.findOrThrow(tenantId, proposalId);
      throw new InvalidTransition(fresh.status, "accepted");
    }
    await this.deps.events.recordEvent({
      tenantId,
      verb: "proposal.accepted",
      objectId: proposal.id,
      actor,
      // HOW, never who at the client or what they said: the name and the note
      // are personal data and live in the erasable row.
      payload: {
        partyId: proposal.partyId,
        decision: "accepted" satisfies ProposalDecision,
        declinedReasonRecorded: false,
        via: "recorded",
        channel: evidence.channel,
        recordedAcceptanceId: id,
        evidenceFiled: evidence.evidenceDocumentId !== null,
      },
    });
    return accepted;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * An email request, checked before anything moves: an address that is not
   * one, or a process with no mailer, must refuse the SEND — not produce a sent
   * proposal whose email never had a chance.
   */
  private checkEmail(email: EmailRequest): { readonly to: string; readonly note: string | null } {
    if (this.deps.mailer === null) throw new EmailUnavailable();
    const to = email.to.trim();
    if (!isEmailAddress(to)) throw new InvalidRecipient(email.to);
    return { to, note: blankToNull(email.note) };
  }

  /**
   * Mint a link and make it THE link — returned exactly once. Only its digest
   * is stored, so this is the only time anybody can read it: the same contract
   * as a magic link, for the same reason — a leaked backup then contains
   * nothing anyone can open. The tenant travels inside the token so opening it
   * is still a tenant-scoped read (see `composeShareToken`).
   */
  private async issueLink(tenantId: string, proposalId: string): Promise<string> {
    const shareToken = composeShareToken(tenantId, this.deps.shareTokens.newToken());
    await this.deps.proposals.attachShareToken(
      tenantId,
      proposalId,
      this.deps.shareTokens.hash(shareToken),
    );
    return shareToken;
  }

  /**
   * Write the email and hand it over. Everything that can fail here — the
   * render, reading the bytes, the mail server — comes back as `failed` with
   * the reason, because the proposal has already been sent and the caller
   * holds the only copy of its link. The mail adapter has already logged a
   * refusal loudly; this is the half the person at the screen reads.
   */
  private async deliver(
    proposal: Proposal,
    shareToken: string,
    request: { readonly to: string; readonly note: string | null },
    actor: Actor,
  ): Promise<EmailOutcome> {
    const mailer = this.deps.mailer;
    if (mailer === null) throw new EmailUnavailable();

    let pdf: FiledPdf;
    try {
      pdf = await this.pdfOfRecord(proposal, actor);
      const record = await this.recordOrThrow(proposal.tenantId, proposal.id);
      const viewUrl = this.deps.links.shareUrl(shareToken);
      await mailer.sendProposal({
        to: request.to,
        replyTo: record.preparedBy?.email ?? null,
        sender: (await this.deps.senders?.senderForProposal(proposal.tenantId, proposal.id)) ?? null,
        firmName: record.firmName,
        preparedBy: record.preparedBy?.displayName ?? null,
        greetingName: record.addressee?.displayName ?? null,
        clientName: record.party.displayName,
        ref: proposal.ref,
        title: proposal.title,
        validUntil: proposal.validUntil,
        note: request.note,
        viewUrl,
        // Each opens the page with that answer ready and nothing given: the
        // answer is a separate POST with a name, which a scanner cannot make.
        acceptUrl: `${viewUrl}?answer=accept`,
        declineUrl: `${viewUrl}?answer=decline`,
        pdf: { filename: pdf.filename, bytes: await this.deps.pdfs.bytes(proposal.tenantId, pdf) },
      });
    } catch (err) {
      return {
        status: "failed",
        to: request.to,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const sentAt = this.deps.clock.now().toISOString();
    const sent = await this.deps.proposals.recordEmail({
      id: this.deps.ids.newId(),
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      toEmail: request.to,
      note: request.note,
      pdfVersionId: pdf.versionId,
      linkDigest: this.deps.shareTokens.hash(shareToken),
      sentBy: actor.type === "human" ? actor.id : null,
      sentAt,
    });
    await this.deps.events.recordEvent({
      tenantId: proposal.tenantId,
      verb: "proposal.emailed",
      objectId: proposal.id,
      actor,
      // The email's id and the PDF's fingerprint — never the address, which is
      // personal and lives in the erasable row (0085).
      payload: {
        partyId: proposal.partyId,
        emailId: sent.id,
        pdfContentHash: pdf.contentHash,
        noteWritten: request.note !== null,
      },
    });
    return { status: "sent", to: request.to, emailId: sent.id, sentAt };
  }

  /**
   * THE PDF OF RECORD — the pinned one, or a render filed and pinned now.
   *
   * Pinned once and never re-rendered after, because a render reads the
   * firm's brand assets as they stand today and "the proposal they accepted"
   * must not change when somebody uploads a new logo. Two callers racing to
   * pin both render; the repository keeps the first, and the second is handed
   * that one, so everybody downstream cites the same file.
   */
  private async pdfOfRecord(proposal: Proposal, actor: Actor): Promise<FiledPdf> {
    const { tenantId } = proposal;
    const current = await this.findOrThrow(tenantId, proposal.id);
    if (current.sentPdfVersionId !== null) {
      const pinned = await this.deps.proposals.findPdf(tenantId, current.sentPdfVersionId);
      if (pinned !== null) return pinned;
    }
    const filed = await this.deps.pdfs.file(tenantId, proposal.id, actor);
    const pinnedId = await this.deps.proposals.pinSentPdf(tenantId, proposal.id, filed.versionId);
    if (pinnedId === filed.versionId) return filed;
    return (await this.deps.proposals.findPdf(tenantId, pinnedId)) ?? filed;
  }

  /** A share token, resolved the way `viewShared` resolves one: malformed,
   *  unknown and withdrawn are one answer. */
  /**
   * The issuing COMPANY's calendar day (0337; the firm's before it, B24). A
   * proposal's `validUntil` is a date the company wrote, so it lapses when
   * that day ends where the company is: on the UTC day an Indian firm's quote
   * stayed acceptable until 05:30 the next morning, and on India's day a New
   * York company's lapsed on the evening of its last day.
   */
  private async companyToday(tenantId: string, entityPartyId: string | null): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.companyZone(tenantId, entityPartyId));
  }

  /** The zone a company's proposal is dated in (0337): its own, else the firm's. */
  private async companyZone(tenantId: string, entityPartyId: string | null): Promise<string> {
    const [firmZone, calendars] = await Promise.all([
      this.deps.timeZones.timeZoneFor(tenantId),
      this.deps.timeZones.companyCalendars(tenantId),
    ]);
    return zoneOfCompany(calendars, entityPartyId, firmZone);
  }

  private async openLink(
    token: string,
  ): Promise<{ readonly tenantId: string; readonly digest: string; readonly proposal: Proposal }> {
    const parsed = parseShareToken(token);
    if (parsed === null) throw new ShareLinkUnknown();
    const digest = this.deps.shareTokens.hash(token);
    const proposalId = await this.deps.proposals.findIdByShareDigest(parsed.tenantId, digest);
    if (proposalId === null) throw new ShareLinkUnknown();
    const proposal = await this.deps.proposals.findById(parsed.tenantId, proposalId);
    if (proposal === null) throw new ShareLinkUnknown();
    return { tenantId: parsed.tenantId, digest, proposal };
  }

  private async recordOrThrow(tenantId: string, proposalId: string): Promise<ProposalRecord> {
    const record = await this.deps.proposals.describe(tenantId, proposalId);
    if (record === null) throw new ProposalNotFound(proposalId);
    return record;
  }

  /** The recipient's view with the document's own prose and the acceptance
   *  statement — the two things the proposal table does not own. */
  private async withProse(
    tenantId: string,
    shared: SharedProposalRecord,
  ): Promise<SharedProposal> {
    // The document's own prose, from the module that owns it — the same seam
    // `describe` uses. Only the words travel: a recipient is not told which
    // lines are house wording and which were written for them.
    const blocks = await this.deps.documents.listBlocks(tenantId, {
      kind: "proposal",
      id: shared.id,
    });
    return {
      ...shared,
      blocks: blocks.map((b) => ({
        kind: b.kind,
        body: b.body,
        isHeading: b.isHeading,
        sortOrder: b.sortOrder,
      })),
      acceptanceStatement: acceptanceStatement(shared.ref, shared.addressedTo),
    };
  }

  /**
   * Tell the colleague who prepared it that the client answered (0085).
   *
   * After the answer is recorded and never able to undo it: the client's
   * answer stands whatever happens to a notice about it. A refusal is not
   * swallowed silently — the mail adapter logs every letter the relay would
   * not take — it is only kept from failing the client's request.
   */
  private async tellPreparer(
    record: ProposalRecord,
    decided: Proposal,
    signerName: string,
    declinedReason: string | null,
  ): Promise<void> {
    const mailer = this.deps.mailer;
    const to = record.preparedBy?.email;
    if (mailer === null || to === undefined) return;
    if (decided.status !== "accepted" && decided.status !== "rejected") return;
    await mailer
      .sendDecisionNotice({
        to,
        clientName: record.party.displayName,
        ref: decided.ref,
        title: decided.title,
        decision: decided.status,
        signerName,
        decidedAt: decided.decidedAt ?? this.deps.clock.now().toISOString(),
        declinedReason,
        proposalUrl: this.deps.links.staffUrl(decided.id),
        timeZone: await this.deps.timeZones.timeZoneFor(decided.tenantId),
        firmName: record.firmName,
      })
      .catch(() => undefined);
  }

  private async findOrThrow(tenantId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.deps.proposals.findById(tenantId, proposalId);
    if (proposal === null) throw new ProposalNotFound(proposalId);
    return proposal;
  }

  /** Everything that CHANGES a proposal's content requires it to still be a
   *  draft. One place, so a method added later cannot forget it. */
  private async draftOrThrow(tenantId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.findOrThrow(tenantId, proposalId);
    // Deleted first: a deleted proposal is always a draft (0086), and "only a
    // draft can be changed" would be the wrong sentence to meet.
    if (proposal.deletedAt !== null) throw new ProposalDeleted(proposal.ref);
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
/**
 * The document's structure, from the SAME `planProposal` the PDF's render
 * source calls, over the same inputs: the PINNED version's code and Dept, the
 * line's company by name, and the firm's Depts retired ones included. The
 * money is the view's; the plan carries it but nothing reads it off the plan.
 */
function planOf(record: ProposalRecord): ProposalPlan {
  return planProposal({
    depts: record.depts,
    lines: record.lines.map((l) => ({
      id: l.line.id,
      position: l.line.position,
      ref: l.service?.ref ?? null,
      deptCode: l.service?.module ?? null,
      description: l.line.description,
      subject: l.entity?.displayName ?? null,
      terms: l.terms,
      billingFrequency: l.line.billingFrequency,
      net: l.net,
      currency: l.line.currency,
      pricingNote: l.line.pricingNote,
      oopEstimate: l.line.oopEstimate,
    })),
  });
}

/** A quantity is a positive decimal string. */
function checkQuantity(quantity: string): void {
  if (!isAmount(quantity) || Number(quantity) <= 0) throw new InvalidQuantity(quantity);
}

/**
 * THE UNPRICED LINE's two rules, and the discount's range — on a line being
 * added and on one being edited, judged on the line as it will be. Absent is a
 * real answer ("as mutually agreed"), and the rules are here rather than only in
 * the CHECKs (0023) so a caller is told what to send instead of reading a
 * constraint name out of a 500.
 */
function checkPricing(
  unitAmount: string | null,
  pricingNote: string | null,
  discountPercent: string,
): void {
  if (unitAmount !== null && !isAmount(unitAmount)) throw new InvalidUnitAmount(unitAmount);
  if (unitAmount === null && pricingNote === null) throw new UnpricedLineNeedsReason();
  if (!isAmount(discountPercent) || Number(discountPercent) > 100) {
    throw new InvalidDiscount(discountPercent);
  }
  // A percentage off "as mutually agreed" is not a number — and it would
  // reach `largestDiscount` and hold the whole proposal at the approval gate.
  if (unitAmount === null && Number(discountPercent) !== 0) {
    throw new UnpricedLineHasDiscount(discountPercent);
  }
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
