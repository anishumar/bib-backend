// The ad-hoc advance (0363, Q044-Q048), as a surface: transport only. Each
// route declares its wire shape; its handler parses, calls one use-case method
// and maps the result FIELD BY FIELD.
//
// AMOUNTS ARE DECIMAL STRINGS and are REDACTED (null) for a caller without the
// fee axis: a colleague may see that a client's advance waits to be mapped,
// and to which services, not what it is worth. Raising and mapping refuse such
// a caller outright (FEES_NOT_VISIBLE): an advance IS an amount.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { AdhocAdvanceService } from "../../usecase/billing/adhoc";
import type { AdhocAdvanceRecord, AdhocAllocationRecord, PersonRef } from "../../usecase/billing/ports";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";
import { compareAmounts } from "../../domain/money/model";
import { adhocAdvanceStatus } from "../../domain/billing/adhoc-advance";

export interface AdvanceRouteDeps {
  readonly adhoc: AdhocAdvanceService;
  /** For the FEE AXIS only; gate 3 is middleware. */
  readonly authz: AuthzService;
}

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);
const SignedDecimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Person = z
  .object({ userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string() })
  .openapi("AdvancePerson");

const AllocationSchema = z
  .object({
    id: z.string().uuid(),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("service"),
        engagementId: z.string().uuid(),
        serviceName: z.string(),
        letterRef: z.string(),
        engagementStatus: z.string(),
        job: z.object({ id: z.string().uuid(), label: z.string().nullable() }).nullable(),
      }),
      z.object({ kind: z.literal("letter"), letterId: z.string().uuid(), letterRef: z.string() }),
    ]),
    amount: Decimal.nullable().openapi({ description: "As mapped, before tax. Null without the fee axis." }),
    effective: Decimal.nullable().openapi({
      description: "What it still holds: all of it while live, what bills took once ended.",
    }),
    taken: Decimal.nullable().openapi({ description: "What bills of that work have taken from it." }),
    left: SignedDecimal.nullable().openapi({ description: "Effective less taken: what later bills will still take." }),
    manager: Person.nullable().openapi({ description: "Whose revenue this part is, frozen when it was mapped." }),
    how: z.enum(["by_hand", "letter_signed"]),
    reason: z.string(),
    createdBy: Person.nullable(),
    createdAt: z.string(),
    ended: z
      .object({ at: z.string(), by: Person.nullable(), reason: z.string(), kept: Decimal.nullable() })
      .nullable(),
  })
  .openapi("AdvanceAllocation");

const AdvanceSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["draft", "open", "mapped", "cancelled"]).openapi({
      description:
        "`draft`: raised, not issued (nothing to map yet). `open`: issued, part of it mapped nowhere. " +
        "`mapped`: all of it is pointed at work. `cancelled`: its invoice was withdrawn.",
    }),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    issuer: z.object({ id: z.string().uuid(), displayName: z.string() }),
    currency: z.string(),
    note: z.string().nullable(),
    raisedBy: Person.nullable(),
    raisedAt: z.string(),
    manager: Person.nullable().openapi({ description: "The invoice's manager: whose revenue the unmapped part is." }),
    invoice: z.object({
      id: z.string().uuid(),
      number: z.string().nullable(),
      status: z.enum(["draft", "issued", "cancelled"]),
      issuedOn: z.string().nullable(),
    }),
    amount: Decimal.nullable().openapi({ description: "The advance, before tax (the invoice's net)." }),
    total: Decimal.nullable().openapi({ description: "With tax: what the client is asked for." }),
    credited: Decimal.nullable(),
    mapped: Decimal.nullable(),
    unmapped: SignedDecimal.nullable().openapi({
      description: "Before tax, mapped nowhere. Null until issued, or without the fee axis.",
    }),
    refundAmount: Decimal.nullable().openapi({
      description: "What Give back would credit: the unmapped part with its share of the tax.",
    }),
    paid: SignedDecimal.nullable(),
    outstanding: SignedDecimal.nullable(),
    paidState: z.enum(["unpaid", "part_paid", "paid", "not_issued"]).openapi({
      description: "Not an amount, so shown to every caller.",
    }),
    allocations: z.array(AllocationSchema),
    namedOn: z.array(
      z.object({ letterId: z.string().uuid(), ref: z.string(), status: z.string(), amount: Decimal.nullable() }),
    ),
  })
  .openapi("AdhocAdvance");

function personBody(p: PersonRef | null) {
  return p === null ? null : { userId: p.userId, displayName: p.displayName, email: p.email };
}

function allocationBody(a: AdhocAllocationRecord, fees: boolean) {
  const m = (v: string): string | null => (fees ? v : null);
  return {
    id: a.id,
    target:
      a.target.kind === "service"
        ? {
            kind: "service" as const,
            engagementId: a.target.engagementId,
            serviceName: a.target.serviceName,
            letterRef: a.target.letterRef,
            engagementStatus: a.target.engagementStatus,
            job: a.target.job === null ? null : { id: a.target.job.id, label: a.target.job.label },
          }
        : { kind: "letter" as const, letterId: a.target.letterId, letterRef: a.target.letterRef },
    amount: m(a.amount),
    effective: m(a.effective),
    taken: m(a.taken),
    left: m(a.left),
    manager: personBody(a.manager),
    how: a.how,
    reason: a.reason,
    createdBy: personBody(a.createdBy),
    createdAt: a.createdAt,
    ended:
      a.ended === null
        ? null
        : { at: a.ended.at, by: personBody(a.ended.by), reason: a.ended.reason, kept: m(a.ended.kept) },
  };
}

/** Paid means money arrived and nothing is owed (0321's rule for advances). */
function paidStateOf(a: AdhocAdvanceRecord): "unpaid" | "part_paid" | "paid" | "not_issued" {
  if (a.invoice.status !== "issued") return "not_issued";
  const paid = compareAmounts(a.paid, "0") > 0;
  if (paid && compareAmounts(a.outstanding, "0") <= 0) return "paid";
  return paid ? "part_paid" : "unpaid";
}

function statusOf(a: AdhocAdvanceRecord): "draft" | "open" | "mapped" | "cancelled" {
  return adhocAdvanceStatus({ invoiceStatus: a.invoice.status, unmapped: a.unmapped });
}

export function advanceBody(a: AdhocAdvanceRecord, fees: boolean) {
  const m = (v: string | null): string | null => (fees ? v : null);
  return {
    id: a.id,
    status: statusOf(a),
    party: { id: a.party.id, displayName: a.party.displayName },
    issuer: { id: a.issuer.id, displayName: a.issuer.displayName },
    currency: a.currency,
    note: a.note,
    raisedBy: personBody(a.raisedBy),
    raisedAt: a.raisedAt,
    manager: personBody(a.manager),
    invoice: { id: a.invoice.id, number: a.invoice.number, status: a.invoice.status, issuedOn: a.invoice.issuedOn },
    amount: m(a.net),
    total: m(a.total),
    credited: m(a.credited),
    mapped: m(a.mapped),
    unmapped: m(a.unmapped),
    refundAmount: m(a.refundAmount),
    paid: m(a.paid),
    outstanding: m(a.outstanding),
    paidState: paidStateOf(a),
    allocations: a.allocations.map((x) => allocationBody(x, fees)),
    namedOn: a.namedOn.map((n) => ({ letterId: n.letterId, ref: n.ref, status: n.status, amount: m(n.amount) })),
  };
}

const AdvanceId = z.object({ advanceId: z.string().uuid() });

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/advances",
  tags: ["billing"],
  summary: "Advances to be adjusted",
  description:
    "Every advance raised before an engagement letter (0363, Q044): who raised it, when, its invoice, " +
    "how much is mapped and to which services, what is left, and whether it is paid. `open` (the " +
    "default) is a draft or an issued one with something unmapped; `all` adds the fully mapped and " +
    "the cancelled. Amounts are per advance, in its own currency; nothing here adds two currencies.",
  request: {
    query: z.object({ status: z.enum(["open", "all"]).optional(), partyId: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Advances",
      content: {
        "application/json": {
          schema: z.object({ advances: z.array(AdvanceSchema), feesVisible: z.boolean() }),
        },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/advances/{advanceId}",
  tags: ["billing"],
  summary: "One advance raised before an engagement letter",
  request: { params: AdvanceId },
  responses: {
    200: { description: "The advance", content: { "application/json": { schema: AdvanceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such advance at this firm"),
  },
});

const raiseRoute = createRoute({
  method: "post",
  path: "/api/v1/advances",
  tags: ["billing"],
  summary: "Raise an advance before the engagement letter",
  description:
    "A DRAFT tax invoice of one line, \"Advance, to be adjusted against services\", for the amount " +
    "BEFORE tax, at the tax rate sent or the issuing company's default. Every invoice rule applies " +
    "(the company is one of the firm's, the client is not, the rate rule, the manager). It is numbered " +
    "when somebody with invoice:issue issues it, and can then be mapped. Needs advance:manage and the " +
    "fee axis (FEES_NOT_VISIBLE, 403).",
  request: {
    query: z.object({ asOf: Day.optional() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              partyId: z.string().uuid(),
              entityPartyId: z.string().uuid(),
              currency: z.string().length(3),
              amount: Decimal,
              taxPercent: Decimal.optional(),
              fxRate: Decimal.optional(),
              fxRateDate: Day.optional(),
              dueOn: Day.optional(),
              managerUserId: z.string().uuid().optional(),
              note: z.string().max(500).optional(),
            })
            .openapi("RaiseAdhocAdvance"),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Drafted",
      content: {
        "application/json": {
          schema: z.object({ advanceId: z.string().uuid(), invoiceId: z.string().uuid() }).openapi("AdhocAdvanceRaised"),
        },
      },
    },
    400: errorResponse("An amount, a tax rate or a rate missing or wrong"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, the role does not permit it, or this login does not see fees"),
    409: errorResponse("The client is archived or is one of the firm's own companies, or the manager is not on the roster"),
  },
});

const targetsRoute = createRoute({
  method: "get",
  path: "/api/v1/advances/{advanceId}/targets",
  tags: ["billing"],
  summary: "The client's services this advance could be mapped to",
  description:
    "Every service of the advance's client with its jobs. `refusal` says why one cannot take this " +
    "advance (another currency, another company, finished), in the words the map would refuse with.",
  request: { params: AdvanceId },
  responses: {
    200: {
      description: "Services",
      content: {
        "application/json": {
          schema: z.object({
            services: z.array(
              z.object({
                engagementId: z.string().uuid(),
                serviceName: z.string(),
                letterRef: z.string(),
                currency: z.string(),
                issuerName: z.string(),
                status: z.string(),
                refusal: z.string().nullable(),
                jobs: z.array(z.object({ id: z.string().uuid(), label: z.string().nullable(), status: z.string() })),
              }),
            ),
          }),
        },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such advance at this firm"),
  },
});

const mapRoute = createRoute({
  method: "post",
  path: "/api/v1/advances/{advanceId}/allocations",
  tags: ["billing"],
  summary: "Map an advance to services",
  description:
    "Split what is left of an issued advance across services, and optionally one job of each. Amounts " +
    "are before tax and together at most what is unmapped (ADVANCE_OVER_MAPPED). Each service is this " +
    "client's (ADVANCE_OF_ANOTHER_CLIENT), under a letter of the company that invoiced the advance " +
    "(ADVANCE_OF_ANOTHER_ISSUER) and billed in its currency (ADVANCE_IN_ANOTHER_CURRENCY: never " +
    "converted). Each part then comes off that work's earliest bills, before tax, and counts in that " +
    "service's manager's revenue. Needs advance:manage and the fee axis.",
  request: {
    params: AdvanceId,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              targets: z
                .array(z.object({ engagementId: z.string().uuid(), jobId: z.string().uuid().optional(), amount: Decimal }))
                .min(1)
                .max(20),
              reason: z.string().min(1).max(500),
            })
            .openapi("MapAdhocAdvance"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Mapped", content: { "application/json": { schema: AdvanceSchema } } },
    400: errorResponse("An amount or the reason missing or wrong"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, the role does not permit it, or this login does not see fees"),
    404: errorResponse("No such advance or service at this firm"),
    409: errorResponse("Not issued, more than is left, or a service it cannot be mapped to"),
  },
});

const endRoute = createRoute({
  method: "post",
  path: "/api/v1/advances/{advanceId}/allocations/{allocationId}/end",
  tags: ["billing"],
  summary: "End a mapping, to map it elsewhere or give it back",
  description:
    "What that work's bills have already taken stays mapped; the rest is unmapped again. A mapping its " +
    "bills took in full cannot move (ALLOCATION_USED_UP). Needs advance:manage.",
  request: {
    params: z.object({ advanceId: z.string().uuid(), allocationId: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ reason: z.string().min(1).max(500) }).openapi("EndAllocation") },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Ended", content: { "application/json": { schema: AdvanceSchema } } },
    400: errorResponse("No reason"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such advance or mapping"),
    409: errorResponse("Already ended, or used up by bills"),
  },
});

const giveBackRoute = createRoute({
  method: "post",
  path: "/api/v1/advances/{advanceId}/give-back",
  tags: ["billing"],
  summary: "Give back what of an advance is mapped nowhere",
  description:
    "The letter never came: a credit note on the advance invoice for its unmapped part with its share " +
    "of the tax (reason `advance_refund`). The money goes back as a negative payment, as every refund. " +
    "Mapped parts are ended first. Needs invoice:issue and the fee axis.",
  request: { params: AdvanceId, query: z.object({ asOf: Day.optional() }) },
  responses: {
    201: {
      description: "Credited",
      content: {
        "application/json": {
          schema: z.object({ creditNoteId: z.string(), number: z.string() }).openapi("AdhocAdvanceGivenBack"),
        },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, the role does not permit it, or this login does not see fees (FEES_NOT_VISIBLE)"),
    404: errorResponse("No such advance at this firm"),
    409: errorResponse("Not issued, or nothing unmapped"),
  },
});

const LetterAdvancesSchema = z
  .object({
    letterStatus: z.string(),
    named: z.array(z.object({ advance: AdvanceSchema, amount: Decimal.nullable() })),
    candidates: z.array(AdvanceSchema),
  })
  .openapi("LetterAdvancesReceived");

const letterGetRoute = createRoute({
  method: "get",
  path: "/api/v1/engagement-letters/{letterId}/advances-received",
  tags: ["billing"],
  summary: "Advances a letter names as received, and those it could name",
  description:
    "Q048, scenario 1: the letter prints \"Advance received\" for each it names, and when it is signed " +
    "each is mapped to the letter (the smaller of the named amount and what is unmapped then), coming off " +
    "its earliest bills before tax. Candidates: this client's issued advances from the letter's company in " +
    "its currency with something unmapped.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: { description: "Named and candidates", content: { "application/json": { schema: LetterAdvancesSchema } } },
    400: errorResponse("No such letter"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const letterPutRoute = createRoute({
  method: "put",
  path: "/api/v1/engagement-letters/{letterId}/advances-received",
  tags: ["billing"],
  summary: "Name the advances a draft letter says were received",
  description:
    "Replaces what the DRAFT letter names. Each advance is this client's, from the letter's company, in " +
    "its currency, issued, and the amount at most what is unmapped today. Needs the fee axis.",
  request: {
    params: z.object({ letterId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              advances: z.array(z.object({ adhocAdvanceId: z.string().uuid(), amount: Decimal })).max(20),
            })
            .openapi("NameLetterAdvances"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Named", content: { "application/json": { schema: LetterAdvancesSchema } } },
    400: errorResponse("Not a draft, or an advance that does not fit the letter"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, the role does not permit it, or this login does not see fees"),
    409: errorResponse("Not issued, or more than is unmapped"),
  },
});

export function registerAdvanceRoutes(app: OpenAPIHono<AppEnv>, deps: AdvanceRouteDeps): void {
  const seesFees = (principal: Principal | null): boolean => principal !== null && deps.authz.seesFees(principal);

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const fees = seesFees(c.get("principal"));
    const rows = await deps.adhoc.list(s.tenantId, { status: q.status, partyId: q.partyId });
    return c.json({ advances: rows.map((a) => advanceBody(a, fees)), feesVisible: fees }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const a = await deps.adhoc.get(s.tenantId, c.req.valid("param").advanceId);
    return c.json(advanceBody(a, seesFees(c.get("principal"))), 200);
  });

  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const b = c.req.valid("json");
    const out = await deps.adhoc.raise(
      {
        tenantId: s.tenantId,
        partyId: b.partyId,
        entityPartyId: b.entityPartyId,
        currency: b.currency,
        amount: b.amount,
        taxPercent: b.taxPercent,
        fxRate: b.fxRate,
        fxRateDate: b.fxRateDate,
        dueOn: b.dueOn,
        managerUserId: b.managerUserId,
        note: b.note,
        asOf: c.req.valid("query").asOf,
        callerSeesFees: seesFees(c.get("principal")),
      },
      s.actor,
    );
    return c.json({ advanceId: out.advanceId, invoiceId: out.invoice.id }, 201);
  });

  app.openapi(targetsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rows = await deps.adhoc.targetsFor(s.tenantId, c.req.valid("param").advanceId);
    return c.json(
      {
        services: rows.map((r) => ({
          engagementId: r.engagementId,
          serviceName: r.serviceName,
          letterRef: r.letterRef,
          currency: r.currency,
          issuerName: r.issuerName,
          status: r.status,
          refusal: r.refusal,
          jobs: r.jobs.map((j) => ({ id: j.id, label: j.label, status: j.status })),
        })),
      },
      200,
    );
  });

  app.openapi(mapRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const b = c.req.valid("json");
    const fees = seesFees(c.get("principal"));
    const a = await deps.adhoc.map(
      {
        tenantId: s.tenantId,
        advanceId: c.req.valid("param").advanceId,
        targets: b.targets.map((t) => ({ engagementId: t.engagementId, jobId: t.jobId, amount: t.amount })),
        reason: b.reason,
        callerSeesFees: fees,
      },
      s.actor,
    );
    return c.json(advanceBody(a, fees), 200);
  });

  app.openapi(endRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const p = c.req.valid("param");
    const a = await deps.adhoc.end(
      { tenantId: s.tenantId, advanceId: p.advanceId, allocationId: p.allocationId, reason: c.req.valid("json").reason },
      s.actor,
    );
    return c.json(advanceBody(a, seesFees(c.get("principal"))), 200);
  });

  app.openapi(giveBackRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    // A credit note writes money, like the invoice route's (B27).
    if (principal !== null) deps.authz.requireFees(principal, "give an advance back");
    const out = await deps.adhoc.giveBack(
      { tenantId: s.tenantId, advanceId: c.req.valid("param").advanceId, asOf: c.req.valid("query").asOf },
      s.actor,
    );
    return c.json({ creditNoteId: out.creditNoteId, number: out.number }, 201);
  });

  const letterBody = async (tenantId: string, letterId: string, fees: boolean) => {
    const out = await deps.adhoc.forLetter(tenantId, letterId);
    return {
      letterStatus: out.letterStatus,
      named: out.named.map((n) => ({ advance: advanceBody(n.advance, fees), amount: fees ? n.amount : null })),
      candidates: out.candidates.map((a) => advanceBody(a, fees)),
    };
  };

  app.openapi(letterGetRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(await letterBody(s.tenantId, c.req.valid("param").letterId, seesFees(c.get("principal"))), 200);
  });

  app.openapi(letterPutRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const letterId = c.req.valid("param").letterId;
    const fees = seesFees(c.get("principal"));
    await deps.adhoc.setNamed({
      tenantId: s.tenantId,
      letterId,
      advances: c.req.valid("json").advances.map((a) => ({ adhocAdvanceId: a.adhocAdvanceId, amount: a.amount })),
      callerSeesFees: fees,
    });
    return c.json(await letterBody(s.tenantId, letterId, fees), 200);
  });
}
