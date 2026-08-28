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
import { scopeOf } from "../scope";
import type { Principal } from "../../platform/callctx";
import type { AuthzService } from "../../usecase/authz/service";
import type { ProposalService } from "../../usecase/proposal/service";
import type { ProposalRecord, ProposalSummary } from "../../usecase/proposal/ports";
import type { ProposalStatus } from "../../domain/proposal/model";
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
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── Response schemas ────────────────────────────────────────────────────────

const MoneySchema = z.object({ amount: AmountSchema, currency: CurrencySchema });

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
    fxRate: AmountSchema.nullable(),
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
    description: z.string(),
    position: z.number().int(),
    quantity: AmountSchema,
    unitAmount: AmountSchema.nullable(),
    currency: CurrencySchema,
    discountPercent: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
  })
  .openapi("ProposalLine");

const ApproverSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string().email(),
  })
  .nullable();

const ProposalRecordSchema = z
  .object({
    proposal: ProposalSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — a letterhead prints a name, not a uuid. */
    issuingEntity: PartyRefSchema,
    lines: z.array(ProposalLineSchema),
    totals: TotalsSchema,
    approvedBy: ApproverSchema,
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

const SentProposalSchema = z
  .object({
    proposal: ProposalSchema,
    /**
     * The share link's token, returned EXACTLY ONCE.
     *
     * Only its digest is stored, so this response is the only place it can ever
     * be read — the same contract sessions and magic links keep, for the same
     * reason. A firm that loses it re-sends, which issues a new one.
     */
    shareToken: z.string(),
  })
  .openapi("SentProposal");

/** What the RECIPIENT reads. Its own shape, not the staff model with fields
 *  nulled, so a field added for colleagues cannot reach a client's screen by
 *  default — no party id, no lead, no exchange rate, no approver, and no
 *  catalogue version. */
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
        unitAmount: AmountSchema,
        discountPercent: AmountSchema,
        net: AmountSchema,
      }),
    ),
    totals: z.object({
      gross: AmountSchema,
      discount: AmountSchema,
      net: AmountSchema,
      currency: CurrencySchema,
    }),
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
    fxRate: AmountSchema,
    fxRateDate: DaySchema,
    validUntil: DaySchema.optional(),
  })
  .openapi("DraftProposalRequest");

const AddLineRequest = z
  .object({
    entityPartyId: z.string().uuid().optional(),
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    unitAmount: AmountSchema,
    discountPercent: AmountSchema.default("0"),
  })
  .openapi("AddProposalLineRequest");

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
    "holding `proposal:approve` has signed it off.",
  request: { params: z.object({ proposalId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Sent, with the share link — returned once and never again",
      content: { "application/json": { schema: SentProposalSchema } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not a draft, empty, or an unapproved over-limit discount"),
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
  };
}

function toRecordBody(record: ProposalRecord, fees: boolean): z.infer<typeof ProposalRecordSchema> {
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
      description: l.line.description,
      position: l.line.position,
      // Quantity is not money. "Three registrations" is what the work IS, and a
      // delivery associate needs it.
      quantity: l.line.quantity,
      unitAmount: fees ? l.line.unitAmount : null,
      currency: l.line.currency,
      discountPercent: fees ? l.line.discountPercent : null,
      net: fees ? l.net : null,
    })),
    totals: toTotalsBody(record.totals, fees),
    approvedBy: record.approvedBy === null ? null : { ...record.approvedBy },
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

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.addLine({ tenantId: s.tenantId, proposalId, ...body });
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
        description: line.description,
        position: line.position,
        quantity: line.quantity,
        unitAmount: fees ? line.unitAmount : null,
        currency: line.currency,
        discountPercent: fees ? line.discountPercent : null,
        net: null,
      },
      201,
    );
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
    const { proposal, shareToken } = await deps.service.send(s.tenantId, proposalId, s.actor);
    return c.json(
      { proposal: toProposalBody(proposal, seesFees(c.get("principal"))), shareToken },
      200,
    );
  });

  app.openapi(viewSharedRoute, async (c) => {
    // No principal, by design — this route is in PUBLIC_PATHS. The recipient
    // has no account, so the event names the SYSTEM actor with the route in its
    // payload; inventing a user id for somebody who has never logged in would
    // be worse than saying plainly that a link was opened.
    const { token } = c.req.valid("json");
    const shared = await deps.service.viewShared(token, SYSTEM_ACTOR);
    return c.json(
      {
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
        })),
        totals: { ...shared.totals },
      },
      200,
    );
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
