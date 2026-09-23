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
//   ACTIVATION is gated on the advance. An engagement starts `pending_advance`
//   whenever the letter requires one, and `contract.activated` — the event the
//   scheduler consumes from T2.4 — is not emitted until it is recorded. That is
//   what makes the fee gate real rather than advisory.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  Engagement,
  EngagementLetter,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import {
  canTransition,
  canonicalContent,
  clauseApplies,
  engagementState,
  isDay,
  isEditable,
  isJurisdiction,
  mayActivate,
  normalizeJurisdiction,
  resolveEffectiveFrom,
  utcDay,
} from "../../domain/engagement/model";
import type { ClauseBody } from "../../domain/config/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { isAmount, isExchangeRate, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import {
  isBillingFrequency,
  outOfPocketProblem,
  BILLING_FREQUENCIES,
} from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
import {
  AdvanceAlreadyRecorded,
  AdvanceAmountRequired,
  AdvanceNotRequired,
  AlreadySuperseded,
  ClauseLawNotIssuers,
  ClauseNotFound,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidAmount,
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
  NoClauses,
  NotAClause,
  ServiceNotQuotable,
  SignatureIncomplete,
  SignatureRequestNotPending,
  EnvelopeAlreadySigned,
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
} from "../../domain/engagement/errors";
import { InvalidQuoteCurrency } from "../../domain/proposal/errors";
import type {
  ClauseLibrary,
  ContentHasher,
  DocumentIdentity,
  ESignProvider,
  AcceptedQuoteDirectory,
  BillableEngagement,
  EngagementRecord,
  EngagementRepository,
  FirmSignatory,
  FirmSignatureRecord,
  LetterFilters,
  LetterSummary,
  LetterPdf,
  LetterView,
  NewEngagement,
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
  /** This letter's own wording for any of the four scope blocks. Absent prints
   *  the pinned catalogue version's words. */
  readonly scopeOverride?: string | undefined;
  readonly clientObligationsOverride?: string | undefined;
  readonly volumeLimitsOverride?: string | undefined;
  readonly exclusionsOverride?: string | undefined;
  readonly oopEstimate?:
    | { readonly min: string; readonly max: string; readonly currency: string }
    | undefined;
  /** WHY there is no amount, and REQUIRED when there is none. */
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
export interface LetterFromQuote {
  readonly letter: EngagementLetter;
  readonly lines: readonly LetterLine[];
  readonly skipped: readonly SkippedQuoteLine[];
}

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
}

export class EngagementService {
  constructor(private readonly deps: Deps) {}

  async draft(input: DraftLetterInput, actor: Actor): Promise<EngagementLetter> {
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
    });

        // The firm's standard prose, COPIED onto this letter (G1.7). The letter
    // stores its OWN jurisdiction, chosen at drafting, so unlike a proposal
    // there is always an answer here — and a letter is the document where
    // getting it wrong is expensive.
    await this.deps.documents.seedBlocks(
      letter.tenantId,
      { kind: "engagement_letter", id: letter.id },
      letter.jurisdiction,
    );

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
      },
    });
    return letter;
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

    const letter = await this.draft(
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

  async addLine(input: AddLetterLineInput): Promise<LetterLine> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);

    if (!isAmount(input.quantity) || Number(input.quantity) <= 0) {
      throw new InvalidAmount("quantity", input.quantity);
    }
    // THE UNPRICED LINE. On a letter this is a TERM two parties sign, so the
    // reason is required and a discount off it is refused — the same two rules
    // the CHECKs make (0023), stated here so a caller is told what to send.
    const unitAmount = input.unitAmount ?? null;
    if (unitAmount !== null && !isAmount(unitAmount)) {
      throw new InvalidAmount("unit amount", unitAmount);
    }
    const pricingNote = blankToNull(input.pricingNote);
    if (unitAmount === null && pricingNote === null) throw new UnpricedLineNeedsReason();
    if (!isAmount(input.discountPercent) || Number(input.discountPercent) > 100) {
      throw new InvalidAmount("discount", input.discountPercent);
    }
    if (unitAmount === null && Number(input.discountPercent) !== 0) {
      throw new UnpricedLineHasDiscount(input.discountPercent);
    }
    if (input.effectiveFrom !== undefined && !isDay(input.effectiveFrom)) {
      throw new InvalidDate("effective date", input.effectiveFrom);
    }

    const jurisdiction = this.lineJurisdiction(input.jurisdiction);
    const billingFrequency = this.statedBillingFrequency(input.billingFrequency);
    const oopEstimate = this.outOfPocket(input.oopEstimate);

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
      billingFrequency: billingFrequency ?? readServiceBody(pinned.body).recurrence,
      scopeOverride: blankToNull(input.scopeOverride),
      clientObligationsOverride: blankToNull(input.clientObligationsOverride),
      volumeLimitsOverride: blankToNull(input.volumeLimitsOverride),
      exclusionsOverride: blankToNull(input.exclusionsOverride),
      oopEstimate,
      pricingNote,
    });
  }

  /** The line's jurisdiction, normalised. Refused rather than dropped: "in" and
   *  "IN" are the same country and "INR" is not one. */
  private lineJurisdiction(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === "") return null;
    const normalised = normalizeJurisdiction(raw);
    if (!isJurisdiction(normalised)) throw new InvalidJurisdiction(raw);
    return normalised;
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
    return {
      ...record,
      engagements: this.withState(record.engagements),
      blocks,
      signing: {
        provider: this.deps.esign.method,
        sends: this.deps.dispatch !== null,
        request,
      },
    };
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

    const now = this.deps.clock.now();
    const at = now.toISOString();
    const standing = await this.deps.firm.firmSignatory(tenantId);
    const firm: FirmSignatureRecord | null =
      standing === null ? null : { userId: standing.userId, title: standing.title, signedAt: at };

    const sent = await this.deps.letters.markSent(tenantId, letter.id, at, utcDay(now), firm);
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
    const [lines, clauses] = await this.requireCompleteTerms(letter.tenantId, letter.id);
    return this.deps.hasher.hash(canonicalContent({ letter, lines, clauses }));
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

    const [lines, clauses] = await this.requireCompleteTerms(input.tenantId, input.letterId);

    const contentHash = this.deps.hasher.hash(
      canonicalContent({ letter, lines, clauses }),
    );
    const signer = input.migrated === true ? this.deps.migrationSigner : this.deps.esign;
    const provider = await signer.sign({
      tenantId: input.tenantId,
      letterId: input.letterId,
      signedByName: input.signedByName.trim(),
      contentHash,
      reference: input.reference,
    });

    const now = this.deps.clock.now();
    const at = now.toISOString();
    // WHEN THE WORK BEGINS, resolved once per line and then stored. Null on the
    // line means the letter's date; null on the letter means today's signature.
    // Resolved HERE rather than read back through two joins later, because the
    // letter freezes at this moment and the answer can therefore never change.
    const signatureDay = utcDay(now);
    // The fee gate, decided ONCE by the domain and carried into every
    // engagement the letter creates.
    //
    // The DATE gate is deliberately not a second status. `active` means the
    // commercial gates are open — signed, and paid when an advance was
    // required; whether work has STARTED is `effectiveFrom` against the
    // calendar, reported as `pending_start` by `engagementState`. Storing that
    // as a status would need something to move the row on the day, and nothing
    // here runs on a timer: a state nothing can leave is worse than a date
    // nothing has reached. See migration 0022.
    const releasedNow = mayActivate(letter);
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
      status: releasedNow ? ("active" as const) : ("pending_advance" as const),
      activatedAt: releasedNow ? at : null,
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
        signatureMethod: signer.method,
        signatureReference: provider.reference,
        signedContentHash: contentHash,
      },
      engagements,
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
        signatureMethod: signer.method,
        contentHash,
        engagementCount: result.engagements.length,
        advanceRequired: letter.advanceRequired,
      },
    });

    // One `contract.activated` per engagement that is actually released — the
    // scheduler consumes these from T2.4, and an engagement waiting on an
    // advance must not produce one.
    for (const engagement of result.engagements) {
      if (engagement.status === "active") await this.recordActivation(engagement, actor);
    }
    return { letter: result.letter, engagements: this.withState(result.engagements) };
  }

  /**
   * Record the advance, and release everything waiting on it.
   *
   * THE HONEST LIMIT, stated where somebody will read it: a person asserts the
   * money arrived, because billing (T3.4) and payments (T3.5) do not exist yet.
   * The GATE is real — no advance, no `contract.activated`, no jobs — but its
   * confirmation is an attestation until the payments module can replace it.
   */
  async recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    actor: Actor,
  ): Promise<{ letter: EngagementLetter; released: readonly EngagementRecord[] }> {
    const letter = await this.findOrThrow(tenantId, letterId);
    if (!letter.advanceRequired) throw new AdvanceNotRequired();
    if (letter.advanceRecordedAt !== null) {
      throw new AdvanceAlreadyRecorded(letter.advanceRecordedAt);
    }

    const at = this.deps.clock.now().toISOString();
    const result = await this.deps.letters.recordAdvance(tenantId, letterId, recordedByUserId, at);

    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.advance_recorded",
      objectId: letter.id,
      actor,
      payload: {
        partyId: letter.partyId,
        amount: letter.advanceAmount,
        currency: letter.currency,
        recordedByUserId,
        releasedEngagements: result.released.length,
      },
    });
    for (const engagement of result.released) await this.recordActivation(engagement, actor);
    return { letter: result.letter, released: this.withState(result.released) };
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
   * `pending_advance` means the letter asked for an advance nobody has
   * recorded. Filtering them out here would leave a screen unable to explain
   * why a service the client signed for is missing from the picker, which is
   * the blank-versus-absent failure this codebase has now paid for several
   * times. The caller decides what to OFFER; this says what is true.
   */
  async billableFor(tenantId: string, partyId: string): Promise<readonly BillableEngagement[]> {
    return this.deps.letters.listBillable(tenantId, partyId);
  }

  async listEngagements(tenantId: string, letterId: string): Promise<readonly EngagementRecord[]> {
    await this.findOrThrow(tenantId, letterId);
    return this.withState(await this.deps.letters.listEngagements(tenantId, letterId));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** The stored rows, each narrowed against today. The clock lives here and
   *  nowhere below: repositories return what is stored, and "has this started
   *  yet" is a rule. */
  private withState(engagements: readonly Engagement[]): readonly EngagementRecord[] {
    const today = utcDay(this.deps.clock.now());
    return engagements.map((engagement) => ({
      engagement,
      state: engagementState(engagement, today),
    }));
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
  ): Promise<[readonly LetterLine[], readonly LetterClause[]]> {
    const [lines, clauses] = await Promise.all([
      this.deps.letters.listLines(tenantId, letterId),
      this.deps.letters.listClauses(tenantId, letterId),
    ]);
    if (lines.length === 0) throw new EmptyLetter();
    if (clauses.length === 0) throw new NoClauses();
    return [lines, clauses];
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
