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
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { isAmount, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
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
  ClauseNotFound,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidAmount,
  InvalidDate,
  InvalidJurisdiction,
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
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
} from "../../domain/engagement/errors";
import { InvalidQuoteCurrency } from "../../domain/proposal/errors";
import type {
  ClauseLibrary,
  ContentHasher,
  DocumentIdentity,
  ESignProvider,
  EngagementRecord,
  EngagementRepository,
  FirmSignatory,
  FirmSignatureRecord,
  LetterFilters,
  LetterSummary,
  LetterView,
  NewEngagement,
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
  readonly hasher: ContentHasher;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
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
}

export class EngagementService {
  constructor(private readonly deps: Deps) {}

  async draft(input: DraftLetterInput, actor: Actor): Promise<EngagementLetter> {
    const jurisdiction = normalizeJurisdiction(input.jurisdiction);
    if (!isJurisdiction(jurisdiction)) throw new InvalidJurisdiction(input.jurisdiction);

    const currency = normalizeCurrency(input.currency);
    if (!isCurrencyCode(currency)) throw new InvalidQuoteCurrency(input.currency);
    if (!isAmount(input.fxRate) || Number(input.fxRate) <= 0) {
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
   * The jurisdiction check is the interesting one. A clause scoped to another
   * country may be unenforceable where this letter is written, or simply wrong,
   * and including it quietly is worse than leaving a gap — so it is refused with
   * both jurisdictions named. A clause with no scope applies everywhere, which
   * is how the catalogue reads the same field.
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

    await this.deps.letters.addClause({
      id: this.deps.ids.newId(),
      tenantId,
      engagementLetterId: letterId,
      clauseVersionId,
    });
  }

  async describe(tenantId: string, letterId: string): Promise<LetterView> {
    const record = await this.deps.letters.describeLetter(tenantId, letterId);
    if (record === null) throw new LetterNotFound(letterId);
    // The one thing the repository could not answer: what each engagement is
    // doing TODAY. The rows say when work begins; the clock says whether it
    // has.
    return { ...record, engagements: this.withState(record.engagements) };
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
  async send(tenantId: string, letterId: string, actor: Actor): Promise<EngagementLetter> {
    // `editableOrThrow` is the whole gate: a letter is editable only while it is
    // a draft, and a draft's only forward move is `sent`. A second
    // `canTransition` check here would be unreachable.
    const letter = await this.editableOrThrow(tenantId, letterId);
    await this.requireCompleteTerms(tenantId, letterId);

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
      },
    });
    return sent;
  }

  async withdraw(tenantId: string, letterId: string, actor: Actor): Promise<EngagementLetter> {
    const letter = await this.findOrThrow(tenantId, letterId);
    if (!canTransition(letter.status, "withdrawn")) {
      throw new InvalidLetterTransition(letter.status, "withdrawn");
    }
    const withdrawn = await this.moveTo(letter, "withdrawn");
    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.withdrawn",
      objectId: letter.id,
      actor,
      payload: { partyId: letter.partyId, wasStatus: letter.status },
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
    const provider = await this.deps.esign.sign({
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
        signatureMethod: this.deps.esign.method,
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
        signatureMethod: this.deps.esign.method,
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
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
