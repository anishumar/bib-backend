// The client portal's own HTTP surface (T6.5) — transport only.
//
// ── THE FIRST ROUTE ON THIS SURFACE, AND THE THREE THINGS IT NEEDED ────────
//
// `PORTAL_PATHS` held four routes before this one and not one of them returned
// a business record, so a client contact could sign in and see nothing. Adding
// a portal read means three things, and missing any of them is a hole rather
// than a bug:
//
//   · an entry in `PORTAL_PATHS` — gate 2 is denied by default
//   · an entry in `NO_PERMISSION_REQUIRED` — gate 3 is denied by default too
//   · the query through `withPortal`, with its own RESTRICTIVE policy on every
//     table it reads (0059 for work items, 0062 for the visibility flag and for
//     filings)
//
// ── WHY IT IS PARAMETER-LESS, AND WHY IT STAYS THAT WAY ──────────────────
//
// Gate 2 was `PORTAL_PATHS.has(c.req.path)` when this was written — an exact
// match on the CONCRETE path — so a portal route with a path parameter was
// unreachable no matter what was in that set, and the whole status home is one
// aggregate read because of it. T6.6 taught that gate templates, as its own
// change with its own test, which is what let the action centre's verbs name
// the record they act on.
//
// This route is still parameter-less and should stay so. It is one screen and
// one round trip, and splitting it now would buy nothing and cost a second
// scope resolution.
//
// ── IT NEEDS NO PERMISSION, AND THAT IS ARGUED RATHER THAN CONVENIENT ──────
//
// Being invited and being granted a company IS the authorisation to read that
// company's status: `crm.portal_access` is the decision somebody took, with a
// granter, a date and a ledger event. A permission on top would be a second
// answer to a question already answered, and every portal login would hold it.
// What a contact may DO — upload, answer, approve — is the question that needs a
// role, and it needs one that declares its audience (a migration, per
// CLAUDE.md). That lands with T6.6, where those verbs exist: a permission
// nothing checks is a lie on a screen, and this codebase has paid four times for
// registering something with no reader.
//
// ── AND IT REFUSES A STAFF SESSION ────────────────────────────────────────
//
// Gate 2 admits a portal session to `PORTAL_PATHS`; it says nothing about a
// STAFF session reaching one, because the staff workspace is the default side.
// Without the check below a colleague could open the client portal's home and
// get an EMPTY answer — they hold no portal grants — which reads as "this client
// has nothing going on" rather than "you are looking at the wrong app". A wrong
// answer that looks right is worse than a refusal.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";
import type { PortalHomeService } from "../../usecase/portalhome/service";
import {
  PORTAL_FILED_WINDOW_DAYS,
  PORTAL_HORIZON_DAYS,
} from "../../domain/portalhome/model";

export interface PortalHomeDeps {
  readonly service: PortalHomeService;
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CompanySchema = z
  .object({
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
  })
  .openapi("PortalCompany");

const WorkSchema = z
  .object({
    workItemId: z.string().uuid(),
    title: z.string(),
    companyName: z.string().nullable().openapi({
      description:
        "Which of your companies this is about. NULL is a real answer — work about the " +
        "relationship rather than one company has no entity (migration 0051).",
    }),
    stateName: z.string().openapi({
      description:
        "The firm's OWN word for where this has got to, not the engine's. Nothing in the " +
        "product compares these — they are rows the firm edits.",
    }),
    isHeldUp: z.boolean(),
    openedOn: IsoDate,
    statutoryDueOn: IsoDate.nullable().openapi({
      description:
        "Present ONLY where the date comes from a statute. The firm's own turnaround times " +
        "have never been given, so a deadline this product derived is a promise nobody made " +
        "to you — elapsed time from `openedOn` is a fact, and that is what is carried instead.",
    }),
    heldUpSince: IsoDate.nullable(),
    heldUpReason: z.string().nullable().openapi({
      description:
        "What the firm recorded it is waiting for. Both this and `heldUpSince` are present " +
        "together or not at all — a trigger insists a held-up task carries a reason.",
    }),
    hasOpenAsk: z.boolean().openapi({
      description:
        "TRUE when the firm has an open ask on this task (T6.6), which the action centre is " +
        "already showing with somewhere to answer it. A screen must not ALSO print " +
        "`heldUpReason` under such a row: the two routinely say the same sentence, and one " +
        "of them has a button.",
    }),
  })
  .openapi("PortalWorkRow");

const FilingSchema = z
  .object({
    obligationId: z.string().uuid(),
    name: z.string(),
    companyName: z.string(),
    periodLabel: z.string().openapi({ description: '"Aug 2026", "Q2 FY2026-27".' }),
    statutoryDueOn: IsoDate.openapi({
      description:
        "The LAW's date. The firm's own internal target — T–X, its working margin — is " +
        "deliberately not on this response: showing it to a client turns the margin into the " +
        "deadline, which is the opposite of what it is for.",
    }),
    stateName: z.string(),
    filedOn: IsoDate.nullable(),
    lastNudgedAt: z.string().nullable().openapi({
      description:
        "When the firm last told you this one was coming up, or null if it never has. A DATE " +
        "AND NOT A COUNT, the same choice the action centre makes about reminders: what you " +
        "can act on is whether you missed a message, and a tally would be the firm being " +
        "defensive about a filing that is not late yet. NULL IS ORDINARY — a firm that has " +
        "published no reminder ladder tells nobody, which is the shipped state.",
    }),
  })
  .openapi("PortalFilingRow");

const HomeSchema = z
  .object({
    companies: z.array(CompanySchema).openapi({
      description:
        "The companies this login may read TODAY, by name. AN EMPTY ARRAY IS A REAL ANSWER " +
        "and means invited-but-granted-nothing: the screen must say so rather than going " +
        "blank, because 'nothing yet, ask the firm' and 'nothing is happening' are different " +
        "sentences and only one of them is true.",
    }),
    inProgress: z.array(WorkSchema),
    heldUp: z.array(WorkSchema).openapi({
      description:
        "Work the firm cannot move on, with what it is waiting for. Named HELD UP rather " +
        "than 'waiting on you' deliberately: nothing in this schema records who a task is " +
        "waiting on, and the reason reads 'the client has not sent the purchase register' as " +
        "readily as 'the GST portal is down'. A client-directed ask with its own answer is " +
        "T6.6.",
    }),
    upcomingFilings: z.array(FilingSchema).openapi({
      description:
        `Still owed. Anything due within ${PORTAL_HORIZON_DAYS} days, plus everything ` +
        "already overdue whatever its date — a passed deadline is the row that must never " +
        "fall out of a forward window.",
    }),
    recentlyFiled: z.array(FilingSchema).openapi({
      description:
        `Filed in the last ${PORTAL_FILED_WINDOW_DAYS} days. Keyed on \`filedOn\` and not on ` +
        "the state being terminal: a deadline that was MISSED and then resolved is also " +
        "terminal, and calling that 'filed' would be a false statement about a statutory " +
        "return.",
    }),
    asOf: IsoDate,
  })
  .openapi("PortalStatusHome");

const homeRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/home",
  tags: ["portal"],
  summary: "The client portal's status home",
  description:
    "What the firm is doing for the companies this login was granted, what is held up, and " +
    "what has been filed. CLIENT_PORTAL sessions only — a staff session is refused rather " +
    "than answered with an empty page. Every row is scoped by gate 4 in the database, not by " +
    "a filter in the query.",
  request: {
    query: z.object({
      asOf: IsoDate.optional().openapi({
        description:
          "The day to answer for, in the CALLER's calendar. Defaults to the server's own " +
          "day, which is not the reader's: a server in UTC is a day behind a firm in India " +
          "every morning, and this value decides both what a grant is in force on and which " +
          "filings count as upcoming. A browser sends its local date.",
      }),
    }),
  },
  responses: {
    200: {
      description: "The status home",
      content: { "application/json": { schema: HomeSchema } },
    },
    400: errorResponse("asOf is not an ISO date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
  },
});

export function registerPortalHomeRoutes(app: OpenAPIHono<AppEnv>, deps: PortalHomeDeps): void {
  app.openapi(homeRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    // Gate 2 lets a STAFF session through — this surface is the client's, and
    // an empty answer would read as "your client has nothing going on".
    if (principal?.audience !== "CLIENT_PORTAL") {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message:
            "this is the client portal's own surface and needs a client-portal session. The " +
            "staff view of the same work is /api/v1/work-items and /api/v1/calendar.",
        }),
        403,
      );
    }
    const { asOf } = c.req.valid("query");
    const home = await deps.service.home(s.tenantId, s.userId, asOf);
    // Field by field, never the domain object: zod-openapi documents a response
    // without validating it, so a forwarded object ships fields the generated
    // client cannot see — and on THIS surface an accidental field is one that
    // reached somebody outside the firm.
    return c.json(
      {
        companies: home.companies.map((x) => ({
          clientPartyId: x.clientPartyId,
          clientName: x.clientName,
        })),
        inProgress: home.inProgress.map(toWorkWire),
        heldUp: home.heldUp.map(toWorkWire),
        upcomingFilings: home.upcomingFilings.map(toFilingWire),
        recentlyFiled: home.recentlyFiled.map(toFilingWire),
        asOf: home.asOf,
      },
      200,
    );
  });
}

function toWorkWire(r: {
  workItemId: string;
  title: string;
  companyName: string | null;
  stateName: string;
  isHeldUp: boolean;
  openedOn: string;
  statutoryDueOn: string | null;
  heldUpSince: string | null;
  heldUpReason: string | null;
  hasOpenAsk: boolean;
}): z.infer<typeof WorkSchema> {
  return {
    workItemId: r.workItemId,
    title: r.title,
    companyName: r.companyName,
    stateName: r.stateName,
    isHeldUp: r.isHeldUp,
    openedOn: r.openedOn,
    statutoryDueOn: r.statutoryDueOn,
    heldUpSince: r.heldUpSince,
    heldUpReason: r.heldUpReason,
    hasOpenAsk: r.hasOpenAsk,
  };
}

function toFilingWire(r: {
  obligationId: string;
  name: string;
  companyName: string;
  periodLabel: string;
  statutoryDueOn: string;
  stateName: string;
  filedOn: string | null;
  lastNudgedAt: string | null;
}): z.infer<typeof FilingSchema> {
  return {
    obligationId: r.obligationId,
    name: r.name,
    companyName: r.companyName,
    periodLabel: r.periodLabel,
    statutoryDueOn: r.statutoryDueOn,
    stateName: r.stateName,
    filedOn: r.filedOn,
    lastNudgedAt: r.lastNudgedAt,
  };
}
