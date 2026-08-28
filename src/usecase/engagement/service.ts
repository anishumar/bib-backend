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
  isEditable,
  isJurisdiction,
  mayActivate,
  normalizeJurisdiction,
} from "../../domain/engagement/model";
import { readClauseBody } from "../../domain/config/model";
import { isAmount, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import {
  AdvanceAlreadyRecorded,
  AdvanceAmountRequired,
  AdvanceNotRequired,
  ClauseNotFound,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidAmount,
  InvalidJurisdiction,
  InvalidLetterTransition,
  LetterLineNotFound,
  LetterNotEditable,
  LetterNotFound,
  NoClauses,
  NotAClause,
  ServiceNotQuotable,
  SignatureIncomplete,
} from "../../domain/engagement/errors";
import { InvalidQuoteCurrency } from "../../domain/proposal/errors";
import type {
  ClauseLibrary,
  ContentHasher,
  DocumentIdentity,
  ESignProvider,
  EngagementRepository,
  LetterFilters,
  LetterRecord,
  LetterSummary,
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
  readonly unitAmount: string;
  readonly discountPercent: string;
}

export interface SignInput {
  readonly tenantId: string;
  readonly letterId: string;
  /** Who signed, as attested by whoever is recording it. */
  readonly signedByName: string;
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
      },
    });
    return letter;
  }

  async addLine(input: AddLetterLineInput): Promise<LetterLine> {
    const letter = await this.editableOrThrow(input.tenantId, input.letterId);

    if (!isAmount(input.quantity) || Number(input.quantity) <= 0) {
      throw new InvalidAmount("quantity", input.quantity);
    }
    if (!isAmount(input.unitAmount)) throw new InvalidAmount("unit amount", input.unitAmount);
    if (!isAmount(input.discountPercent) || Number(input.discountPercent) > 100) {
      throw new InvalidAmount("discount", input.discountPercent);
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

    return this.deps.letters.addLine({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      engagementLetterId: letter.id,
      entityPartyId: input.entityPartyId,
      serviceVersionId: input.serviceVersionId,
      description: input.description,
      quantity: input.quantity,
      unitAmount: input.unitAmount,
      currency: letter.currency,
      discountPercent: input.discountPercent,
    });
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

  async describe(tenantId: string, letterId: string): Promise<LetterRecord> {
    const record = await this.deps.letters.describeLetter(tenantId, letterId);
    if (record === null) throw new LetterNotFound(letterId);
    return record;
  }

  async list(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    return this.deps.letters.listLetters(tenantId, filters);
  }

  /** Send it for signature. Refuses a letter that commits nobody to anything,
   *  and one with no terms at all. */
  async send(tenantId: string, letterId: string, actor: Actor): Promise<EngagementLetter> {
    const letter = await this.editableOrThrow(tenantId, letterId);
    await this.requireCompleteTerms(tenantId, letterId);

    const sent = await this.moveTo(letter, "sent");
    await this.deps.events.recordEvent({
      tenantId,
      verb: "engagement_letter.sent",
      objectId: letter.id,
      actor,
      payload: { partyId: letter.partyId, jurisdiction: letter.jurisdiction },
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
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }> {
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

    const at = this.deps.clock.now().toISOString();
    // The fee gate, decided ONCE by the domain and carried into every
    // engagement the letter creates.
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
    }));

    const result = await this.deps.letters.signAndFanOut(
      input.tenantId,
      letter.id,
      {
        signedAt: at,
        signedByName: input.signedByName.trim(),
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
    return result;
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
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }> {
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
    return result;
  }

  async listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]> {
    await this.findOrThrow(tenantId, letterId);
    return this.deps.letters.listEngagements(tenantId, letterId);
  }

  // ── internals ───────────────────────────────────────────────────────────────

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
      },
    });
  }
}
