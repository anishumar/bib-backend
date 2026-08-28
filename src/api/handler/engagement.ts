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
import type { LetterRecord, LetterSummary } from "../../usecase/engagement/ports";
import type { EngagementStatus, LetterStatus } from "../../domain/engagement/model";

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

const AmountSchema = z.string().regex(/^\d{1,15}(?:\.\d{1,4})?$/);
const CurrencySchema = z.string().length(3);
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const JurisdictionSchema = z.string().length(2);

// ── Response schemas ────────────────────────────────────────────────────────

const TotalsSchema = z
  .object({
    gross: AmountSchema.nullable(),
    discount: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
    currency: CurrencySchema,
  })
  .openapi("EngagementLetterTotals");

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
    fxRate: AmountSchema.nullable(),
    fxRateDate: DaySchema,
    advanceRequired: z.boolean(),
    advanceAmount: AmountSchema.nullable(),
    advanceRecordedAt: z.string().nullable(),
    sentAt: z.string().nullable(),
    signedAt: z.string().nullable(),
    signedByName: z.string().nullable(),
    signatureMethod: z.string().nullable(),
    signatureReference: z.string().nullable(),
    // The document's fingerprint. On the wire because verifying a signature is
    // something a firm should be able to do without a database session.
    signedContentHash: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
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
    service: z
      .object({ key: z.string(), version: z.number().int(), name: z.string() })
      .nullable(),
    description: z.string(),
    position: z.number().int(),
    quantity: AmountSchema,
    unitAmount: AmountSchema.nullable(),
    currency: CurrencySchema,
    discountPercent: AmountSchema.nullable(),
    net: AmountSchema.nullable(),
  })
  .openapi("EngagementLetterLine");

/** A term, as it was PINNED. Not redacted by the fee axis: what the firm
 *  undertook is the work, not the money. */
const LetterClauseSchema = z
  .object({
    id: z.string().uuid(),
    clauseVersionId: z.string().uuid(),
    key: z.string(),
    version: z.number().int(),
    position: z.number().int(),
    title: z.string(),
    text: z.string(),
  })
  .openapi("EngagementLetterClause");

const EngagementSchema = z
  .object({
    id: z.string().uuid(),
    engagementLetterId: z.string().uuid(),
    engagementLetterLineId: z.string().uuid(),
    /** Who is billed. */
    partyId: z.string().uuid(),
    /** Who the work is delivered to — `service × one legal entity`. */
    entityPartyId: z.string().uuid(),
    status: z.enum(ENGAGEMENT_STATUS_VALUES),
    activatedAt: z.string().nullable(),
    endsOn: DaySchema.nullable(),
  })
  .openapi("Engagement");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

const LetterRecordSchema = z
  .object({
    letter: LetterSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — the letterhead and the signature block both
     *  print it. */
    issuingEntity: PartyRefSchema,
    lines: z.array(LetterLineSchema),
    clauses: z.array(LetterClauseSchema),
    totals: TotalsSchema,
    engagements: z.array(EngagementSchema),
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
    fxRate: AmountSchema,
    fxRateDate: DaySchema,
    advanceRequired: z.boolean().default(false),
    advanceAmount: AmountSchema.optional(),
  })
  .openapi("DraftEngagementLetterRequest");

const AddLineRequest = z
  .object({
    entityPartyId: z.string().uuid(),
    serviceVersionId: z.string().uuid(),
    description: z.string().min(1),
    quantity: AmountSchema.default("1"),
    unitAmount: AmountSchema,
    discountPercent: AmountSchema.default("0"),
  })
  .openapi("AddEngagementLetterLineRequest");

const AddClauseRequest = z
  .object({ clauseVersionId: z.string().uuid() })
  .openapi("AddEngagementLetterClauseRequest");

const SignRequest = z
  .object({
    signedByName: z.string().min(1),
    reference: z.string().optional(),
  })
  .openapi("SignEngagementLetterRequest");

// ── Routes ──────────────────────────────────────────────────────────────────

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

const sendRoute = createRoute({
  method: "post",
  path: "/api/v1/engagement-letters/{letterId}/send",
  tags: ["engagement-letters"],
  summary: "Send it for signature",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: LetterSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not a draft, no lines, or no clauses"),
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
  letter: LetterRecord["letter"],
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
    signedContentHash: letter.signedContentHash,
    withdrawnAt: letter.withdrawnAt,
  };
}

function toEngagementBody(e: LetterRecord["engagements"][number]): z.infer<typeof EngagementSchema> {
  return {
    id: e.id,
    engagementLetterId: e.engagementLetterId,
    engagementLetterLineId: e.engagementLetterLineId,
    partyId: e.partyId,
    entityPartyId: e.entityPartyId,
    status: e.status,
    activatedAt: e.activatedAt,
    endsOn: e.endsOn,
  };
}

function toRecordBody(record: LetterRecord, fees: boolean): z.infer<typeof LetterRecordSchema> {
  return {
    letter: toLetterBody(record.letter, fees),
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
      service: l.service === null ? null : { ...l.service },
      description: l.line.description,
      position: l.line.position,
      quantity: l.line.quantity,
      unitAmount: fees ? l.line.unitAmount : null,
      currency: l.line.currency,
      discountPercent: fees ? l.line.discountPercent : null,
      net: fees ? l.net : null,
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
    })),
    totals: {
      gross: fees ? record.totals.gross : null,
      discount: fees ? record.totals.discount : null,
      net: fees ? record.totals.net : null,
      currency: record.totals.currency,
    },
    engagements: record.engagements.map(toEngagementBody),
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
    const sent = await deps.service.send(s.tenantId, letterId, s.actor);
    return c.json(toLetterBody(sent, seesFees(c.get("principal"))), 200);
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
