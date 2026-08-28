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
    partyId: z.string().uuid(),
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
  })
  .openapi("Proposal");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

const ProposalLineSchema = z
  .object({
    id: z.string().uuid(),
    // The PIN, on the wire, because a screen showing "list 25,000 / quoted
    // 22,500" needs to be able to say which catalogue version it is quoting.
    serviceVersionId: z.string().uuid(),
    service: z
      .object({
        key: z.string(),
        version: z.number().int(),
        name: z.string(),
        listPrice: MoneySchema.nullable(),
      })
      .nullable(),
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
    lines: z.array(ProposalLineSchema),
    totals: TotalsSchema,
    approvedBy: ApproverSchema,
  })
  .openapi("ProposalRecord");

const ProposalSummarySchema = z
  .object({
    proposal: ProposalSchema,
    party: PartyRefSchema,
    totals: TotalsSchema,
    lineCount: z.number().int(),
  })
  .openapi("ProposalSummary");

const ProposalsResponse = z
  .object({ proposals: z.array(ProposalSummarySchema) })
  .openapi("ProposalsResponse");

// ── Request schemas ─────────────────────────────────────────────────────────

const DraftProposalRequest = z
  .object({
    partyId: z.string().uuid(),
    leadId: z.string().uuid().optional(),
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
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    unitAmount: AmountSchema,
    discountPercent: AmountSchema.default("0"),
  })
  .openapi("AddProposalLineRequest");

const DecisionRequest = z
  .object({ decision: z.enum(["accepted", "rejected"]) })
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
    200: { description: "Sent", content: { "application/json": { schema: ProposalSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such proposal at this firm"),
    409: errorResponse("Not a draft, empty, or an unapproved over-limit discount"),
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
    partyId: proposal.partyId,
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
    lines: record.lines.map((l) => ({
      id: l.line.id,
      serviceVersionId: l.line.serviceVersionId,
      service:
        l.service === null
          ? null
          : {
              key: l.service.key,
              version: l.service.version,
              name: l.service.name,
              // The list price is the firm's own commercial data, so it goes
              // with the rest of the money.
              listPrice: fees && l.service.listPrice !== null ? { ...l.service.listPrice } : null,
            },
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
    const sent = await deps.service.send(s.tenantId, proposalId, s.actor);
    return c.json(toProposalBody(sent, seesFees(c.get("principal"))), 200);
  });

  app.openapi(decideRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { proposalId } = c.req.valid("param");
    const { decision } = c.req.valid("json");
    const decided = await deps.service.decide(s.tenantId, proposalId, decision, s.actor);
    return c.json(toProposalBody(decided, seesFees(c.get("principal"))), 200);
  });
}
