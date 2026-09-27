// Proposal HTTP surface — transport only. Each route declares its wire shape
// (the zod schemas ARE the DTOs and the OpenAPI spec) and its handler parses the
// validated input, calls exactly one use-case method, and maps the result field
// by field. No rule lives here.
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route.
//
// This is the first surface in the product that carries money, so it is the
// first to answer the FIFTH axis: fee visibility. It is not a permission and not
// a role — it is a flag on the membership — and it REDACTS rather than omits.
// A delivery associate still needs to see that the firm quoted this client for
// this work; they simply must not learn the fee. Returning nothing at all would
// make "you may not see the money" indistinguishable from "there is no
// proposal", and those are different answers a person acts on differently.
//
// Amounts are strings on the wire, all the way out. Turning them into JSON
// numbers here would undo the whole reason they are `numeric` in the database.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { BLOCK_KIND_VALUES } from "./document";
import { scopeOf } from "../scope";
import type { Principal } from "../../platform/callctx";
import type { AuthzService } from "../../usecase/authz/service";
import type { ProposalService } from "../../usecase/proposal/service";
import type { ProposalRecord, ProposalSummary, ProposalView } from "../../usecase/proposal/ports";
import type { ProposalStatus } from "../../domain/proposal/model";
import { EMAIL_NOTE_MAX, SIGNER_NAME_MAX } from "../../domain/proposal/model";
import type { EmailOutcome } from "../../usecase/proposal/service";
import type { SharedProposal } from "../../usecase/proposal/ports";
import type { BillingFrequency } from "../../domain/document/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";

export interface ProposalDeps {
  readonly service: ProposalService;
  /** For the fee axis only. Gate 3 is middleware; nothing here re-checks a
   *  permission. */
  readonly authz: AuthzService;
}

// The closed set lives in the domain; zod needs a literal tuple, so `satisfies`
// makes a value that is not a status a compile error here.
export const STATUS_VALUES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
] as const satisfies readonly ProposalStatus[];

/** An amount, as it travels: a decimal string, never a JSON number. */
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

// ── Response schemas ────────────────────────────────────────────────────────

const MoneySchema = z.object({ amount: AmountSchema, currency: CurrencySchema });

const JurisdictionSchema = z.string().length(2);

/** The closed set lives in the domain; zod needs a literal tuple, so `satisfies`
 *  makes a value that is not a billing frequency a compile error here. */
export const BILLING_FREQUENCY_VALUES = [
  "one_time",
  "monthly",
  "quarterly",
  "annually",
  "custom",
] as const satisfies readonly BillingFrequency[];

/**
 * OUT-OF-POCKET EXPENSES — a range, in its own currency.
 *
 * All three or none, which is what the database says too
 * (`proposal_line_oop_is_whole_chk`): a range with one end is not a range and an
 * amount with no currency is the one shape this product never stores. Its
 * currency is deliberately NOT held to the document's — a client quoted in INR
 * still faces a filing fee in USD, and that is the whole reason the field
 * carries a currency of its own. It is never folded into a total: the document's
 * FX rate is struck for the fee currency and says nothing about a third one.
 */
const OopEstimateSchema = z
  .object({ min: AmountSchema, max: AmountSchema, currency: CurrencySchema })
  .openapi("OutOfPocketEstimate");

/**
 * ONE OF THE FOUR SCOPE BLOCKS, RESOLVED — the words that print, and whether
 * this document wrote them.
 *
 * `tailored` is the half a screen cannot do without: an editor that cannot tell
 * "our standard scope" from "what we agreed with this client" is one where
 * somebody edits the catalogue to fix a single letter. `text: null` means
 * neither the document nor the catalogue version it pinned states this block —
 * a real answer, and a renderer should print nothing rather than an empty
 * heading.
 */
const ResolvedTermSchema = z
  .object({ text: z.string().nullable(), tailored: z.boolean() })
  .openapi("ResolvedTerm");

const DocumentTermsSchema = z
  .object({
    scope: ResolvedTermSchema,
    clientObligations: ResolvedTermSchema,
    volumeLimits: ResolvedTermSchema,
    exclusions: ResolvedTermSchema,
  })
  .openapi("DocumentTerms");

/**
 * THE CATALOGUE ROW THIS LINE CITES, as it was PINNED.
 *
 * G2.1's acceptance is "a proposal CITES the firm's own service code", and until
 * this schema carried `ref` a screen had to call the config registry once per
 * line to print `A1` — the per-row lookup CLAUDE.md names as the sign that a
 * join belongs in the query. `slaDays` is the same gap and the one T3.1 walks
 * into: a work item snapshots the SLA in force when it was created, off the
 * version the document PINNED, and nothing served it.
 *
 * Everything but `key`, `version` and `name` is nullable because the CATALOGUE
 * is: a published version is frozen, so a body published before a field existed
 * can never carry it, and null means "the firm never stated this". A screen must
 * not turn that into a default — `slaDays: null` is not a zero-day SLA.
 *
 * The four prose blocks are the CATALOGUE's words. G1.6 adds per-document
 * overrides of exactly these; they will arrive beside this object rather than
 * inside it, so "what does our catalogue say" and "what does this document say"
 * stay two answers.
 */
const PinnedServiceSchema = z
  .object({
    key: z.string(),
    version: z.number().int(),
    /** The firm's OWN code — "A1". Not the registry key, which is lowercase and
     *  url-safe by rule. */
    ref: z.string().nullable(),
    name: z.string(),
    /** The revenue axis and the delivery axis. Independent dimensions. */
    module: z.string().nullable(),
    group: z.string().nullable(),
    /** What the amounts are PER — per hour, per month, per item, or for the
     *  whole engagement. */
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
  .openapi("PinnedService");

const TotalsSchema = z
  .object({
    // Nullable because of the fee axis: a caller without commercial visibility
    // gets the proposal with its money removed, not a 403.
    gross: AmountSchema.nullable(),
    discount: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
    currency: CurrencySchema,
    /**
     * HOW MANY LIVE LINES THE THREE FIGURES ABOVE DO NOT COVER.
     *
     * A line with no price contributes nothing to a sum, so without this the
     * total would quietly understate the document and nothing on the wire would
     * say so. Non-zero means the figures are a FLOOR — "this much, plus whatever
     * is agreed for N further lines" — and a screen that renders the money
     * without this field prints a number that is not the price of this document.
     *
     * NOT redacted by the fee axis, and that is the point: it is a count of
     * lines, not an amount, and somebody who may not see the money still has to
     * know the document is not fully priced.
     */
    unpricedLineCount: z.number().int(),
  })
  .openapi("ProposalTotals");

const ProposalSchema = z
  .object({
    id: z.string().uuid(),
    /** The firm's own number for this document — `PR-2026-0007`. What a client
     *  quotes back and what an audit cites; the id is the system's name for it
     *  and this is the firm's. */
    ref: z.string(),
    partyId: z.string().uuid(),
    /** Which of the FIRM's own entities is offering. Not redacted by the fee
     *  axis: who is contracting is not money, and delivery staff need it. */
    issuingEntityPartyId: z.string().uuid(),
    leadId: z.string().uuid().nullable(),
    title: z.string(),
    status: z.enum(STATUS_VALUES),
    currency: CurrencySchema,
    fxRate: RateSchema.nullable(),
    fxRateDate: DaySchema,
    validUntil: DaySchema.nullable(),
    sentAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    discountApprovedBy: z.string().uuid().nullable(),
    discountApprovedAt: z.string().nullable(),
    // The TRACK half of send/track. Not money — whether the client has opened
    // the document is exactly what the person chasing it needs to know, and
    // withholding it from delivery staff would serve nobody.
    firstViewedAt: z.string().nullable(),
    viewCount: z.number().int(),
    /** WHY the client said no. Null on every other status — the schema says so
     *  too, so a reason can never sit on a proposal that was accepted. */
    declinedReason: z.string().nullable(),
    /** The firm's paragraph about the client's business — the proposal's
     *  Background (0084). Null when unwritten. */
    background: z.string().nullable(),
    /** The person at the client it is prepared for (0084). */
    addressedToPartyId: z.string().uuid().nullable(),
    /** The colleague the cover names under "Prepared by" (0084). */
    preparedByUserId: z.string().uuid().nullable(),
    deletedAt: z.string().nullable().openapi({
      description:
        "When this DRAFT was deleted as made by mistake (0086), or null. A deleted proposal is " +
        "in no list, still opens by id, and never changes again; its reference is not reused.",
    }),
    deletedByUserId: z.string().uuid().nullable(),
  })
  .openapi("Proposal");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

const ProposalLineSchema = z
  .object({
    id: z.string().uuid(),
    /** Which of the client's entities this line is for. Nullable on a proposal:
     *  the prospect may hold none yet, and Incorporation is a line whose entity
     *  is its own output. An engagement letter line must name one. */
    entityPartyId: z.string().uuid().nullable(),
    entity: z.object({ id: z.string().uuid(), displayName: z.string() }).nullable(),
    // The PIN, on the wire, because a screen showing "list 25,000 / quoted
    // 22,500" needs to be able to say which catalogue version it is quoting.
    serviceVersionId: z.string().uuid(),
    service: PinnedServiceSchema.nullable(),
    /** THE FOUR SCOPE BLOCKS, RESOLVED: this line's override where it has one,
     *  the pinned catalogue version's words where it does not, and which of the
     *  two won. `service` above still carries the catalogue's own words, so an
     *  editor can show what was standard beside what this document changed. */
    terms: DocumentTermsSchema,
    description: z.string(),
    position: z.number().int(),
    quantity: AmountSchema,
    /**
     * NULL FOR TWO DIFFERENT REASONS, which is why `priced` sits beside it: the
     * fee axis redacts a price this caller may not see, and G1.6 allows a line
     * that HAS no price. Read them together.
     */
    unitAmount: AmountSchema.nullable(),
    /**
     * WHETHER THIS LINE HAS A PRICE AT ALL — false means "as mutually agreed",
     * and `pricingNote` says why.
     *
     * NOT redacted by the fee axis. It is a fact about the document, not an
     * amount, and without it a delivery associate would see `unitAmount: null`
     * on every line and could not tell a redacted fee from an unpriced one —
     * so every line would read as "as mutually agreed" to exactly the people
     * who most need to know which lines really are.
     */
    priced: z.boolean(),
    currency: CurrencySchema,
    discountPercent: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
    /** Where the WORK is. */
    jurisdiction: z.string().nullable(),
    /** How often this DEAL is billed — defaulted from the pinned service's
     *  recurrence at the moment the line was quoted, and freely different. */
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable(),
    /** WHY there is no amount. Not redacted by the fee axis: it is the sentence
     *  that prints where a figure would, and hiding it leaves a line showing
     *  neither a price nor a reason. */
    pricingNote: z.string().nullable(),
    /** Out-of-pocket expenses, separate from the fee and never in the totals.
     *  Redacted with the money — it is an amount the firm expects to bill on. */
    oopEstimate: OopEstimateSchema.nullable(),
  })
  .openapi("ProposalLine");

const ApproverSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string().email(),
  })
  .nullable();

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
  .openapi("ProposalBlock");

/** A rendered proposal in the document store. `contentHash` is its
 *  fingerprint — lower-case SHA-256, what any stored file carries. */
const FiledPdfSchema = z
  .object({
    documentId: z.string().uuid(),
    versionId: z.string().uuid(),
    contentHash: z.string(),
    filename: z.string(),
  })
  .openapi("ProposalPdf");

const ProposalEmailSchema = z
  .object({
    id: z.string().uuid(),
    to: z.string(),
    note: z.string().nullable(),
    sentAt: z.string(),
    /** Who pressed the button. Null for a system actor or an erased account. */
    sentBy: ApproverSchema,
    /** The fingerprint of the PDF it attached. */
    pdfContentHash: z.string(),
  })
  .openapi("ProposalEmail");

const ClientDecisionSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    /** The name they typed. */
    signerName: z.string(),
    /** The sentence they ticked, word for word. Acceptances only. */
    statement: z.string().nullable(),
    decidedAt: z.string(),
    /** As this deployment derives a caller's address (api/ratelimit.ts). */
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    /** Where bib emailed the link they used. Null when it reached them some
     *  other way. */
    emailedTo: z.string().nullable(),
    /** The PDF of record when they answered. */
    pdf: FiledPdfSchema.nullable(),
  })
  .openapi("ProposalClientDecision");

const ProposalRecordSchema = z
  .object({
    proposal: ProposalSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — a letterhead prints a name, not a uuid. */
    issuingEntity: PartyRefSchema,
    lines: z.array(ProposalLineSchema),
    blocks: z.array(DocumentBlockSchema),
    totals: TotalsSchema,
    approvedBy: ApproverSchema,
    /** "Prepared for", by NAME (0084), with that person's email identifier
     *  when the firm holds one — what Send offers to email it to (0085). Null
     *  when the proposal names nobody. */
    addressee: z
      .object({
        id: z.string().uuid(),
        displayName: z.string(),
        email: z.string().nullable(),
      })
      .nullable(),
    /** "Prepared by", with the address the cover prints (0084). The email is
     *  the discriminator — an account may have no display name. */
    preparedBy: ApproverSchema,
    /** The PDF of record (0085): the file the client was sent — the email's
     *  attachment and the link's download. Null until a sent proposal has one. */
    sentPdf: FiledPdfSchema.nullable(),
    /** Every email bib sent it in, newest first (0085). */
    emails: z.array(ProposalEmailSchema),
    /** The evidence behind an answer the CLIENT gave on the link (0085). Null
     *  when unanswered, and when a colleague recorded the answer — the History
     *  names that colleague. */
    clientDecision: ClientDecisionSchema.nullable(),
    /** Who deleted it (0086), when it was and the account still resolves. */
    deletedBy: ApproverSchema,
    deleteRefusal: z
      .object({ code: z.string(), message: z.string() })
      .nullable()
      .openapi({
        description:
          "Why DELETE /api/v1/proposals/{proposalId} would be refused right now, in its own " +
          "words — or null when it would work (0086). Says nothing about `party:write`, which " +
          "/auth/me already does.",
      }),
  })
  .openapi("ProposalRecord");

const ProposalSummarySchema = z
  .object({
    proposal: ProposalSchema,
    party: PartyRefSchema,
    issuingEntity: PartyRefSchema,
    totals: TotalsSchema,
    lineCount: z.number().int(),
  })
  .openapi("ProposalSummary");

/**
 * What happened to the email. ONE object with nullable fields rather than a
 * discriminated union: this spec is OpenAPI 3.0, where a nullable `oneOf`
 * generates as `unknown` in the front end's client and the whole field loses
 * its type. `status` says which of the others are set.
 */
const EmailOutcomeSchema = z
  .object({
    status: z.enum(["sent", "failed"]),
    to: z.string(),
    /** Set when `sent`. */
    emailId: z.string().uuid().nullable(),
    sentAt: z.string().nullable(),
    /** Set when `failed`: what went wrong, in the mail server's or the
     *  renderer's own words. */
    reason: z.string().nullable(),
  })
  .openapi("ProposalEmailOutcome");

const SentProposalSchema = z
  .object({
    proposal: ProposalSchema,
    /**
     * The share link's token, returned EXACTLY ONCE.
     *
     * Only its digest is stored, so this response is the only place it can ever
     * be read — the same contract sessions and magic links keep, for the same
     * reason. A firm that loses it asks for a new one (`…/reissue`), and the
     * old one stops working.
     */
    shareToken: z.string(),
    /**
     * What happened to the email (0085), when one was asked for. `failed` is an
     * ordinary answer: the proposal IS sent and the link above DOES work — the
     * person who pressed the button needs both facts with the one that went
     * wrong. Null when no email was asked for.
     */
    email: EmailOutcomeSchema.nullable(),
  })
  .openapi("SentProposal");

/** What the RECIPIENT reads. Its own shape, not the staff model with fields
 *  nulled, so a field added for colleagues cannot reach a client's screen by
 *  default — no party id, no lead, no exchange rate, no approver, and no
 *  catalogue version. */
/** One line of prose as the RECIPIENT reads it — see `SharedProposal.blocks`. */
const SharedBlockSchema = z
  .object({
    kind: z.enum(BLOCK_KIND_VALUES),
    body: z.string(),
    /** A section title inside the block (the team block is a list with
     *  headings in it), not an item. */
    isHeading: z.boolean(),
    sortOrder: z.number().int(),
  })
  .openapi("SharedProposalBlock");

const SharedProposalSchema = z
  .object({
    id: z.string().uuid(),
    /** The number the recipient quotes back down the phone. */
    ref: z.string(),
    firmName: z.string(),
    /** Which of the firm's companies is offering. A client is entitled to know
     *  which one they would be contracting with, and it is not always the group
     *  name above it. */
    issuedBy: z.string(),
    addressedTo: z.string(),
    title: z.string(),
    status: z.enum(STATUS_VALUES),
    currency: CurrencySchema,
    validUntil: DaySchema.nullable(),
    sentAt: z.string().nullable(),
    lines: z.array(
      z.object({
        description: z.string(),
        quantity: AmountSchema,
        /** Null for "as mutually agreed". There is no fee axis on this route —
         *  the recipient sees the money by definition — so unlike the staff
         *  model, null here has exactly one meaning and needs no companion
         *  flag. */
        unitAmount: AmountSchema.nullable(),
        discountPercent: AmountSchema,
        net: AmountSchema.nullable(),
        /** What the client reads where the figure would be. */
        pricingNote: z.string().nullable(),
        billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable(),
        /** What they are told to expect to reimburse, separate from the fee. */
        oopEstimate: OopEstimateSchema.nullable(),
      }),
    ),
    totals: z.object({
      gross: AmountSchema,
      discount: AmountSchema,
      net: AmountSchema,
      currency: CurrencySchema,
      /** The recipient is told the same thing a partner is: how many lines this
       *  figure does not cover. A client reading a total that quietly omits two
       *  "as mutually agreed" lines is the worst place for this to go wrong. */
      unpricedLineCount: z.number().int(),
    }),
    /** The document's own exclusions, commercial notes and team block (G1.7),
     *  in print order. The words only: no ids, and nothing that says which
     *  lines are the firm's standard wording and which were written for this
     *  client. Empty when the document carries none. */
    blocks: z.array(SharedBlockSchema),
    /** The answer given on this page, by name and date (0085). Null when
     *  unanswered, and when the firm recorded the answer itself. */
    answer: z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        signerName: z.string(),
        decidedAt: z.string(),
      })
      .nullable(),
    /** The sentence beside the acceptance's tick box, WORD FOR WORD — the page
     *  shows this text and the API records the same (0085). */
    acceptanceStatement: z.string(),
  })
  .openapi("SharedProposal");

const ProposalsResponse = z
  .object({ proposals: z.array(ProposalSummarySchema) })
  .openapi("ProposalsResponse");

// ── Request schemas ─────────────────────────────────────────────────────────

const DraftProposalRequest = z
  .object({
    partyId: z.string().uuid(),
    leadId: z.string().uuid().optional(),
    // WHO is offering, and the key the firm's own rule is looked up on when
    // nobody says. Both optional, and both absent is the ordinary case: the
    // firm's preference rows answer it, and a firm always has a fallback.
    issuingEntityPartyId: z.string().uuid().optional(),
    clientJurisdiction: z.string().length(2).optional(),
    title: z.string().min(1),
    // The quote currency and the rate back to the firm's reporting currency.
    // Both required, and the rate is "1" when they match — stored rather than
    // omitted, so "did we convert this?" is never a question about a null.
    currency: CurrencySchema,
    fxRate: RateSchema,
    fxRateDate: DaySchema,
    validUntil: DaySchema.optional(),
    /** The Background paragraph (0084). Blank is "none". */
    background: z.string().max(4000).optional(),
    /** The PERSON at the client it is prepared for — somebody recorded in the
     *  client's structure, the letter's addressee rule. */
    addressedToPartyId: z.string().uuid().optional(),
    /** The colleague the cover names. Omit it and it is whoever is drafting. */
    preparedByUserId: z.string().uuid().optional(),
  })
  .openapi("DraftProposalRequest");

/**
 * A change to a DRAFT's head (0084). Every field optional; `null` clears one
 * (the title excepted — a proposal always has one). Sending nothing is refused
 * rather than recorded as an edit that changed nothing.
 */
const ReviseProposalRequest = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    validUntil: DaySchema.nullable().optional(),
    background: z.string().max(4000).nullable().optional(),
    addressedToPartyId: z.string().uuid().nullable().optional(),
    preparedByUserId: z.string().uuid().nullable().optional(),
  })
  .openapi("ReviseProposalRequest");

const AddLineRequest = z
  .object({
    entityPartyId: z.string().uuid().optional(),
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    /**
     * OPTIONAL since G1.6 — omit it for a line that is genuinely "as mutually
     * agreed", and send `pricingNote` saying so.
     *
     * OMITTING IT IS NOT SENDING "0". Zero is a price the firm committed to; the
     * schema could not express the difference until now, and quoting an unpriced
     * line at zero says something completely different to a client.
     */
    unitAmount: AmountSchema.optional(),
    discountPercent: AmountSchema.default("0"),
    /** Where the WORK is — the country the user picked. Not derived. */
    jurisdiction: JurisdictionSchema.optional(),
    /** How often this DEAL is billed. Omit and it defaults from the PINNED
     *  service's `recurrence`; state it to bill a monthly service quarterly. */
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).optional(),
    /** THIS DOCUMENT'S OWN WORDING for any of the four scope blocks. Omit any of
     *  them and the pinned catalogue version's words print — which is what makes
     *  tailoring one client's scope stop meaning "edit the catalogue". */
    scopeOverride: z.string().min(1).optional(),
    clientObligationsOverride: z.string().min(1).optional(),
    volumeLimitsOverride: z.string().min(1).optional(),
    exclusionsOverride: z.string().min(1).optional(),
    /** Out-of-pocket expenses: a RANGE, in its own currency, reimbursed at
     *  actuals. Its currency need not be the document's, and it is never added
     *  into the totals. */
    oopEstimate: OopEstimateSchema.optional(),
    /** WHY there is no amount — REQUIRED when `unitAmount` is omitted. */
    pricingNote: z.string().min(1).optional(),
  })
  .openapi("AddProposalLineRequest");

/**
 * An edit to one line of a DRAFT (T6.18). Every field optional — absent leaves
 * it as it is — and `null` is each field's own "undo": the four overrides go
 * back to the pinned catalogue version's words, `billingFrequency` back to the
 * service's recurrence, `unitAmount` to "as mutually agreed" (send a
 * `pricingNote` with it), and the rest are cleared. The same names as adding a
 * line, so a screen maps one form onto both.
 */
const UpdateLineRequest = z
  .object({
    description: z.string().max(2000).optional(),
    quantity: AmountSchema.optional(),
    unitAmount: AmountSchema.nullable().optional(),
    discountPercent: AmountSchema.optional(),
    jurisdiction: JurisdictionSchema.nullable().optional(),
    billingFrequency: z.enum(BILLING_FREQUENCY_VALUES).nullable().optional(),
    scopeOverride: z.string().max(20000).nullable().optional(),
    clientObligationsOverride: z.string().max(20000).nullable().optional(),
    volumeLimitsOverride: z.string().max(20000).nullable().optional(),
    exclusionsOverride: z.string().max(20000).nullable().optional(),
    oopEstimate: OopEstimateSchema.nullable().optional(),
    pricingNote: z.string().max(2000).nullable().optional(),
  })
  .openapi("UpdateProposalLineRequest");

/**
 * The token arrives in a BODY, not in the path.
 *
 * A share token is a bearer capability, and a path lands in access logs, error
 * logs, browser history and any Referer the page sends. A body does not. The
 * method is POST for the same reason it is honest: opening a link RECORDS a
 * view, so it was never a safe idempotent read.
 */
const ViewSharedRequest = z
  .object({ token: z.string().min(1).max(512) })
  .openapi("ViewSharedProposalRequest");

const DecisionRequest = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    declinedReason: z.string().min(1).max(2000).optional().openapi({
      description:
        "Why they said no, in the firm's own words. Recorded only on a rejection — the status " +
        "already says THAT a quote was lost, and this is the half worth anything later.",
    }),
  })
  .openapi("ProposalDecisionRequest");

/**
 * Send, or send again — and whether bib emails it (0085). Absent `email` is
 * the old behaviour: the link comes back and the firm sends it however it
 * likes. The address is judged by the use case, which names the problem; a
 * format check here would answer with a schema's words instead.
 */
const SendRequest = z
  .object({
    email: z
      .object({
        to: z.string().min(1).max(320),
        note: z.string().max(EMAIL_NOTE_MAX).optional().openapi({
          description:
            "The colleague's own words, printed above the standard letter. Blank is none.",
        }),
      })
      .optional(),
  })
  .openapi("SendProposalRequest");

/**
 * The client's answer, from the link's page (0085). The token rides in the
 * BODY like the view's, for the view's reason.
 */
const AnswerSharedRequest = z
  .object({
    token: z.string().min(1).max(512),
    decision: z.enum(["accepted", "rejected"]),
    signerName: z.string().max(SIGNER_NAME_MAX).openapi({
      description: "The client's full name, as they typed it. Required for either answer.",
    }),
    confirmed: z.boolean().optional().openapi({
      description:
        "The tick against `acceptanceStatement`. An acceptance without it is refused " +
        "(`ACCEPTANCE_NOT_CONFIRMED`); a decline ignores it.",
    }),
    declinedReason: z.string().max(2000).optional().openapi({
      description: "Why, on a decline, in the client's words. Optional; ignored on an acceptance.",
    }),
  })
  .openapi("AnswerSharedProposalRequest");

// ── Routes ──────────────────────────────────────────────────────────────────

const draftRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals",
  tags: ["proposals"],
  summary: "Draft a proposal",
  description:
    "Starts a quote for a party, in one currency, at one exchange rate. Lines are added " +
    "separately, each pinned to the catalogue version it was quoted from.",
  request: {
    body: { content: { "application/json": { schema: DraftProposalRequest } }, required: true },
  },
  responses: {
    201: { description: "Drafted", content: { "application/json": { schema: ProposalSchema } } },
    400: errorResponse("Request failed validation, or a currency or rate that is not one"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/proposals",
  tags: ["proposals"],
  summary: "List proposals",
  description:
    "Totals only — opening one is what fetches its lines. Money is null for a caller " +
    "without commercial visibility.",
  request: {
    query: z.object({
      status: z.enum(STATUS_VALUES).optional(),
      partyId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: { description: "Proposals", content: { "application/json": { schema: ProposalsResponse } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/proposals/{proposalId}",
  tags: ["proposals"],
  summary: "Read one proposal",
  request: { params: z.object({ proposalId: z.string().uuid() }) },
  responses: {
    200: { description: "Proposal", content: { "application/json": { schema: ProposalRecordSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
  },
});

const reviseRoute = createRoute({
  method: "patch",
  path: "/api/v1/proposals/{proposalId}",
  tags: ["proposals"],
  summary: "Change a draft proposal's head",
  description:
    "Its title, how long it is valid, its Background, and the two names its cover prints — " +
    "who it is prepared for and who prepared it (0084). A draft only: once sent, the client " +
    "holds what it said. Answers with the whole proposal, names resolved.",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: ReviseProposalRequest } }, required: true },
  },
  responses: {
    200: { description: "Revised", content: { "application/json": { schema: ProposalRecordSchema } } },
    400: errorResponse(
      "Nothing to change, a value that failed validation, a company named where a person " +
        "belongs, or a colleague who does not work here",
    ),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not a draft, or the person named has no recorded role at this client"),
  },
});

const addLineRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/lines",
  tags: ["proposals"],
  summary: "Quote a service on a proposal",
  description:
    "The line is pinned to a published catalogue version, so what the list price was at " +
    "the time survives the catalogue moving on. Draft proposals only.",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AddLineRequest } }, required: true },
  },
  responses: {
    201: { description: "Line added", content: { "application/json": { schema: ProposalLineSchema } } },
    400: errorResponse("An amount that is not one, or a version that is not a published service"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("The proposal is no longer a draft"),
  },
});

const updateLineRoute = createRoute({
  method: "patch",
  path: "/api/v1/proposals/{proposalId}/lines/{lineId}",
  tags: ["proposals"],
  summary: "Change a line on a draft",
  description:
    "Its fee, quantity, discount, billing frequency, pricing note, country, out-of-pocket range " +
    "and its four scope blocks — judged by the rules for adding one, on the line as it will " +
    "be (T6.18). A null override puts back the catalogue's words. A discount raised past the " +
    "firm's limit after a sign-off lapses the sign-off, so the draft needs approving again. " +
    "Answers with the whole proposal, so a screen gets the new totals in the same round trip.",
  request: {
    params: z.object({ proposalId: z.string().uuid(), lineId: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateLineRequest } }, required: true },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: ProposalRecordSchema } } },
    400: errorResponse(
      "Nothing to change, an amount or discount that is not one, no price and no reason, a " +
        "discount on an unpriced line, or a country code that is not one",
    ),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal, or no such live line on it"),
    409: errorResponse("The proposal is no longer a draft, or was deleted"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/v1/proposals/{proposalId}",
  tags: ["proposals"],
  summary: "Delete a draft made by mistake",
  description:
    "Takes a DRAFT off the list of quotes; it still opens by id, says it was deleted, and never " +
    "changes again (0086). Its reference is not reused. Refused once sent — the client holds " +
    "the document — and while a live engagement letter cites it. GET " +
    "/api/v1/proposals/{proposalId} says in advance whether this would work.",
  request: { params: z.object({ proposalId: z.string().uuid() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: ProposalSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse(
      "The proposal is not a draft, a live engagement letter cites it, or it was already deleted",
    ),
  },
});

const removeLineRoute = createRoute({
  method: "delete",
  path: "/api/v1/proposals/{proposalId}/lines/{lineId}",
  tags: ["proposals"],
  summary: "Pull a line from a draft",
  description: "Soft: the line stops appearing on the document, and the record of it stays.",
  request: {
    params: z.object({ proposalId: z.string().uuid(), lineId: z.string().uuid() }),
  },
  responses: {
    204: { description: "Removed" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal or line at this firm"),
    409: errorResponse("The proposal is no longer a draft"),
  },
});

const approveDiscountRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/discount-approval",
  tags: ["proposals"],
  summary: "Sign off a discount past the firm's limit",
  description:
    "Requires `proposal:approve`. Refused when the discount is already within the firm's " +
    "published limit — an approval recorded for a decision nobody had to make would sit in " +
    "an audit trail that cannot be corrected.",
  request: { params: z.object({ proposalId: z.string().uuid() }) },
  responses: {
    200: { description: "Approved", content: { "application/json": { schema: ProposalSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not carry proposal:approve"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not a draft, has no lines, or needed no approval"),
  },
});

const sendRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/send",
  tags: ["proposals"],
  summary: "Send the proposal",
  description:
    "The gate: a discount past the firm's published limit blocks here until somebody " +
    "holding `proposal:approve` has signed it off. With `email`, bib also emails it — the " +
    "PDF of record attached, with Accept and Decline buttons that open its link (0085); the " +
    "address is checked before anything moves, and a mail server that will not take the " +
    "letter comes back as `email.status = \"failed\"` beside a proposal that IS sent.",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendRequest } }, required: false },
  },
  responses: {
    200: {
      description: "Sent, with the share link — returned once and never again",
      content: { "application/json": { schema: SentProposalSchema } },
    },
    400: errorResponse("The email address is not one"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not a draft, empty, or an unapproved over-limit discount"),
  },
});

const reissueRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/reissue",
  tags: ["proposals"],
  summary: "Give a sent proposal a new link — and, with `email`, email it again",
  description:
    "The link is readable once. A firm that lost it, or a client who lost the email, gets a " +
    "new one here, and THE OLD ONE STOPS WORKING — a proposal has one live link. Only while " +
    "the proposal is out: answered and expired proposals refuse (0085).",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendRequest } }, required: false },
  },
  responses: {
    200: {
      description: "A new link — returned once and never again",
      content: { "application/json": { schema: SentProposalSchema } },
    },
    400: errorResponse("The email address is not one"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not out for an answer — a draft, answered, or expired"),
  },
});

const viewSharedRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/shared",
  tags: ["proposals"],
  summary: "Open a proposal from its share link",
  description:
    "PUBLIC — no session. A proposal goes to somebody who has no login and will not get one, " +
    "so the link is a bearer capability rather than a session. The token carries the tenant it " +
    "belongs to, which is what keeps this an ordinary tenant-scoped read. Read-only: the " +
    "recipient cannot accept from here.",
  request: {
    body: { content: { "application/json": { schema: ViewSharedRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The proposal, as its recipient reads it",
      content: { "application/json": { schema: SharedProposalSchema } },
    },
    400: errorResponse("Request failed validation"),
    404: errorResponse("Not a link we recognise — malformed, unknown and withdrawn are one answer"),
    409: errorResponse("The proposal has expired"),
    429: errorResponse("Too many attempts from this address"),
  },
});

const answerSharedRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/shared/answer",
  tags: ["proposals"],
  summary: "Accept or decline a proposal from its share link",
  description:
    "PUBLIC — no session, like the view (0085). The client answers the proposal the firm " +
    "sent them: a name for either answer, and for an acceptance the tick against " +
    "`acceptanceStatement`. Once, while the offer stands — a second answer is refused and " +
    "the first stands. The name, the statement, the address and the browser are kept as the " +
    "firm's evidence; the colleague who prepared it is emailed.",
  request: {
    body: { content: { "application/json": { schema: AnswerSharedRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Answered — the proposal as its recipient now reads it",
      content: { "application/json": { schema: SharedProposalSchema } },
    },
    400: errorResponse("No name typed, or an acceptance with the statement unticked"),
    404: errorResponse("Not a link we recognise — malformed, unknown and withdrawn are one answer"),
    409: errorResponse("Already answered, or expired"),
    429: errorResponse("Too many attempts from this address"),
  },
});

const sharedPdfRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/shared/pdf",
  tags: ["proposals"],
  summary: "Download the proposal's PDF from its share link",
  description:
    "PUBLIC — no session (0085). The PDF of record: the file bib emailed, or — for a " +
    "proposal nothing has asked for a PDF of yet — rendered and pinned now, so every later " +
    "download is the same file. The token rides in the BODY, so the page fetches this and " +
    "saves the bytes itself.",
  request: {
    body: { content: { "application/json": { schema: ViewSharedRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The PDF",
      content: { "application/pdf": { schema: z.any() } },
    },
    404: errorResponse("Not a link we recognise — malformed, unknown and withdrawn are one answer"),
    409: errorResponse("The proposal has expired"),
    429: errorResponse("Too many attempts from this address"),
  },
});

const decideRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{proposalId}/decision",
  tags: ["proposals"],
  summary: "Record the client's decision",
  description:
    "A proposal past its validity date is marked expired here rather than accepted late — " +
    "nothing in this system runs on a timer, so expiry is written the first time somebody " +
    "acts on it.",
  request: {
    params: z.object({ proposalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: DecisionRequest } }, required: true },
  },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: ProposalSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Already decided, still a draft, or now expired"),
  },
});

// ── Mapping ─────────────────────────────────────────────────────────────────
//
// Every field is named. The alternative — returning the read model — is how
// /auth/me shipped two fields the spec never described for six tasks, and in a
// codebase whose frontend client is generated from that spec an undocumented
// field is one the browser cannot see.

function toProposalBody(
  proposal: ProposalRecord["proposal"],
  fees: boolean,
): z.infer<typeof ProposalSchema> {
  return {
    id: proposal.id,
    ref: proposal.ref,
    partyId: proposal.partyId,
    issuingEntityPartyId: proposal.issuingEntityPartyId,
    leadId: proposal.leadId,
    title: proposal.title,
    status: proposal.status,
    currency: proposal.currency,
    // The rate is money-adjacent: it and the amounts together are what let
    // somebody reconstruct a fee, so it goes with them.
    fxRate: fees ? proposal.fxRate : null,
    fxRateDate: proposal.fxRateDate,
    validUntil: proposal.validUntil,
    sentAt: proposal.sentAt,
    decidedAt: proposal.decidedAt,
    discountApprovedBy: proposal.discountApprovedBy,
    discountApprovedAt: proposal.discountApprovedAt,
    firstViewedAt: proposal.firstViewedAt,
    viewCount: proposal.viewCount,
    // NOT redacted by the fee axis: why a client said no is a pipeline fact,
    // not a price. It is on the STAFF model only — SharedProposal is a separate
    // shape, so it can never reach the recipient's own screen.
    declinedReason: proposal.declinedReason,
    // What the document says about the client and who it is between — words
    // and names, not money.
    background: proposal.background,
    addressedToPartyId: proposal.addressedToPartyId,
    preparedByUserId: proposal.preparedByUserId,
    deletedAt: proposal.deletedAt,
    deletedByUserId: proposal.deletedByUserId,
  };
}

/**
 * The pinned catalogue row, field by field — never the port object forwarded.
 *
 * Only the PRICE half is redacted by the fee axis. The code, the Dept, the
 * delivery team, the SLA and the four scope blocks are what the firm SELLS and
 * what it UNDERTOOK; a delivery associate without commercial visibility is
 * precisely the person who needs to read them, and hiding the scope of the work
 * from whoever does the work would be the fee axis answering a question nobody
 * asked it. `pricingNote` stays with them and not with the money on purpose: it
 * is the sentence that PRINTS on the document where an amount would ("As
 * mutually agreed"), so redacting it would leave a line showing neither a price
 * nor a reason, which reads as data missing rather than as a decision.
 */
function toPinnedServiceBody(
  service: NonNullable<ProposalRecord["lines"][number]["service"]>,
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
    // The list price is the firm's own commercial data, so it goes with the rest
    // of the money.
    listPrice: fees && service.listPrice !== null ? { ...service.listPrice } : null,
    pricingNote: service.pricingNote,
    scope: service.scope,
    clientObligations: service.clientObligations,
    volumeLimits: service.volumeLimits,
    exclusions: service.exclusions,
  };
}

function toTotalsBody(
  totals: ProposalRecord["totals"],
  fees: boolean,
): z.infer<typeof TotalsSchema> {
  return {
    gross: fees ? totals.gross : null,
    discount: fees ? totals.discount : null,
    net: fees ? totals.net : null,
    // The CURRENCY stays. It is not a fee, and a document labelled AED is
    // information a delivery associate legitimately needs.
    currency: totals.currency,
    // And so does the COUNT of what the money leaves out. It is not an amount,
    // and "this document is not fully priced" is a fact about the work.
    unpricedLineCount: totals.unpricedLineCount,
  };
}

function toRecordBody(record: ProposalView, fees: boolean): z.infer<typeof ProposalRecordSchema> {
  return {
    proposal: toProposalBody(record.proposal, fees),
    party: { id: record.party.id, displayName: record.party.displayName },
    issuingEntity: {
      id: record.issuingEntity.id,
      displayName: record.issuingEntity.displayName,
    },
    lines: record.lines.map((l) => ({
      id: l.line.id,
      entityPartyId: l.line.entityPartyId,
      entity: l.entity === null ? null : { ...l.entity },
      serviceVersionId: l.line.serviceVersionId,
      service: l.service === null ? null : toPinnedServiceBody(l.service, fees),
      terms: { ...l.terms },
      description: l.line.description,
      position: l.line.position,
      // Quantity is not money. "Three registrations" is what the work IS, and a
      // delivery associate needs it.
      quantity: l.line.quantity,
      unitAmount: fees ? l.line.unitAmount : null,
      // Computed BEFORE the redaction, from the line itself: it is what makes
      // the null above readable.
      priced: l.line.unitAmount !== null,
      currency: l.line.currency,
      discountPercent: fees ? l.line.discountPercent : null,
      net: fees ? l.net : null,
      jurisdiction: l.line.jurisdiction,
      billingFrequency: l.line.billingFrequency,
      pricingNote: l.line.pricingNote,
      oopEstimate: fees && l.line.oopEstimate !== null ? { ...l.line.oopEstimate } : null,
    })),
    // NOT redacted by the fee axis. What the firm will and will NOT do is the
    // work, and somebody delivering it needs the exclusions even when they may
    // not see the money.
    blocks: record.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      body: b.body,
      isHeading: b.isHeading,
      sortOrder: b.sortOrder,
      sourceId: b.sourceId,
      isEdited: b.isEdited,
    })),
    totals: toTotalsBody(record.totals, fees),
    approvedBy: record.approvedBy === null ? null : { ...record.approvedBy },
    addressee:
      record.addressee === null
        ? null
        : {
            id: record.addressee.id,
            displayName: record.addressee.displayName,
            email: record.addressee.email,
          },
    preparedBy:
      record.preparedBy === null
        ? null
        : {
            userId: record.preparedBy.userId,
            displayName: record.preparedBy.displayName,
            email: record.preparedBy.email,
          },
    sentPdf: record.sentPdf === null ? null : { ...record.sentPdf },
    emails: record.emails.map((e) => ({
      id: e.id,
      to: e.to,
      note: e.note,
      sentAt: e.sentAt,
      sentBy: e.sentBy === null ? null : { ...e.sentBy },
      pdfContentHash: e.pdfContentHash,
    })),
    clientDecision:
      record.clientDecision === null
        ? null
        : {
            decision: record.clientDecision.decision,
            signerName: record.clientDecision.signerName,
            statement: record.clientDecision.statement,
            decidedAt: record.clientDecision.decidedAt,
            ipAddress: record.clientDecision.ipAddress,
            userAgent: record.clientDecision.userAgent,
            emailedTo: record.clientDecision.emailedTo,
            pdf: record.clientDecision.pdf === null ? null : { ...record.clientDecision.pdf },
          },
    deletedBy: record.deletedBy === null ? null : { ...record.deletedBy },
    deleteRefusal:
      record.deleteRefusal === null
        ? null
        : { code: record.deleteRefusal.code, message: record.deleteRefusal.message },
  };
}

/** What sending returned, field by field. */
function toSentBody(
  proposal: ProposalRecord["proposal"],
  shareToken: string,
  email: EmailOutcome | null,
  fees: boolean,
): z.infer<typeof SentProposalSchema> {
  return {
    proposal: toProposalBody(proposal, fees),
    shareToken,
    email:
      email === null
        ? null
        : email.status === "sent"
          ? { status: "sent", to: email.to, emailId: email.emailId, sentAt: email.sentAt, reason: null }
          : { status: "failed", to: email.to, emailId: null, sentAt: null, reason: email.reason },
  };
}

/** The recipient's view, field by field — the view and the answer both return
 *  it, and a field mapped in one and not the other is a page that disagrees
 *  with itself after the client presses a button. */
function toSharedBody(shared: SharedProposal): z.infer<typeof SharedProposalSchema> {
  return {
    id: shared.id,
    ref: shared.ref,
    firmName: shared.firmName,
    issuedBy: shared.issuedBy,
    addressedTo: shared.addressedTo,
    title: shared.title,
    status: shared.status,
    currency: shared.currency,
    validUntil: shared.validUntil,
    sentAt: shared.sentAt,
    lines: shared.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      discountPercent: l.discountPercent,
      net: l.net,
      pricingNote: l.pricingNote,
      billingFrequency: l.billingFrequency,
      oopEstimate: l.oopEstimate === null ? null : { ...l.oopEstimate },
    })),
    totals: { ...shared.totals },
    blocks: shared.blocks.map((b) => ({
      kind: b.kind,
      body: b.body,
      isHeading: b.isHeading,
      sortOrder: b.sortOrder,
    })),
    answer: shared.answer === null ? null : { ...shared.answer },
    acceptanceStatement: shared.acceptanceStatement,
  };
}

function toSummaryBody(
  summary: ProposalSummary,
  fees: boolean,
): z.infer<typeof ProposalSummarySchema> {
  return {
    proposal: toProposalBody(summary.proposal, fees),
    party: { id: summary.party.id, displayName: summary.party.displayName },
    issuingEntity: {
      id: summary.issuingEntity.id,
      displayName: summary.issuingEntity.displayName,
    },
    totals: toTotalsBody(summary.totals, fees),
    lineCount: summary.lineCount,
  };
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerProposalRoutes(app: OpenAPIHono<AppEnv>, deps: ProposalDeps): void {
  /** The fifth axis, asked once per request. */
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);

  app.openapi(draftRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const proposal = await deps.service.draft({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(toProposalBody(proposal, seesFees(c.get("principal"))), 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { status, partyId } = c.req.valid("query");
    const summaries = await deps.service.list(s.tenantId, { status, partyId });
    const fees = seesFees(c.get("principal"));
    return c.json({ proposals: summaries.map((p) => toSummaryBody(p, fees)) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const record = await deps.service.describe(s.tenantId, proposalId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const deleted = await deps.service.delete(s.tenantId, proposalId, s.actor);
    return c.json(toProposalBody(deleted, seesFees(c.get("principal"))), 200);
  });

  app.openapi(reviseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.revise({
      tenantId: s.tenantId,
      proposalId,
      title: body.title,
      validUntil: body.validUntil,
      background: body.background,
      addressedToPartyId: body.addressedToPartyId,
      preparedByUserId: body.preparedByUserId,
    });
    const record = await deps.service.describe(s.tenantId, proposalId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.addLine({ tenantId: s.tenantId, proposalId, ...body }, s.actor);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        id: line.id,
        entityPartyId: line.entityPartyId,
        // Same as `service` below: a name the write path did not join for.
        entity: null,
        serviceVersionId: line.serviceVersionId,
        // The pinned service is a join the write path does not do; the read
        // route carries it. Null here says "not loaded", which is what it is.
        service: null,
        // Same as `service`: resolving the four blocks needs the pinned body,
        // which is a join the write path does not make. The line's own
        // overrides are what it wrote, so they are reported as written and
        // `tailored` is exactly right; the catalogue's fallback is null here
        // and the read route is what fills it in.
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
        jurisdiction: line.jurisdiction,
        billingFrequency: line.billingFrequency,
        pricingNote: line.pricingNote,
        oopEstimate: fees && line.oopEstimate !== null ? { ...line.oopEstimate } : null,
      },
      201,
    );
  });

  app.openapi(updateLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId, lineId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.updateLine(
      {
        tenantId: s.tenantId,
        proposalId,
        lineId,
        description: body.description,
        quantity: body.quantity,
        unitAmount: body.unitAmount,
        discountPercent: body.discountPercent,
        jurisdiction: body.jurisdiction,
        billingFrequency: body.billingFrequency,
        scopeOverride: body.scopeOverride,
        clientObligationsOverride: body.clientObligationsOverride,
        volumeLimitsOverride: body.volumeLimitsOverride,
        exclusionsOverride: body.exclusionsOverride,
        oopEstimate: body.oopEstimate,
        pricingNote: body.pricingNote,
      },
      s.actor,
    );
    const record = await deps.service.describe(s.tenantId, proposalId);
    return c.json(toRecordBody(record, seesFees(c.get("principal"))), 200);
  });

  app.openapi(removeLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId, lineId } = c.req.valid("param");
    await deps.service.removeLine(s.tenantId, proposalId, lineId);
    return c.body(null, 204);
  });

  app.openapi(approveDiscountRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const principal = c.get("principal");
    const { proposalId } = c.req.valid("param");
    // The approver is the SESSION's user, never a field in the body: an
    // approval somebody could attribute to a colleague is not an approval.
    const approved = await deps.service.approveDiscount(
      s.tenantId,
      proposalId,
      principal?.userId ?? "",
      s.actor,
    );
    return c.json(toProposalBody(approved, seesFees(principal)), 200);
  });

  app.openapi(sendRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { proposal, shareToken, email } = await deps.service.send(
      s.tenantId,
      proposalId,
      s.actor,
      body?.email,
    );
    return c.json(toSentBody(proposal, shareToken, email, seesFees(c.get("principal"))), 200);
  });

  app.openapi(reissueRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { proposal, shareToken, email } = await deps.service.reissue(
      s.tenantId,
      proposalId,
      s.actor,
      body?.email,
    );
    return c.json(toSentBody(proposal, shareToken, email, seesFees(c.get("principal"))), 200);
  });

  app.openapi(viewSharedRoute, async (c) => {
    // No principal, by design — this route is in PUBLIC_PATHS. The recipient
    // has no account, so the event names the SYSTEM actor with the route in its
    // payload; inventing a user id for somebody who has never logged in would
    // be worse than saying plainly that a link was opened.
    const { token } = c.req.valid("json");
    const shared = await deps.service.viewShared(token, SYSTEM_ACTOR);
    return c.json(toSharedBody(shared), 200);
  });

  app.openapi(answerSharedRoute, async (c) => {
    // PUBLIC, like the view — the argument is on PUBLIC_PATHS in guards.ts. The
    // SYSTEM actor for the ledger, for the view's reason; the NAME the client
    // typed is the evidence, and it lives in the erasable row, not the log.
    const body = c.req.valid("json");
    // The address as the rate limiter derived it — the one place that knows
    // which address this deployment may believe. Its fail-closed shared key
    // is not an address, and is recorded as none.
    const clientKey = c.get("clientKey");
    const userAgent = c.req.header("user-agent");
    const shared = await deps.service.answerShared(
      {
        token: body.token,
        decision: body.decision,
        signerName: body.signerName,
        confirmed: body.confirmed ?? false,
        declinedReason: body.declinedReason,
        ipAddress:
          clientKey === null || clientKey === "unknown-client" ? null : clientKey.slice(0, 64),
        userAgent: userAgent === undefined || userAgent === "" ? null : userAgent.slice(0, 512),
      },
      SYSTEM_ACTOR,
    );
    return c.json(toSharedBody(shared), 200);
  });

  app.openapi(sharedPdfRoute, async (c) => {
    // PUBLIC. The same bytes the email attached — see `sharedPdf`.
    const { token } = c.req.valid("json");
    const pdf = await deps.service.sharedPdf(token, SYSTEM_ACTOR);
    return new Response(pdf.bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.bytes.byteLength),
        "content-disposition": `attachment; filename="${pdf.filename.replace(/[^\w.-]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        // A capability's bytes: nothing in between keeps a copy.
        "cache-control": "private, no-store",
      },
    });
  });

  app.openapi(decideRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const { decision, declinedReason } = c.req.valid("json");
    const decided = await deps.service.decide(
      s.tenantId,
      proposalId,
      decision,
      s.actor,
      declinedReason,
    );
    return c.json(toProposalBody(decided, seesFees(c.get("principal"))), 200);
  });
}
