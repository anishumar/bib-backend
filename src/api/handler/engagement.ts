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
import type { LetterBillingTiming } from "../../domain/engagement/model";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { BLOCK_KIND_VALUES } from "./document";
import { RecordAcceptanceRequest, RecordedAcceptanceSchema, toRecordedAcceptanceBody } from "./acceptance";
import { scopeOf } from "../scope";
import type { Principal } from "../../platform/callctx";
import type { AuthzService } from "../../usecase/authz/service";
import type { EngagementService } from "../../usecase/engagement/service";
import type { EngagementLifecycleService } from "../../usecase/engagement/lifecycle";
import type {
  EngagementRecord,
  FeeGroupRecord,
  LetterSummary,
  LetterTotals,
  LetterView,
} from "../../usecase/engagement/ports";
import type {
  EngagementState,
  EngagementStatus,
  LetterLayout,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import type { BillingFrequency } from "../../domain/document/model";

export interface EngagementDeps {
  readonly service: EngagementService;
  readonly authz: AuthzService;
  /** End, pause and resume an engagement (V2.3). */
  readonly lifecycle: EngagementLifecycleService;
}

export const LETTER_STATUS_VALUES = [
  "draft",
  "sent",
  "signed",
  "withdrawn",
] as const satisfies readonly LetterStatus[];

/** The two layouts a letter prints in (0083). Every letter drafted now is
 *  `annexure`; `classic` is the one every letter issued before it went out in. */
export const LETTER_LAYOUT_VALUES = ["classic", "annexure"] as const satisfies readonly LetterLayout[];

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

/** The rate of one OTHER currency on a letter (0344). The main currency's is
 *  the letter's own `fxRate`. The proposal's shape, under its own name. */
const LetterCurrencyRateSchema = z
  .object({
    currency: CurrencySchema,
    /** Redacted by the fee axis, like the letter's own rate. */
    fxRate: RateSchema.nullable(),
    fxRateDate: DaySchema,
    source: z.string().openapi({ description: 'Either "typed" or the name of the rate service that supplied it.' }),
  })
  .openapi("LetterCurrencyRate");

const SetLetterRateRequest = z
  .object({
    fxRate: RateSchema,
    fxRateDate: DaySchema,
    source: z.string().min(1).max(60).optional(),
  })
  .openapi("SetLetterCurrencyRateRequest");

/** The closed set lives in the domain; zod needs a literal tuple. */
/** When a recurring fee is invoiced (0319), the domain's own list. */
const LETTER_BILLING_TIMINGS = ["arrears", "advance", "on_date"] as const satisfies readonly LetterBillingTiming[];

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
    /** Which layout the PDF prints in (0083). `annexure` — a cover letter,
     *  Annexure 1 (scope, deliverables, a summary of fees by section) and
     *  Annexure 2 (the terms) — for every letter drafted now; `classic` for the
     *  letters issued before it, which must re-render as the client holds them. */
    layout: z.enum(LETTER_LAYOUT_VALUES),
    currency: CurrencySchema.openapi({
      description: "The MAIN currency: the default for a new service, with its rate below (0344).",
    }),
    fxRate: RateSchema.nullable(),
    fxRateDate: DaySchema,
    rates: z.array(LetterCurrencyRateSchema).openapi({
      description: "The rate of every other currency a service or section is priced in (0344), by code.",
    }),
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
    deletedAt: z.string().nullable().openapi({
      description:
        "When this DRAFT was deleted as made by mistake (0086), or null. Not withdrawn, which " +
        "is a letter the client has seen: a deleted letter is in no list, still opens by id, and " +
        "never changes again.",
    }),
    deletedByUserId: z.string().uuid().nullable(),
    copiedFromId: z.string().uuid().nullable().openapi({
      description:
        "The withdrawn letter this draft was copied from (0316), or null. Not `supersedesId`, " +
        "which names a SIGNED letter this one replaces.",
    }),
    chosenSignatoryId: z.string().uuid().nullable().openapi({
      description:
        "Who the drafter chose to sign for the firm (0343): an entry on " +
        "GET /api/v1/tenancy/signatories, or null for the firm's default at send. Once sent, " +
        "`firmSignatoryUserId`/`firmSignatoryTitle` are the record.",
    }),
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
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).nullable().openapi({
      description:
        "When the fee is invoiced (0319): `arrears` (on each period's last day, Q042), `advance` (at its start) " +
        "or `on_date` (from `billingOn`, then one span after). Null: not chosen, billed after each " +
        "period. Only for a monthly, quarterly or yearly fee.",
    }),
    billingOn: DaySchema.nullable().openapi({ description: "The first invoice date, with `on_date` only." }),
    advanceAmount: AmountSchema.nullable().openapi({
      description:
        "This service's own advance, before tax (0320): its work waits until the advance invoice is " +
        "paid. Null: none, or hidden without the fee axis (see `hasAdvance`).",
    }),
    hasAdvance: z.boolean().openapi({
      description: "Whether this service has its own advance. Never redacted, so a screen can say so.",
    }),
    /** WHY there is no amount. Not redacted: it is what prints where a figure
     *  would. */
    pricingNote: z.string().nullable(),
    /** Out-of-pocket expenses, separate from the fee and never in the totals.
     *  Redacted with the money. */
    oopEstimate: OopEstimateSchema.nullable(),
    /** The FEE GROUP that prices this line, or null for a line priced on its
     *  own (0083). A grouped line has no price of its own — `priced` is false
     *  and the group's fee is what it costs. */
    feeGroupId: z.string().uuid().nullable(),
  })
  .openapi("EngagementLetterLine");

/**
 * ONE FEE FOR SEVERAL SERVICES — a section of the letter's Annexure 1 (0083).
 *
 * The money — the fee and how it is paid — is redacted by the fee axis like a
 * line's price. The title and the section's prose are not: they say what the
 * firm undertook, which is the work.
 */
const FeeGroupSchema = z
  .object({
    id: z.string().uuid(),
    /** "A", "B", … — its rank among the letter's live groups; the section's
     *  letter on the PDF. */
    code: z.string(),
    position: z.number().int(),
    title: z.string(),
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES),
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).nullable(),
    billingOn: DaySchema.nullable(),
    /** PER BILLING PERIOD. Null when redacted. */
    amount: AmountSchema.nullable(),
    currency: CurrencySchema,
    /** "40% advance, 60% on completion". Redacted with the money. */
    paymentTerms: z.string().nullable(),
    /** What the Summary of Fees prints for this row. Null prints the title and
     *  the services it covers. */
    feeDescription: z.string().nullable(),
    intro: z.string().nullable(),
    deliverables: z.string().nullable(),
    clientObligations: z.string().nullable(),
    /** The live lines this fee pays for, in line order. */
    lineIds: z.array(z.string().uuid()),
  })
  .openapi("EngagementLetterFeeGroup");

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
    kind: z.enum(BLOCK_KIND_VALUES),
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
    /** Its LAST day of service, once it has been ended (V2.3). Periods that
     *  begin after it get no job and no filing. */
    endsOn: DaySchema.nullable(),
    /** Why it ended, in the firm's words. Null until it is ended. */
    endReason: z.string().nullable(),
    /** When the end was recorded. */
    endedAt: z.string().nullable(),
    /** When it was paused, while it is paused. */
    pausedAt: z.string().nullable(),
    /** The firm's day it last resumed after a pause. */
    resumedOn: DaySchema.nullable(),
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

/** One end of a letter copy (0316). Inlined, not a named component, for the
 *  reason given beside the proposal's: `.nullable()` would make it nullable
 *  everywhere it is used. */
const LetterCopyLinkSchema = z.object({
  id: z.string().uuid(),
  ref: z.string(),
  status: z.enum(LETTER_STATUS_VALUES),
});

/**
 * The letter's money PER BILLING FREQUENCY (T6.18, D8), summed by the
 * database: lines priced on their own at their frequency, each section's fee
 * once at the section's. The proposal's field names, so one sentence says both
 * documents' totals.
 */
const LetterFrequencyTotalSchema = z
  .object({
    /** One currency per row (0344): two currencies are never added together. */
    currency: CurrencySchema,
    frequency: z.enum(BILLING_FREQUENCY_VALUES).nullable(),
    /** Null when redacted by the fee axis. */
    net: AmountSchema.nullable(),
    /** What the figure covers: lines priced on their own, and whole sections. */
    lineCount: z.number().int(),
    /** Lines on their own with no price ("as mutually agreed"), left out of
     *  the figure. A count, not money: not redacted. */
    unpricedLineCount: z.number().int(),
  })
  .openapi("LetterFrequencyTotal");

/**
 * HOW ANNEXURE 1 IS ORGANISED (T6.18 S6), from the SAME `planAnnexure` the PDF
 * is drawn from: the sections in order (a fee group is a section; lines priced
 * on their own come last as one more), each numbered service and the lines it
 * prints for, and the Summary of Fees row by row. A screen draws the letter
 * from this rather than re-deciding which service is "B2".
 */
const LetterDocumentSchema = z
  .object({
    sections: z.array(
      z.object({
        /** "B". */
        code: z.string(),
        title: z.string(),
        /** The fee group this section IS, or null for the lines priced on
         *  their own. Its fee and prose are in `feeGroups`. */
        feeGroupId: z.string().uuid().nullable(),
        /** The companies every service here is for, printed once under the
         *  heading — or null when the letter should not say so here. */
        entityNames: z.array(z.string()).nullable(),
        items: z.array(
          z.object({
            /** "B1". */
            code: z.string(),
            description: z.string(),
            /** The companies this one service is for, when the section mixes. */
            entityNames: z.array(z.string()).nullable(),
            /** Printed only when this service starts on a day of its own. */
            beginsOn: DaySchema.nullable(),
            /** The letter lines this item prints for — one per company. */
            lineIds: z.array(z.string().uuid()),
          }),
        ),
      }),
    ),
    fees: z.array(
      z.object({
        /** "B" for a whole section, "C1" for a line priced on its own. */
        code: z.string(),
        /** The section this row is, or null for a line's row. */
        feeGroupId: z.string().uuid().nullable(),
        /** The line this row is, or null for a section's row. */
        lineId: z.string().uuid().nullable(),
        description: z.string(),
        billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable(),
        startsOn: DaySchema.nullable(),
        /** Null for a line with no price of its own, or when redacted. */
        amount: AmountSchema.nullable(),
        /** The section's or the line's own currency (0344). */
        currency: CurrencySchema,
        pricingNote: z.string().nullable(),
        /** Redacted with the money. */
        paymentTerms: z.string().nullable(),
      }),
    ),
  })
  .openapi("LetterDocumentPlan");

const LetterRecordSchema = z
  .object({
    letter: LetterSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — the letterhead and the signature block both
     *  print it. */
    issuingEntity: PartyRefSchema,
    /**
     * THE ISSUER WITH WHERE IT IS REGISTERED (T6.18 S6): whose law and courts
     * a term on this letter may name (D6). A screen offering terms offers only
     * those; `jurisdiction` is null for a company with no registration
     * recorded, which the API refuses any law-naming term for.
     */
    issuer: z.object({
      partyId: z.string().uuid(),
      name: z.string(),
      jurisdiction: z.string().nullable(),
    }),
    /** The money per billing frequency (D8), never one mixed net. */
    totalsByFrequency: z.array(LetterFrequencyTotalSchema).openapi({
      description: "Per currency and frequency, the main currency's rows first (0344).",
    }),
    /** How Annexure 1 is organised, as the PDF prints it. */
    document: LetterDocumentSchema,
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
    /** The live fee groups, in section order (0083). Each group's fee is in the
     *  totals once; its lines are not counted as unpriced. */
    feeGroups: z.array(FeeGroupSchema),
    clauses: z.array(LetterClauseSchema),
    blocks: z.array(DocumentBlockSchema),
    totals: z.array(TotalsSchema).openapi({
      description:
        "One per currency the live services and sections are in, the main currency first; one " +
        "zero row in the main currency on an empty letter (0344). Never added together.",
    }),
    engagements: z.array(EngagementSchema),
    signing: SigningSchema,
    /** Who deleted it (0086), when it was and the account still resolves. */
    deletedBy: z
      .object({
        userId: z.string().uuid(),
        displayName: z.string().nullable(),
        email: z.string().email(),
      })
      .nullable(),
    deleteRefusal: z
      .object({ code: z.string(), message: z.string() })
      .nullable()
      .openapi({
        description:
          "Why DELETE /api/v1/engagement-letters/{letterId} would be refused right now, in its " +
          "own words — or null when it would work (0086), which means a live draft. Says nothing " +
          "about `party:write`, which /auth/me already does.",
      }),
    copiedFrom: LetterCopyLinkSchema.nullable().openapi({
      description: "The withdrawn letter this draft was copied from (0316), or null.",
    }),
    copies: z.array(LetterCopyLinkSchema).openapi({
      description:
        "The drafts copied from this letter, oldest first (0316). A copy deleted as a mistake " +
        "is left out.",
    }),
    copyRefusal: z
      .object({ code: z.string(), message: z.string() })
      .nullable()
      .openapi({
        description:
          "Why POST /api/v1/engagement-letters/{letterId}/copy would be refused right now, in " +
          "its own words, or null when it would work (0316): only a withdrawn letter is copied.",
      }),
    recordedAcceptance: RecordedAcceptanceSchema.nullable().openapi({
      description:
        "The client's acceptance given outside bib, recorded by a colleague holding " +
        "`acceptance:record` (0317): how, when, who, the note and the client's filed email. " +
        "The letter's signatureMethod is then `recorded_acceptance`.",
    }),
  })
  .openapi("EngagementLetterRecord");

const LetterSummarySchema = z
  .object({
    letter: LetterSchema,
    party: PartyRefSchema,
    issuingEntity: PartyRefSchema,
    totals: z.array(TotalsSchema).openapi({ description: "One per currency, the main currency first (0344)." }),
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

/**
 * A revision of a DRAFT letter's head (T6.18 S6). Every field optional; null
 * clears a nullable one. The three money fields travel together.
 */
const ReviseLetterRequest = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    background: z.string().max(20000).nullable().optional(),
    addressedToPartyId: z.string().uuid().nullable().optional(),
    issuedOn: DaySchema.nullable().optional(),
    effectiveFrom: DaySchema.nullable().optional(),
    advanceRequired: z.boolean().optional(),
    advanceAmount: AmountSchema.nullable().optional(),
    jurisdiction: JurisdictionSchema.optional().openapi({
      description:
        "The letter's country, which decides its terms and its wording. Changing it (or the " +
        "issuer) replaces the wording with the standard set for the new country and company, " +
        "and is refused while terms are on the letter (TERMS_ON_LETTER).",
    }),
    issuingEntityPartyId: z.string().uuid().optional(),
    replaceEditedProse: z.boolean().optional().openapi({
      description:
        "Replace wording edited or written for this client when the issuer or country changes. " +
        "Without it such a change is refused with PROSE_EDITED, naming how many lines would go.",
    }),
    currency: CurrencySchema.optional(),
    fxRate: RateSchema.optional(),
    fxRateDate: DaySchema.optional(),
    chosenSignatoryId: z.string().uuid().nullable().optional().openapi({
      description:
        "Who signs for the firm (0343): an entry on the firm's list, or null for its default. " +
        "A retired signatory is refused (SIGNATORY_RETIRED), here and again at send.",
    }),
  })
  .openapi("ReviseEngagementLetterRequest");

/**
 * A change to one line of a DRAFT letter (T6.18 S6): the add-line fields, all
 * optional. Null means "back to the default": no fixed fee (a pricing note is
 * then required), the service's recurrence, the letter's start date, the
 * catalogue's words for a scope text.
 */
const UpdateLetterLineRequest = z
  .object({
    description: z.string().max(500).optional(),
    entityPartyId: z.string().uuid().optional(),
    quantity: AmountSchema.optional(),
    unitAmount: AmountSchema.nullable().optional(),
    currency: CurrencySchema.optional().openapi({
      description:
        "Another currency the letter holds a rate for (0344): CURRENCY_NEEDS_A_RATE (409) when " +
        "it holds none. Not on a service in a section (LINE_CURRENCY_IS_SECTIONS, 409).",
    }),
    discountPercent: AmountSchema.optional(),
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable().optional(),
    /** Null clears it. Sent with `billingOn` when it is `on_date`. */
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).nullable().optional(),
    billingOn: DaySchema.nullable().optional(),
    /** This service's own advance, before tax (0320). Null clears it. Refused
     *  on a grouped line and on a letter with one advance for the whole of it. */
    advanceAmount: AmountSchema.nullable().optional(),
    pricingNote: z.string().max(2000).nullable().optional(),
    effectiveFrom: DaySchema.nullable().optional(),
    jurisdiction: JurisdictionSchema.nullable().optional(),
    scopeOverride: z.string().max(20000).nullable().optional(),
    clientObligationsOverride: z.string().max(20000).nullable().optional(),
    volumeLimitsOverride: z.string().max(20000).nullable().optional(),
    exclusionsOverride: z.string().max(20000).nullable().optional(),
    oopEstimate: OopEstimateSchema.nullable().optional(),
  })
  .openapi("UpdateEngagementLetterLineRequest");

const AddLineRequest = z
  .object({
    entityPartyId: z.string().uuid(),
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    /** OPTIONAL since G1.6: omit it for a line that is genuinely "as mutually
     *  agreed" and send `pricingNote`. Omitting it is NOT sending "0". */
    unitAmount: AmountSchema.optional().openapi({
      description:
        "The fee. Omit it and `pricingNote` both to quote the catalogue's list price for this " +
        "service in the letter's currency (B09): how a login that cannot see fees adds a priced " +
        "service. SERVICE_HAS_NO_LIST_PRICE (400) when there is none.",
    }),
    currency: CurrencySchema.optional().openapi({
      description:
        "What this service is priced in (0344): the letter's main currency or another it holds a " +
        "rate for. Omit for the section's (in a section), else the list price's currency when " +
        "the fee comes from the list price and the letter holds its rate, else the main currency.",
    }),
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
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).optional().openapi({
      description:
        "When the fee is invoiced (0319): `arrears` (on each period's last day, Q042), `advance` (at its start) " +
        "or `on_date` (from `billingOn`, then one span after). Null: not chosen, billed after each " +
        "period. Only for a monthly, quarterly or yearly fee.",
    }),
    billingOn: DaySchema.optional(),
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
    /** WHY there is no amount — REQUIRED when `unitAmount` is omitted, unless
     *  the line is in a fee group. */
    pricingNote: z.string().min(1).optional(),
    feeGroupId: z.string().uuid().optional().openapi({
      description:
        "The FEE GROUP that prices this service (0083). The line then carries no price of its " +
        "own: omit `unitAmount` and leave the discount at 0 — the group's fee already pays for " +
        "it, and a price on both would charge twice.",
    }),
  })
  .openapi("AddEngagementLetterLineRequest");

const FeeGroupRequest = z
  .object({
    title: z.string().min(1).max(200),
    /** The fee's currency (0344): the main one when omitted, else one the
     *  letter holds a rate for. */
    currency: CurrencySchema.optional(),
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES),
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).optional(),
    billingOn: DaySchema.optional(),
    /** PER BILLING PERIOD — 5000 on a monthly group is 5,000 a month. */
    amount: AmountSchema,
    paymentTerms: z.string().max(500).optional(),
    feeDescription: z.string().max(2000).optional(),
    intro: z.string().max(20000).optional(),
    deliverables: z.string().max(20000).optional(),
    clientObligations: z.string().max(20000).optional(),
  })
  .openapi("FeeGroupRequest");

/** Every field optional. An absent one is left as it is; an EMPTY string
 *  clears a prose field, which a null would say less clearly on a form. */
const EditFeeGroupRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    /** A new currency for the fee (0344); its services move with it. */
    currency: CurrencySchema.optional(),
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).optional(),
    billingTiming: z.enum(LETTER_BILLING_TIMINGS).nullable().optional(),
    billingOn: DaySchema.nullable().optional(),
    amount: AmountSchema.optional(),
    paymentTerms: z.string().max(500).optional(),
    feeDescription: z.string().max(2000).optional(),
    intro: z.string().max(20000).optional(),
    deliverables: z.string().max(20000).optional(),
    clientObligations: z.string().max(20000).optional(),
  })
  .openapi("EditFeeGroupRequest");

const LinePricingRequest = z
  .object({
    feeGroupId: z.string().uuid().nullable().openapi({
      description:
        "The fee group to price this service, or null to price it on its own. Into a group, " +
        "the line GIVES UP its price, discount and pricing note. On its own, it needs " +
        "`unitAmount` or a `pricingNote` saying why it has none.",
    }),
    unitAmount: AmountSchema.optional(),
    discountPercent: AmountSchema.optional(),
    pricingNote: z.string().min(1).optional(),
  })
  .openapi("LinePricingRequest");

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
    issuingEntityPartyId: z.string().uuid().openapi({
      description:
        "Which of the firm's companies signed the letter. That company charges for the work: " +
        "an invoice line for this engagement is refused on an invoice charged by any other " +
        "(ENGAGEMENT_OF_ANOTHER_ISSUER), so an invoice screen preselects it.",
    }),
    issuingEntityName: z.string(),
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
    /** Why it ended (V2.3), in the firm's words. Null until it is ended. */
    endReason: z.string().nullable(),
    billingFrom: DaySchema.nullable().openapi({
      description:
        "The first period billed (0318), its first day. Null with `firstInvoiceOn`: billing not set up.",
    }),
    firstInvoiceOn: DaySchema.nullable().openapi({
      description: "The date the first period's invoice falls due; each later period one billing span after.",
    }),
    feeGroup: z
      .object({
        id: z.string().uuid(),
        /** The section letter it prints under — "B". */
        code: z.string(),
        title: z.string(),
        /** The GROUP's fee per period, for every engagement in it together.
         *  Null when redacted. */
        amount: AmountSchema.nullable(),
        billingFrequency: z.string(),
        lineCount: z.number().int(),
      })
      .nullable()
      .openapi({
        description:
          "The fee group that prices this engagement (0083), or null. When set, `unitAmount` " +
          "is null because the price is the GROUP's — one fee for every engagement in it — and " +
          "a screen must not prefill that fee per engagement: four engagements of a USD 5,000 " +
          "retainer are billed 5,000, not 20,000.",
      }),
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

const reviseRoute = createRoute({
  method: "patch",
  path: "/api/v1/engagement-letters/{letterId}",
  tags: ["engagement-letters"],
  summary: "Change a draft letter's head",
  description:
    "T6.18 S6. Its title, Background, addressee, dates and advance; its currency while nothing " +
    "on it is priced; its country and issuing company while no term is on it, which replaces " +
    "its wording with that company's standard set for that country (D9). A draft only. Answers " +
    "with the whole letter, as GET reads it.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: ReviseLetterRequest } }, required: true },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: LetterRecordSchema } } },
    400: errorResponse("Nothing to change, a bad date or amount, or a currency without its rate"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse(
      "Not a draft, a new currency over priced lines, wording written for the client, or terms on the letter",
    ),
  },
});

const setRateRoute = createRoute({
  method: "put",
  path: "/api/v1/engagement-letters/{letterId}/rates/{currency}",
  tags: ["engagement-letters"],
  summary: "Set the exchange rate of one of a draft letter's other currencies",
  description:
    "Every currency a service or section is priced in, other than the main one, needs a rate " +
    "back to the firm's reporting currency (0344). Inserts it, or replaces the one there. The " +
    "main currency's rate is changed with the currency (PATCH the letter). Answers with the " +
    "whole letter.",
  request: {
    params: z.object({ letterId: z.string().uuid(), currency: CurrencySchema }),
    body: { content: { "application/json": { schema: SetLetterRateRequest } }, required: true },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: LetterRecordSchema } } },
    400: errorResponse("Not a rate or a day, or the main currency (RATE_FOR_MAIN_CURRENCY)"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const removeRateRoute = createRoute({
  method: "delete",
  path: "/api/v1/engagement-letters/{letterId}/rates/{currency}",
  tags: ["engagement-letters"],
  summary: "Take a currency's rate off a draft letter",
  description:
    "Only while no live service or section is priced in it (RATE_IN_USE). Answers with the whole letter.",
  request: { params: z.object({ letterId: z.string().uuid(), currency: CurrencySchema }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: LetterRecordSchema } } },
    400: errorResponse("The main currency (RATE_FOR_MAIN_CURRENCY)"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not a draft, or services or sections are priced in it (RATE_IN_USE)"),
  },
});

const updateLineRoute = createRoute({
  method: "patch",
  path: "/api/v1/engagement-letters/{letterId}/lines/{lineId}",
  tags: ["engagement-letters"],
  summary: "Change a service already on a draft letter",
  description:
    "T6.18 S6. Its wording, company, quantity, fee, discount, billing frequency, pricing note, " +
    "start date and scope texts, judged by the same rules as adding it. A service in a section " +
    "has no price of its own; move it with `PUT …/pricing`. Answers with the whole letter.",
  request: {
    params: z.object({ letterId: z.string().uuid(), lineId: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateLetterLineRequest } }, required: true },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: LetterRecordSchema } } },
    400: errorResponse("Nothing to change, a blank name, or a price the rules refuse"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter or line at this firm"),
    409: errorResponse("The letter is no longer a draft, or the company is not the client's"),
  },
});

const LetterGroupParams = z.object({ letterId: z.string().uuid(), groupId: z.string().uuid() });

const addFeeGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/fee-groups",
  tags: ["engagement-letters"],
  summary: "Add a fee group — one fee for several services",
  description:
    "A section of the letter's Annexure 1 and the ONE fee it charges (0083): \"B. Ongoing " +
    "recurring services — USD 5,000 per month\" for accounting, tax and payroll across four " +
    "companies. Services are put in it when they are added (`feeGroupId`) or afterwards (`PUT " +
    "…/lines/{lineId}/pricing`), and then carry no price of their own. In the letter's " +
    "currency, always. Draft only.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: { content: { "application/json": { schema: FeeGroupRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: FeeGroupSchema } } },
    400: errorResponse("No title, an amount that is not one, or an unknown billing frequency"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const editFeeGroupRoute = createRoute({
  method: "patch",
  path: "/api/v1/engagement-letters/{letterId}/fee-groups/{groupId}",
  tags: ["engagement-letters"],
  summary: "Change a fee group's terms while the letter is a draft",
  request: {
    params: LetterGroupParams,
    body: { content: { "application/json": { schema: EditFeeGroupRequest } }, required: true },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: FeeGroupSchema } } },
    400: errorResponse("A blank title, an amount that is not one, or an unknown frequency"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter or fee group at this firm"),
    409: errorResponse("The letter is no longer a draft"),
  },
});

const removeFeeGroupRoute = createRoute({
  method: "delete",
  path: "/api/v1/engagement-letters/{letterId}/fee-groups/{groupId}",
  tags: ["engagement-letters"],
  summary: "Strike a fee group off a draft",
  description:
    "Refused while the group still prices a service: struck off, it would leave that service " +
    "with no price and no reason. Move the services out first.",
  request: { params: LetterGroupParams },
  responses: {
    204: { description: "Struck off" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter or fee group at this firm"),
    409: errorResponse("The letter is not a draft, or the group still covers services"),
  },
});

const linePricingRoute = createRoute({
  method: "put",
  path: "/api/v1/engagement-letters/{letterId}/lines/{lineId}/pricing",
  tags: ["engagement-letters"],
  summary: "Price a service by a fee group, or on its own",
  request: {
    params: z.object({ letterId: z.string().uuid(), lineId: z.string().uuid() }),
    body: { content: { "application/json": { schema: LinePricingRequest } }, required: true },
  },
  responses: {
    200: { description: "Repriced", content: { "application/json": { schema: LetterLineSchema } } },
    400: errorResponse("A grouped line sent with a price, or a line on its own sent with none"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter, line or fee group at this firm"),
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

const StandardClausesResponse = z
  .object({
    /** What went on, in the order it went on. */
    added: z.array(
      z.object({ clauseKey: z.string(), clauseVersionId: z.string().uuid(), title: z.string() }),
    ),
    /** What did not, each with the sentence adding it by hand would have been
     *  refused with — another country, another law than the issuer's, or
     *  already on the letter. */
    skipped: z.array(z.object({ clauseKey: z.string(), reason: z.string() })),
  })
  .openapi("StandardClausesAdded");

const addStandardClausesRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/clauses/standard",
  tags: ["engagement-letters"],
  summary: "Put every standard term that fits on the letter",
  description:
    "T6.18 (D6): every published clause that applies to the letter's country and whose " +
    "governing law and courts are the issuing company's, by the same rules as adding one by " +
    "hand; clauses already on the letter are skipped. A draft only.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: {
      description: "What was added and what was skipped, and why",
      content: { "application/json": { schema: StandardClausesResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is no longer a draft, or was deleted"),
  },
});

/**
 * The CALLER's today, for the two writes that stamp a day on a letter: sending
 * (the date on an undated letter) and recording the signature (the day its work
 * starts when nothing else says). Absent means the FIRM's day, never the
 * server's UTC day. Held to the firm's day or one either side, as on invoices.
 */
const CallerDayQuery = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description:
        "Today where the caller is (a browser sends its local date). Defaults to the firm's " +
        "day. Must be the firm's day or one either side; a letter meant for another day says " +
        "so in its own issuedOn or effectiveFrom.",
    }),
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
    "does not send, `signer` is ignored. A letter drafted with no `issuedOn` is dated the " +
    "caller's `asOf`, or the firm's day.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: SendRequest } }, required: false },
  },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: LetterSchema } } },
    400: errorResponse(
      "DocuSign is the provider and no usable signer was given, or asOf is not today anywhere",
    ),
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

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/v1/engagement-letters/{letterId}",
  tags: ["engagement-letters"],
  summary: "Delete a draft made by mistake",
  description:
    "Takes a DRAFT off the list of letters; it still opens by id, says it was deleted, and " +
    "never changes again (0086). Its reference is not reused. A letter the client has seen is " +
    "WITHDRAWN instead, which keeps the record that it was offered, and a signed one is never " +
    "deleted. GET /api/v1/engagement-letters/{letterId} says in advance whether this would work.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: LetterSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is not a draft, or it was already deleted"),
  },
});

const SkippedCopySchema = z.object({
  id: z.string(),
  description: z.string(),
  reason: z.string(),
});

const copyRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/copy",
  tags: ["engagement-letters"],
  summary: "Copy a withdrawn letter into a new draft",
  description:
    "Starts the next letter from one the firm withdrew or the client declined (0316): a new " +
    "DRAFT with a new reference, the same client, issuing company, country, quote, currency, " +
    "title, Background, addressee and advance, every fee section and live line exactly as it " +
    "was, and the prose including the cover letter and acceptance. Terms come across at the " +
    "clause library's CURRENT wording; one retired from the library, or no longer fitting the " +
    "country or the issuer's law, is listed in `skippedClauses`. A start date already past is " +
    "left off. The old letter does not change. GET /api/v1/engagement-letters/{letterId} says " +
    "in advance whether this would work (`copyRefusal`).",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    201: {
      description: "The new draft",
      content: {
        "application/json": {
          schema: z
            .object({
              letter: LetterSchema,
              source: DocumentRefSchema,
              linesCopied: z.number().int(),
              feeGroupsCopied: z.number().int(),
              clausesCopied: z.number().int(),
              skippedLines: z.array(SkippedCopySchema),
              skippedClauses: z.array(SkippedCopySchema),
              addresseeDropped: z.boolean(),
            })
            .openapi("LetterCopy"),
        },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("The letter is not withdrawn, or it was deleted"),
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

// ── An engagement's life after signature (V2.3) ─────────────────────────────

const EngagementParam = z.object({ engagementId: z.string().uuid() });

const EndEngagementBody = z
  .object({
    endsOn: DaySchema.openapi({
      description:
        "The LAST day the firm serves it, YYYY-MM-DD. Periods that begin after it get no job " +
        "and no filing; its untouched filings for them are withdrawn. A day before its work " +
        "began ends it as cancelled.",
      example: "2026-09-30",
    }),
    reason: z.string().max(2000).openapi({
      description: "Why it is ending, in your words. Kept on the engagement, never in the audit log.",
      example: "Client moved their books to another firm.",
    }),
  })
  .openapi("EndEngagement");

const EngagementEndedSchema = z
  .object({
    engagement: EngagementSchema,
    filings: z.object({
      withdrawn: z.number().int(),
      kept: z.number().int(),
      keptStarted: z.number().int(),
      keptPastDue: z.number().int(),
      keptCoveredElsewhere: z.number().int(),
      repointed: z.number().int(),
    }),
    openJobsAfterEnd: z
      .array(z.object({ jobId: z.string().uuid(), periodLabel: z.string().nullable() }))
      .openapi({
        description:
          "Jobs already on the board for periods after the end. Ending leaves them; cancel each " +
          "on its job page.",
      }),
  })
  .openapi("EngagementEnded");

const endEngagementRoute = createRoute({
  method: "post",
  path: "/api/v1/engagements/{engagementId}/end",
  tags: ["engagement-letters"],
  summary: "End an engagement on its last day of service",
  description:
    "The status changes at once (completed, or cancelled when the end falls before the work " +
    "began), so it leaves MRR today. Work up to the last day still spawns; its untouched " +
    "upcoming filings for later periods are withdrawn in the same transaction. The signed " +
    "letter is not touched.",
  request: {
    params: EngagementParam,
    body: { content: { "application/json": { schema: EndEngagementBody } }, required: true },
  },
  responses: {
    200: { description: "Ended", content: { "application/json": { schema: EngagementEndedSchema } } },
    400: errorResponse("No reason, or the day is not a calendar day"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such engagement at this firm"),
    409: errorResponse("It has already ended"),
  },
});

const pauseEngagementRoute = createRoute({
  method: "post",
  path: "/api/v1/engagements/{engagementId}/pause",
  tags: ["engagement-letters"],
  summary: "Pause running work",
  description:
    "No new jobs and no new filings until it resumes. Nothing already on the board or the " +
    "calendar moves. It leaves MRR while paused.",
  request: { params: EngagementParam },
  responses: {
    200: { description: "Paused", content: { "application/json": { schema: EngagementSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such engagement at this firm"),
    409: errorResponse("It is not running: waiting for its advance, already paused, or ended"),
  },
});

const resumeEngagementRoute = createRoute({
  method: "post",
  path: "/api/v1/engagements/{engagementId}/resume",
  tags: ["engagement-letters"],
  summary: "Resume a paused engagement",
  description:
    "Work spawns again from the firm's today. A period that ended while it was paused gets no " +
    "job; a filing that fell due meanwhile comes back, as missed if its date has passed.",
  request: { params: EngagementParam },
  responses: {
    200: { description: "Resumed", content: { "application/json": { schema: EngagementSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such engagement at this firm"),
    409: errorResponse("It is not paused, or it has ended"),
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
    "no `contract.activated` is emitted until it is recorded. Work whose line and letter name " +
    "no start day starts on the caller's `asOf`, or the firm's day.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: SignRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Signed, with the engagements it created",
      content: { "application/json": { schema: SignedResponse } },
    },
    400: errorResponse("A signature missing a signatory, or asOf is not today anywhere"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not in a signable state, or missing lines or clauses"),
  },
});

const recordAcceptanceRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/acceptance",
  tags: ["engagement-letters"],
  summary: "Record that the client accepted outside bib",
  description:
    "The client said yes by email, on a call or in a meeting and never signed (0317). Needs " +
    "`acceptance:record` (a partner, by default). The client's email or letter must already " +
    "be uploaded and attached to THIS letter (`evidenceDocumentId`). Only while the letter is " +
    "sent. An envelope still out with the e-sign provider is VOIDED first, so the client " +
    "cannot also sign it; one the provider reports signed is refused and left for the " +
    "signature sweep. Then the letter is signed as a signature would sign it — frozen, one " +
    "engagement per line, the advance gate — under the method `recorded_acceptance`, with the " +
    "evidence in the same transaction. The recorder is the session's user.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: RecordAcceptanceRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Signed as accepted, with the engagements it created",
      content: { "application/json": { schema: SignedResponse } },
    },
    400: errorResponse("A field is missing or impossible, no evidence, or asOf is not today anywhere"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not hold acceptance:record"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not sent, the envelope is already signed, or the file is not attached to this letter"),
    502: errorResponse("The e-sign provider could not be reached to void the envelope"),
  },
});

const recordAgreedRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/agreed",
  tags: ["engagement-letters"],
  summary: "Record a draft the client already agreed to, without sending it",
  description:
    "The short letter: the client agreed to these services and fees by email or on a call, " +
    "so nothing is sent for signature. Needs `acceptance:record`, and the body and evidence " +
    "rules of `/acceptance` (the client's email uploaded and attached to THIS letter). Only " +
    "while the letter is a draft. A draft with no terms gets the firm's standard terms. The " +
    "letter is then signed as `/acceptance` signs one, under `recorded_acceptance`; no " +
    "envelope is raised and no cover page is needed. A refusal leaves it a draft.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: RecordAcceptanceRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Signed as agreed, with the engagements it created",
      content: { "application/json": { schema: SignedResponse } },
    },
    400: errorResponse("A field is missing or impossible, no evidence, or asOf is not today anywhere"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not hold acceptance:record"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not a draft, no services or terms, or the file is not attached to this letter"),
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
    layout: letter.layout,
    currency: letter.currency,
    fxRate: fees ? letter.fxRate : null,
    fxRateDate: letter.fxRateDate,
    rates: letter.rates.map((r) => ({
      currency: r.currency,
      fxRate: fees ? r.fxRate : null,
      fxRateDate: r.fxRateDate,
      source: r.source,
    })),
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
    deletedAt: letter.deletedAt,
    deletedByUserId: letter.deletedByUserId,
    copiedFromId: letter.copiedFromId,
    chosenSignatoryId: letter.chosenSignatoryId,
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
    endReason: r.engagement.endReason,
    endedAt: r.engagement.endedAt,
    pausedAt: r.engagement.pausedAt,
    resumedOn: r.engagement.resumedOn,
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
    issuer: {
      partyId: record.issuingEntity.id,
      name: record.issuingEntity.displayName,
      jurisdiction: record.issuerJurisdiction,
    },
    totalsByFrequency: record.totalsByFrequency.map((t) => ({
      currency: t.currency,
      frequency: t.frequency,
      net: fees ? t.net : null,
      lineCount: t.lineCount,
      unpricedLineCount: t.unpricedLineCount,
    })),
    document: {
      sections: record.document.sections.map((sec) => ({
        code: sec.code,
        title: sec.title,
        feeGroupId: sec.group === null ? null : sec.group.id,
        entityNames: sec.entityNames === null ? null : [...sec.entityNames],
        items: sec.items.map((item) => ({
          code: item.code,
          description: item.description,
          entityNames: item.entityNames === null ? null : [...item.entityNames],
          beginsOn: item.beginsOn,
          lineIds: [...item.lineIds],
        })),
      })),
      fees: record.document.fees.map((f) => ({
        code: f.code,
        feeGroupId: f.feeGroupId,
        lineId: f.lineId,
        description: f.description,
        billingFrequency: f.billingFrequency,
        startsOn: f.startsOn,
        amount: fees ? f.amount : null,
        currency: f.currency,
        pricingNote: f.pricingNote,
        paymentTerms: fees ? f.paymentTerms : null,
      })),
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
      billingTiming: l.line.billingTiming,
      billingOn: l.line.billingOn,
      advanceAmount: fees ? l.line.advanceAmount : null,
      hasAdvance: l.line.advanceAmount !== null,
      pricingNote: l.line.pricingNote,
      oopEstimate: fees && l.line.oopEstimate !== null ? { ...l.line.oopEstimate } : null,
      feeGroupId: l.line.feeGroupId,
    })),
    feeGroups: record.feeGroups.map((g) => toFeeGroupBody(g, fees)),
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
    totals: record.totals.map((t) => toTotalsBody(t, fees)),
    engagements: record.engagements.map(toEngagementBody),
    signing: toSigningBody(record.signing),
    deletedBy: record.deletedBy === null ? null : { ...record.deletedBy },
    deleteRefusal:
      record.deleteRefusal === null
        ? null
        : { code: record.deleteRefusal.code, message: record.deleteRefusal.message },
    copiedFrom: record.copiedFrom === null ? null : { ...record.copiedFrom },
    copies: record.copies.map((c) => ({ id: c.id, ref: c.ref, status: c.status })),
    copyRefusal:
      record.copyRefusal === null
        ? null
        : { code: record.copyRefusal.code, message: record.copyRefusal.message },
    recordedAcceptance: toRecordedAcceptanceBody(record.recordedAcceptance),
  };
}

/** A fee group, field by field. The fee and how it is paid are money and go
 *  with the fee axis; the title and prose are the work and do not. */
function toFeeGroupBody(g: FeeGroupRecord, fees: boolean): z.infer<typeof FeeGroupSchema> {
  return {
    id: g.group.id,
    code: g.code,
    position: g.group.position,
    title: g.group.title,
    billingFrequency: g.group.billingFrequency,
    billingTiming: g.group.billingTiming,
    billingOn: g.group.billingOn,
    amount: fees ? g.group.amount : null,
    currency: g.group.currency,
    paymentTerms: fees ? g.group.paymentTerms : null,
    feeDescription: g.group.feeDescription,
    intro: g.group.intro,
    deliverables: g.group.deliverables,
    clientObligations: g.group.clientObligations,
    lineIds: [...g.lineIds],
  };
}

/**
 * A line as a WRITE echoes it: what the line itself says, with the joins the
 * write path does not make (`entity`, `service`, `net`) reported as absent
 * rather than faked. The read route fills them in.
 */
function toLineEchoBody(line: LetterLine, fees: boolean): z.infer<typeof LetterLineSchema> {
  return {
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
    billingTiming: line.billingTiming,
    billingOn: line.billingOn,
    advanceAmount: fees ? line.advanceAmount : null,
    hasAdvance: line.advanceAmount !== null,
    pricingNote: line.pricingNote,
    oopEstimate: fees && line.oopEstimate !== null ? { ...line.oopEstimate } : null,
    feeGroupId: line.feeGroupId,
  };
}

function toTotalsBody(t: LetterTotals, fees: boolean): z.infer<typeof TotalsSchema> {
  return {
    gross: fees ? t.gross : null,
    discount: fees ? t.discount : null,
    net: fees ? t.net : null,
    currency: t.currency,
    // Not redacted: a count of lines, not an amount, and "this agreement is
    // not fully priced" is a fact about the work.
    unpricedLineCount: t.unpricedLineCount,
  };
}

function toSummaryBody(s: LetterSummary, fees: boolean): z.infer<typeof LetterSummarySchema> {
  return {
    letter: toLetterBody(s.letter, fees),
    party: { id: s.party.id, displayName: s.party.displayName },
    issuingEntity: { id: s.issuingEntity.id, displayName: s.issuingEntity.displayName },
    totals: s.totals.map((t) => toTotalsBody(t, fees)),
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

  app.openapi(copyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const made = await deps.service.copyAsDraft(s.tenantId, letterId, s.actor);
    const item = (i: { id: string; description: string; reason: string }) => ({
      id: i.id,
      description: i.description,
      reason: i.reason,
    });
    return c.json(
      {
        letter: toLetterBody(made.letter, seesFees(c.get("principal"))),
        source: { id: made.source.id, ref: made.source.ref },
        linesCopied: made.linesCopied,
        feeGroupsCopied: made.feeGroupsCopied,
        clausesCopied: made.clausesCopied,
        skippedLines: made.skippedLines.map(item),
        skippedClauses: made.skippedClauses.map(item),
        addresseeDropped: made.addresseeDropped,
      },
      201,
    );
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
    // Field by field: the response is documented, not validated, so a spread
    // would ship whatever the read model grows next without the spec saying so.
    return c.json(
      {
        engagements: engagements.map((e) => ({
          engagementId: e.engagementId,
          entityPartyId: e.entityPartyId,
          entityName: e.entityName,
          letterId: e.letterId,
          letterRef: e.letterRef,
          issuingEntityPartyId: e.issuingEntityPartyId,
          issuingEntityName: e.issuingEntityName,
          description: e.description,
          quantity: e.quantity,
          unitAmount: fees ? e.unitAmount : null,
          pricingNote: e.pricingNote,
          currency: e.currency,
          discountPercent: e.discountPercent,
          billingFrequency: e.billingFrequency,
          status: e.status,
          effectiveFrom: e.effectiveFrom,
          endsOn: e.endsOn,
          endReason: e.endReason,
          billingFrom: e.billingFrom,
          firstInvoiceOn: e.firstInvoiceOn,
          feeGroup:
            e.feeGroup === null
              ? null
              : {
                  id: e.feeGroup.id,
                  code: e.feeGroup.code,
                  title: e.feeGroup.title,
                  amount: fees ? e.feeGroup.amount : null,
                  billingFrequency: e.feeGroup.billingFrequency,
                  lineCount: e.feeGroup.lineCount,
                },
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

  app.openapi(reviseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.revise({ tenantId: s.tenantId, letterId, ...body }, s.actor);
    const record = await deps.service.describe(s.tenantId, letterId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(setRateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, currency } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.setRate(
      { tenantId: s.tenantId, letterId, currency, fxRate: body.fxRate, fxRateDate: body.fxRateDate, source: body.source },
      s.actor,
    );
    const record = await deps.service.describe(s.tenantId, letterId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(removeRateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, currency } = c.req.valid("param");
    await deps.service.removeRate(s.tenantId, letterId, currency, s.actor);
    const record = await deps.service.describe(s.tenantId, letterId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(updateLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, lineId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.updateLine({ tenantId: s.tenantId, letterId, lineId, ...body });
    const record = await deps.service.describe(s.tenantId, letterId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.addLine({ tenantId: s.tenantId, letterId, ...body });
    return c.json(toLineEchoBody(line, seesFees(c.get("principal"))), 201);
  });

  app.openapi(linePricingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, lineId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.setLinePricing({ tenantId: s.tenantId, letterId, lineId, ...body });
    return c.json(toLineEchoBody(line, seesFees(c.get("principal"))), 200);
  });

  // A group's LETTER and its lines are the read model's (`code`, `lineIds`), so
  // a write reads the letter back and answers with the group as the page will
  // show it — the arrangement `…/signature-request` already has.
  const groupAsRead = async (
    tenantId: string,
    letterId: string,
    groupId: string,
    fees: boolean,
  ): Promise<z.infer<typeof FeeGroupSchema>> => {
    const view = await deps.service.describe(tenantId, letterId);
    const record = view.feeGroups.find((g) => g.group.id === groupId);
    if (record === undefined) {
      throw new Error(`fee group ${groupId} was written and is not on letter ${letterId}`);
    }
    return toFeeGroupBody(record, fees);
  };

  app.openapi(addFeeGroupRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const group = await deps.service.addFeeGroup(s.tenantId, letterId, body);
    return c.json(
      await groupAsRead(s.tenantId, letterId, group.id, seesFees(c.get("principal"))),
      201,
    );
  });

  app.openapi(editFeeGroupRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, groupId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.editFeeGroup(s.tenantId, letterId, groupId, body);
    return c.json(
      await groupAsRead(s.tenantId, letterId, groupId, seesFees(c.get("principal"))),
      200,
    );
  });

  app.openapi(removeFeeGroupRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId, groupId } = c.req.valid("param");
    await deps.service.removeFeeGroup(s.tenantId, letterId, groupId);
    return c.body(null, 204);
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

  app.openapi(addStandardClausesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const result = await deps.service.addStandardClauses(s.tenantId, letterId);
    return c.json(
      {
        added: result.added.map((a) => ({
          clauseKey: a.clauseKey,
          clauseVersionId: a.clauseVersionId,
          title: a.title,
        })),
        skipped: result.skipped.map((k) => ({ clauseKey: k.clauseKey, reason: k.reason })),
      },
      200,
    );
  });

  app.openapi(sendRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const sent = await deps.service.send(s.tenantId, letterId, s.actor, {
      signer: body?.signer,
      asOf: c.req.valid("query").asOf,
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

  app.openapi(deleteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const deleted = await deps.service.delete(s.tenantId, letterId, s.actor);
    return c.json(toLetterBody(deleted, seesFees(c.get("principal"))), 200);
  });

  app.openapi(withdrawRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const withdrawn = await deps.service.withdraw(s.tenantId, letterId, s.actor);
    return c.json(toLetterBody(withdrawn, seesFees(c.get("principal"))), 200);
  });

  app.openapi(endEngagementRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { engagementId } = c.req.valid("param");
    const body = c.req.valid("json");
    const out = await deps.lifecycle.end(
      { tenantId: s.tenantId, engagementId, endsOn: body.endsOn, reason: body.reason },
      s.actor,
    );
    return c.json(
      {
        engagement: toEngagementBody(out.record),
        filings: {
          withdrawn: out.filings.withdrawn,
          kept: out.filings.kept,
          keptStarted: out.filings.keptStarted,
          keptPastDue: out.filings.keptPastDue,
          keptCoveredElsewhere: out.filings.keptCoveredElsewhere,
          repointed: out.filings.repointed,
        },
        openJobsAfterEnd: out.openJobsAfterEnd.map((j) => ({ jobId: j.jobId, periodLabel: j.periodLabel })),
      },
      200,
    );
  });

  app.openapi(pauseEngagementRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { engagementId } = c.req.valid("param");
    const record = await deps.lifecycle.pause({ tenantId: s.tenantId, engagementId }, s.actor);
    return c.json(toEngagementBody(record), 200);
  });

  app.openapi(resumeEngagementRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { engagementId } = c.req.valid("param");
    const record = await deps.lifecycle.resume({ tenantId: s.tenantId, engagementId }, s.actor);
    return c.json(toEngagementBody(record), 200);
  });

  app.openapi(signRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.service.sign(
      { tenantId: s.tenantId, letterId, ...body, asOf: c.req.valid("query").asOf },
      s.actor,
    );
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        letter: toLetterBody(result.letter, fees),
        engagements: result.engagements.map(toEngagementBody),
      },
      200,
    );
  });

  app.openapi(recordAcceptanceRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const principal = c.get("principal");
    const { letterId } = c.req.valid("param");
    // The recorder is the SESSION's user, never a field in the body.
    const result = await deps.service.recordAcceptance(
      { tenantId: s.tenantId, letterId, statement: c.req.valid("json"), asOf: c.req.valid("query").asOf },
      principal?.userId ?? "",
      s.actor,
    );
    const fees = seesFees(principal);
    return c.json(
      {
        letter: toLetterBody(result.letter, fees),
        engagements: result.engagements.map(toEngagementBody),
      },
      200,
    );
  });

  app.openapi(recordAgreedRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const principal = c.get("principal");
    const { letterId } = c.req.valid("param");
    const result = await deps.service.recordAgreed(
      { tenantId: s.tenantId, letterId, statement: c.req.valid("json"), asOf: c.req.valid("query").asOf },
      principal?.userId ?? "",
      s.actor,
    );
    const fees = seesFees(principal);
    return c.json(
      {
        letter: toLetterBody(result.letter, fees),
        engagements: result.engagements.map(toEngagementBody),
      },
      200,
    );
  });
}
