// Engagement-letter HTTP surface — transport only. Each route declares its wire
// shape and its handler parses, calls one use-case method, and maps the result
// field by field.
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route.
//
// Money is redacted for a caller without commercial visibility, exactly as on
// proposals — but the CLAUSES are not. A delivery associate needs to know what
// the firm undertook, and the scope and liability terms are the work, not the
// fee.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { Principal } from "../../platform/callctx";
import type { AuthzService } from "../../usecase/authz/service";
import type { EngagementService } from "../../usecase/engagement/service";
import type { EngagementRecord, LetterSummary, LetterView } from "../../usecase/engagement/ports";
import type { EngagementState, EngagementStatus, LetterStatus } from "../../domain/engagement/model";
import type { BillingFrequency } from "../../domain/document/model";

export interface EngagementDeps {
  readonly service: EngagementService;
  readonly authz: AuthzService;
}

export const LETTER_STATUS_VALUES = [
  "draft",
  "sent",
  "signed",
  "withdrawn",
] as const satisfies readonly LetterStatus[];

export const ENGAGEMENT_STATUS_VALUES = [
  "pending_advance",
  "active",
  "paused",
  "completed",
  "cancelled",
] as const satisfies readonly EngagementStatus[];

/**
 * What an engagement is doing TODAY — the stored status, narrowed by the
 * effective date.
 *
 * `pending_start` appears here and in no CHECK constraint anywhere, which is
 * the design: it is computed against the clock, never written, so an engagement
 * that begins in October reads as `pending_start` today and as `active` on the
 * day without anything having to run in between. See migration 0022.
 */
export const ENGAGEMENT_STATE_VALUES = [
  ...ENGAGEMENT_STATUS_VALUES,
  "pending_start",
] as const satisfies readonly EngagementState[];

const AmountSchema = z.string().regex(/^\d{1,15}(?:\.\d{1,4})?$/);
const CurrencySchema = z.string().length(3);

/**
 * AN EXCHANGE RATE, and it is NOT the amount schema.
 *
 * `fx_rate` is `numeric(20,10)`, so Postgres hands a rate stored as "1" back as
 * "1.0000000000" — and the amount schema allows four places, so the API refused
 * a value its own database had just produced. Invisible while every rate was
 * typed by a person (four is all anybody can type); it failed on the first
 * click of writing a quote up as a letter, which is the first thing here that
 * feeds a stored rate back into a write. See `isExchangeRate`.
 */
const RateSchema = z.string().regex(/^\d{1,10}(?:\.\d{1,10})?$/);

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const JurisdictionSchema = z.string().length(2);

// ── Response schemas ────────────────────────────────────────────────────────

const TotalsSchema = z
  .object({
    gross: AmountSchema.nullable(),
    discount: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
    currency: CurrencySchema,
    /**
     * HOW MANY LIVE LINES THE THREE FIGURES ABOVE DO NOT COVER — the ones with
     * no price. Non-zero means the money is a FLOOR rather than what this letter
     * commits the client to. Not redacted by the fee axis: it is a count of
     * lines, and "this agreement is not fully priced" is a fact about the work.
     */
    unpricedLineCount: z.number().int(),
  })
  .openapi("EngagementLetterTotals");

const MoneySchema = z.object({ amount: AmountSchema, currency: CurrencySchema });

/** The closed set lives in the domain; zod needs a literal tuple. */
export const BILLING_FREQUENCY_VALUES = [
  "one_time",
  "monthly",
  "quarterly",
  "annually",
  "custom",
] as const satisfies readonly BillingFrequency[];

/** Out-of-pocket expenses: a range, in its own currency, reimbursed at actuals
 *  and never folded into a total. All three or none. Its own component name
 *  from the proposal surface's, because the two documents are separate wire
 *  shapes even where they agree. */
const OopEstimateSchema = z
  .object({ min: AmountSchema, max: AmountSchema, currency: CurrencySchema })
  .openapi("LetterOutOfPocketEstimate");

/** One of the four scope blocks, RESOLVED: the words that print, and whether
 *  THIS letter wrote them. On a signed letter `tailored: true` is the record
 *  that this client negotiated their own wording. */
const ResolvedTermSchema = z
  .object({ text: z.string().nullable(), tailored: z.boolean() })
  .openapi("LetterResolvedTerm");

const DocumentTermsSchema = z
  .object({
    scope: ResolvedTermSchema,
    clientObligations: ResolvedTermSchema,
    volumeLimits: ResolvedTermSchema,
    exclusions: ResolvedTermSchema,
  })
  .openapi("LetterDocumentTerms");

/**
 * THE CATALOGUE ROW THIS LINE CITES, as it was PINNED — its own schema rather
 * than the proposal handler's, because the two surfaces are separate documents
 * and a field added for one must not appear on the other by accident. The
 * component name differs for the same reason the shape does not.
 *
 * G2.2 says an engagement letter is "ASSEMBLED from the catalogue's own words",
 * and until this schema carried the four scope blocks there were ZERO consumers
 * of them outside the config model. `slaDays` is the other half: T3.1 snapshots
 * the SLA in force when a work item is created, read off the version this letter
 * PINNED, and nothing served it.
 *
 * Everything but `key`, `version` and `name` is nullable because the CATALOGUE
 * is: a published version is frozen, so a body published before a field existed
 * can never carry it, and null means "the firm never stated this" — never a
 * default. The four blocks are the CATALOGUE's words; G1.6's per-document
 * overrides arrive beside this object rather than inside it, so what the firm
 * sells and what this client agreed to stay two answers.
 */
const PinnedServiceSchema = z
  .object({
    key: z.string(),
    version: z.number().int(),
    /** The firm's OWN code — "A1". Not the registry key. */
    ref: z.string().nullable(),
    name: z.string(),
    module: z.string().nullable(),
    group: z.string().nullable(),
    billingBasis: z.string().nullable(),
    /** How often the WORK comes round, which is not how often it is billed. */
    recurrence: z.string().nullable(),
    /** The turnaround promised by THIS version, in whole days from signing. */
    slaDays: z.number().int().nullable(),
    /** Redacted by the fee axis, with the rest of the money. */
    listPrice: MoneySchema.nullable(),
    pricingNote: z.string().nullable(),
    scope: z.string().nullable(),
    clientObligations: z.string().nullable(),
    volumeLimits: z.string().nullable(),
    exclusions: z.string().nullable(),
  })
  .openapi("LetterPinnedService");

const LetterSchema = z
  .object({
    id: z.string().uuid(),
    /** The firm's own number for this letter — `EL-2026-0007`. What the client
     *  quotes back, what an invoice narrates and what a court filing cites. */
    ref: z.string(),
    partyId: z.string().uuid(),
    /** Which of the FIRM's own entities is contracting. Not redacted by the fee
     *  axis: who is bound by this letter is not money, and it is exactly what
     *  delivery staff need to know whose paper they are working under. */
    issuingEntityPartyId: z.string().uuid(),
    proposalId: z.string().uuid().nullable(),
    jurisdiction: JurisdictionSchema,
    title: z.string(),
    status: z.enum(LETTER_STATUS_VALUES),
    currency: CurrencySchema,
    fxRate: RateSchema.nullable(),
    fxRateDate: DaySchema,
    advanceRequired: z.boolean(),
    advanceAmount: AmountSchema.nullable(),
    advanceRecordedAt: z.string().nullable(),
    sentAt: z.string().nullable(),
    signedAt: z.string().nullable(),
    signedByName: z.string().nullable(),
    signatureMethod: z.string().nullable(),
    signatureReference: z.string().nullable(),
    /** The capacity the client signed in. Optional at signature — it is not
     *  always known when a wet signature is attested. */
    signedByTitle: z.string().nullable(),
    // The document's fingerprint. On the wire because verifying a signature is
    // something a firm should be able to do without a database session.
    signedContentHash: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
    /** The opening paragraph — why this client is buying this. */
    background: z.string().nullable(),
    /** The named individual the letter is written to, care-of `partyId`. */
    addressedToPartyId: z.string().uuid().nullable(),
    /** The document's own date, distinct from `sentAt`. */
    issuedOn: DaySchema.nullable(),
    /** The signed letter this one replaces. */
    supersedesId: z.string().uuid().nullable(),
    /** When the engagements it opens begin. Null means the signature date. */
    effectiveFrom: DaySchema.nullable(),
    /** WHO BOUND THE FIRM, and in what capacity — the "Yours sincerely" half of
     *  the signature block. Not redacted by the fee axis: who committed the firm
     *  is not money. All three move together or not at all. */
    firmSignatoryUserId: z.string().uuid().nullable(),
    firmSignatoryTitle: z.string().nullable(),
    firmSignedAt: z.string().nullable(),
  })
  .openapi("EngagementLetter");

const LetterLineSchema = z
  .object({
    id: z.string().uuid(),
    /** The entity this line's work is for — the id AND the name, because this
     *  is where a group client's companies are told apart on screen. */
    entityPartyId: z.string().uuid(),
    entity: z.object({ id: z.string().uuid(), displayName: z.string() }).nullable(),
    serviceVersionId: z.string().uuid(),
    service: PinnedServiceSchema.nullable(),
    /** THE FOUR SCOPE BLOCKS, RESOLVED — this letter's override where it has
     *  one, the pinned catalogue version's words where it does not. On a SIGNED
     *  letter this is the wording the client agreed to, and both halves of it
     *  are frozen. */
    terms: DocumentTermsSchema,
    description: z.string(),
    position: z.number().int(),
    quantity: AmountSchema,
    /** Null for two different reasons — a redacted fee and a line that HAS no
     *  price. `priced` below is which. */
    unitAmount: AmountSchema.nullable(),
    /** Whether this line has a price at all; false means "as mutually agreed"
     *  and `pricingNote` says why. Not redacted — see the proposal surface. */
    priced: z.boolean(),
    currency: CurrencySchema,
    discountPercent: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
    /** When THIS line's work begins. Null means whatever the letter says. */
    effectiveFrom: DaySchema.nullable(),
    /** Where the WORK is — on a letter, the entity's own jurisdiction. */
    jurisdiction: z.string().nullable(),
    /** How often this DEAL is billed. */
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable(),
    /** WHY there is no amount. Not redacted: it is what prints where a figure
     *  would. */
    pricingNote: z.string().nullable(),
    /** Out-of-pocket expenses, separate from the fee and never in the totals.
     *  Redacted with the money. */
    oopEstimate: OopEstimateSchema.nullable(),
  })
  .openapi("EngagementLetterLine");

/** A term, as it was PINNED. Not redacted by the fee axis: what the firm
 *  undertook is the work, not the money. */
/** A term of the contract that belongs to a jurisdiction: the code that makes
 *  it comparable and the words the document prints. Both halves — neither does
 *  the other's job. */
const JurisdictionalTermSchema = z
  .object({
    jurisdiction: z.string().length(2),
    text: z.string(),
  })
  .openapi("JurisdictionalTerm");

const LetterClauseSchema = z
  .object({
    id: z.string().uuid(),
    clauseVersionId: z.string().uuid(),
    key: z.string(),
    version: z.number().int(),
    position: z.number().int(),
    title: z.string(),
    text: z.string(),
    /**
     * WHOSE LAW governs and WHERE a dispute is heard, structured — from the
     * PINNED body, so a signed letter answers with what the client agreed to.
     *
     * Null on almost every clause, which is correct: confidentiality and fee
     * terms name no law. They are on the wire because `text` alone is a
     * paragraph, and a renderer asking "whose law does this letter name" had to
     * read prose — which is the exact position the firm's original letter was
     * written from. `addClause` already refuses a term that is not the issuing
     * entity's, so what arrives here has been checked.
     */
    governingLaw: JurisdictionalTermSchema.nullable(),
    courts: JurisdictionalTermSchema.nullable(),
  })
  .openapi("EngagementLetterClause");

/** One line of a document's own prose (G1.7) — an exclusion, a commercial note,
 *  or a row of the team block. A COPY the document owns, so editing the firm's
 *  standard set changes the next document and never this one. */
const DocumentBlockSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["exclusion", "commercial", "team"]),
    body: z.string(),
    isHeading: z.boolean(),
    sortOrder: z.number().int(),
    /** Which standard line it was copied from, or null for one written by hand
     *  on this document — what lets a screen mark it as this document's own. */
    sourceId: z.string().uuid().nullable(),
    isEdited: z.boolean().openapi({
      description:
        "Whether this line has been CHANGED since it landed on the document. `sourceId` " +
        "survives an edit, so a house line somebody reworded for this client goes on " +
        "pointing at the standard row — 0025's own comment asks for a screen that says " +
        "'standard' beside an untouched line and 'edited' beside a changed one, and " +
        "`sourceId` alone can only say the first half. Derived from `updated_at > " +
        "created_at`; the only UPDATE this table takes is an edit.",
    }),
  })
  .openapi("EngagementLetterBlock");

const EngagementSchema = z
  .object({
    id: z.string().uuid(),
    engagementLetterId: z.string().uuid(),
    engagementLetterLineId: z.string().uuid(),
    /** Who is billed. */
    partyId: z.string().uuid(),
    /** Who the work is delivered to — `service × one legal entity`. */
    entityPartyId: z.string().uuid(),
    /** The COMMERCIAL gates: `pending_advance` until the advance is recorded,
     *  then `active`. It does not say whether work has begun. */
    status: z.enum(ENGAGEMENT_STATUS_VALUES),
    /** What it is doing TODAY — `status`, narrowed to `pending_start` while the
     *  effective date is still in the future. Computed, never stored. */
    state: z.enum(ENGAGEMENT_STATE_VALUES),
    activatedAt: z.string().nullable(),
    /** The day work begins, resolved at signature from line, then letter, then
     *  the signature date. This is what a scheduler plans from. */
    effectiveFrom: DaySchema,
    endsOn: DaySchema.nullable(),
  })
  .openapi("Engagement");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

/**
 * How this letter is being signed (0080). `sends` is the deployment's answer —
 * whether sending raises an envelope and therefore needs a signer — so a
 * DRAFT's screen knows what to ask for before anybody presses send.
 *
 * The signer's NAME and ADDRESS are on the wire because the firm typed them and
 * needs to see where the envelope went. They are not redacted by the fee axis:
 * they are not money.
 */
const SigningSchema = z
  .object({
    provider: z.string(),
    sends: z.boolean(),
    request: z
      .object({
        signerName: z.string(),
        signerEmail: z.string(),
        /** Null until the provider accepts an envelope. */
        envelopeId: z.string().nullable(),
        raisedAt: z.string().nullable(),
        /** The provider's own words for why the last attempt failed — what the
         *  screen shows beside "Try again". Null once an attempt succeeds. */
        lastFailure: z.string().nullable(),
        attempts: z.number().int(),
        outcome: z.enum(["completed", "declined", "voided"]).nullable(),
        settledAt: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("EngagementLetterSigning");

/** A letter identified the way a person identifies one: by its reference. */
const DocumentRefSchema = z.object({ id: z.string().uuid(), ref: z.string() });

const LetterRecordSchema = z
  .object({
    letter: LetterSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — the letterhead and the signature block both
     *  print it. */
    issuingEntity: PartyRefSchema,
    /** The addressee by NAME, care-of `party`. Null when the letter names no
     *  individual. */
    addressedTo: PartyRefSchema.nullable(),
    /** The firm's own signature block, resolved to a name. The NAME is a join
     *  (an erased account stops resolving); the TITLE is what the document
     *  said. */
    firmSignatory: z
      .object({
        userId: z.string().uuid(),
        displayName: z.string().nullable(),
        title: z.string(),
        signedAt: z.string(),
      })
      .nullable(),
    /** Lineage, both directions, by REFERENCE — a uuid is not something anybody
     *  can follow. `supersededBy` is how a screen answers "is this still the
     *  agreement?". */
    supersedes: DocumentRefSchema.nullable(),
    supersededBy: DocumentRefSchema.nullable(),
    lines: z.array(LetterLineSchema),
    clauses: z.array(LetterClauseSchema),
    blocks: z.array(DocumentBlockSchema),
    totals: TotalsSchema,
    engagements: z.array(EngagementSchema),
    signing: SigningSchema,
  })
  .openapi("EngagementLetterRecord");

const LetterSummarySchema = z
  .object({
    letter: LetterSchema,
    party: PartyRefSchema,
    issuingEntity: PartyRefSchema,
    totals: TotalsSchema,
    lineCount: z.number().int(),
  })
  .openapi("EngagementLetterSummary");

const LettersResponse = z
  .object({ letters: z.array(LetterSummarySchema) })
  .openapi("EngagementLettersResponse");

const SignedResponse = z
  .object({ letter: LetterSchema, engagements: z.array(EngagementSchema) })
  .openapi("SignedEngagementLetter");

// ── Request schemas ─────────────────────────────────────────────────────────

const DraftLetterRequest = z
  .object({
    partyId: z.string().uuid(),
    proposalId: z.string().uuid().optional(),
    // WHO is contracting. Optional, and absent is the ordinary case: the
    // letter's own jurisdiction is where the client is, so the firm's
    // preference rows answer it and a firm always has a fallback. Naming one
    // here overrides that for this letter only.
    issuingEntityPartyId: z.string().uuid().optional(),
    // The letter's OWN jurisdiction, stated rather than inferred: it is not
    // always the client's or the firm's, and a legal document records the one
    // it was written for.
    jurisdiction: JurisdictionSchema,
    title: z.string().min(1),
    currency: CurrencySchema,
    fxRate: RateSchema,
    fxRateDate: DaySchema,
    advanceRequired: z.boolean().default(false),
    advanceAmount: AmountSchema.optional(),
    // THE PROSE. Settable here and nowhere else, because a letter is editable
    // only while it is a draft and there is deliberately no route that rewrites
    // a sent one — the client has it as it was sent.
    background: z.string().min(1).max(20000).optional(),
    addressedToPartyId: z.string().uuid().optional(),
    issuedOn: DaySchema.optional().openapi({
      description: "The date printed on the document. Defaults to the day it is SENT.",
    }),
    supersedesId: z.string().uuid().optional().openapi({
      description:
        "The SIGNED letter this one replaces. A draft is edited instead; a letter that went " +
        "out and was never signed is withdrawn.",
    }),
    effectiveFrom: DaySchema.optional().openapi({
      description:
        "When the engagements this letter opens begin. Omit for the signature date, which is " +
        "the ordinary case. A line may override it.",
    }),
  })
  .openapi("DraftEngagementLetterRequest");

const AddLineRequest = z
  .object({
    entityPartyId: z.string().uuid(),
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    /** OPTIONAL since G1.6: omit it for a line that is genuinely "as mutually
     *  agreed" and send `pricingNote`. Omitting it is NOT sending "0". */
    unitAmount: AmountSchema.optional(),
    discountPercent: AmountSchema.default("0"),
    effectiveFrom: DaySchema.optional().openapi({
      description:
        "When THIS line starts, if that is not the letter's date. Omit for the letter's.",
    }),
    /** Where the WORK is. */
    jurisdiction: JurisdictionSchema.optional(),
    /** How often this DEAL is billed. Omit and it defaults from the PINNED
     *  service's `recurrence`. */
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).optional(),
    /** THIS LETTER'S OWN WORDING for any of the four scope blocks — what makes
     *  a signed document reproducible. Omit any and the pinned catalogue
     *  version's words print. */
    scopeOverride: z.string().min(1).optional(),
    clientObligationsOverride: z.string().min(1).optional(),
    volumeLimitsOverride: z.string().min(1).optional(),
    exclusionsOverride: z.string().min(1).optional(),
    /** Out-of-pocket expenses: a range in its own currency, reimbursed at
     *  actuals. */
    oopEstimate: OopEstimateSchema.optional(),
    /** WHY there is no amount — REQUIRED when `unitAmount` is omitted. */
    pricingNote: z.string().min(1).optional(),
  })
  .openapi("AddEngagementLetterLineRequest");

const AddClauseRequest = z
  .object({ clauseVersionId: z.string().uuid() })
  .openapi("AddEngagementLetterClauseRequest");

const SignRequest = z
  .object({
    signedByName: z.string().min(1),
    /** The capacity they signed in. Optional: it is not always known when a wet
     *  signature is attested afterwards, and the letter is verifiable without
     *  it. */
    signedByTitle: z.string().min(1).max(120).optional(),
    reference: z.string().optional(),
  })
  .openapi("SignEngagementLetterRequest");

const DraftFromProposalRequest = z
  .object({
    jurisdiction: JurisdictionSchema.optional().openapi({
      description:
        "The country this letter is under. OMIT IT when every line of the quote names the same " +
        "one — that is the answer, and nobody should retype it. Required only when the lines " +
        "disagree or none says, because a letter states ONE and it settles governing law, the " +
        "courts and which of the firm's own companies contracts. Derived when it is obvious, " +
        "asked for otherwise, never guessed.",
    }),
    title: z.string().min(1).optional().openapi({
      description: "Defaults to the quote's own title.",
    }),
    advanceRequired: z.boolean().default(false).openapi({
      description:
        "The FIRM's decision and not the quote's — a proposal has no advance, so this is not " +
        "carried across and there is nothing here to inherit.",
    }),
    advanceAmount: AmountSchema.optional(),
    defaultEntityPartyId: z.string().uuid().optional().openapi({
      description:
        "Which company to file a quote line against when the LINE names none. Explicit, never " +
        "inferred: a proposal may quote a prospect that holds no entity yet, and a letter line " +
        "must name one because signing it creates an engagement — one service for one legal " +
        "entity. Omit it and those lines are SKIPPED and reported rather than filed against a " +
        "company nobody chose, which on a signed page is indistinguishable from one somebody " +
        "agreed to.",
    }),
    issuingEntityPartyId: z.string().uuid().optional().openapi({
      description:
        "Defaults to the QUOTE's issuer. The firm already decided which of its companies was " +
        "offering this, and contracting through a different one would change the client's " +
        "counterparty between the offer and the contract.",
    }),
    background: z.string().min(1).max(20000).optional(),
    addressedToPartyId: z.string().uuid().optional(),
    issuedOn: DaySchema.optional(),
    effectiveFrom: DaySchema.optional(),
  })
  .openapi("DraftLetterFromProposalRequest");

const SkippedQuoteLineSchema = z
  .object({
    proposalLineId: z.string().uuid(),
    description: z.string(),
    reason: z.string(),
  })
  .openapi("SkippedQuoteLine");

const LetterFromProposalSchema = z
  .object({
    letter: LetterSchema,
    linesCopied: z.number().int(),
    skipped: z.array(SkippedQuoteLineSchema).openapi({
      description:
        "Quote lines that did NOT become letter lines, each with the reason. NOT an error " +
        "list, and a screen must show it beside the success rather than instead of it: a " +
        "carry-forward that silently dropped three of eight lines is worse than one that never " +
        "ran, because the letter LOOKS complete.",
    }),
  })
  .openapi("LetterFromProposal");

const BillableEngagementSchema = z
  .object({
    engagementId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().openapi({
      description:
        "Who the work is DELIVERED TO. An engagement is one service for one legal entity, so a " +
        "group of four companies appears as four of these — which is exactly the distinction " +
        "an invoice line has to get right.",
    }),
    letterId: z.string().uuid(),
    letterRef: z.string().openapi({
      description: "Where the figure comes from, so a screen can cite the signed document.",
    }),
    description: z.string().openapi({
      description:
        "The LETTER LINE's own wording — what the client read and agreed to, not the " +
        "catalogue's standard description.",
    }),
    quantity: AmountSchema,
    unitAmount: AmountSchema.nullable().openapi({
      description:
        "The price AGREED, not the catalogue's list price — reading the list price here would " +
        "quietly bill a negotiated discount away. NULL is a real answer: 'as mutually agreed' " +
        "is a term two parties signed, and `pricingNote` says why. An invoice line cannot be " +
        "unpriced, so a screen has to ASK for the figure there rather than prefill one.",
    }),
    pricingNote: z.string().nullable(),
    currency: CurrencySchema,
    discountPercent: AmountSchema,
    billingFrequency: z.string().nullable(),
    status: z.string().openapi({
      description:
        "The commercial gate. `pending_advance` means the letter asked for an advance nobody " +
        "has recorded, and billing then is the firm invoicing work it has not been cleared to " +
        "start. Every engagement is returned including those — a picker that silently dropped " +
        "them could not explain why a signed service is missing from it.",
    }),
    effectiveFrom: DaySchema,
    endsOn: DaySchema.nullable(),
  })
  .openapi("BillableEngagement");

const BillableEngagementsResponse = z
  .object({ engagements: z.array(BillableEngagementSchema) })
  .openapi("BillableEngagementsResponse");

// ── Routes ──────────────────────────────────────────────────────────────────

const draftFromProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/engagement-letter",
  tags: ["engagement-letters"],
  summary: "Write an accepted quote up as a draft engagement letter",
  description:
    "CARRIES THE TERMS ACROSS so nobody types a price twice. Every line comes over with its " +
    "pinned service version, its wording, its quantity, its price, its discount, its billing " +
    "frequency, its scope overrides and its pricing note; the currency and the exchange rate " +
    "come from the quote and CANNOT be overridden, because changing the currency underneath " +
    "copied amounts reinterprets every figure on the document. The advance and the clauses are " +
    "not carried: a proposal has no advance, and a letter's terms are chosen from the library " +
    "against ITS jurisdiction. Refused unless the client has ACCEPTED — recording the " +
    "acceptance is the act that turns an offer into something to write up.",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: DraftFromProposalRequest } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Drafted, with an account of any line that could not be carried",
      content: { "application/json": { schema: LetterFromProposalSchema } },
    },
    400: errorResponse("The quote's lines name more than one country, so say which this letter is under"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse(
      "The quote is not accepted, has no lines, or names no company for any of them",
    ),
  },
});

const billableRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/{partyId}/billable-engagements",
  tags: ["engagement-letters"],
  summary: "What this client can be billed for, and the price its letters agreed",
  description:
    "THE OTHER HALF OF THE CARRY-FORWARD. `crm.invoice_line.engagement_id` has existed since " +
    "T3.4 with nothing offering it, so a letter's agreed price reached the invoice only by " +
    "somebody typing it a third time. This is the read an invoice line's picker is built on: " +
    "one row per engagement, carrying the LETTER LINE's wording, quantity, agreed price and " +
    "discount, plus the letter it came from. It is a read and not a 'raise an invoice from " +
    "this letter' write, because a letter is the whole contract and an invoice bills a period " +
    "of it — which period and which services is a decision somebody takes every month.",
  request: { params: z.object({ partyId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Every engagement of this client, billable or not yet",
      content: { "application/json": { schema: BillableEngagementsResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const StructureMemberSchema = z
  .object({ id: z.string().uuid(), displayName: z.string() })
  .openapi("StructureMember");

const ClientStructureResponse = z
  .object({
    entities: z.array(StructureMemberSchema).openapi({
      description:
        "The companies a letter for this client may cover: the client itself first, then " +
        "every company recorded under it (subsidiaries at any depth) and every company it " +
        "holds shares in or is a director of. Archived parties are left out.",
    }),
    people: z.array(StructureMemberSchema).openapi({
      description:
        "The people a letter for this client may be addressed to: anyone recorded as a " +
        "director, authorised signatory, employee or shareholder of one of those companies, " +
        "and the client itself when the client is a person.",
    }),
  })
  .openapi("ClientStructureResponse");

const structureRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/{partyId}/structure",
  tags: ["engagement-letters"],
  summary: "Which companies and people a letter for this client may name",
  description:
    "F-10-1. A letter's lines and its addressee were checked for the FIRM only, so another " +
    "client's company or director could be written onto it. Drafting now refuses both, and " +
    "this is the same answer as a read, on the firm's today, so a picker offers exactly what " +
    "drafting accepts. A company or person missing here is fixed by recording the " +
    "relationship on the client's page.",
  request: { params: z.object({ partyId: z.string().uuid() }) },
  responses: {
    200: {
      description: "The client's companies and contacts, today",
      content: { "application/json": { schema: ClientStructureResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const draftRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters",
  tags: ["engagement-letters"],
  summary: "Draft an engagement letter",
  description:
    "The document that creates obligations. Lines come from the catalogue and clauses from " +
    "the firm's library; both are pinned to the version in force when they are added.",
  request: {
    body: { content: { "application/json": { schema: DraftLetterRequest } }, required: true },
  },
  responses: {
    201: { description: "Drafted", content: { "application/json": { schema: LetterSchema } } },
    400: errorResponse("Validation, or an advance required with no amount"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/engagement-letters",
  tags: ["engagement-letters"],
  summary: "List engagement letters",
  request: {
    query: z.object({
      status: z.enum(LETTER_STATUS_VALUES).optional(),
      partyId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: { description: "Letters", content: { "application/json": { schema: LettersResponse } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/engagement-letters/{letterId}",
  tags: ["engagement-letters"],
  summary: "Read one engagement letter",
  description:
    "The clauses come back with the wording that was PINNED, so a signed letter reads as " +
    "what was agreed rather than as what the library says today.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Letter", content: { "application/json": { schema: LetterRecordSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
  },
});

const addLineRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/lines",
  tags: ["engagement-letters"],
  summary: "Agree a service on the letter",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AddLineRequest } }, required: true },
  },
  responses: {
    201: { description: "Line added", content: { "application/json": { schema: LetterLineSchema } } },
    400: errorResponse("An amount that is not one, or a version that is not a published service"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const removeLineRoute = createRoute({
  method: "delete",
  path: "/api/v1/engagement-letters/{letterId}/lines/{lineId}",
  tags: ["engagement-letters"],
  summary: "Pull a line from a draft",
  request: { params: z.object({ letterId: z.string().uuid(), lineId: z.string().uuid() }) },
  responses: {
    204: { description: "Removed" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter or line at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const addClauseRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/clauses",
  tags: ["engagement-letters"],
  summary: "Put a term on the letter",
  description:
    "Pinned to the clause version in force now. A clause drafted for another jurisdiction " +
    "is refused rather than quietly included — it may be unenforceable where this letter " +
    "is written.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AddClauseRequest } }, required: true },
  },
  responses: {
    204: { description: "Clause added" },
    400: errorResponse("Not a published clause, or one for another jurisdiction"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter or clause at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const SendRequest = z
  .object({
    signer: z
      .object({
        name: z.string().min(1),
        email: z.string().min(3),
      })
      .optional(),
  })
  .openapi("SendEngagementLetterRequest");

const sendRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/send",
  tags: ["engagement-letters"],
  summary: "Send it for signature",
  description:
    "Freezes the terms and dates the letter. When the deployment signs through a provider " +
    "that SENDS (`signing.sends` on the letter — DocuSign), `signer` is required and an " +
    "envelope is raised for them at once; if the provider refuses, the letter is still sent " +
    "and `signing.request.lastFailure` says why — retry with `…/signature-request`. When it " +
    "does not send, `signer` is ignored.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendRequest } }, required: false },
  },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: LetterSchema } } },
    400: errorResponse("DocuSign is the provider and no usable signer was given"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not a draft, no lines, or no clauses"),
  },
});

const retrySignatureRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/signature-request",
  tags: ["engagement-letters"],
  summary: "Raise the envelope again after the provider refused",
  description:
    "For a SENT letter whose envelope was never raised. Answers with the provider's own " +
    "fault (502) if it refuses again. A letter whose envelope is already with the client is " +
    "refused — ask the client to find DocuSign's email, or withdraw and send a new letter.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Raised", content: { "application/json": { schema: SigningSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Nothing waiting to be raised"),
    502: errorResponse("The e-signature provider refused"),
  },
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/withdraw",
  tags: ["engagement-letters"],
  summary: "Pull it before signature",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Withdrawn", content: { "application/json": { schema: LetterSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("A signed letter is superseded, never withdrawn"),
  },
});

const signRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/signature",
  tags: ["engagement-letters"],
  summary: "Record the client's signature",
  description:
    "Freezes the letter — the database refuses any later change — and creates one engagement " +
    "per line. Engagements start `pending_advance` when the letter requires an advance, and " +
    "no `contract.activated` is emitted until it is recorded.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SignRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Signed, with the engagements it created",
      content: { "application/json": { schema: SignedResponse } },
    },
    400: errorResponse("A signature missing a signatory"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not in a signable state, or missing lines or clauses"),
  },
});

const advanceRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/advance",
  tags: ["engagement-letters"],
  summary: "Record the advance as received",
  description:
    "Releases every engagement waiting on it. HONEST LIMIT: a person asserts the money " +
    "arrived — payments (T3.5) do not exist yet. The gate is real; its confirmation is an " +
    "attestation until they do.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Recorded, with the engagements released",
      content: { "application/json": { schema: SignedResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("No advance is required, or it was already recorded"),
  },
});

// ── Mapping ─────────────────────────────────────────────────────────────────

function toLetterBody(
  letter: LetterView["letter"],
  fees: boolean,
): z.infer<typeof LetterSchema> {
  return {
    id: letter.id,
    ref: letter.ref,
    partyId: letter.partyId,
    issuingEntityPartyId: letter.issuingEntityPartyId,
    proposalId: letter.proposalId,
    jurisdiction: letter.jurisdiction,
    title: letter.title,
    status: letter.status,
    currency: letter.currency,
    fxRate: fees ? letter.fxRate : null,
    fxRateDate: letter.fxRateDate,
    advanceRequired: letter.advanceRequired,
    advanceAmount: fees ? letter.advanceAmount : null,
    advanceRecordedAt: letter.advanceRecordedAt,
    sentAt: letter.sentAt,
    signedAt: letter.signedAt,
    signedByName: letter.signedByName,
    signatureMethod: letter.signatureMethod,
    signatureReference: letter.signatureReference,
    signedByTitle: letter.signedByTitle,
    signedContentHash: letter.signedContentHash,
    withdrawnAt: letter.withdrawnAt,
    background: letter.background,
    addressedToPartyId: letter.addressedToPartyId,
    issuedOn: letter.issuedOn,
    supersedesId: letter.supersedesId,
    effectiveFrom: letter.effectiveFrom,
    // NOT redacted by the fee axis. Who bound the firm, and in what capacity,
    // is not money — and it is exactly what delivery staff need in order to
    // know whose paper they are working under.
    firmSignatoryUserId: letter.firmSignatoryUserId,
    firmSignatoryTitle: letter.firmSignatoryTitle,
    firmSignedAt: letter.firmSignedAt,
  };
}

/** Field by field, never the port object forwarded — the request carries
 *  ids and a claim time this wire has no business with. */
function toSigningBody(signing: LetterView["signing"]): z.infer<typeof SigningSchema> {
  const r = signing.request;
  return {
    provider: signing.provider,
    sends: signing.sends,
    request:
      r === null
        ? null
        : {
            signerName: r.signer.name,
            signerEmail: r.signer.email,
            envelopeId: r.envelopeId,
            raisedAt: r.raisedAt,
            lastFailure: r.lastFailure,
            attempts: r.attempts,
            outcome: r.outcome,
            settledAt: r.settledAt,
          },
  };
}

function toEngagementBody(r: EngagementRecord): z.infer<typeof EngagementSchema> {
  return {
    id: r.engagement.id,
    engagementLetterId: r.engagement.engagementLetterId,
    engagementLetterLineId: r.engagement.engagementLetterLineId,
    partyId: r.engagement.partyId,
    entityPartyId: r.engagement.entityPartyId,
    status: r.engagement.status,
    // BOTH, and they are different questions. `status` is the commercial gate
    // the row stores; `state` is what it is doing today. A screen shows the
    // second and an audit of "when did we take this on" reads the first.
    state: r.state,
    activatedAt: r.engagement.activatedAt,
    effectiveFrom: r.engagement.effectiveFrom,
    endsOn: r.engagement.endsOn,
  };
}

/**
 * The pinned catalogue row, field by field — never the port object forwarded.
 * It was a spread until this task, which is exactly how `role` and
 * `commercialVisibility` sat undocumented on `/auth/me` for six tasks.
 *
 * Only the PRICE half is redacted by the fee axis, for the reason the clauses
 * are not redacted at all: what the firm UNDERTOOK is the work, not the fee, and
 * a delivery associate without commercial visibility is precisely the person who
 * has to read the scope, the client's obligations and the exclusions.
 * `pricingNote` stays with them rather than with the money: it is the sentence
 * that prints on the document where an amount would ("As mutually agreed"), so
 * redacting it would leave a line showing neither a price nor a reason.
 */
function toPinnedServiceBody(
  service: NonNullable<LetterView["lines"][number]["service"]>,
  fees: boolean,
): z.infer<typeof PinnedServiceSchema> {
  return {
    key: service.key,
    version: service.version,
    ref: service.ref,
    name: service.name,
    module: service.module,
    group: service.group,
    billingBasis: service.billingBasis,
    recurrence: service.recurrence,
    slaDays: service.slaDays,
    listPrice: fees && service.listPrice !== null ? { ...service.listPrice } : null,
    pricingNote: service.pricingNote,
    scope: service.scope,
    clientObligations: service.clientObligations,
    volumeLimits: service.volumeLimits,
    exclusions: service.exclusions,
  };
}

function toRecordBody(record: LetterView, fees: boolean): z.infer<typeof LetterRecordSchema> {
  return {
    letter: toLetterBody(record.letter, fees),
    party: { id: record.party.id, displayName: record.party.displayName },
    issuingEntity: {
      id: record.issuingEntity.id,
      displayName: record.issuingEntity.displayName,
    },
    addressedTo: record.addressedTo === null ? null : { ...record.addressedTo },
    firmSignatory: record.firmSignatory === null ? null : { ...record.firmSignatory },
    supersedes: record.supersedes === null ? null : { ...record.supersedes },
    supersededBy: record.supersededBy === null ? null : { ...record.supersededBy },
    lines: record.lines.map((l) => ({
      id: l.line.id,
      entityPartyId: l.line.entityPartyId,
      entity: l.entity === null ? null : { ...l.entity },
      serviceVersionId: l.line.serviceVersionId,
      service: l.service === null ? null : toPinnedServiceBody(l.service, fees),
      // NOT redacted, like the clauses below and for the same reason: the
      // wording is what the firm undertook, not what it charged.
      terms: { ...l.terms },
      description: l.line.description,
      position: l.line.position,
      quantity: l.line.quantity,
      unitAmount: fees ? l.line.unitAmount : null,
      // Computed BEFORE the redaction, from the line itself: it is what makes
      // the null above readable.
      priced: l.line.unitAmount !== null,
      currency: l.line.currency,
      discountPercent: fees ? l.line.discountPercent : null,
      net: fees ? l.net : null,
      effectiveFrom: l.line.effectiveFrom,
      jurisdiction: l.line.jurisdiction,
      billingFrequency: l.line.billingFrequency,
      pricingNote: l.line.pricingNote,
      oopEstimate: fees && l.line.oopEstimate !== null ? { ...l.line.oopEstimate } : null,
    })),
    // NOT redacted. What the firm undertook is the work, and somebody delivering
    // it needs the scope and the limits even when they may not see the fee.
    clauses: record.clauses.map((c) => ({
      id: c.clause.id,
      clauseVersionId: c.clause.clauseVersionId,
      key: c.key,
      version: c.version,
      position: c.clause.position,
      title: c.title,
      text: c.text,
      governingLaw: c.governingLaw === null ? null : { ...c.governingLaw },
      courts: c.courts === null ? null : { ...c.courts },
    })),
    // NOT redacted, for the same reason the clauses are not: what the firm
    // undertook — and what it explicitly did NOT undertake — is the work, and
    // somebody delivering it needs the exclusions even when they may not see
    // the fee.
    blocks: record.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      body: b.body,
      isHeading: b.isHeading,
      sortOrder: b.sortOrder,
      sourceId: b.sourceId,
      isEdited: b.isEdited,
    })),
    totals: {
      gross: fees ? record.totals.gross : null,
      discount: fees ? record.totals.discount : null,
      net: fees ? record.totals.net : null,
      currency: record.totals.currency,
      // Not redacted: a count of lines, not an amount, and "this agreement is
      // not fully priced" is a fact about the work.
      unpricedLineCount: record.totals.unpricedLineCount,
    },
    engagements: record.engagements.map(toEngagementBody),
    signing: toSigningBody(record.signing),
  };
}

function toSummaryBody(s: LetterSummary, fees: boolean): z.infer<typeof LetterSummarySchema> {
  return {
    letter: toLetterBody(s.letter, fees),
    party: { id: s.party.id, displayName: s.party.displayName },
    issuingEntity: { id: s.issuingEntity.id, displayName: s.issuingEntity.displayName },
    totals: {
      gross: fees ? s.totals.gross : null,
      discount: fees ? s.totals.discount : null,
      net: fees ? s.totals.net : null,
      currency: s.totals.currency,
      unpricedLineCount: s.totals.unpricedLineCount,
    },
    lineCount: s.lineCount,
  };
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerEngagementRoutes(app: OpenAPIHono<AppEnv>, deps: EngagementDeps): void {
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);

  app.openapi(draftRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const letter = await deps.service.draft({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(toLetterBody(letter, seesFees(c.get("principal"))), 201);
  });

  app.openapi(draftFromProposalRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const out = await deps.service.draftFromQuote(
      { tenantId: s.tenantId, proposalId, ...body },
      s.actor,
    );
    return c.json(
      {
        letter: toLetterBody(out.letter, seesFees(c.get("principal"))),
        linesCopied: out.lines.length,
        skipped: out.skipped.map((sk) => ({ ...sk })),
      },
      201,
    );
  });

  app.openapi(structureRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const structure = await deps.service.structureFor(s.tenantId, partyId);
    return c.json(
      {
        entities: structure.entities.map((e) => ({ id: e.id, displayName: e.displayName })),
        people: structure.people.map((p) => ({ id: p.id, displayName: p.displayName })),
      },
      200,
    );
  });

  app.openapi(billableRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const engagements = await deps.service.billableFor(s.tenantId, partyId);
    // MONEY IS REDACTED, NOT REFUSED, exactly as it is on a letter and a
    // proposal: somebody without the fee axis sees which services the client
    // has signed for and no figures, rather than an empty list that reads as
    // "this client has no engagements".
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        engagements: engagements.map((e) => ({
          ...e,
          unitAmount: fees ? e.unitAmount : null,
        })),
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { status, partyId } = c.req.valid("query");
    const letters = await deps.service.list(s.tenantId, { status, partyId });
    const fees = seesFees(c.get("principal"));
    return c.json({ letters: letters.map((l) => toSummaryBody(l, fees)) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const record = await deps.service.describe(s.tenantId, letterId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.addLine({ tenantId: s.tenantId, letterId, ...body });
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        id: line.id,
        entityPartyId: line.entityPartyId,
        // Null, not fetched: this is the write's echo, and the name comes back
        // on the next read. Honest about the join rather than pretending to it.
        entity: null,
        serviceVersionId: line.serviceVersionId,
        service: null,
        // Same as `service`: the catalogue's half of the four blocks needs the
        // pinned body, which is a join the write path does not make. What the
        // LINE wrote is reported as written, so `tailored` is exactly right and
        // the read route fills in the fallback.
        terms: {
          scope: { text: line.scopeOverride, tailored: line.scopeOverride !== null },
          clientObligations: {
            text: line.clientObligationsOverride,
            tailored: line.clientObligationsOverride !== null,
          },
          volumeLimits: {
            text: line.volumeLimitsOverride,
            tailored: line.volumeLimitsOverride !== null,
          },
          exclusions: {
            text: line.exclusionsOverride,
            tailored: line.exclusionsOverride !== null,
          },
        },
        description: line.description,
        position: line.position,
        quantity: line.quantity,
        unitAmount: fees ? line.unitAmount : null,
        priced: line.unitAmount !== null,
        currency: line.currency,
        discountPercent: fees ? line.discountPercent : null,
        net: null,
        effectiveFrom: line.effectiveFrom,
        jurisdiction: line.jurisdiction,
        billingFrequency: line.billingFrequency,
        pricingNote: line.pricingNote,
        oopEstimate: fees && line.oopEstimate !== null ? { ...line.oopEstimate } : null,
      },
      201,
    );
  });

  app.openapi(removeLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, lineId } = c.req.valid("param");
    await deps.service.removeLine(s.tenantId, letterId, lineId);
    return c.body(null, 204);
  });

  app.openapi(addClauseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const { clauseVersionId } = c.req.valid("json");
    await deps.service.addClause(s.tenantId, letterId, clauseVersionId);
    return c.body(null, 204);
  });

  app.openapi(sendRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const sent = await deps.service.send(s.tenantId, letterId, s.actor, {
      signer: body?.signer,
    });
    return c.json(toLetterBody(sent, seesFees(c.get("principal"))), 200);
  });

  app.openapi(retrySignatureRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    await deps.service.retrySignatureRequest(s.tenantId, letterId, s.actor);
    const view = await deps.service.describe(s.tenantId, letterId);
    return c.json(toSigningBody(view.signing), 200);
  });

  app.openapi(withdrawRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const withdrawn = await deps.service.withdraw(s.tenantId, letterId, s.actor);
    return c.json(toLetterBody(withdrawn, seesFees(c.get("principal"))), 200);
  });

  app.openapi(signRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.service.sign({ tenantId: s.tenantId, letterId, ...body }, s.actor);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        letter: toLetterBody(result.letter, fees),
        engagements: result.engagements.map(toEngagementBody),
      },
      200,
    );
  });

  app.openapi(advanceRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const principal = c.get("principal");
    const { letterId } = c.req.valid("param");
    // The person recording it is the SESSION's user, never a field in the body:
    // an attestation somebody could attribute to a colleague is not one.
    const result = await deps.service.recordAdvance(
      s.tenantId,
      letterId,
      principal?.userId ?? "",
      s.actor,
    );
    return c.json(
      {
        letter: toLetterBody(result.letter, seesFees(principal)),
        engagements: result.released.map(toEngagementBody),
      },
      200,
    );
  });
}
