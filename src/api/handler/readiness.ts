// Setup readiness over HTTP (V2.6) — transport only. One read, `tenant:admin`,
// mapped field by field.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { READINESS_KEYS } from "../../domain/readiness/model";
import type { ReadinessService } from "../../usecase/readiness/service";
import { scopeOf } from "../scope";

export interface ReadinessDeps {
  readonly service: ReadinessService;
}

const GapSchema = z
  .object({
    id: z.string().nullable().openapi({
      description:
        "The subject: a client's party id (account_team, portal_contacts), a person's user id " +
        "(reporting_lines) or a rule's id (compliance_rules). Null for a gap that is the firm's own.",
    }),
    ref: z.string().nullable().openapi({
      description: "A key to link with: the service's catalogue key on `processes`. Null elsewhere.",
    }),
    name: z.string().openapi({ description: "The subject's name as the firm wrote it; empty for the firm's own gap." }),
    missing: z.array(z.string()).openapi({
      description:
        "What is missing, as a closed vocabulary per line: deadlines go_live_floor | " +
        "fiscal_year_start; reporting_lines manager; request_routing routing; processes process " +
        "| published_process; compliance_rules confirmed_linked_rule | confirmed; ladders " +
        "escalation | chaser | nudge; account_team key_manager | spoc:<Dept code>; " +
        "portal_contacts portal_login. The screen words them.",
    }),
  })
  .openapi("ReadinessGap");

const LineSchema = z
  .object({
    key: z.enum(READINESS_KEYS),
    done: z.boolean(),
    gaps: z.array(GapSchema),
    context: z.array(z.string()).openapi({
      description:
        "Why the line applies: on reporting_lines, the labels of the published check rules that " +
        "read reporting lines alone. Empty elsewhere, and empty there when no rule reads them.",
    }),
  })
  .openapi("ReadinessLine");

const ReadinessResponse = z
  .object({
    asOf: z.string().openapi({ description: "The firm's calendar day the lines were computed on." }),
    lines: z.array(LineSchema).openapi({
      description:
        "The eight lines in the order a firm sets itself up. Computed on every read and never " +
        "stored, so fixing a gap turns its line done on the next one. A ladder line asks that a " +
        "ladder is PUBLISHED, never which days are on it: the firm has not given its numbers (D3).",
    }),
  })
  .openapi("ReadinessResponse");

const readinessRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/readiness",
  tags: ["tenancy"],
  summary: "Is this firm set up well enough to run its work?",
  description:
    "Eight lines: go-live floor and financial year, reporting lines where a check rule reads " +
    "them, client-request routing, a published process for every service, confirmed and linked " +
    "compliance rules, the three ladders published, every active client's Key Manager and SPOCs, " +
    "and a portal login per active client. Each lists what is missing, by name.",
  responses: {
    200: { description: "The lines", content: { "application/json": { schema: ReadinessResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

export function registerReadinessRoutes(app: OpenAPIHono<AppEnv>, deps: ReadinessDeps): void {
  app.openapi(readinessRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const r = await deps.service.readiness(s.tenantId);
    return c.json(
      {
        asOf: r.asOf,
        lines: r.lines.map((l) => ({
          key: l.key,
          done: l.done,
          gaps: l.gaps.map((g) => ({ id: g.id, ref: g.ref, name: g.name, missing: [...g.missing] })),
          context: [...l.context],
        })),
      },
      200,
    );
  });
}
