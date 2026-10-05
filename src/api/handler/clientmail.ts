// The firm's client-mail setting over HTTP (Q059, 0350) — transport only.
// Reading and writing are both `tenant:admin`: which addresses the firm's mail
// may claim to come from is an administrator's decision, made once its mail
// provider is set up.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { ClientMailService } from "../../usecase/clientmail/service";
import { scopeOf } from "../scope";

export interface ClientMailDeps {
  readonly service: ClientMailService;
}

const MailSendersSchema = z
  .object({
    sendFromDomains: z.array(z.string()).openapi({
      description:
        "Mail domains the relay may send FROM (lower case, e.g. 10xglobal.in). A client email " +
        "whose SPOC's address is in one of them goes from that address; otherwise from the " +
        "deployment's sender, with the SPOC's name and Reply-To the SPOC. Empty by default: list " +
        "a domain only once its SPF and DKIM authorise the relay.",
    }),
  })
  .openapi("MailSenders");

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/mail-senders",
  tags: ["tenancy"],
  summary: "The domains this firm's client emails may be sent from",
  responses: {
    200: { description: "The list", content: { "application/json": { schema: MailSendersSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/mail-senders",
  tags: ["tenancy"],
  summary: "Replace the domains this firm's client emails may be sent from",
  description:
    "The whole list, each domain trimmed and lower-cased; an empty list sends every client " +
    "email from the deployment's sender. Ledger `tenant.send_domains_set`.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ sendFromDomains: z.array(z.string().max(253)).max(50) })
            .openapi("SetMailSenders"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: MailSendersSchema } } },
    400: errorResponse("A domain that is not one, an email address, or more than twenty"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

export function registerClientMailRoutes(app: OpenAPIHono<AppEnv>, deps: ClientMailDeps): void {
  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json({ sendFromDomains: [...(await deps.service.sendFromDomains(s.tenantId))] }, 200);
  });

  app.openapi(putRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const saved = await deps.service.setSendFromDomains(s.tenantId, body.sendFromDomains, s.actor);
    return c.json({ sendFromDomains: [...saved] }, 200);
  });
}
