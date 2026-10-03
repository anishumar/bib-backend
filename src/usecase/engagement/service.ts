// The engagement use case — what turns an agreed price into work the firm owes.
//
// Three moments matter and each is guarded here rather than in a handler:
//
//   DRAFTING pins clauses from the library and lines from the catalogue, and
//   refuses a clause drafted for another jurisdiction — a term that may be
//   unenforceable where the letter is written is worse than a missing one.
//
//   SIGNING freezes the document and fans it out into one engagement per line,
//   in ONE transaction. The two must not be separately observable: a signature
//   with no engagements is a client committed to work nobody scheduled, and
//   engagements with no signature is work nobody agreed to.
//
//   ACTIVATION is the signature (0322). Until then the advance gated it: an
//   engagement started `pending_advance` whenever the letter required one, and
//   `contract.activated` — the event the scheduler consumes from T2.4 — waited
//   for the advance. Ashish (2026-10-02): "work can be started and parallelly
//   the system should keep on notifying", because the advance "generally comes
//   within 5 to 15 days of starting of work". So every engagement starts active
//   and the advance is drafted and chased by the billing use case instead.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  Engagement,
  EngagementLetter,
  FeeGroup,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import { isLetterBillingTiming, TIMED_FREQUENCIES, type LetterBillingTiming } from "../../domain/engagement/model";
import {
  CURRENT_LETTER_LAYOUT,
  canTransition,
  canonicalContent,
  clauseApplies,
  engagementState,
  isDay,
  isEditable,
  isJurisdiction,
  isLetterCopyable,
  letterDeletionBlock,
  normalizeJurisdiction,
  resolveEffectiveFrom,
} from "../../domain/engagement/model";
import type { ClauseBody } from "../../domain/config/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { compareAmounts, isAmount, isExchangeRate, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import type { Amount } from "../../domain/money/model";
import {
  isBillingFrequency,
  outOfPocketProblem,
  BILLING_FREQUENCIES,
} from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
import {
  InvalidLetterBillingTiming,
  AdvanceAmountRequired,
  AlreadySuperseded,
  ClauseLawNotIssuers,
  ClauseNotFound,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidAmount,
  InvalidLineAdvance,
  OneKindOfAdvance,
  InvalidDate,
  InvalidJurisdiction,
  QuoteHasNoLines,
  QuoteJurisdictionUnclear,
  QuoteNamesNoEntity,
  QuoteNotAccepted,
  QuoteNotFound,
  IssuerJurisdictionUnknown,
  InvalidLetterTransition,
  InvalidLineBillingFrequency,
  InvalidOutOfPocketEstimate,
  LetterLineNotFound,
  LetterNotEditable,
  LetterNotFound,
  LetterNotSupersedable,
  LetterPartyArchived,
  LetterClientIsOwnCompany,
  NoClauses,
  NotAClause,
  ServiceNotQuotable,
  SignatureIncomplete,
  SignatureRequestNotPending,
  EnvelopeAlreadySigned,
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
  ServiceHasNoListPrice,
  AddresseeNotAPerson,
  AddresseeNotLinked,
  EntityOutsideClient,
  IssuerNotAFirmEntity,
  QuoteOfAnotherClient,
  FeeGroupEmpty,
  FeeGroupNotEmpty,
  FeeGroupNotFound,
  FeeGroupTitleRequired,
  GroupedLinePriced,
  LineNotPriced,
  LetterDeleted,
  LetterNotCopyable,
  NothingToRevise,
  NothingToChangeOnLetterLine,
  InvalidLetterLineDescription,
  LetterInvalidCurrencyChange,
  LetterCurrencyLocked,
  LetterProseEdited,
  TermsOnLetter,
  QuoteDeleted,
  LetterNotCallersToday,
  letterDeletionRefusal,
  EngagementError,
} from "../../domain/engagement/errors";
import { InvalidQuoteCurrency } from "../../domain/proposal/errors";
import type { ClientStructure } from "../../domain/party/model";
import { dayInZone, isCallersToday } from "../../domain/scheduler/zone";
import { checkAcceptance } from "../../domain/acceptance/model";
import type { AcceptanceStatement, NewRecordedAcceptance } from "../../domain/acceptance/model";
import { EvidenceNotFiledHere } from "../../domain/acceptance/errors";
import { planAnnexure } from "../../domain/engagement/annexure";
import type {
  ClauseLibrary,
  ContentHasher,
  DocumentIdentity,
  ESignProvider,
  AcceptedQuoteDirectory,
  BillableEngagement,
  ClientStructureDirectory,
  FirmTimeZone,
  GoLiveBilling,
  AdvanceBilling,
  EngagementRecord,
  EngagementRepository,
  FeeGroupEdit,
  FirmSignatory,
  FirmSignatureImage,
  FirmSignatureRecord,
  LetterFilters,
  LetterProseLine,
  LetterRevision,
  LetterSummary,
  LetterPdf,
  LetterView,
  NewEngagement,
  PartyStanding,
  SignatureDispatch,
  SignatureOutcome,
  SignatureRequest,
  SignatureRequestRepository,
  SignatureSigner,
  SignatureTenants,
  SignedCopyFiler,
} from "./ports";

export interface Deps {
  readonly letters: EngagementRepository;
  /** The configuration registry, behind this use case's own narrow interface. */
  readonly library: ClauseLibrary;
  /** The firm's document reference series, and its rule for which of its own
   *  entities is contracting. The same seam proposals use, so the two documents
   *  cannot disagree about who serves a UAE client. */
  readonly documents: DocumentIdentity;
  /** Who signs the firm's letters. One signatory for the whole firm, held as a
   *  row on the tenant so a successor is an UPDATE — tenancy satisfies this at
   *  the composition root. */
  readonly firm: FirmSignatory;
  /** The signature IMAGE for the issuing entity, pinned at send (0081). Its own
   *  port because the mark is per ENTITY while the signatory is per firm, and
   *  because the document store owns brand assets. */
  readonly firmSignatureImage: FirmSignatureImage;
  /** Whether a client or an entity has been archived (0305). */
  readonly parties: PartyStanding;
  readonly esign: ESignProvider;
  /**
   * The signer for a letter the client signed BEFORE this product existed —
   * the book import's migrated letters (T6.12). Always the attested signer,
   * whatever `esign` is: a paper letter in a Drive folder has no DocuSign
   * envelope and never will, and the person confirming the import is
   * attesting exactly what the attested signer records. It is reached only
   * through `SignInput.migrated`, which only the import sets.
   */
  readonly migrationSigner: ESignProvider;
  /** The accepted quote a letter is written up from (T3.5b). Satisfied
   *  structurally by `ProposalService`, so neither use case imports the other. */
  readonly quotes: AcceptedQuoteDirectory;
  /** The client's structure: which companies a letter's lines may be for, and
   *  whom it may be addressed to (F-10-1). */
  readonly structure: ClientStructureDirectory;
  /** The firm's zone, for the day that structure is read on. */
  readonly timeZones: FirmTimeZone;
  readonly hasher: ContentHasher;
  /** Whom a provider was asked to have sign, and which envelope (0080). */
  readonly signatures: SignatureRequestRepository;
  /**
   * The provider, asked to SEND. Null when it sends nothing — the attested
   * signer records a signature a person obtained elsewhere, so there is no
   * envelope to raise and nothing for the sweep to watch.
   */
  readonly dispatch: SignatureDispatch | null;
  /** The letter's PDF for the envelope. Null in the worker, which settles
   *  envelopes and never raises one. */
  readonly letterPdf: LetterPdf | null;
  /** Where the provider's signed PDF and certificate are filed once an
   *  envelope completes. Null where no document store is composed. */
  readonly signedCopies: SignedCopyFiler | null;
  readonly tenants: SignatureTenants;
  /** The billing desk, to set the schedules the letter's terms give when the
   *  work goes live (0319). Optional: a composition without billing (and most
   *  tests) sets none, and the engagements wait on "Billing not set up". */
  readonly goLiveBilling?: GoLiveBilling | null;
  /** The billing desk, to write the advance bill a signed letter owes (0320).
   *  Optional for the same reason: a composition without billing writes none,
   *  and the daily sweep writes it later. */
  readonly advanceBilling?: AdvanceBilling | null;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** How long a claim to raise an envelope is honoured before another caller may
 *  take it. Longer than one render plus two provider calls on a bad day; short
 *  enough that a crashed attempt is retried on the next try, not tomorrow. */
const RAISE_LEASE_MS = 2 * 60_000;

/** A plausible address, and nothing cleverer: the provider is the authority on
 *  whether it delivers, and this exists to catch a name typed into the email
 *  box. The database CHECK (0080) says the same thing. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SendOptions {
  /**
   * Whom the provider should ask to sign. Required when the provider SENDS
   * (DocuSign); ignored when it does not (attested), because nobody is asked.
   */
  readonly signer?: SignatureSigner | undefined;
  /**
   * A letter signed before the firm used this product, marked sent on its way
   * to a migrated signature (T6.12). Never raises an envelope: the client
   * signed on paper years ago, and emailing them the contract again would be
   * the product inventing a second signing. Set by the book import only.
   */
  readonly migrated?: boolean | undefined;
  /** The caller's today, which dates an undated letter; the firm's day when
   *  absent. Held to the firm's day or one either side (`isCallersToday`). */
  readonly asOf?: string | undefined;
}

/** What one pass of the signature sweep did at one firm. */
export interface SignatureSweepReport {
  readonly tenantId: string;
  readonly signed: number;
  readonly withdrawn: number;
  readonly stillOut: number;
  /** Signed letters whose provider copies were filed in bib's store this pass. */
  readonly copiesFiled: number;
  /** Requests the sweep could not settle this pass, with the reason — a
   *  provider fault, or a completed envelope the verifier refused. */
  readonly failed: readonly { readonly letterId: string; readonly reason: string }[];
  /** Set when the whole firm could not be visited. */
  readonly failure?: string | undefined;
}

export interface DraftLetterInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly proposalId?: string | undefined;
  /**
   * Which of the firm's own entities is contracting — the "flexibility to
   * choose" half of the firm's rule.
   *
   * OPTIONAL, and absent is the ordinary case: the letter's own jurisdiction is
   * where the client is, so the firm's preference rows answer it. Naming one
   * here overrides that for this letter only.
   */
  readonly issuingEntityPartyId?: string | undefined;
  readonly jurisdiction: string;
  readonly title: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly advanceRequired: boolean;
  readonly advanceAmount?: string | undefined;
  /** The opening paragraph — why this client is buying this. Optional, and the
   *  only chance to write it: a letter is editable while it is a draft and
   *  there is deliberately no route that rewrites a sent one. */
  readonly background?: string | undefined;
  /** The named individual the letter is written to, care-of the client. */
  readonly addressedToPartyId?: string | undefined;
  /** The date printed under the letterhead. Defaults to the day it is SENT —
   *  see `send` — because a document nobody dated is dated when it went out. */
  readonly issuedOn?: string | undefined;
  /** The SIGNED letter this one replaces. */
  readonly supersedesId?: string | undefined;
  /** When the engagements this letter opens begin. Null/absent means the
   *  signature date. */
  readonly effectiveFrom?: string | undefined;
}

export interface AddLetterLineInput {
  readonly tenantId: string;
  readonly letterId: string;
  /** WHOSE entity. Required on a letter line, unlike a proposal's, because
   *  signing turns this line into an engagement. */
  readonly entityPartyId: string;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly quantity: string;
  /** OPTIONAL since G1.6. Absent means "as mutually agreed", and then
   *  `pricingNote` is required. Absent is NOT "0" — zero is a price the firm
   *  committed to, and it is what the old schema forced. */
  readonly unitAmount?: string | undefined;
  readonly discountPercent: string;
  /** When THIS line starts, when that is not the letter's date. */
  readonly effectiveFrom?: string | undefined;
  /** Where the WORK is — on a letter, the entity's own jurisdiction, carried so
   *  a letter and its proposal print and group the same way. */
  readonly jurisdiction?: string | undefined;
  /** How often this DEAL is billed. Absent falls back to the PINNED service's
   *  `recurrence`. */
  readonly billingFrequency?: string | undefined;
  /** When it is invoiced (0319): "arrears" | "advance" | "on_date" (with
   *  `billingOn`). Only for a monthly, quarterly or yearly fee. */
  readonly billingTiming?: string | undefined;
  readonly billingOn?: string | undefined;
  /** This service's own advance, before tax (0320). Not on a grouped line, and
   *  not on a letter that asks for one advance for the whole of it. */
  readonly advanceAmount?: string | undefined;
  /** This letter's own wording for any of the four scope blocks. Absent prints
   *  the pinned catalogue version's words. */
  readonly scopeOverride?: string | undefined;
  readonly clientObligationsOverride?: string | undefined;
  readonly volumeLimitsOverride?: string | undefined;
  readonly exclusionsOverride?: string | undefined;
  readonly oopEstimate?:
    | { readonly min: string; readonly max: string; readonly currency: string }
    | undefined;
  /** WHY there is no amount, and REQUIRED when there is none — unless the line
   *  is in a fee group, whose fee is the reason. */
  readonly pricingNote?: string | undefined;
  /**
   * The FEE GROUP that prices this line (0083). The line then has no price of
   * its own: `unitAmount` must be absent and the discount "0", because the
   * group's fee already pays for it.
   */
  readonly feeGroupId?: string | undefined;
}

/** A fee group's terms as a caller states them (0083). Prose is optional and
 *  a blank clears it. */
export interface FeeGroupInput {
  readonly title: string;
  readonly billingFrequency: string;
  readonly billingTiming?: string | undefined;
  readonly billingOn?: string | undefined;
  readonly amount: string;
  readonly paymentTerms?: string | undefined;
  readonly feeDescription?: string | undefined;
  readonly intro?: string | undefined;
  readonly deliverables?: string | undefined;
  readonly clientObligations?: string | undefined;
}

/** A partial edit of one. Absent leaves a field as it is; for the prose, a
 *  blank string clears it. */
export interface FeeGroupChange {
  readonly title?: string | undefined;
  readonly billingFrequency?: string | undefined;
  /** Null clears it (back to after each period). */
  readonly billingTiming?: string | null | undefined;
  readonly billingOn?: string | null | undefined;
  readonly amount?: string | undefined;
  readonly paymentTerms?: string | undefined;
  readonly feeDescription?: string | undefined;
  readonly intro?: string | undefined;
  readonly deliverables?: string | undefined;
  readonly clientObligations?: string | undefined;
}

/**
 * How one line is priced: by a fee group, or on its own (0083).
 *
 * Into a group, the line gives up any price it had. On its own, it needs a
 * price or a reason, exactly as when it was first added.
 */
export interface LinePricingInput {
  readonly tenantId: string;
  readonly letterId: string;
  readonly lineId: string;
  /** The group to put it in, or null to price it on its own. */
  readonly feeGroupId: string | null;
  readonly unitAmount?: string | undefined;
  readonly discountPercent?: string | undefined;
  readonly pricingNote?: string | undefined;
}

export interface DraftFromQuoteInput {
  readonly tenantId: string;
  readonly proposalId: string;
  /**
   * The country this letter is under.
   *
   * Optional, and absent is the ordinary case: when every line of the quote
   * names the same country, that is the answer and nobody should have to retype
   * it. When they disagree — or none says — this is REQUIRED, because a letter
   * states ONE and it settles governing law, the courts and which of the firm's
   * own companies contracts. Derived-when-obvious, asked-for otherwise; never
   * guessed.
   */
  readonly jurisdiction?: string | undefined;
  /** Defaults to the quote's own title. */
  readonly title?: string | undefined;
  /** The firm's decision and NOT the quote's — a proposal has no advance. */
  readonly advanceRequired: boolean;
  readonly advanceAmount?: string | undefined;
  /**
   * The company to file a quote line against when the LINE names none.
   *
   * Explicit, never inferred. A proposal may quote a prospect that holds no
   * entity yet, and a letter line must name one because signing it creates an
   * engagement — one service for one legal entity. Absent, those lines are
   * SKIPPED and reported rather than filed against a company somebody would
   * have to notice was wrong on a signed page.
   */
  readonly defaultEntityPartyId?: string | undefined;
  readonly background?: string | undefined;
  readonly addressedToPartyId?: string | undefined;
  readonly issuedOn?: string | undefined;
  readonly effectiveFrom?: string | undefined;
  readonly issuingEntityPartyId?: string | undefined;
}

/** A quote line that did NOT become a letter line, and why. */
export interface SkippedQuoteLine {
  readonly proposalLineId: string;
  readonly description: string;
  readonly reason: string;
}

/**
 * What came of writing a quote up as a letter.
 *
 * `skipped` is not an error list and must not be rendered as one — it is the
 * same shape the dashboard's MRR exclusions have, and for the same reason: a
 * carry-forward that silently dropped three of eight lines would be worse than
 * one that never ran, because the letter LOOKS complete. Every screen showing
 * this shows both halves.
 */
/** Something of the source letter that did not come across to the copy, and why. */
export interface SkippedCopyItem {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
}

/** What copying a withdrawn letter made (0316). */
export interface LetterCopy {
  readonly letter: EngagementLetter;
  readonly source: { readonly id: string; readonly ref: string };
  readonly linesCopied: number;
  readonly feeGroupsCopied: number;
  readonly clausesCopied: number;
  readonly skippedLines: readonly SkippedCopyItem[];
  /** Terms that could not come across: retired from the library, or no longer
   *  fitting the letter's country or its issuer's law. Each is added again by
   *  hand, or left off. */
  readonly skippedClauses: readonly SkippedCopyItem[];
  /** The addressee was left off: no longer a person in the client's structure. */
  readonly addresseeDropped: boolean;
}

export interface LetterFromQuote {
  readonly letter: EngagementLetter;
  readonly lines: readonly LetterLine[];
  readonly skipped: readonly SkippedQuoteLine[];
}

/**
 * A revision of a DRAFT letter's head (T6.18 S6) — what the letter builder's
 * step 1 and the document's in-place edits send. Absent leaves a field as it
 * is; null clears a nullable one.
 */
export interface ReviseLetterInput {
  readonly tenantId: string;
  readonly letterId: string;
  readonly title?: string | undefined;
  readonly background?: string | null | undefined;
  readonly addressedToPartyId?: string | null | undefined;
  readonly issuedOn?: string | null | undefined;
  readonly effectiveFrom?: string | null | undefined;
  readonly advanceRequired?: boolean | undefined;
  readonly advanceAmount?: string | null | undefined;
  /** The letter's country, which decides its terms and its wording. */
  readonly jurisdiction?: string | undefined;
  readonly issuingEntityPartyId?: string | undefined;
  /** Replace wording edited or written for this client when the issuer or the
   *  country changes (D9). Without it such a change is refused, naming how
   *  many lines would go. */
  readonly replaceEditedProse?: boolean | undefined;
  /** All three or none. */
  readonly currency?: string | undefined;
  readonly fxRate?: string | undefined;
  readonly fxRateDate?: string | undefined;
}

/**
 * A change to one line of a DRAFT letter (T6.18 S6). The same names as adding
 * one. Absent leaves a field as it is; null means "back to the default" — no
 * fixed fee (then a pricing note is needed), the service's own recurrence, the
 * letter's start date, the catalogue's words for a scope text.
 */
export interface UpdateLetterLineInput {
  readonly tenantId: string;
  readonly letterId: string;
  readonly lineId: string;
  readonly description?: string | undefined;
  readonly entityPartyId?: string | undefined;
  readonly quantity?: string | undefined;
  readonly unitAmount?: string | null | undefined;
  readonly discountPercent?: string | undefined;
  readonly billingFrequency?: string | null | undefined;
  readonly billingTiming?: string | null | undefined;
  readonly billingOn?: string | null | undefined;
  /** This service's own advance, before tax (0320); null clears it. */
  readonly advanceAmount?: string | null | undefined;
  readonly pricingNote?: string | null | undefined;
  readonly effectiveFrom?: string | null | undefined;
  readonly jurisdiction?: string | null | undefined;
  readonly scopeOverride?: string | null | undefined;
  readonly clientObligationsOverride?: string | null | undefined;
  readonly volumeLimitsOverride?: string | null | undefined;
  readonly exclusionsOverride?: string | null | undefined;
  readonly oopEstimate?:
    | { readonly min: string; readonly max: string; readonly currency: string }
    | null
    | undefined;
}

/** Every field a line change may name — "did it name anything" is asked of
 *  exactly these. */
const LETTER_LINE_FIELDS = [
  "description",
  "entityPartyId",
  "quantity",
  "unitAmount",
  "discountPercent",
  "billingFrequency",
  "billingTiming",
  "billingOn",
  "advanceAmount",
  "pricingNote",
  "effectiveFrom",
  "jurisdiction",
  "scopeOverride",
  "clientObligationsOverride",
  "volumeLimitsOverride",
  "exclusionsOverride",
  "oopEstimate",
] as const satisfies readonly (keyof UpdateLetterLineInput)[];

export interface SignInput {
  readonly tenantId: string;
  readonly letterId: string;
  /** Who signed, as attested by whoever is recording it. */
  readonly signedByName: string;
  /** The capacity they signed in — "Director". Optional: it is not always known
   *  when a wet signature is attested afterwards, and a letter recorded without
   *  it is still verifiable. */
  readonly signedByTitle?: string | undefined;
  /** The provider's own reference, or the firm's for a paper copy. */
  readonly reference?: string | undefined;
  /**
   * True for a letter signed before the firm used this product, recorded now
   * from the firm's own records. Routes the signature through
   * `migrationSigner` (attested) rather than the configured provider, which
   * would otherwise demand an envelope that never existed. Set by the book
   * import only; the HTTP route does not expose it.
   */
  readonly migrated?: boolean | undefined;
  /** The caller's today: the day work starts when neither the line nor the
   *  letter names one. The firm's day when absent, which is what the
   *  signature sweep and the import get. */
  readonly asOf?: string | undefined;
  /**
   * The client accepted OUTSIDE bib and a colleague recorded it (0317). Signs
   * through the attested signer under the method `recorded_acceptance`, and
   * writes this evidence in the fan-out's own transaction. Set only by
   * `recordAcceptance`; the HTTP signature route does not expose it.
   */
  readonly recorded?: NewRecordedAcceptance | undefined;
}

/** The signature method a letter accepted outside bib is recorded under
 *  (0317): neither a provider's signature nor a wet one attested by hand. */
export const RECORDED_ACCEPTANCE_METHOD = "recorded_acceptance";

export interface RecordAcceptanceInput {
  readonly tenantId: string;
  readonly letterId: string;
  readonly statement: AcceptanceStatement;
  /** The caller's today, held to the firm's day ± 1 like every other. */
  readonly asOf?: string | undefined;
}

export class EngagementService {
  constructor(private readonly deps: Deps) {}

  async draft(input: DraftLetterInput, actor: Actor): Promise<EngagementLetter> {
    return (await this.draftLetter(input, actor, null)).letter;
  }

  /**
   * COPY a withdrawn letter into a new draft (0316, decided 2026-09-30).
   *
   * A letter the firm pulled, or the client declined in DocuSign, usually comes
   * back changed rather than not at all. The source must be WITHDRAWN and it
   * does not change: it stays on record as what was offered and pulled.
   *
   * WHAT IS COPIED, exactly as it was: the client, the issuing company, the
   * country, the quote it cites, the currency and its rate, the title, the
   * Background, the addressee, the advance, every fee section (0083) with its
   * fee, terms and prose, every live line with its price, discount, section,
   * wording and scope overrides, and the prose including the cover letter and
   * the acceptance. The TERMS come across at the clause library's CURRENT
   * wording (a new letter is a new contract, on the firm's terms as they stand
   * today), each through `addClause`, so one that no longer fits the country or
   * the issuer's law is skipped and reported, as is one retired from the
   * library. NOT copied: the status, the dates it was issued, sent and
   * withdrawn, the signature request and the firm's signature. A start date
   * already past is left off; the letter then starts when it is signed.
   *
   * Lines and fee sections go through `addLine` and `addFeeGroup`, the doors a
   * hand-built draft uses. A line that can no longer be added is skipped and
   * reported rather than failing the copy.
   */
  async copyAsDraft(tenantId: string, letterId: string, actor: Actor): Promise<LetterCopy> {
    const source = await this.deps.letters.findLetter(tenantId, letterId);
    if (source === null) throw new LetterNotFound(letterId);
    if (source.deletedAt !== null) throw new LetterDeleted(source.ref);
    if (!isLetterCopyable(source.status)) throw new LetterNotCopyable(source.ref, source.status);

    const [lines, groups, clauses] = await Promise.all([
      this.deps.letters.listLines(tenantId, source.id),
      this.deps.letters.listFeeGroups(tenantId, source.id),
      this.deps.letters.listClauses(tenantId, source.id),
    ]);
    const today = await this.firmDay(tenantId);
    const ahead = (day: string | null): string | undefined =>
      day !== null && day >= today ? day : undefined;

    let addressedToPartyId = source.addressedToPartyId ?? undefined;
    let addresseeDropped = false;
    if (addressedToPartyId !== undefined) {
      try {
        await this.requireContact(tenantId, source.partyId, addressedToPartyId);
      } catch (err) {
        if (!(err instanceof EngagementError)) throw err;
        addressedToPartyId = undefined;
        addresseeDropped = true;
      }
    }

    const effectiveFrom = ahead(source.effectiveFrom);
    const { letter } = await this.draftLetter(
      {
        tenantId,
        partyId: source.partyId,
        ...(source.proposalId === null ? {} : { proposalId: source.proposalId }),
        issuingEntityPartyId: source.issuingEntityPartyId,
        jurisdiction: source.jurisdiction,
        title: source.title,
        currency: source.currency,
        fxRate: source.fxRate,
        fxRateDate: source.fxRateDate,
        advanceRequired: source.advanceRequired,
        ...(source.advanceAmount === null ? {} : { advanceAmount: source.advanceAmount }),
        ...(source.background === null ? {} : { background: source.background }),
        ...(addressedToPartyId === undefined ? {} : { addressedToPartyId }),
        ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
      },
      actor,
      null,
      source,
    );

    // The fee sections first, in their order, so each line can name its new one.
    const groupIds = new Map<string, string>();
    for (const g of groups) {
      const made = await this.addFeeGroup(tenantId, letter.id, {
        title: g.title,
        billingFrequency: g.billingFrequency,
        ...(g.billingTiming === null ? {} : { billingTiming: g.billingTiming }),
        ...(g.billingOn === null ? {} : { billingOn: g.billingOn }),
        amount: g.amount,
        ...(g.paymentTerms === null ? {} : { paymentTerms: g.paymentTerms }),
        ...(g.feeDescription === null ? {} : { feeDescription: g.feeDescription }),
        ...(g.intro === null ? {} : { intro: g.intro }),
        ...(g.deliverables === null ? {} : { deliverables: g.deliverables }),
        ...(g.clientObligations === null ? {} : { clientObligations: g.clientObligations }),
      });
      groupIds.set(g.id, made.id);
    }

    let linesCopied = 0;
    const skippedLines: SkippedCopyItem[] = [];
    // IN ORDER, one at a time: `addLine` takes each line's position from what
    // is already on the letter.
    for (const line of lines) {
      const feeGroupId = line.feeGroupId === null ? undefined : groupIds.get(line.feeGroupId);
      const lineStart = ahead(line.effectiveFrom);
      try {
        await this.addLine({
          tenantId,
          letterId: letter.id,
          entityPartyId: line.entityPartyId,
          serviceVersionId: line.serviceVersionId,
          description: line.description,
          quantity: line.quantity,
          ...(line.unitAmount === null ? {} : { unitAmount: line.unitAmount }),
          discountPercent: line.discountPercent,
          ...(lineStart === undefined ? {} : { effectiveFrom: lineStart }),
          ...(line.jurisdiction === null ? {} : { jurisdiction: line.jurisdiction }),
          ...(line.billingFrequency === null ? {} : { billingFrequency: line.billingFrequency }),
          ...(line.billingTiming === null ? {} : { billingTiming: line.billingTiming }),
          ...(line.billingOn === null ? {} : { billingOn: line.billingOn }),
          ...(line.advanceAmount === null ? {} : { advanceAmount: line.advanceAmount }),
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
          ...(feeGroupId === undefined ? {} : { feeGroupId }),
        });
        linesCopied += 1;
      } catch (err) {
        if (!(err instanceof EngagementError)) throw err;
        skippedLines.push({ id: line.id, description: line.description, reason: err.message });
      }
    }

    // The terms, at the library's CURRENT wording of each.
    const published = await this.deps.library.publishedClauses(tenantId);
    let clausesCopied = 0;
    const skippedClauses: SkippedCopyItem[] = [];
    for (const clause of clauses) {
      const pinned = await this.deps.library.readPinnedVersion(tenantId, clause.clauseVersionId);
      const title =
        pinned === null ? clause.clauseVersionId : readClauseBody(pinned.body).title;
      const current = pinned === null ? undefined : published.find((c) => c.key === pinned.key);
      if (current === undefined) {
        skippedClauses.push({
          id: clause.clauseVersionId,
          description: title,
          reason: "This term is no longer in the firm's clause library.",
        });
        continue;
      }
      try {
        await this.addClause(tenantId, letter.id, current.versionId);
        clausesCopied += 1;
      } catch (err) {
        if (!(err instanceof EngagementError)) throw err;
        skippedClauses.push({ id: clause.clauseVersionId, description: title, reason: err.message });
      }
    }

    const prose = await this.deps.documents.listBlocks(tenantId, {
      kind: "engagement_letter",
      id: letter.id,
    });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.copied",
      objectId: source.id,
      actor,
      // Ids and counts; which lines and terms did not come across is on the
      // answer the person is looking at.
      payload: {
        copyId: letter.id,
        copyRef: letter.ref,
        linesCopied,
        linesSkipped: skippedLines.length,
        feeGroupsCopied: groupIds.size,
        clausesCopied,
        clausesSkipped: skippedClauses.length,
        proseLinesCopied: prose.length,
        addresseeDropped,
      },
    });
    return {
      letter,
      source: { id: source.id, ref: source.ref },
      linesCopied,
      feeGroupsCopied: groupIds.size,
      clausesCopied,
      skippedLines,
      skippedClauses,
      addresseeDropped,
    };
  }

  /**
   * Drafting, with the one thing a letter from a quote does differently: its
   * prose is the QUOTE's (T6.18, D11) rather than the standard set's.
   * `carryFrom` is that quote, or null for an ordinary draft. Answers with how
   * many of the quote's lines came across.
   */
  private async draftLetter(
    input: DraftLetterInput,
    actor: Actor,
    carryFrom: string | null,
    /** A withdrawn letter this draft copies (0316): its prose comes whole. */
    copyFrom: EngagementLetter | null = null,
  ): Promise<{ readonly letter: EngagementLetter; readonly proseCarried: number }> {
    const jurisdiction = normalizeJurisdiction(input.jurisdiction);
    if (!isJurisdiction(jurisdiction)) throw new InvalidJurisdiction(input.jurisdiction);

    const currency = normalizeCurrency(input.currency);
    if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(input.currency);
    // A RATE, not a price: `numeric(20,10)` on this column, so a stored
    // rate read back at full scale ("1.0000000000") has to be acceptable
    // input. `isAmount` allows four places and refused it — see
    // `isExchangeRate`.
    if (!isExchangeRate(input.fxRate) || Number(input.fxRate) <= 0) {
      throw new InvalidAmount("exchange rate", input.fxRate);
    }

    // A gate with no figure is a gate nobody can pass.
    if (input.advanceRequired && input.advanceAmount === undefined) {
      throw new AdvanceAmountRequired();
    }
    if (input.advanceAmount !== undefined && !isAmount(input.advanceAmount)) {
      throw new InvalidAmount("advance amount", input.advanceAmount);
    }

    for (const [field, value] of [
      ["issue date", input.issuedOn],
      ["effective date", input.effectiveFrom],
    ] as const) {
      if (value !== undefined && !isDay(value)) throw new InvalidDate(field, value);
    }

    // SUPERSESSION, checked before anything is written. The rule is that only a
    // SIGNED letter is superseded — a draft is edited, an unsigned sent letter
    // is withdrawn — and it is checked here as well as by the trigger in 0022,
    // because a caller deserves a sentence rather than a constraint name. The
    // trigger is what makes it true when this code is bypassed.
    if (input.supersedesId !== undefined) {
      await this.requireSupersedable(input.tenantId, input.supersedesId);
    }

    // An archived client gets no new letter (0305) - refused before the
    // reference number is drawn.
    await this.refuseArchived(input.tenantId, input.partyId, "client");
    // Nor one of the firm's own companies: every letter, drafted or written
    // up from a quote, comes through here, as every invoice meets BILLS_THE_FIRM.
    if (await this.deps.documents.isFirmEntity(input.tenantId, input.partyId)) {
      throw new LetterClientIsOwnCompany(await this.nameOf(input.tenantId, input.partyId));
    }

    // WHO ELSE the letter names, also before the number is drawn (F-10-1).
    // Each of these was checked for the FIRM only, so a client's company as
    // the issuer, a quote made to another client, or another client's director
    // as the addressee could all be written onto this letter.
    if (input.issuingEntityPartyId !== undefined) {
      await this.requireFirmEntity(input.tenantId, input.issuingEntityPartyId);
    }
    if (input.proposalId !== undefined) {
      await this.requireQuoteOf(input.tenantId, input.proposalId, input.partyId);
    }
    if (input.addressedToPartyId !== undefined) {
      await this.requireContact(input.tenantId, input.partyId, input.addressedToPartyId);
    }

    // WHO is contracting. The letter already states WHERE the work is, so that
    // is the key the firm's rule is looked up on — "jahan ka client hota hai,
    // wahan ki entity" — and a country the firm has no entity in lands on the
    // fallback ROW rather than on an `if` here.
    const issuingEntityPartyId =
      input.issuingEntityPartyId ??
      (await this.deps.documents.issuerFor(input.tenantId, jurisdiction));

    // Drawn before the row is written; the counter commits on its own, so a
    // draft that fails after this burns its number. See migration 0020.
    const ref = await this.deps.documents.nextRef(
      input.tenantId,
      "engagement_letter",
      this.deps.clock.now(),
    );

    const letter = await this.deps.letters.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      ref,
      partyId: input.partyId,
      issuingEntityPartyId,
      proposalId: input.proposalId ?? null,
      jurisdiction,
      title: input.title,
      // Every letter drafted now prints in the firm's Annexure format (0083).
      // Stated rather than left to the column's default, which exists for the
      // writers that are not this service.
      layout: CURRENT_LETTER_LAYOUT,
      currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      advanceRequired: input.advanceRequired,
      advanceAmount: input.advanceRequired ? (input.advanceAmount ?? null) : null,
      background: blankToNull(input.background),
      addressedToPartyId: input.addressedToPartyId ?? null,
      issuedOn: input.issuedOn ?? null,
      supersedesId: input.supersedesId ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      copiedFromId: copyFrom?.id ?? null,
    });

        // The firm's standard prose, COPIED onto this letter (G1.7). The letter
    // stores its OWN jurisdiction, chosen at drafting, so unlike a proposal
    // there is always an answer here — and a letter is the document where
    // getting it wrong is expensive.
    // Whose lines: the issuing company's own where it has any (T6.18, D5) —
    // or, for a letter from a quote, the quote's own as the client accepted
    // them, with only the cover and acceptance from the standard set (D11).
    const owner = { kind: "engagement_letter" as const, id: letter.id };
    let proseCarried = 0;
    if (copyFrom !== null) {
      // A COPY (0316) takes the withdrawn letter's prose whole, its cover letter
      // and acceptance included: the firm's wording for this client as it stood.
      await this.deps.documents.seedBlocksCopied(letter.tenantId, owner, {
        kind: "engagement_letter",
        id: copyFrom.id,
      });
    } else if (carryFrom === null) {
      await this.deps.documents.seedBlocks(
        letter.tenantId,
        owner,
        letter.jurisdiction,
        letter.issuingEntityPartyId,
      );
    } else {
      const seeded = await this.deps.documents.seedBlocksCarrying(
        letter.tenantId,
        owner,
        letter.jurisdiction,
        letter.issuingEntityPartyId,
        { kind: "proposal", id: carryFrom },
      );
      proseCarried = seeded.filter((b) => b.kind !== "cover" && b.kind !== "acceptance").length;
    }

    await this.deps.events.recordEvent({
      tenantId: letter.tenantId,
      verb: "engagement_letter.drafted",
      objectId: letter.id,
      actor,
      // Ids and machine facts. The TITLE is absent for the same reason a
      // proposal's is: it routinely names the client, and this log cannot be
      // erased.
      payload: {
        ref: letter.ref,
        partyId: letter.partyId,
        // WHO the firm bound itself through, on the first row of the document's
        // own timeline. An audit that asks "which of our companies signed this"
        // gets an answer that predates the signature.
        issuingEntityPartyId: letter.issuingEntityPartyId,
        proposalId: letter.proposalId,
        jurisdiction: letter.jurisdiction,
        currency: letter.currency,
        advanceRequired: letter.advanceRequired,
        // LINEAGE, on the first row of the successor's timeline. "Why does this
        // client have two engagement letters for the same year" is answered
        // here and not by comparing dates. The BACKGROUND and the ADDRESSEE are
        // absent for the reason the title is: one is prose about a named client
        // and the other is a person, and this log cannot be erased.
        supersedesId: letter.supersedesId,
        effectiveFrom: letter.effectiveFrom,
        // Where it came from, when it is a copy of a withdrawn letter (0316).
        copiedFromId: letter.copiedFromId,
      },
    });
    return { letter, proseCarried };
  }

  /**
   * Write an ACCEPTED quote up as a draft engagement letter (T3.5b).
   *
   * ── THE HOLE THIS CLOSES, AND IT WAS FOUND BY WALKING THE PRODUCT ───────
   *
   * The accepted proposal's lines, prices and discount reached nothing. The
   * letter form had no reference to a proposal AT ALL, so 1,75,000 was typed by
   * hand a second time and nothing in the system would have caught a fourth
   * digit. And pressing "Client accepted" left a page with zero controls on it:
   * the next thing IS a letter, and the product neither said so nor offered it.
   *
   * ── WHAT IS COPIED, AND WHAT IS DELIBERATELY NOT ────────────────────────
   *
   * Every line, with its pinned service version, its wording, its quantity, its
   * price, its discount, its billing frequency, its four scope overrides, its
   * out-of-pocket estimate and its pricing note. The CURRENCY, the rate and the
   * rate's date come from the quote and cannot be overridden: changing the
   * currency underneath copied amounts would reinterpret 1,75,000 rupees as
   * 1,75,000 dollars, which is the exact class of mistake this method exists to
   * end.
   *
   * NOT copied: the advance (a proposal has none — it is the firm's decision
   * here), the clauses (a letter's terms are chosen from the library against
   * ITS jurisdiction, and a quote has none), and the totals (a number the
   * database computed for a different document; the letter computes its own).
   *
   * ── THE TWO THINGS A QUOTE CANNOT ANSWER, AND NEITHER IS GUESSED ────────
   *
   * A letter states ONE country and a proposal states one PER LINE. When the
   * lines agree that is the answer; when they do not, the caller says which,
   * because that field settles governing law and the courts.
   *
   * And a letter line must name the company the work is for, while a proposal
   * line may not: a proposal is an offer and the prospect may hold no entity
   * yet. A line with none is filed against `defaultEntityPartyId` when the
   * caller named one, and otherwise SKIPPED AND REPORTED — never filed against
   * a company nobody chose, because on a signed page a guessed party is
   * indistinguishable from one somebody agreed to.
   *
   * ── ORDER, AND WHY NOTHING IS WRITTEN UNTIL EVERY REFUSAL HAS RUN ───────
   *
   * `draft` draws a reference number from a counter that commits on its own, so
   * a letter that fails after that point BURNS one. Every check therefore
   * happens first, including "could any line be copied at all" — a letter with
   * a spent number, no lines and no way to add any is a worse outcome than a
   * refusal naming what to fix.
   */
  async draftFromQuote(input: DraftFromQuoteInput, actor: Actor): Promise<LetterFromQuote> {
    const found = await this.deps.quotes.findQuote(input.tenantId, input.proposalId);
    if (found === null) throw new QuoteNotFound(input.proposalId);
    const quote = found.proposal;
    // Deleted first: a deleted quote is always a draft (0086), and "record the
    // acceptance first" would send somebody to accept a mistake.
    if (quote.deletedAt !== null) throw new QuoteDeleted(quote.ref);
    if (quote.status !== "accepted") throw new QuoteNotAccepted(quote.ref, quote.status);
    if (found.lines.length === 0) throw new QuoteHasNoLines(quote.ref);

    const jurisdiction = this.jurisdictionFor(quote.ref, found.lines, input.jurisdiction);

    // Decided BEFORE the reference number is drawn. `entityFor` is pure, so
    // asking it twice costs nothing and buys the one thing that matters: a
    // quote whose every line is entity-less is refused with a sentence rather
    // than turned into an empty letter holding a spent number.
    const usable = found.lines.filter(
      (line) => this.entityFor(line, input.defaultEntityPartyId) !== null,
    );
    if (usable.length === 0) throw new QuoteNamesNoEntity(quote.ref, found.lines.length);
    // Every company the letter would name, BEFORE the letter exists (0305). A
    // quote line may name an entity archived since it was quoted, and finding
    // that out line by line would leave a half-written letter holding a spent
    // reference number.
    const entities = new Set(
      usable.map((line) => this.entityFor(line, input.defaultEntityPartyId)).filter((e) => e !== null),
    );
    for (const entity of entities) await this.refuseArchived(input.tenantId, entity, "entity");
    // And every one of them the CLIENT'S (F-10-1), for the same reason: a quote
    // line may name any company of the firm, and finding that out at the
    // fourth line would leave a half-written letter holding a spent number.
    const structure = await this.structureFor(input.tenantId, quote.partyId);
    for (const entity of entities) {
      await this.requireInStructure(input.tenantId, quote.partyId, entity, structure);
    }

    const { letter, proseCarried } = await this.draftLetter(
      {
        tenantId: input.tenantId,
        partyId: quote.partyId,
        proposalId: quote.id,
        // The quote's own issuer unless the caller says otherwise: the firm
        // already decided which of its companies was offering this, and a
        // letter that quietly contracted through a different one would change
        // the client's counterparty between the quote and the contract.
        issuingEntityPartyId: input.issuingEntityPartyId ?? quote.issuingEntityPartyId,
        jurisdiction,
        title: input.title ?? quote.title,
        currency: quote.currency,
        fxRate: quote.fxRate,
        fxRateDate: quote.fxRateDate,
        advanceRequired: input.advanceRequired,
        advanceAmount: input.advanceAmount,
        background: input.background,
        addressedToPartyId: input.addressedToPartyId,
        issuedOn: input.issuedOn,
        effectiveFrom: input.effectiveFrom,
      },
      actor,
      quote.id,
    );

    const lines: LetterLine[] = [];
    const skipped: SkippedQuoteLine[] = [];
    // IN ORDER, one at a time. `addLine` takes each line's `position` from what
    // is already on the letter, so writing these in parallel would put the
    // terms of a contract in an order decided by which round trip finished
    // first.
    for (const line of found.lines) {
      const entityPartyId = this.entityFor(line, input.defaultEntityPartyId);
      if (entityPartyId === null) {
        skipped.push({
          proposalLineId: line.id,
          description: line.description,
          reason:
            "This line does not say which company the work is for. A letter line has to, " +
            "because signing it creates an engagement — one service for one legal entity. " +
            "Add it to the letter by hand, naming the company.",
        });
        continue;
      }
      lines.push(
        await this.addLine({
          tenantId: input.tenantId,
          letterId: letter.id,
          entityPartyId,
          serviceVersionId: line.serviceVersionId,
          description: line.description,
          quantity: line.quantity,
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
          ...(line.exclusionsOverride === null
            ? {}
            : { exclusionsOverride: line.exclusionsOverride }),
          ...(line.oopEstimate === null ? {} : { oopEstimate: line.oopEstimate }),
          ...(line.pricingNote === null ? {} : { pricingNote: line.pricingNote }),
        }),
      );
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement_letter.drafted_from_proposal",
      objectId: letter.id,
      actor,
      // Counts, not content. HOW MANY of a client's agreed lines did not make
      // it onto the contract is what this row is read for, and the descriptions
      // that would answer "which" are the client's own words.
      payload: {
        proposalId: quote.id,
        linesCopied: lines.length,
        linesSkipped: skipped.length,
        // Whether a person had to state the country, or the quote answered it.
        jurisdictionStated: input.jurisdiction !== undefined,
        defaultEntityUsed: input.defaultEntityPartyId !== undefined,
        // How many of the quote's exclusion, commercial and team lines came
        // across as the client accepted them (T6.18, D11).
        proseLinesCarried: proseCarried,
      },
    });

    return { letter, lines, skipped };
  }

  /** The company a quote line's work is for: the line's own, then the caller's
   *  stated fallback, then null — which is a SKIP and never a guess. */
  private entityFor(
    line: { readonly entityPartyId: string | null },
    fallback: string | undefined,
  ): string | null {
    return line.entityPartyId ?? fallback ?? null;
  }

  /**
   * The country the letter is under.
   *
   * Stated wins; otherwise the quote answers only when its lines AGREE. Two
   * countries on one quote is a real thing a firm sells and it is two letters,
   * because governing law is a document-level term — so the refusal says that
   * rather than picking whichever line came first.
   */
  private jurisdictionFor(
    ref: string,
    lines: readonly { readonly jurisdiction: string | null }[],
    stated: string | undefined,
  ): string {
    if (stated !== undefined && stated.trim() !== "") return stated;
    const named = [
      ...new Set(
        lines.map((l) => l.jurisdiction).filter((j): j is string => j !== null && j.trim() !== ""),
      ),
    ];
    const only = named[0];
    if (named.length !== 1 || only === undefined) throw new QuoteJurisdictionUnclear(ref, named);
    return only;
  }

  /**
   * The client's structure on the FIRM's day (F-10-1): the companies work for
   * this client may be for, and the people a letter to it may be addressed to.
   *
   * The read behind `GET /parties/{partyId}/structure` AND the rule the checks
   * below apply, so the letter's pickers offer exactly what drafting accepts.
   * The firm's day and not the server's: a directorship that starts today in
   * Delhi must count from the morning, not from 05:30.
   */
  async structureFor(tenantId: string, clientPartyId: string): Promise<ClientStructure> {
    const today = await this.firmDay(tenantId);
    return this.deps.structure.structureOf(tenantId, clientPartyId, today);
  }

  /** A party's name for a refusal, or its id when it has none on file. */
  private async nameOf(tenantId: string, partyId: string): Promise<string> {
    return (await this.deps.parties.findParty(tenantId, partyId))?.displayName ?? partyId;
  }

  /** The letter's issuer must be one of the firm's own companies (F-10-1). */
  private async requireFirmEntity(tenantId: string, partyId: string): Promise<void> {
    if (await this.deps.documents.isFirmEntity(tenantId, partyId)) return;
    throw new IssuerNotAFirmEntity(await this.nameOf(tenantId, partyId));
  }

  /** A letter drafted "from" a quote names a quote made to THIS client. */
  private async requireQuoteOf(
    tenantId: string,
    proposalId: string,
    clientPartyId: string,
  ): Promise<void> {
    const found = await this.deps.quotes.findQuote(tenantId, proposalId);
    if (found === null) throw new QuoteNotFound(proposalId);
    // A quote deleted as a mistake gains no letter citing it (0086).
    if (found.proposal.deletedAt !== null) throw new QuoteDeleted(found.proposal.ref);
    if (found.proposal.partyId === clientPartyId) return;
    throw new QuoteOfAnotherClient(
      found.proposal.ref,
      await this.nameOf(tenantId, found.proposal.partyId),
      await this.nameOf(tenantId, clientPartyId),
    );
  }

  /** The addressee is a PERSON with a recorded role in the client's structure. */
  private async requireContact(
    tenantId: string,
    clientPartyId: string,
    personPartyId: string,
  ): Promise<void> {
    const person = await this.deps.parties.findParty(tenantId, personPartyId);
    if (person !== null && person.kind !== "person") {
      throw new AddresseeNotAPerson(person.displayName);
    }
    const structure = await this.structureFor(tenantId, clientPartyId);
    if (structure.people.some((p) => p.id === personPartyId)) return;
    throw new AddresseeNotLinked(
      person?.displayName ?? personPartyId,
      await this.nameOf(tenantId, clientPartyId),
    );
  }

  /** A line's company is the client, or recorded as one of its companies. */
  private async requireInStructure(
    tenantId: string,
    clientPartyId: string,
    entityPartyId: string,
    known?: ClientStructure,
  ): Promise<void> {
    const structure = known ?? (await this.structureFor(tenantId, clientPartyId));
    if (structure.entities.some((e) => e.id === entityPartyId)) return;
    throw new EntityOutsideClient(
      await this.nameOf(tenantId, entityPartyId),
      await this.nameOf(tenantId, clientPartyId),
    );
  }

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
      throw new LetterPartyArchived(party.displayName, as);
    }
  }

  async addLine(input: AddLetterLineInput): Promise<LetterLine> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);
    await this.refuseArchived(input.tenantId, input.entityPartyId, "entity");
    // The company the work is FOR must be the client's (F-10-1). Signing fans
    // this line out into an engagement, and the engagement's work lands in the
    // LETTER's client's portal, so another client's company here shows one
    // client work done for somebody else.
    await this.requireInStructure(input.tenantId, letter.partyId, input.entityPartyId);

    if (!isAmount(input.quantity) || Number(input.quantity) <= 0) {
      throw new InvalidAmount("quantity", input.quantity);
    }
    // A FEE GROUP'S LINE (0083) has no price of its own: the group's fee pays
    // for it. Checked before the pricing rules below, which a grouped line is
    // exempt from — "why is there no amount" is answered by the group.
    const feeGroupId = input.feeGroupId ?? null;
    if (feeGroupId !== null) {
      await this.liveFeeGroupOrThrow(input.tenantId, letter.id, feeGroupId);
    }
    const pinned = await this.deps.library.readPinnedVersion(
      input.tenantId,
      input.serviceVersionId,
    );
    if (pinned === null) throw new ClauseNotFound(input.serviceVersionId);
    if (pinned.kind !== "service") {
      throw new ServiceNotQuotable(input.serviceVersionId, `it is a ${pinned.kind}, not a service`);
    }
    if (pinned.status === "draft") {
      throw new ServiceNotQuotable(
        input.serviceVersionId,
        "it is still a draft and was never in force, so it cannot be sold",
      );
    }

    // NEITHER A FEE NOR A REASON, outside a section: quoted at the pinned
    // version's list price in the letter's currency (B09, audit 2026-10-03), as
    // ProposalService.addLine does and for its reason: a login that cannot see
    // fees reads every list price as null.
    let stated = input.unitAmount;
    if (feeGroupId === null && stated === undefined && blankToNull(input.pricingNote) === null) {
      const service = readServiceBody(pinned.body);
      if (service.listPrice === null || service.listPrice.currency !== letter.currency) {
        throw new ServiceHasNoListPrice(service.name === "" ? input.description : service.name, letter.currency);
      }
      stated = service.listPrice.amount;
    }
    const { unitAmount, pricingNote } = this.pricingOrThrow({
      grouped: feeGroupId !== null,
      unitAmount: stated,
      discountPercent: input.discountPercent,
      pricingNote: input.pricingNote,
    });
    if (input.effectiveFrom !== undefined && !isDay(input.effectiveFrom)) {
      throw new InvalidDate("effective date", input.effectiveFrom);
    }

    const jurisdiction = this.lineJurisdiction(input.jurisdiction);
    const billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    const oopEstimate = this.outOfPocket(input.oopEstimate);

    const resolvedFrequency = billingFrequency ?? readServiceBody(pinned.body).recurrence;
    return this.deps.letters.addLine({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      engagementLetterId: letter.id,
      entityPartyId: input.entityPartyId,
      serviceVersionId: input.serviceVersionId,
      description: input.description,
      quantity: input.quantity,
      unitAmount,
      currency: letter.currency,
      discountPercent: input.discountPercent,
      effectiveFrom: input.effectiveFrom ?? null,
      jurisdiction,
      // DEFAULTED FROM THE PIN, ONCE, AND STORED — see the same line on
      // ProposalService.addLine. On a letter it matters more: the value is part
      // of what the client signs, so it must be the one decided at drafting and
      // not one re-derived from a catalogue that has since moved.
      billingFrequency: resolvedFrequency,
      ...this.timingOrThrow(resolvedFrequency, input.billingTiming, input.billingOn),
      advanceAmount: this.lineAdvanceOrThrow(letter, feeGroupId, input.advanceAmount),
      scopeOverride: blankToNull(input.scopeOverride),
      clientObligationsOverride: blankToNull(input.clientObligationsOverride),
      volumeLimitsOverride: blankToNull(input.volumeLimitsOverride),
      exclusionsOverride: blankToNull(input.exclusionsOverride),
      oopEstimate,
      pricingNote,
      feeGroupId,
    });
  }

  /**
   * THE PRICE RULES FOR ONE LINE, in one place — adding a line and repricing
   * one ask the same questions, and two copies would disagree on the case that
   * matters.
   *
   * On its own, a line is priced, or it says why it is not (0023), and a
   * discount off "as mutually agreed" is refused. In a fee group it has no
   * price and no discount at all — anything else would charge twice (0083) —
   * and it needs no reason, because the group is the reason.
   */
  private pricingOrThrow(input: {
    readonly grouped: boolean;
    readonly unitAmount: string | undefined;
    readonly discountPercent: string;
    readonly pricingNote: string | undefined;
  }): { unitAmount: string | null; pricingNote: string | null } {
    if (!isAmount(input.discountPercent) || Number(input.discountPercent) > 100) {
      throw new InvalidAmount("discount", input.discountPercent);
    }
    const unitAmount = input.unitAmount ?? null;
    if (unitAmount !== null && !isAmount(unitAmount)) {
      throw new InvalidAmount("unit amount", unitAmount);
    }
    const pricingNote = blankToNull(input.pricingNote);
    if (input.grouped) {
      if (unitAmount !== null || Number(input.discountPercent) !== 0) throw new GroupedLinePriced();
      return { unitAmount: null, pricingNote };
    }
    // THE UNPRICED LINE. On a letter this is a TERM two parties sign, so the
    // reason is required and a discount off it is refused — the same two rules
    // the CHECKs make (0023), stated here so a caller is told what to send.
    if (unitAmount === null && pricingNote === null) throw new UnpricedLineNeedsReason();
    if (unitAmount === null && Number(input.discountPercent) !== 0) {
      throw new UnpricedLineHasDiscount(input.discountPercent);
    }
    return { unitAmount, pricingNote };
  }

  /**
   * Price a line by a fee group, or on its own (0083).
   *
   * Into a group, the line GIVES UP its price, its discount and its pricing
   * note: the group's fee pays for it, and a note about a price the line no
   * longer has would be a sentence about nothing. Out of one, it needs a price
   * or a reason, exactly as when it was added — `LineNotPriced` says which to
   * send, because "as mutually agreed" is a term too.
   */
  async setLinePricing(input: LinePricingInput): Promise<LetterLine> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);
    const lines = await this.deps.letters.listLines(input.tenantId, letter.id);
    const line = lines.find((l) => l.id === input.lineId);
    if (line === undefined) throw new LetterLineNotFound(input.lineId);

    if (input.feeGroupId !== null) {
      await this.liveFeeGroupOrThrow(input.tenantId, letter.id, input.feeGroupId);
      if (input.unitAmount !== undefined || Number(input.discountPercent ?? "0") !== 0) {
        throw new GroupedLinePriced();
      }
      return this.deps.letters.setLinePricing(input.tenantId, letter.id, line.id, {
        feeGroupId: input.feeGroupId,
        unitAmount: null,
        discountPercent: "0",
        pricingNote: null,
      });
    }

    if (input.unitAmount === undefined && blankToNull(input.pricingNote) === null) {
      throw new LineNotPriced(line.description);
    }
    const priced = this.pricingOrThrow({
      grouped: false,
      unitAmount: input.unitAmount,
      discountPercent: input.discountPercent ?? "0",
      pricingNote: input.pricingNote,
    });
    return this.deps.letters.setLinePricing(input.tenantId, letter.id, line.id, {
      feeGroupId: null,
      unitAmount: priced.unitAmount,
      discountPercent: input.discountPercent ?? "0",
      pricingNote: priced.pricingNote,
    });
  }

  // ── Fee groups (0083) ──────────────────────────────────────────────────────
  //
  // A section of the letter and the one fee it charges. Draft-only, like every
  // other change to a letter's terms, through `editableOrThrow`. No ledger
  // event, for the reason adding a line records none: drafting a document is
  // not a state transition, and what the client was finally asked to sign is
  // recorded at send.

  async addFeeGroup(
    tenantId: string,
    letterId: string,
    input: FeeGroupInput,
  ): Promise<FeeGroup> {
    const letter = await this.editableOrThrow(tenantId, letterId);
    const terms = this.feeGroupTermsOrThrow(input);
    return this.deps.letters.addFeeGroup({
      id: this.deps.ids.newId(),
      tenantId,
      engagementLetterId: letter.id,
      // THE LETTER'S currency, and only that: a group is held to it by a
      // composite key (0083), so a fee in another currency cannot be written.
      currency: letter.currency,
      title: terms.title,
      billingFrequency: terms.billingFrequency,
      ...this.timingOrThrow(terms.billingFrequency, input.billingTiming, input.billingOn),
      amount: terms.amount,
      paymentTerms: blankToNull(input.paymentTerms),
      feeDescription: blankToNull(input.feeDescription),
      intro: blankToNull(input.intro),
      deliverables: blankToNull(input.deliverables),
      clientObligations: blankToNull(input.clientObligations),
    });
  }

  async editFeeGroup(
    tenantId: string,
    letterId: string,
    groupId: string,
    change: FeeGroupChange,
  ): Promise<FeeGroup> {
    await this.editableOrThrow(tenantId, letterId);
    const current = await this.liveFeeGroupOrThrow(tenantId, letterId, groupId);
    const terms = this.feeGroupTermsOrThrow({
      title: change.title ?? current.title,
      billingFrequency: change.billingFrequency ?? current.billingFrequency,
      amount: change.amount ?? current.amount,
    });
    // The timing as it will be: sent, or kept, or cleared when the frequency
    // stops being one billed per period.
    const timingSent = change.billingTiming !== undefined || change.billingOn !== undefined;
    const timing = this.timingOrThrow(
      terms.billingFrequency,
      timingSent ? change.billingTiming : current.billingTiming,
      timingSent ? change.billingOn : current.billingOn,
      !timingSent,
    );
    const edit: FeeGroupEdit = {
      title: terms.title,
      billingFrequency: terms.billingFrequency,
      billingTiming: timing.billingTiming,
      billingOn: timing.billingOn,
      amount: terms.amount,
      // Absent keeps the words; a blank clears them. Null and "" are not the
      // same thing to the reader of a contract, and the column refuses "".
      ...(change.paymentTerms === undefined ? {} : { paymentTerms: blankToNull(change.paymentTerms) }),
      ...(change.feeDescription === undefined
        ? {}
        : { feeDescription: blankToNull(change.feeDescription) }),
      ...(change.intro === undefined ? {} : { intro: blankToNull(change.intro) }),
      ...(change.deliverables === undefined
        ? {}
        : { deliverables: blankToNull(change.deliverables) }),
      ...(change.clientObligations === undefined
        ? {}
        : { clientObligations: blankToNull(change.clientObligations) }),
    };
    return this.deps.letters.editFeeGroup(tenantId, letterId, groupId, edit);
  }

  /**
   * Strike a group off a draft — refused while it still prices a service,
   * because the service would be left with no price and no reason. The trigger
   * in 0083 refuses it too; this is the sentence a person is told first.
   */
  async removeFeeGroup(tenantId: string, letterId: string, groupId: string): Promise<void> {
    await this.editableOrThrow(tenantId, letterId);
    const group = await this.liveFeeGroupOrThrow(tenantId, letterId, groupId);
    const covered = (await this.deps.letters.listLines(tenantId, letterId)).filter(
      (l) => l.feeGroupId === groupId,
    );
    if (covered.length > 0) throw new FeeGroupNotEmpty(group.title, covered.length);
    await this.deps.letters.removeFeeGroup(tenantId, letterId, groupId);
  }

  /** A live group on THIS letter, or a refusal naming the id. A group on
   *  another letter is "not found" here — the composite key would refuse the
   *  line anyway, and the caller has the wrong id either way. */
  private async liveFeeGroupOrThrow(
    tenantId: string,
    letterId: string,
    groupId: string,
  ): Promise<FeeGroup> {
    const groups = await this.deps.letters.listFeeGroups(tenantId, letterId);
    const group = groups.find((g) => g.id === groupId);
    if (group === undefined) throw new FeeGroupNotFound(groupId);
    return group;
  }

  /** The three things a group cannot exist without, each refused by name. */
  private feeGroupTermsOrThrow(input: {
    readonly title: string;
    readonly billingFrequency: string;
    readonly amount: string;
  }): { title: string; billingFrequency: BillingFrequency; amount: string } {
    const title = input.title.trim();
    if (title === "") throw new FeeGroupTitleRequired();
    if (!isBillingFrequency(input.billingFrequency)) {
      throw new InvalidLineBillingFrequency(input.billingFrequency, BILLING_FREQUENCIES);
    }
    if (!isAmount(input.amount)) throw new InvalidAmount("fee", input.amount);
    return { title, billingFrequency: input.billingFrequency, amount: input.amount };
  }

  /** The line's jurisdiction, normalised. Refused rather than dropped: "in" and
   *  "IN" are the same country and "INR" is not one. */
  private lineJurisdiction(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === "") return null;
    const normalised = normalizeJurisdiction(raw);
    if (!isJurisdiction(normalised)) throw new InvalidJurisdiction(raw);
    return normalised;
  }

  /**
   * A service's own advance (0320), as it will be stored: an amount above zero,
   * before tax. A grouped line has none (the group's advance is the letter's),
   * and a letter that asks for one advance for the whole of it cannot ask for a
   * service's as well: that service's work would wait for two payments.
   */
  private lineAdvanceOrThrow(
    letter: Pick<EngagementLetter, "advanceRequired">,
    feeGroupId: string | null,
    advance: string | null | undefined,
  ): Amount | null {
    if (advance === undefined || advance === null) return null;
    const amount = advance.trim();
    if (feeGroupId !== null) throw new InvalidLineAdvance("a service in a fee group has no advance of its own");
    if (!isAmount(amount) || compareAmounts(amount, "0") <= 0) {
      throw new InvalidLineAdvance(`${JSON.stringify(advance)} is not an amount above zero`);
    }
    if (letter.advanceRequired) throw new OneKindOfAdvance("letter");
    return amount;
  }

  /**
   * When a recurring fee is invoiced (0319), as it will be stored. A timing
   * only for a fee billed per period; a date with "on_date" and only with it.
   * `kept` is a value already on the row being carried through an edit of
   * something else: when the frequency stopped being one billed per period it
   * is cleared rather than refused, because nobody asked to change it.
   */
  private timingOrThrow(
    frequency: string | null,
    timing: string | null | undefined,
    on: string | null | undefined,
    kept = false,
  ): { billingTiming: LetterBillingTiming | null; billingOn: string | null } {
    if (timing === undefined || timing === null || timing.trim() === "") {
      if (on !== undefined && on !== null && on.trim() !== "") {
        throw new InvalidLetterBillingTiming("a first invoice date needs the timing \"on_date\"");
      }
      return { billingTiming: null, billingOn: null };
    }
    if (!isLetterBillingTiming(timing)) throw new InvalidLetterBillingTiming(`${JSON.stringify(timing)} is not one`);
    if (!TIMED_FREQUENCIES.includes(frequency ?? "")) {
      if (kept) return { billingTiming: null, billingOn: null };
      throw new InvalidLetterBillingTiming(`a ${frequency ?? "frequency-less"} fee is not billed per period`);
    }
    if (timing === "on_date") {
      if (on === undefined || on === null || !isDay(on)) {
        throw new InvalidLetterBillingTiming("\"on_date\" needs \"billingOn\", a calendar day");
      }
      return { billingTiming: timing, billingOn: on };
    }
    if (on !== undefined && on !== null && on.trim() !== "") {
      throw new InvalidLetterBillingTiming(`a date goes with "on_date" only, not ${JSON.stringify(timing)}`);
    }
    return { billingTiming: timing, billingOn: null };
  }

  private statedBillingFrequency(raw: string | undefined): BillingFrequency | null {
    if (raw === undefined || raw.trim() === "") return null;
    if (!isBillingFrequency(raw)) throw new InvalidLineBillingFrequency(raw, BILLING_FREQUENCIES);
    return raw;
  }

  /** The out-of-pocket range, whole or absent. Its currency is normalised but
   *  NOT held to the letter's — see `OutOfPocketEstimate`. */
  private outOfPocket(
    raw: { readonly min: string; readonly max: string; readonly currency: string } | undefined,
  ): OutOfPocketEstimate | null {
    if (raw === undefined) return null;
    const estimate = { min: raw.min, max: raw.max, currency: normalizeCurrency(raw.currency) };
    const problem = outOfPocketProblem(estimate, isAmount, isCurrencyCode);
    if (problem !== null) throw new InvalidOutOfPocketEstimate(problem);
    return estimate;
  }

  /**
   * Change what a DRAFT letter says about itself (T6.18 S6): its title,
   * Background, addressee, dates and advance, and — while nothing is priced or
   * no term is on it — its currency, its country and which of the firm's
   * companies issues it.
   *
   * The builder's step 1 reopens a draft, and its preview edits the cover in
   * place; before this a letter's head could be written only at drafting, so a
   * typo in the subject line meant deleting the draft and starting again.
   *
   * A new ISSUER or COUNTRY replaces the letter's wording with that company's
   * standard set for that country, in the same transaction (D9), and is refused
   * while terms are on the letter: each was checked against the old issuer's
   * law and the old country when it went on, and a term cannot be taken off.
   * No event for the head itself, the same as the proposal's revise — a draft
   * being written is not a transition. Who contracts, under whose law and in
   * what money ARE recorded, because each is a commercial fact even on a draft.
   */
  async revise(input: ReviseLetterInput, actor: Actor): Promise<EngagementLetter> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);
    const change: {
      title?: string;
      background?: string | null;
      addressedToPartyId?: string | null;
      issuedOn?: string | null;
      effectiveFrom?: string | null;
      advanceRequired?: boolean;
      advanceAmount?: string | null;
      jurisdiction?: string;
      issuingEntityPartyId?: string;
      currency?: string;
      fxRate?: string;
      fxRateDate?: string;
    } = {};

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title === "") throw new NothingToRevise();
      change.title = title;
    }
    if (input.background !== undefined) change.background = blankToNull(input.background ?? undefined);
    if (input.addressedToPartyId !== undefined) {
      if (input.addressedToPartyId !== null) {
        await this.requireContact(input.tenantId, letter.partyId, input.addressedToPartyId);
      }
      change.addressedToPartyId = input.addressedToPartyId;
    }
    for (const [field, key] of [
      ["issue date", "issuedOn"],
      ["effective date", "effectiveFrom"],
    ] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (value !== null && !isDay(value)) throw new InvalidDate(field, value);
      change[key] = value;
    }

    // THE ADVANCE: its two columns move together, so both are always sent.
    if (input.advanceRequired !== undefined || input.advanceAmount !== undefined) {
      const required = input.advanceRequired ?? letter.advanceRequired;
      const amount = required
        ? (input.advanceAmount === undefined ? letter.advanceAmount : input.advanceAmount)
        : null;
      if (required && amount === null) throw new AdvanceAmountRequired();
      if (amount !== null && !isAmount(amount)) throw new InvalidAmount("advance amount", amount);
      // One kind of advance per letter (0320).
      if (required && !letter.advanceRequired) {
        const lines = await this.deps.letters.listLines(input.tenantId, letter.id);
        if (lines.some((l) => l.advanceAmount !== null)) throw new OneKindOfAdvance("services");
      }
      change.advanceRequired = required;
      change.advanceAmount = amount;
    }

    // THE MONEY: three fields or none, and a new currency only while nothing
    // on the letter is priced in the old one.
    const money = [input.currency, input.fxRate, input.fxRateDate];
    if (money.some((v) => v !== undefined)) {
      if (money.some((v) => v === undefined)) throw new LetterInvalidCurrencyChange();
      const currency = normalizeCurrency(input.currency ?? "");
      if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(input.currency ?? "");
      const fxRate = input.fxRate ?? "";
      if (!isExchangeRate(fxRate) || Number(fxRate) <= 0) {
        throw new InvalidAmount("exchange rate", fxRate);
      }
      const fxRateDate = input.fxRateDate ?? "";
      if (!isDay(fxRateDate)) throw new InvalidDate("rate date", fxRateDate);
      if (currency !== letter.currency && (await this.deps.letters.pricesAnything(input.tenantId, letter.id))) {
        throw new LetterCurrencyLocked(letter.currency);
      }
      change.currency = currency;
      change.fxRate = fxRate;
      change.fxRateDate = fxRateDate;
    }

    // WHO CONTRACTS, AND UNDER WHICH COUNTRY (D6, D9).
    let jurisdiction = letter.jurisdiction;
    if (input.jurisdiction !== undefined) {
      jurisdiction = normalizeJurisdiction(input.jurisdiction);
      if (!isJurisdiction(jurisdiction)) throw new InvalidJurisdiction(input.jurisdiction);
    }
    const issuer = input.issuingEntityPartyId ?? letter.issuingEntityPartyId;
    const moved = jurisdiction !== letter.jurisdiction || issuer !== letter.issuingEntityPartyId;
    let prose: readonly LetterProseLine[] | null = null;
    let editedReplaced = 0;
    if (moved) {
      if (issuer !== letter.issuingEntityPartyId) await this.requireFirmEntity(input.tenantId, issuer);
      const terms = await this.deps.letters.listClauses(input.tenantId, letter.id);
      if (terms.length > 0) {
        throw new TermsOnLetter(terms.length, await this.nameOf(input.tenantId, letter.issuingEntityPartyId));
      }
      const owner = { kind: "engagement_letter" as const, id: letter.id };
      const current = await this.deps.documents.listBlocks(input.tenantId, owner);
      // Written for this client either way: a house line reworded, or one
      // added by hand (or carried from the quote as edited there).
      editedReplaced = current.filter((b) => b.isEdited || b.sourceId === null).length;
      if (editedReplaced > 0 && input.replaceEditedProse !== true) {
        throw new LetterProseEdited(editedReplaced, await this.nameOf(input.tenantId, issuer));
      }
      prose = await this.deps.documents.standardProse(input.tenantId, owner, jurisdiction, issuer);
      if (jurisdiction !== letter.jurisdiction) change.jurisdiction = jurisdiction;
      if (issuer !== letter.issuingEntityPartyId) change.issuingEntityPartyId = issuer;
    }

    if (Object.keys(change).length === 0) throw new NothingToRevise();

    const revision: LetterRevision = change;
    const revised = await this.deps.letters.revise(input.tenantId, letter.id, revision, prose);
    if (revised === null) {
      // Sent or deleted between the read above and the write, or a line was
      // priced a moment ago under a currency change: the letter as it now
      // stands says which.
      await this.editableOrThrow(input.tenantId, letter.id);
      throw new LetterCurrencyLocked(letter.currency);
    }

    if (moved) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "engagement_letter.issuer_changed",
        objectId: letter.id,
        actor,
        payload: {
          fromIssuingEntityPartyId: letter.issuingEntityPartyId,
          toIssuingEntityPartyId: revised.issuingEntityPartyId,
          fromJurisdiction: letter.jurisdiction,
          toJurisdiction: revised.jurisdiction,
          proseReplaced: true,
          editedLinesReplaced: editedReplaced,
        },
      });
    }
    if (
      change.currency !== undefined &&
      (change.currency !== letter.currency ||
        change.fxRate !== letter.fxRate ||
        change.fxRateDate !== letter.fxRateDate)
    ) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "engagement_letter.currency_changed",
        objectId: letter.id,
        actor,
        payload: {
          fromCurrency: letter.currency,
          toCurrency: revised.currency,
          fromFxRate: letter.fxRate,
          toFxRate: revised.fxRate,
          fxRateDate: revised.fxRateDate,
        },
      });
    }
    return revised;
  }

  /**
   * Change a line already on a DRAFT letter (T6.18 S6) — its wording, its
   * company, its fee, how often it is billed, when it starts, its scope texts —
   * without pulling it and agreeing it again, which lost its place and its pin.
   *
   * The same rules as adding one, judged on the line AS IT WILL BE: the change
   * merged over what the line says now, so "no price" and "no reason" cannot
   * each be allowed on their own and meet on the row. A line in a SECTION keeps
   * no price of its own; moving it in or out is `setLinePricing`'s. No event,
   * like adding or removing a line: a draft being written is not a transition.
   */
  async updateLine(input: UpdateLetterLineInput): Promise<LetterLine> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);
    if (LETTER_LINE_FIELDS.every((f) => input[f] === undefined)) {
      throw new NothingToChangeOnLetterLine();
    }
    const current = (await this.deps.letters.listLines(input.tenantId, letter.id)).find(
      (l) => l.id === input.lineId,
    );
    if (current === undefined) throw new LetterLineNotFound(input.lineId);

    let description = current.description;
    if (input.description !== undefined) {
      description = input.description.trim();
      if (description === "") throw new InvalidLetterLineDescription();
    }

    const entityPartyId = input.entityPartyId ?? current.entityPartyId;
    if (entityPartyId !== current.entityPartyId) {
      await this.refuseArchived(input.tenantId, entityPartyId, "entity");
      await this.requireInStructure(input.tenantId, letter.partyId, entityPartyId);
    }

    const quantity = input.quantity ?? current.quantity;
    if (!isAmount(quantity) || Number(quantity) <= 0) throw new InvalidAmount("quantity", quantity);

    const unitAmount = input.unitAmount === undefined ? current.unitAmount : input.unitAmount;
    const pricingNote = input.pricingNote === undefined ? current.pricingNote : input.pricingNote;
    const discountPercent = input.discountPercent ?? current.discountPercent;
    const priced = this.pricingOrThrow({
      grouped: current.feeGroupId !== null,
      unitAmount: unitAmount ?? undefined,
      discountPercent,
      pricingNote: pricingNote ?? undefined,
    });

    const effectiveFrom =
      input.effectiveFrom === undefined ? current.effectiveFrom : input.effectiveFrom;
    if (effectiveFrom !== null && !isDay(effectiveFrom)) {
      throw new InvalidDate("effective date", effectiveFrom);
    }
    const jurisdiction =
      input.jurisdiction === undefined
        ? current.jurisdiction
        : this.lineJurisdiction(input.jurisdiction ?? undefined);

    // Null is "back to what the service says", read off the SAME pin the line
    // was agreed from — never today's catalogue.
    let billingFrequency = current.billingFrequency;
    if (input.billingFrequency === null) {
      const pinned = await this.deps.library.readPinnedVersion(
        input.tenantId,
        current.serviceVersionId,
      );
      billingFrequency = pinned === null ? null : readServiceBody(pinned.body).recurrence;
    } else if (input.billingFrequency !== undefined) {
      billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    }

    const timingSent = input.billingTiming !== undefined || input.billingOn !== undefined;
    const timing = this.timingOrThrow(
      billingFrequency,
      timingSent ? input.billingTiming : current.billingTiming,
      timingSent ? input.billingOn : current.billingOn,
      !timingSent,
    );
    // Its own advance (0320): kept unless sent; a grouped line never has one.
    const advanceAmount =
      input.advanceAmount === undefined
        ? current.feeGroupId === null
          ? current.advanceAmount
          : null
        : this.lineAdvanceOrThrow(letter, current.feeGroupId, input.advanceAmount);

    const override = (next: string | null | undefined, now: string | null): string | null =>
      next === undefined ? now : blankToNull(next ?? undefined);
    const oopEstimate =
      input.oopEstimate === undefined
        ? current.oopEstimate
        : this.outOfPocket(input.oopEstimate ?? undefined);

    const updated = await this.deps.letters.updateLine(input.tenantId, letter.id, current.id, {
      entityPartyId,
      description,
      quantity,
      unitAmount: priced.unitAmount,
      discountPercent,
      effectiveFrom,
      jurisdiction,
      billingFrequency,
      billingTiming: timing.billingTiming,
      billingOn: timing.billingOn,
      advanceAmount,
      scopeOverride: override(input.scopeOverride, current.scopeOverride),
      clientObligationsOverride: override(
        input.clientObligationsOverride,
        current.clientObligationsOverride,
      ),
      volumeLimitsOverride: override(input.volumeLimitsOverride, current.volumeLimitsOverride),
      exclusionsOverride: override(input.exclusionsOverride, current.exclusionsOverride),
      oopEstimate,
      pricingNote: priced.pricingNote,
    });
    if (updated === null) {
      // Sent, deleted or pulled between the read above and the write.
      await this.editableOrThrow(input.tenantId, letter.id);
      throw new LetterLineNotFound(input.lineId);
    }
    return updated;
  }

  async removeLine(tenantId: string, letterId: string, lineId: string): Promise<void> {
    await this.editableOrThrow(tenantId, letterId);
    const lines = await this.deps.letters.listLines(tenantId, letterId);
    if (!lines.some((l) => l.id === lineId)) throw new LetterLineNotFound(lineId);
    await this.deps.letters.removeLine(tenantId, letterId, lineId);
  }

  /**
   * Put a clause on the letter, PINNED to the version in force right now.
   *
   * TWO jurisdiction checks, asking different questions of different fields,
   * and the second is G1.8's acceptance:
   *
   *   - `jurisdictions` says where a clause may be USED, compared against the
   *     jurisdiction the letter is written for. A clause scoped to another
   *     country may be unenforceable here, or simply wrong, and including it
   *     quietly is worse than leaving a gap. A clause with no scope applies
   *     everywhere, which is how the catalogue reads the same field.
   *   - `governingLaw` / `courts` say what the clause SAYS, compared against
   *     where the ISSUING ENTITY is registered. The firm's real letter was
   *     issued by its US entity and named Indian law and Delhi courts; the
   *     first check could not have caught it, because that clause was
   *     applicable everywhere and every word of it was true — the letter was
   *     the wrong place for it.
   *
   * Only a clause that actually names a term is checked, and most name none.
   */
  async addClause(tenantId: string, letterId: string, clauseVersionId: string): Promise<void> {
    const letter = await this.editableOrThrow(tenantId, letterId);

    const pinned = await this.deps.library.readPinnedVersion(tenantId, clauseVersionId);
    if (pinned === null) throw new ClauseNotFound(clauseVersionId);
    if (pinned.kind !== "clause") throw new NotAClause(clauseVersionId, pinned.kind);
    if (pinned.status === "draft") throw new ClauseNotPublished(clauseVersionId);

    const body = readClauseBody(pinned.body);
    if (!clauseApplies(body.jurisdictions, letter.jurisdiction)) {
      throw new ClauseWrongJurisdiction(body.title, body.jurisdictions, letter.jurisdiction);
    }
    await this.refuseForeignTerms(tenantId, letter, body);

    await this.deps.letters.addClause({
      id: this.deps.ids.newId(),
      tenantId,
      engagementLetterId: letterId,
      clauseVersionId,
    });
  }

  /**
   * EVERY STANDARD TERM THAT FITS, in one call (T6.18, D6) — "Add all standard
   * terms for <entity>".
   *
   * Each published clause goes through `addClause` exactly as if it had been
   * added by hand, so the same rules decide: it must apply to the letter's
   * country, and its governing law and courts must be the ISSUER's
   * (`refuseForeignTerms`). What those rules refuse is not an error here but a
   * line in `skipped` with the refusal's own sentence, because "these did not
   * fit, and why" is the answer a person adding a whole set needs. A clause
   * already on the letter, in any version, is skipped too — never a second copy.
   * Draft only, like `addClause`.
   */
  async addStandardClauses(
    tenantId: string,
    letterId: string,
  ): Promise<{
    readonly added: readonly { readonly clauseKey: string; readonly clauseVersionId: string; readonly title: string }[];
    readonly skipped: readonly { readonly clauseKey: string; readonly reason: string }[];
  }> {
    await this.editableOrThrow(tenantId, letterId);
    const onLetter = new Set<string>();
    for (const c of await this.deps.letters.listClauses(tenantId, letterId)) {
      const pinned = await this.deps.library.readPinnedVersion(tenantId, c.clauseVersionId);
      if (pinned !== null) onLetter.add(pinned.key);
    }

    const added: { clauseKey: string; clauseVersionId: string; title: string }[] = [];
    const skipped: { clauseKey: string; reason: string }[] = [];
    // IN ORDER, one at a time: a clause's position is taken from what is
    // already on the letter.
    for (const clause of await this.deps.library.publishedClauses(tenantId)) {
      if (onLetter.has(clause.key)) {
        skipped.push({ clauseKey: clause.key, reason: "Already on this letter." });
        continue;
      }
      try {
        await this.addClause(tenantId, letterId, clause.versionId);
      } catch (err) {
        if (!(err instanceof EngagementError)) throw err;
        // The letter itself stopped being editable mid-way: that is not about
        // this clause, and the caller must hear it as the refusal it is.
        if (err.code === "LETTER_NOT_EDITABLE" || err.code === "LETTER_DELETED") throw err;
        skipped.push({ clauseKey: clause.key, reason: err.message });
        continue;
      }
      added.push({
        clauseKey: clause.key,
        clauseVersionId: clause.versionId,
        title: readClauseBody(clause.body).title,
      });
    }
    return { added, skipped };
  }

  /**
   * G1.8 — a letter issued by the US entity cannot print Indian governing law.
   *
   * Both terms are checked, because the firm stated the rule for both ("For US
   * it's US. For UAE it's DIFC in Dubai") and half the bug it caught was the
   * forum. The comparison is on the CODE; the prose beside it is what prints.
   *
   * THE LIMIT, stated rather than discovered: this makes a deliberate foreign
   * choice unrepresentable — an Indian entity contracting under English law, or
   * naming a neutral arbitral seat, is a real arrangement in cross-border work
   * and this refuses it. That is the firm's own rule applied as a product rule,
   * and it is the safer direction to be wrong in for now: a wrong law on an
   * issued document reached a client once already, and a refusal is visible in
   * a way a bad clause is not. Making the exception representable — a term the
   * letter records as chosen on purpose — is a decision nobody has taken, and
   * it belongs on the letter rather than here.
   *
   * An unregistered issuer is refused too; `IssuerJurisdictionUnknown` carries
   * the reasoning for the fail-closed direction.
   */
  private async refuseForeignTerms(
    tenantId: string,
    letter: EngagementLetter,
    body: ClauseBody,
  ): Promise<void> {
    const terms = [
      { term: "governing law", value: body.governingLaw },
      { term: "courts", value: body.courts },
    ] as const;
    const named = terms.filter((t) => t.value !== null);
    // The overwhelmingly common clause names neither, and asking the document
    // module where an entity is registered on every one of them would be a
    // query per clause to answer a question nobody asked.
    if (named.length === 0) return;

    const issuer = await this.deps.documents.issuerJurisdiction(
      tenantId,
      letter.issuingEntityPartyId,
    );
    if (issuer.jurisdiction === null) {
      throw new IssuerJurisdictionUnknown(body.title, issuer.displayName);
    }

    for (const { term, value } of named) {
      if (value !== null && value.jurisdiction !== issuer.jurisdiction) {
        throw new ClauseLawNotIssuers(body.title, term, value.jurisdiction, issuer.jurisdiction);
      }
    }
  }

  async describe(tenantId: string, letterId: string): Promise<LetterView> {
    const record = await this.deps.letters.describeLetter(tenantId, letterId);
    if (record === null) throw new LetterNotFound(letterId);
    // Two things the repository could not answer. What each engagement is doing
    // TODAY — the rows say when work begins, the clock says whether it has. And
    // the letter's own prose, which lives in the document module's table and is
    // reached through the same seam this use case already asks for references
    // and issuing entities.
    const blocks = await this.deps.documents.listBlocks(tenantId, {
      kind: "engagement_letter",
      id: letterId,
    });
    const request = await this.deps.signatures.findForLetter(tenantId, letterId);
    // Whether Delete would work (0086). Nothing depends on a draft letter, so
    // the letter alone answers it.
    const block = letterDeletionBlock(record.letter);
    const refusal = block === null ? null : letterDeletionRefusal(record.letter.ref, block);
    // HOW ANNEXURE 1 IS ORGANISED, by the same function the PDF is drawn
    // with (T6.18 S6), so the in-app preview letters and numbers exactly as the
    // paper does.
    const document = planAnnexure({
      letterEffectiveFrom: record.letter.effectiveFrom,
      feeGroups: record.feeGroups.map((g) => g.group),
      lines: record.lines.map((l) => ({
        id: l.line.id,
        position: l.line.position,
        feeGroupId: l.line.feeGroupId,
        entityPartyId: l.line.entityPartyId,
        entityName: l.entity?.displayName ?? l.line.entityPartyId,
        serviceVersionId: l.line.serviceVersionId,
        description: l.line.description,
        terms: l.terms,
        billingFrequency: l.line.billingFrequency,
        effectiveFrom: l.line.effectiveFrom,
        net: l.net,
        pricingNote: l.line.pricingNote,
        oopEstimate: l.line.oopEstimate,
      })),
    });
    return {
      ...record,
      document,
      engagements: await this.withState(tenantId, record.engagements),
      blocks,
      signing: {
        provider: this.deps.esign.method,
        sends: this.deps.dispatch !== null,
        request,
      },
      deleteRefusal: refusal === null ? null : { code: refusal.code, message: refusal.message },
      recordedAcceptance: await this.deps.letters.findRecordedAcceptance(tenantId, record.letter.id),
      // Whether Copy would work (0316): the same test `copyAsDraft` makes.
      copyRefusal: (() => {
        const letter = record.letter;
        const refused =
          letter.deletedAt !== null
            ? new LetterDeleted(letter.ref)
            : isLetterCopyable(letter.status)
              ? null
              : new LetterNotCopyable(letter.ref, letter.status);
        return refused === null ? null : { code: refused.code, message: refused.message };
      })(),
    };
  }

  /**
   * Delete a DRAFT made by mistake (0086) — off the list of letters, still
   * readable by id, and final.
   *
   * Only a draft: a letter the client has seen is WITHDRAWN, which keeps the
   * record that it was offered, and a signed one is the agreement itself.
   * Nothing can depend on a draft letter, so there is nothing else to ask. The
   * trigger under this (`trg_el_guard_deletion`) holds the same rule for the
   * writers that do not come through here.
   */
  async delete(tenantId: string, letterId: string, actor: Actor): Promise<EngagementLetter> {
    const letter = await this.findOrThrow(tenantId, letterId);
    const block = letterDeletionBlock(letter);
    if (block !== null) throw letterDeletionRefusal(letter.ref, block);

    const deleted = await this.deps.letters.markDeleted(
      tenantId,
      letterId,
      actor.type === "human" ? actor.id : null,
    );
    if (deleted === null) {
      // Sent, or deleted by somebody else, between the read and the write: the
      // WHERE clause refused it, and the letter as it now stands says which.
      const current = await this.findOrThrow(tenantId, letterId);
      const late = letterDeletionBlock(current);
      throw late === null
        ? new LetterDeleted(current.ref)
        : letterDeletionRefusal(current.ref, late);
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.deleted",
      objectId: letter.id,
      actor,
      payload: { ref: letter.ref, partyId: letter.partyId },
    });
    return deleted;
  }

  async list(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    return this.deps.letters.listLetters(tenantId, filters);
  }

  /**
   * Send it for signature. Refuses a letter that commits nobody to anything,
   * and one with no terms at all.
   *
   * THIS IS ALSO WHERE THE FIRM SIGNS. A real engagement letter goes out
   * already carrying "Yours sincerely, <name>, Director" and comes back with
   * the client's acceptance underneath it — the firm commits first, which is
   * what makes it an offer the client can accept. So the firm's block is
   * snapshotted here, from the standing signatory on the tenant, and is frozen
   * with everything else once the client signs.
   *
   * A firm that has named NO signatory still sends: the block does not print,
   * exactly as today. Refusing would be defensible — a letter with a blank
   * signature block is not really a letter — but it would lock every existing
   * firm out of a flow they use now, and that is a product decision nobody has
   * made. It is recorded as an open question rather than assumed here.
   */
  async send(
    tenantId: string,
    letterId: string,
    actor: Actor,
    options: SendOptions = {},
  ): Promise<EngagementLetter> {
    // `editableOrThrow` is the whole gate: a letter is editable only while it is
    // a draft, and a draft's only forward move is `sent`. A second
    // `canTransition` check here would be unreachable.
    const letter = await this.editableOrThrow(tenantId, letterId);
    await this.requireCompleteTerms(tenantId, letterId);
    // THE DATE ON THE LETTER, when the drafter left it blank: the caller's
    // today, or the firm's. It was Greenwich's, which dated a letter sent at
    // 01:00 in Delhi the day before it went out. Settled before anything is
    // written, so a refused asOf leaves nothing behind.
    const issuedOn = await this.callersDay(tenantId, options.asOf);

    // WHOM TO ASK, recorded BEFORE the letter is marked sent. The other order
    // could leave a letter `sent` through DocuSign with nobody on record to
    // ask, and nothing could ever raise its envelope. This order can at worst
    // leave a request row beside a DRAFT, which the sweep never reads (it asks
    // only about raised envelopes) and the next send overwrites.
    const dispatch = options.migrated === true ? null : this.deps.dispatch;
    const request =
      dispatch === null
        ? null
        : await this.deps.signatures.open({
            id: this.deps.ids.newId(),
            tenantId,
            letterId: letter.id,
            provider: dispatch.method,
            signer: signerOrThrow(options.signer),
            requestedBy: actor.type === "human" ? actor.id : null,
          });

    const at = this.deps.clock.now().toISOString();
    const standing = await this.deps.firm.firmSignatory(tenantId);
    // THE MARK IS RESOLVED HERE AND PINNED, never looked up when the PDF is
    // drawn (0081). Only when there IS a signatory: the firm's block prints on
    // the strength of the signatory row, so with no signatory there is no block
    // to draw a mark on and the lookup would answer a question nobody asked.
    const firm: FirmSignatureRecord | null =
      standing === null
        ? null
        : {
            userId: standing.userId,
            title: standing.title,
            signedAt: at,
            signatureVersionId: await this.deps.firmSignatureImage.activeSignatureVersion(
              tenantId,
              letter.issuingEntityPartyId,
            ),
          };

    const sent = await this.deps.letters.markSent(tenantId, letter.id, at, issuedOn, firm);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.sent",
      objectId: letter.id,
      actor,
      // WHO BOUND THE FIRM, beside the actor rather than instead of it. The
      // actor is whoever pressed send — that is who OPERATED the system, and
      // the ledger has always recorded it. This is a different question, and
      // the one an audit asks: on whose authority did the firm commit? A single
      // field could not answer both, because they are routinely two people.
      payload: {
        partyId: letter.partyId,
        jurisdiction: letter.jurisdiction,
        issuedOn: sent.issuedOn,
        firmSignatoryUserId: sent.firmSignatoryUserId,
        firmSignatoryTitle: sent.firmSignatoryTitle,
        // Which provider will ask for the signature, or null when a person
        // records it afterwards. The provider's NAME, never the signer's.
        signatureProvider: request === null ? null : request.provider,
      },
    });

    // THE ENVELOPE, raised now so the client hears about it now. A provider
    // fault does NOT undo the send: the letter's terms are frozen and its date
    // is set whether or not DocuSign answered, and pretending otherwise would
    // mean a letter that is `sent` in every respect but one. The fault is kept
    // on the request, the letter page says so, and `retrySignatureRequest`
    // tries again.
    if (request !== null) await this.raise(request, actor).catch(() => undefined);
    return sent;
  }

  /**
   * Raise the envelope for a sent letter whose first attempt failed.
   *
   * Throws the provider's fault this time rather than keeping it quiet: the
   * person pressed a button to find out, and "it failed again, here is why" is
   * the answer. The fault is also kept on the request, as on the first try.
   */
  async retrySignatureRequest(
    tenantId: string,
    letterId: string,
    actor: Actor,
  ): Promise<SignatureRequest> {
    const letter = await this.findOrThrow(tenantId, letterId);
    const request = await this.deps.signatures.findForLetter(tenantId, letterId);
    if (request === null) {
      throw new SignatureRequestNotPending(
        letterId,
        "it was never sent through a provider that asks for signatures",
      );
    }
    if (letter.status !== "sent") {
      throw new SignatureRequestNotPending(letterId, `the letter is ${letter.status}`);
    }
    if (request.envelopeId !== null) {
      throw new SignatureRequestNotPending(
        letterId,
        `envelope ${request.envelopeId} is already with the client`,
      );
    }
    return this.raise(request, actor);
  }

  /**
   * One attempt at the envelope, under a claim so two callers cannot both send
   * the client one. Resolves with the request as it now stands; rejects with
   * the fault after recording it.
   */
  private async raise(request: SignatureRequest, actor: Actor): Promise<SignatureRequest> {
    const dispatch = this.deps.dispatch;
    const pdf = this.deps.letterPdf;
    if (dispatch === null || pdf === null) {
      // Not a fault anybody can fix from a screen: the process was composed
      // without a way to send. The worker is composed that way on purpose,
      // and nothing in it calls this.
      throw new Error(
        "EngagementService.raise was called in a process composed with no signature dispatch " +
          "or no letter renderer. The API wires both when BIB_ESIGN_PROVIDER sends; the worker " +
          "wires neither and must never raise an envelope.",
      );
    }
    const now = this.deps.clock.now();
    const claimed = await this.deps.signatures.claim(
      request.tenantId,
      request.id,
      now.toISOString(),
      new Date(now.getTime() - RAISE_LEASE_MS).toISOString(),
    );
    if (claimed === null) {
      // Raised already, or somebody else is raising it this minute. Either way
      // the answer is whatever the row says now.
      return (await this.deps.signatures.findForLetter(request.tenantId, request.letterId)) ?? request;
    }

    try {
      const letter = await this.findOrThrow(claimed.tenantId, claimed.letterId);
      if (letter.status !== "sent") {
        throw new SignatureRequestNotPending(letter.id, `the letter is ${letter.status}`);
      }
      // THE SAME HASH `sign()` will compute, over the same frozen terms. That
      // is the binding: the verifier refuses an envelope whose stamped hash is
      // not the letter's, so the two must be one function of one state.
      const contentHash = await this.contentHashOf(letter);
      const envelopeId =
        (await dispatch.findForLetter(letter.id, claimed.createdAt)) ??
        (
          await dispatch.raise({
            letterId: letter.id,
            ref: letter.ref,
            title: letter.title,
            contentHash,
            signer: claimed.signer,
            document: await pdf.render(letter.tenantId, letter.id),
          })
        ).envelopeId;

      const raised = await this.deps.signatures.recordRaised(
        claimed.tenantId,
        claimed.id,
        envelopeId,
        this.deps.clock.now().toISOString(),
      );
      await this.deps.events.recordEvent({
        tenantId: letter.tenantId,
        verb: "engagement_letter.signature_requested",
        objectId: letter.id,
        actor,
        payload: { provider: dispatch.method, envelopeId },
      });
      return raised;
    } catch (err) {
      await this.deps.signatures.recordFailure(
        claimed.tenantId,
        claimed.id,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * THE SIGNATURE SWEEP. Asks the provider about every envelope still out, and
   * acts on the three answers that end one: completed signs the letter,
   * declined and voided withdraw it. Anything else — sent, delivered, partly
   * signed — waits for the next pass.
   *
   * THE SIGNATURE ITSELF STILL GOES THROUGH `sign()`, and so through the
   * verifier: status, content hash, letter id and a recipient who signed are
   * all checked again. The sweep is how the product LEARNS an envelope
   * finished; it is never a second way to record a signature.
   *
   * Per firm, and one firm's fault never stops the others — the rule every
   * sweep here follows since T3.1.
   */
  async settleSignatures(): Promise<readonly SignatureSweepReport[]> {
    if (this.deps.dispatch === null) return [];
    const reports: SignatureSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        reports.push(await this.settleTenant(tenantId, this.deps.dispatch));
      } catch (err) {
        reports.push({
          tenantId,
          signed: 0,
          withdrawn: 0,
          stillOut: 0,
          copiesFiled: 0,
          failed: [],
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  private async settleTenant(
    tenantId: string,
    dispatch: SignatureDispatch,
  ): Promise<SignatureSweepReport> {
    let signed = 0;
    let withdrawn = 0;
    let stillOut = 0;
    const failed: { letterId: string; reason: string }[] = [];

    for (const request of await this.deps.signatures.listAwaiting(tenantId)) {
      // `listAwaiting` returns only raised requests; the guard is for the type.
      if (request.envelopeId === null) continue;
      try {
        const letter = await this.findOrThrow(tenantId, request.letterId);
        // Settled by hand while the envelope was out — withdrawn by a person,
        // or signed through the form with this envelope's id. The request
        // records what happened to the LETTER, so it stops being asked about.
        if (letter.status !== "sent") {
          await this.deps.signatures.settle(
            tenantId,
            request.id,
            letter.status === "signed" ? "completed" : "voided",
            this.deps.clock.now().toISOString(),
          );
          continue;
        }

        const progress = await dispatch.progress(request.envelopeId);
        if (progress.state === "out") {
          stillOut += 1;
          continue;
        }
        // Reported and left alone: a wrong account must not withdraw every
        // letter out for signature. A person withdraws it if it truly is gone.
        if (progress.state === "missing") {
          failed.push({
            letterId: letter.id,
            reason:
              `${dispatch.method} holds no envelope ${request.envelopeId} in the account this ` +
              `server signs in to, so the letter was left as it is. If the account or key ` +
              `changed since it was sent, point them back; if the envelope was purged, withdraw ` +
              `the letter by hand.`,
          });
          continue;
        }
        if (progress.state === "completed") {
          await this.sign(
            {
              tenantId,
              letterId: letter.id,
              // The person the provider asked is the person who signed — the
              // provider refuses to complete an envelope otherwise.
              signedByName: request.signer.name,
              reference: request.envelopeId,
            },
            SYSTEM_ACTOR,
          );
          signed += 1;
        } else {
          await this.withdrawFor(letter, progress.state, SYSTEM_ACTOR);
          withdrawn += 1;
        }
        await this.deps.signatures.settle(
          tenantId,
          request.id,
          progress.state,
          this.deps.clock.now().toISOString(),
        );
      } catch (err) {
        failed.push({
          letterId: request.letterId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // THE SIGNED COPIES, in a pass of their own rather than inside the one
    // above: a letter signed through the form with an envelope id, or one
    // whose copies failed to file last time, is found here too, and a fault
    // fetching a PDF must never be able to stop a signature being recorded.
    const copiesFiled = await this.fileSignedCopies(tenantId, dispatch, failed);
    return { tenantId, signed, withdrawn, stillOut, copiesFiled, failed };
  }

  /**
   * Fetch the provider's signed PDF and certificate for every signed letter
   * whose copies bib does not yet hold, and file them. BOTH are fetched before
   * EITHER is filed, so a provider fault half way leaves nothing filed and the
   * next pass starts clean rather than filing the letter twice.
   */
  private async fileSignedCopies(
    tenantId: string,
    dispatch: SignatureDispatch,
    failed: { letterId: string; reason: string }[],
  ): Promise<number> {
    const filer = this.deps.signedCopies;
    if (filer === null) return 0;
    let filed = 0;
    for (const request of await this.deps.signatures.listUnfiled(tenantId)) {
      if (request.envelopeId === null) continue;
      try {
        const letter = await this.findOrThrow(tenantId, request.letterId);
        const copies = await dispatch.signedCopies(request.envelopeId);
        await filer.file({
          tenantId,
          letterId: letter.id,
          partyId: letter.partyId,
          title: `${letter.ref} — signed by ${request.signer.name}`,
          which: "signed",
          document: copies.signed,
        });
        await filer.file({
          tenantId,
          letterId: letter.id,
          partyId: letter.partyId,
          title: `${letter.ref} — ${dispatch.method} certificate of completion`,
          which: "certificate",
          document: copies.certificate,
        });
        await this.deps.signatures.recordCopiesFiled(
          tenantId,
          request.id,
          this.deps.clock.now().toISOString(),
        );
        filed += 1;
      } catch (err) {
        failed.push({
          letterId: request.letterId,
          reason:
            `signed, but the signed copy is not filed yet: ` +
            (err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return filed;
  }

  private async contentHashOf(letter: EngagementLetter): Promise<string> {
    const [lines, clauses, feeGroups] = await this.requireCompleteTerms(
      letter.tenantId,
      letter.id,
    );
    return this.deps.hasher.hash(canonicalContent({ letter, lines, feeGroups, clauses }));
  }

  /**
   * Pull it before signature.
   *
   * WITH AN ENVELOPE OUT, THE PROVIDER IS ASKED FIRST. The client may have
   * finished signing a minute ago and the sweep not yet noticed — withdrawing
   * then would discard a real signature, so it is refused and the sweep records
   * it. Otherwise the envelope is voided BEFORE the letter moves: a withdrawn
   * letter whose envelope the client can still sign is a contract the firm
   * thinks it pulled. If the void fails, nothing is withdrawn and the provider's
   * fault is the answer.
   */
  async withdraw(tenantId: string, letterId: string, actor: Actor): Promise<EngagementLetter> {
    const letter = await this.findOrThrow(tenantId, letterId);
    // A deleted draft is final (0086): it was never offered, so there is
    // nothing to pull.
    if (letter.deletedAt !== null) throw new LetterDeleted(letter.ref);
    const request = await this.deps.signatures.findForLetter(tenantId, letterId);
    const dispatch = this.deps.dispatch;
    if (
      dispatch === null ||
      request === null ||
      request.envelopeId === null ||
      request.outcome !== null ||
      letter.status !== "sent"
    ) {
      return this.withdrawFor(letter, null, actor);
    }

    const progress = await dispatch.progress(request.envelopeId);
    if (progress.state === "completed") throw new EnvelopeAlreadySigned(request.envelopeId);
    if (progress.state === "out") {
      await dispatch.void(request.envelopeId, `${letter.ref} was withdrawn by the firm`);
    }
    // A person pulling the letter: `out` was just voided and `missing` has
    // nothing left to void, so both are the firm's decision, not the client's.
    const byTheFirm = progress.state === "out" || progress.state === "missing";
    const withdrawn = await this.withdrawFor(
      letter,
      byTheFirm ? null : progress.state,
      actor,
    );
    await this.deps.signatures.settle(
      tenantId,
      request.id,
      byTheFirm ? "voided" : progress.state,
      this.deps.clock.now().toISOString(),
    );
    return withdrawn;
  }

  /** Withdrawing, by a person or because the client's envelope ended without a
   *  signature. `signatureOutcome` is the provider's reason, and it is on the
   *  event so "why was this pulled" is answerable without the request row. */
  private async withdrawFor(
    letter: EngagementLetter,
    signatureOutcome: Exclude<SignatureOutcome, "completed"> | null,
    actor: Actor,
  ): Promise<EngagementLetter> {
    if (!canTransition(letter.status, "withdrawn")) {
      throw new InvalidLetterTransition(letter.status, "withdrawn");
    }
    const withdrawn = await this.moveTo(letter, "withdrawn");
    await this.deps.events.recordEvent({
      tenantId: letter.tenantId,
      verb: "engagement_letter.withdrawn",
      objectId: letter.id,
      actor,
      payload: {
        partyId: letter.partyId,
        wasStatus: letter.status,
        ...(signatureOutcome === null ? {} : { signatureOutcome }),
      },
    });
    return withdrawn;
  }

  /**
   * THE SIGNATURE, and the fan-out it causes.
   *
   * The hash is computed over the canonical rendering BEFORE the provider is
   * called, so what the provider is asked to sign and what is stored are the
   * same bytes. The provider call comes next, and if it throws nothing is
   * written — a letter must never be recorded as signed because a vendor call
   * failed quietly.
   */
  async sign(
    input: SignInput,
    actor: Actor,
  ): Promise<{ letter: EngagementLetter; engagements: readonly EngagementRecord[] }> {
    const letter = await this.findOrThrow(input.tenantId, input.letterId);
    if (!canTransition(letter.status, "signed")) {
      throw new InvalidLetterTransition(letter.status, "signed");
    }
    if (input.signedByName.trim() === "") throw new SignatureIncomplete("a signatory's name");
    // The signature's day, settled before the provider is asked anything. It
    // is the caller's today, or the firm's: never Greenwich's, which started
    // work signed at 01:00 in Delhi on the day before.
    const signatureDay = await this.callersDay(input.tenantId, input.asOf);

    const [lines, clauses, feeGroups] = await this.requireCompleteTerms(
      input.tenantId,
      input.letterId,
    );

    const contentHash = this.deps.hasher.hash(
      canonicalContent({ letter, lines, feeGroups, clauses }),
    );
    const recorded = input.recorded ?? null;
    const signer =
      input.migrated === true || recorded !== null ? this.deps.migrationSigner : this.deps.esign;
    const signatureMethod = recorded !== null ? RECORDED_ACCEPTANCE_METHOD : signer.method;
    const provider = await signer.sign({
      tenantId: input.tenantId,
      letterId: input.letterId,
      signedByName: input.signedByName.trim(),
      contentHash,
      reference: input.reference,
    });

    const at = this.deps.clock.now().toISOString();
    // WHEN THE WORK BEGINS, resolved once per line and then stored. Null on the
    // line means the letter's date; null on the letter means today's signature.
    // Resolved HERE rather than read back through two joins later, because the
    // letter freezes at this moment and the answer can therefore never change.
    // The fee gate, decided ONCE by the domain and carried into every
    // engagement the letter creates.
    //
    // The DATE gate is deliberately not a second status. `active` means the
    // commercial gate is open — signed (since 0322 the advance holds nothing);
    // whether work has STARTED is `effectiveFrom` against the calendar,
    // reported as `pending_start` by `engagementState`. Storing that as a
    // status would need something to move the row on the day, and nothing here
    // runs on a timer: a state nothing can leave is worse than a date nothing
    // has reached. See migration 0022.
    // BOTH parties, and from different places on purpose. The CLIENT comes from
    // the letter — it is who the firm is billing, and it is the same for every
    // line. The ENTITY comes from the LINE, because an engagement is
    // `service × one legal entity`: a letter covering a group's four companies
    // fans out into four engagements that differ in exactly this field, and
    // taking it from the letter instead would make them indistinguishable.
    const engagements: NewEngagement[] = lines.map((line) => ({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      engagementLetterId: letter.id,
      engagementLetterLineId: line.id,
      partyId: letter.partyId,
      entityPartyId: line.entityPartyId,
      // Every engagement starts active (0322): the advance, the letter's or a
      // service's own, is drafted and chased, and holds no work.
      status: "active" as const,
      activatedAt: at,
      effectiveFrom: resolveEffectiveFrom(
        line.effectiveFrom,
        letter.effectiveFrom,
        signatureDay,
      ),
    }));

    const result = await this.deps.letters.signAndFanOut(
      input.tenantId,
      letter.id,
      {
        signedAt: at,
        signedByName: input.signedByName.trim(),
        signedByTitle: blankToNull(input.signedByTitle),
        signatureMethod,
        signatureReference: provider.reference,
        signedContentHash: contentHash,
      },
      engagements,
      recorded,
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement_letter.signed",
      objectId: letter.id,
      actor,
      // The METHOD and the HASH, never the signatory's name: that is personal
      // data and it lives in the erasable row. The hash is what makes the log
      // useful years later — it says which document was signed, verifiably,
      // without containing it.
      payload: {
        ref: letter.ref,
        partyId: letter.partyId,
        issuingEntityPartyId: letter.issuingEntityPartyId,
        signatureMethod,
        contentHash,
        engagementCount: result.engagements.length,
        advanceRequired: letter.advanceRequired,
        // HOW, never who at the client or what they said (0317): those are in
        // the erasable evidence row.
        ...(recorded === null
          ? {}
          : {
              via: "recorded",
              channel: recorded.channel,
              recordedAcceptanceId: recorded.id,
            }),
      },
    });

    // One `contract.activated` per engagement — the scheduler consumes these
    // from T2.4, and spawns the work the letter agreed (0322: at once).
    for (const engagement of result.engagements) {
      if (engagement.status === "active") await this.recordActivation(engagement, actor);
    }
    // The letter's billing terms, for the work that started today.
    await this.scheduleGoLive(
      input.tenantId,
      result.engagements.filter((e) => e.status === "active").map((e) => e.id),
      signatureDay,
      actor,
    );
    // The advance (0320, 0322): a bill, and its tax invoice drafted at once.
    if (letter.advanceRequired || lines.some((l) => l.advanceAmount !== null)) {
      await this.billAdvances(input.tenantId, letter.id, actor);
    }
    return {
      letter: result.letter,
      engagements: await this.withState(input.tenantId, result.engagements),
    };
  }

  /**
   * Ask the billing desk for the advance bill(s) a signed letter owes and
   * their draft invoices (0320, 0322). After the signature is committed and
   * never undoing it, for the reason `scheduleGoLive` gives: if it fails, the
   * daily catch-up writes and drafts it, and the work has started either way.
   */
  private async billAdvances(tenantId: string, letterId: string, actor: Actor): Promise<void> {
    const billing = this.deps.advanceBilling ?? null;
    if (billing === null) return;
    try {
      await billing.billAdvances({ tenantId, letterId }, actor);
    } catch {
      // Deliberately swallowed: see above.
    }
  }

  /**
   * Ask the billing desk to schedule the engagements that went live on
   * `liveOn` (0319). AFTER the signature or the advance is committed, and it
   * never undoes either: if it fails, those engagements are simply not
   * scheduled and wait on "Billing not set up", which is the state a person
   * already deals with. A failed bill schedule must not read as a failed
   * signature, which the client has already given.
   */
  private async scheduleGoLive(
    tenantId: string,
    engagementIds: readonly string[],
    liveOn: string,
    actor: Actor,
  ): Promise<void> {
    const billing = this.deps.goLiveBilling ?? null;
    if (billing === null || engagementIds.length === 0) return;
    try {
      await billing.scheduleActivated({ tenantId, engagementIds, liveOn }, actor);
    } catch {
      // Deliberately swallowed: see above. The engagements stay unscheduled.
    }
  }

  /**
   * The client accepted the letter OUTSIDE bib — by email, on a call — and a
   * colleague holding `acceptance:record` records it (0317, decided
   * 2026-09-30). The route carries the permission; this carries the rules.
   *
   * A letter is the contract, so the client's own email or letter must be
   * FILED against it first; the check is asked before anything else moves.
   * Only a SENT letter. When an envelope is still out with the provider it is
   * VOIDED first, so the client cannot also sign it, and the request settled;
   * one the provider reports signed is refused and left for the sweep, which
   * will record the real signature. Then the letter is signed through the
   * ordinary path — the hash, the freeze, the fan-out, the advance gate — under
   * the method `recorded_acceptance`, with the evidence in the same transaction.
   *
   * The one window left, stated: between the void and the settle a sweep that
   * reads the envelope as voided would withdraw the letter. The two are one
   * call apart, and the sweep runs every five minutes.
   */
  async recordAcceptance(
    input: RecordAcceptanceInput,
    recordedByUserId: string,
    actor: Actor,
  ): Promise<{ letter: EngagementLetter; engagements: readonly EngagementRecord[] }> {
    const letter = await this.findOrThrow(input.tenantId, input.letterId);
    if (letter.deletedAt !== null) throw new LetterDeleted(letter.ref);
    if (letter.status !== "sent") throw new InvalidLetterTransition(letter.status, "signed");

    const today = await this.callersDay(input.tenantId, input.asOf);
    const zone = await this.deps.timeZones.timeZoneFor(input.tenantId);
    const evidence = checkAcceptance(input.statement, {
      today,
      sentOn: letter.sentAt === null ? null : dayInZone(letter.sentAt, zone),
      needsEvidence: true,
    });
    const documentId = evidence.evidenceDocumentId ?? "";
    if (!(await this.deps.letters.isFiledAgainst(input.tenantId, letter.id, documentId))) {
      throw new EvidenceNotFiledHere(documentId);
    }

    const request = await this.deps.signatures.findForLetter(input.tenantId, letter.id);
    const dispatch = this.deps.dispatch;
    if (request !== null && request.outcome === null) {
      if (dispatch !== null && request.envelopeId !== null) {
        const progress = await dispatch.progress(request.envelopeId);
        if (progress.state === "completed") throw new EnvelopeAlreadySigned(request.envelopeId);
        if (progress.state === "out") {
          await dispatch.void(
            request.envelopeId,
            `${letter.ref}: the client accepted it outside ${dispatch.method}, and the firm recorded that`,
          );
        }
      }
      await this.deps.signatures.settle(
        input.tenantId,
        request.id,
        "voided",
        this.deps.clock.now().toISOString(),
      );
    }

    const id = this.deps.ids.newId();
    const signed = await this.sign(
      {
        tenantId: input.tenantId,
        letterId: letter.id,
        signedByName: evidence.acceptedByName,
        signedByTitle: evidence.acceptedByTitle ?? undefined,
        // The thread back to the evidence, in words: the row holds the rest.
        reference: `Accepted by ${evidence.channel} on ${evidence.acceptedOn}; recorded by the firm`,
        asOf: input.asOf,
        recorded: { ...evidence, id, tenantId: input.tenantId, recordedByUserId },
      },
      actor,
    );
    return signed;
  }

  /**
   * WORK SIGNED BEFORE 0322 THAT STILL WAITS ON ITS ADVANCE STARTS (the user,
   * 2026-10-02: the letters stuck at deploy get "kaam shuru + draft"). The
   * billing catch-up calls this, then drafts the advance. Each engagement
   * records its `contract.activated` (the scheduler spawns its work) and its
   * billing is scheduled from today: billing from the signature would bill
   * months nobody worked. `status = 'pending_advance'` in the write is the
   * lock, so a second call starts nothing and records nothing.
   */
  async startWaitingWork(tenantId: string, letterId: string, actor: Actor): Promise<{ readonly started: number }> {
    const letter = await this.findOrThrow(tenantId, letterId);
    const waiting = (await this.deps.letters.listEngagements(tenantId, letterId))
      .filter((e) => e.status === "pending_advance")
      .map((e) => e.id);
    if (waiting.length === 0) return { started: 0 };
    const at = this.deps.clock.now().toISOString();
    const released = await this.deps.letters.releaseEngagements(tenantId, waiting, at);
    if (released.length === 0) return { started: 0 };
    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.work_started_before_advance",
      objectId: letter.id,
      actor,
      payload: { partyId: letter.partyId, startedEngagements: released.length },
    });
    for (const engagement of released) await this.recordActivation(engagement, actor);
    await this.scheduleGoLive(
      tenantId,
      released.map((e) => e.id),
      await this.firmDay(tenantId),
      actor,
    );
    return { started: released.length };
  }

  /**
   * What this client can be billed for, with the terms its letters agreed
   * (T3.5b).
   *
   * ── THE OTHER HALF OF THE CARRY-FORWARD, AND IT IS A READ ───────────────
   *
   * The walk found the letter's agreed price reaching nothing: the invoice line
   * had no catalogue picker and no link to the letter, so the same figure was
   * typed a third time. `crm.invoice_line.engagement_id` has existed since T3.4
   * with nothing offering it — this is the read that lets a screen offer it,
   * with the agreed price beside each one.
   *
   * A READ rather than a "raise an invoice from this letter" write, and that is
   * the design: a letter is the whole contract and an invoice bills a PERIOD of
   * it. Which period, which of the client's companies and which services go on
   * one document are decisions somebody takes every month, so a bulk act would
   * produce a document nobody chose the shape of and the firm would edit it
   * back down — more typing than it saved.
   *
   * EVERY engagement comes back, including the ones that cannot be billed yet:
   * `pending_advance` means work signed before 0322 that still waits on its
   * advance. Filtering them out here would leave a screen unable to explain
   * why a service the client signed for is missing from the picker, which is
   * the blank-versus-absent failure this codebase has now paid for several
   * times. The caller decides what to OFFER; this says what is true.
   */
  async billableFor(tenantId: string, partyId: string): Promise<readonly BillableEngagement[]> {
    return this.deps.letters.listBillable(tenantId, partyId);
  }

  async listEngagements(tenantId: string, letterId: string): Promise<readonly EngagementRecord[]> {
    await this.findOrThrow(tenantId, letterId);
    return this.withState(tenantId, await this.deps.letters.listEngagements(tenantId, letterId));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** The stored rows, each narrowed against today. The clock lives here and
   *  nowhere below: repositories return what is stored, and "has this started
   *  yet" is a rule. Today is the FIRM's, the calendar `effectiveFrom` was
   *  set on: on Greenwich's, work signed at 01:00 in Delhi read "not started"
   *  until 05:30. */
  private async withState(
    tenantId: string,
    engagements: readonly Engagement[],
  ): Promise<readonly EngagementRecord[]> {
    const today = await this.firmDay(tenantId);
    return engagements.map((engagement) => ({
      engagement,
      state: engagementState(engagement, today),
    }));
  }

  /** Today on the firm's calendar (0071). */
  private async firmDay(tenantId: string): Promise<string> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    return dayInZone(this.deps.clock.now().toISOString(), zone);
  }

  /**
   * Today as the caller sees it, for the two moments that stamp a day on a
   * letter: sending (its date) and signing (the day its work starts, when
   * nothing else says). The caller's `asOf` (the browser's local day), else the
   * firm's day, never the server's. `asOf` is held to the firm's day or one
   * either side (`isCallersToday`): it says what day it is, it does not choose
   * one. Invoices and proposals answer the same question the same way.
   */
  private async callersDay(tenantId: string, asOf: string | undefined): Promise<string> {
    const firmDay = await this.firmDay(tenantId);
    if (asOf === undefined) return firmDay;
    if (!isCallersToday(asOf, firmDay)) throw new LetterNotCallersToday(asOf, firmDay);
    return asOf;
  }

  /**
   * The letter being replaced must be one the client actually signed, and must
   * not already have a live replacement.
   *
   * Both are enforced in the database too (a trigger and a partial unique
   * index, 0022) — this is here so the caller gets a sentence naming what to do
   * instead, rather than a constraint name.
   */
  private async requireSupersedable(tenantId: string, letterId: string): Promise<void> {
    const target = await this.deps.letters.findLetter(tenantId, letterId);
    if (target === null) throw new LetterNotFound(letterId);
    if (target.status !== "signed") throw new LetterNotSupersedable(target.status);
    const existing = await this.deps.letters.findSuccessor(tenantId, letterId);
    if (existing !== null) throw new AlreadySuperseded(existing.ref);
  }

  private async findOrThrow(tenantId: string, letterId: string): Promise<EngagementLetter> {
    const letter = await this.deps.letters.findLetter(tenantId, letterId);
    if (letter === null) throw new LetterNotFound(letterId);
    return letter;
  }

  /** Everything that CHANGES a letter's terms goes through here, so a method
   *  added later cannot forget the rule. */
  private async editableOrThrow(tenantId: string, letterId: string): Promise<EngagementLetter> {
    const letter = await this.findOrThrow(tenantId, letterId);
    // Deleted first: a deleted letter is always a draft (0086), and "only a
    // draft can be changed" would be the wrong sentence to meet.
    if (letter.deletedAt !== null) throw new LetterDeleted(letter.ref);
    if (!isEditable(letter.status)) throw new LetterNotEditable(letter.status);
    return letter;
  }

  /**
   * A letter needs both halves before anyone is asked to sign it.
   *
   * No lines commits nobody to anything. No clauses is the dangerous one: a
   * signed contract with no terms is enforceable as whatever a court reads into
   * it, and that failure is silent at exactly the moment it is expensive.
   */
  private async requireCompleteTerms(
    tenantId: string,
    letterId: string,
  ): Promise<[readonly LetterLine[], readonly LetterClause[], readonly FeeGroup[]]> {
    const [lines, clauses, feeGroups] = await Promise.all([
      this.deps.letters.listLines(tenantId, letterId),
      this.deps.letters.listClauses(tenantId, letterId),
      this.deps.letters.listFeeGroups(tenantId, letterId),
    ]);
    if (lines.length === 0) throw new EmptyLetter();
    if (clauses.length === 0) throw new NoClauses();
    // A fee for nothing (0083). The Summary of Fees would print a charge that
    // no service on the letter explains.
    const empty = feeGroups.find((g) => !lines.some((l) => l.feeGroupId === g.id));
    if (empty !== undefined) throw new FeeGroupEmpty(empty.title);
    return [lines, clauses, feeGroups];
  }

  private async moveTo(
    letter: EngagementLetter,
    to: LetterStatus,
  ): Promise<EngagementLetter> {
    if (!canTransition(letter.status, to)) {
      throw new InvalidLetterTransition(letter.status, to);
    }
    return this.deps.letters.setStatus(
      letter.tenantId,
      letter.id,
      to,
      this.deps.clock.now().toISOString(),
    );
  }

  /** The spawn trigger. One per engagement, and only for engagements that are
   *  actually released — this is the event T2.4's scheduler consumes. */
  private async recordActivation(engagement: Engagement, actor: Actor): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId: engagement.tenantId,
      verb: "contract.activated",
      objectId: engagement.id,
      actor,
      payload: {
        engagementLetterId: engagement.engagementLetterId,
        engagementLetterLineId: engagement.engagementLetterLineId,
        partyId: engagement.partyId,
        // THE ENTITY, on the trigger itself. This is the event T2.4's scheduler
        // consumes and T3.2's calendar generates from, and an obligation
        // attaches to an entity — an entity owes GSTR-3B, a client does not.
        // A consumer that had to join back to the line to find out which
        // company it was scheduling for would be reading the one fact the
        // trigger exists to deliver out of a second table.
        entityPartyId: engagement.entityPartyId,
        // AND THE DATE THE WORK BEGINS (G1.5). This event fires when the
        // COMMERCIAL gates open, which is not always when work starts: a letter
        // signed in September can open engagements that begin in October.
        //
        // It is emitted then rather than held until the date, deliberately.
        // Holding it would need a timer this service does not have, and would
        // leave a September-signed October engagement invisible to the delivery
        // lane with nothing to make it visible later. Carrying the date instead
        // gives the scheduler — the component that owns a clock, and that
        // already plans future periods for any recurring service — what it
        // needs to plan the FIRST period correctly. That is what stops the firm
        // being issued August's filings for work it has not taken on, which is
        // the whole point of the field.
        //
        // CONSUMERS MUST READ IT. Scheduling from the event's own timestamp is
        // the bug this field exists to prevent.
        effectiveFrom: engagement.effectiveFrom,
      },
    });
  }
}

/**
 * Optional prose, as a nullable column wants it.
 *
 * A body that arrives as "" or "   " is somebody clearing a field, not somebody
 * writing an empty paragraph — and the database refuses blank prose outright
 * (`el_background_not_blank_chk`, 0022). Trimmed rather than stored as typed,
 * because trailing whitespace in a document that gets hashed is a difference
 * nobody can see and every signature would commit to.
 */
/** The signer a provider will email, or a refusal that says what is missing.
 *  Trimmed, and the address lower-cased, because it is compared by the
 *  provider and stored for the letter page — never re-typed. */
function signerOrThrow(signer: SignatureSigner | undefined): SignatureSigner {
  const name = signer?.name.trim() ?? "";
  const email = signer?.email.trim().toLowerCase() ?? "";
  if (name === "") {
    throw new SignatureIncomplete(
      "the name of the person DocuSign should ask to sign, in signer.name — the client's " +
        "signatory, as the envelope will address them",
    );
  }
  if (!EMAIL.test(email)) {
    throw new SignatureIncomplete(
      `an email address DocuSign can send the envelope to, in signer.email, and ` +
        `${JSON.stringify(signer?.email ?? "")} is not one`,
    );
  }
  return { name, email };
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
