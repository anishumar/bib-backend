// The service's public surface, composed in one place. A reviewer reads this to
// see every route the service exposes, how it is gated, and where the docs are:
//
//   /health, /ready                    ops, auth-free
//   /api/v1/auth/...                   sign in / prove / switch org / sign out
//   /internal/v1/...                   service-to-service / platform (not app-facing)
//   /api/v1/tenancy/...                app-facing (user principal)
//   /api/v1/config/...                 the firm's own services and roles (T2.5)
//   /api/v1/leads/...                  the commercial pipeline (T2.1)
//   /api/v1/work-items/...             the board — what is owed and whose (T3.1)
//   /api/v1/escalations                what the firm's own ladder has escalated (T4.5)
//   /api/v1/work-vocabulary/...        the firm's own states and priorities (T3.1)
//   /api/v1/firm-entities/...          which of the firm's own entities issues (G1.2)
//   /api/v1/invoices/...               invoicing, and the one gapless series (T3.4)
//   /api/v1/documents/...              the document store — bytes, versions, links (T3.6)
//   /api/v1/dashboard/...              MRR, ageing and DSO — behind the fee axis (T3.7)
//   /openapi.json, /docs               generated spec + Swagger UI (gated)
//
// Per-module routes live in their handler module's registrar (registerTenancy…)
// and are mounted here; ops, error mapping and docs are cross-cutting and stay.
import { swaggerUI } from "@hono/swagger-ui";
import { createRoute } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./guards";
import { internalGuard, permissionGuard, sessionGuard } from "./guards";
import type { PrincipalResolver } from "./principal";
import type { AuthzService } from "../usecase/authz/service";
import type { RateLimiter } from "../platform/ratelimit";
import { rateLimit, sessionRateLimit } from "./ratelimit";
import type { RateLimitConfig } from "./ratelimit";
import { originGuard } from "./origin";
import { boundedStrings } from "./bounds";
import { PUBLIC_PATHS } from "./guards";
import type { InternalClient } from "./capabilities";
import type { Logger } from "../platform/log";
import { createOpenAPIApp, z } from "./openapi";
import { registerTenancyRoutes } from "./handler/tenancy";
import type { TenancyDeps } from "./handler/tenancy";
import { registerStaffGradeRoutes } from "./handler/staffgrade";
import type { StaffGradeDeps } from "./handler/staffgrade";
import { registerServiceAxisRoutes } from "./handler/serviceaxis";
import { registerObligationRoutes } from "./handler/obligation";
import type { ObligationDeps } from "./handler/obligation";
import { registerEscalationRoutes } from "./handler/escalation";
import type { EscalationDeps } from "./handler/escalation";
import type { ServiceAxisDeps } from "./handler/serviceaxis";
import { registerClientAssignmentRoutes } from "./handler/clientassignment";
import type { ClientAssignmentDeps } from "./handler/clientassignment";
import { registerClientImportRoutes } from "./handler/clientimport";
import type { ClientImportDeps } from "./handler/clientimport";
import { registerPortalAccessRoutes } from "./handler/portalaccess";
import type { PortalAccessDeps } from "./handler/portalaccess";
import { registerPortalInviteRoutes } from "./handler/portalinvite";
import type { PortalInviteDeps } from "./handler/portalinvite";
import { registerPortalHomeRoutes } from "./handler/portalhome";
import { registerClientAskRoutes } from "./handler/clientask";
import { registerClientRequestRoutes } from "./handler/clientrequest";
import { registerPortalAskRoutes } from "./handler/portalask";
import { registerPortalLibraryRoutes } from "./handler/portallibrary";
import { registerPortalRequestRoutes } from "./handler/portalrequest";
import { registerChaserRoutes } from "./handler/chaser";
import type { PortalHomeDeps } from "./handler/portalhome";
import type { ClientAskDeps } from "./handler/clientask";
import type { ClientRequestDeps } from "./handler/clientrequest";
import type { PortalAskDeps } from "./handler/portalask";
import type { PortalLibraryDeps } from "./handler/portallibrary";
import type { PortalRequestDeps } from "./handler/portalrequest";
import type { ChaserDeps } from "./handler/chaser";
import { registerWorkItemRoutes } from "./handler/workitem";
import type { WorkItemDeps } from "./handler/workitem";
import { registerOrchestratorRoutes } from "./handler/orchestrator";
import type { OrchestratorDeps } from "./handler/orchestrator";
import { registerSchedulerRoutes } from "./handler/scheduler";
import type { SchedulerDeps } from "./handler/scheduler";
import { registerPartyRoutes } from "./handler/party";
import type { PartyDeps } from "./handler/party";
import { registerLedgerRoutes } from "./handler/ledger";
import type { LedgerDeps } from "./handler/ledger";
import { registerConfigRoutes } from "./handler/config";
import type { ConfigDeps } from "./handler/config";
import { registerLeadRoutes } from "./handler/lead";
import { registerProposalRoutes } from "./handler/proposal";
import { registerEngagementRoutes } from "./handler/engagement";
import { registerDocumentRoutes } from "./handler/document";
import { registerInvoiceRoutes } from "./handler/invoice";
import { registerBillingRoutes } from "./handler/billing";
import type { BillingDeps } from "./handler/billing";
import { registerFileStoreRoutes } from "./handler/filestore";
import { registerDashboardRoutes } from "./handler/dashboard";
import type { DashboardDeps } from "./handler/dashboard";
import { registerReadinessRoutes } from "./handler/readiness";
import type { ReadinessDeps } from "./handler/readiness";
import type { FileStoreDeps } from "./handler/filestore";
import type { InvoiceDeps } from "./handler/invoice";
import type { LeadDeps } from "./handler/lead";
import type { ProposalDeps } from "./handler/proposal";
import type { EngagementDeps } from "./handler/engagement";
import type { DocumentDeps } from "./handler/document";
import { registerAuthRoutes } from "./handler/auth";
import type { AuthDeps } from "./handler/auth";
import { mapError } from "./domainerr";
import { toEnvelope } from "./httpresp";

/**
 * The largest JSON body this API will read, in bytes.
 *
 * 256 KB is roughly two orders of magnitude more than the biggest form in the
 * product and small enough that buffering one costs nothing. It is deliberately
 * not configurable: a body limit somebody can raise in an environment variable
 * is one that gets raised the first time a request is refused.
 */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/** What a multipart envelope costs on top of the file itself — boundaries, part
 *  headers and the other form fields. Generous; the point is that the SERVICE's
 *  check on the file's own bytes stays the one that decides. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * The routes that carry a file, as patterns over the CONCRETE path.
 *
 * Matched here rather than mounted per-path, because `app.use(path, …)`
 * registers an entry in Hono's route table and `tests/api/auth-coverage.test.ts`
 * reads that table to prove every route declares who may reach it. A body limit
 * is not a route and must not look like one.
 */
const UPLOAD_PATHS = [
  /^\/api\/v1\/documents$/,
  /^\/api\/v1\/documents\/[^/]+\/versions$/,
  /^\/api\/v1\/portal\/asks\/[^/]+\/documents$/,
  // The client import: three spreadsheets in one multipart body.
  /^\/api\/v1\/client-imports$/,
] as const;

function isUploadPath(path: string): boolean {
  return UPLOAD_PATHS.some((p) => p.test(path));
}

export interface RouterOptions {
  /** Serve /openapi.json and /docs. Off in production-like environments unless
   *  BIB_DOCS_ENABLED is set — the spec enumerates every endpoint. */
  readonly docsEnabled: boolean;
  /** The provisioning callers, each with its own key and capabilities. */
  readonly internalClients: readonly InternalClient[];
  /** How a request becomes a principal on the /api/v1 surface. */
  readonly principalOf: PrincipalResolver;
  readonly authz: AuthzService;
  readonly rateLimiter: RateLimiter;
  readonly rateLimit: RateLimitConfig;
  /** Exact browser origins allowed to send credentialed requests. */
  readonly corsOrigins: readonly string[];
  /**
   * The largest upload the store accepts, in bytes (BIB_MAX_UPLOAD_BYTES).
   *
   * The edge needs it because the SERVICE's check is too late: `parseBody()`
   * has already pulled the whole multipart body into memory by the time the
   * use case measures it. Passed in rather than imported so the one number
   * lives in config and both layers read the same value.
   */
  readonly maxUploadBytes: number;
  /** Whether to send Strict-Transport-Security. On in production-like only —
   *  the header pins a browser to https for the WHOLE host, which on localhost
   *  breaks every other service the developer runs. */
  readonly hstsEnabled: boolean;
  /** Which build this process is, for GET /health (V0.2). Nulls when the
   *  image was not stamped. */
  readonly build: { readonly commit: string | null; readonly builtAt: string | null };
}

/** Per-module dependencies the router mounts. One field per capability. */
export interface RouterDeps {
  readonly tenancy: TenancyDeps;
  readonly staffGrades: StaffGradeDeps;
  readonly serviceAxes: ServiceAxisDeps;
  readonly obligations: ObligationDeps;
  readonly escalations: EscalationDeps;
  readonly clientAssignments: ClientAssignmentDeps;
  readonly clientImports: ClientImportDeps;
  readonly portalAccess: PortalAccessDeps;
  readonly portalInvites: PortalInviteDeps;
  readonly portalHome: PortalHomeDeps;
  /** The firm's side of a client-directed ask, and the client's. Two handler
   *  sets over ONE service — the rules about an ask are the same whoever is
   *  looking, and only the scope the adapter opens differs. */
  readonly clientAsks: ClientAskDeps;
  readonly clientRequests: ClientRequestDeps;
  readonly portalAsks: PortalAskDeps;
  readonly portalLibrary: PortalLibraryDeps;
  readonly portalRequests: PortalRequestDeps;
  /** Stopping the chaser on one client (T4.4). The SWEEP has no route — it is a
   *  cron in the worker, and a "chase now" button would make the ledger's
   *  SYSTEM actor a lie on some rows and not others. */
  readonly chaser: ChaserDeps;
  readonly workItems: WorkItemDeps;
  readonly orchestrator: OrchestratorDeps;
  readonly scheduler: SchedulerDeps;
  readonly party: PartyDeps;
  readonly ledger: LedgerDeps;
  readonly config: ConfigDeps;
  readonly lead: LeadDeps;
  readonly proposal: ProposalDeps;
  readonly engagement: EngagementDeps;
  readonly document: DocumentDeps;
  readonly invoice: InvoiceDeps;
  readonly billing: BillingDeps;
  readonly filestore: FileStoreDeps;
  readonly dashboard: DashboardDeps;
  readonly readiness: ReadinessDeps;
  readonly auth: AuthDeps;
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["ops"],
  summary: "Is the process up, and which build is it",
  responses: {
    200: {
      description: "Up. `commit` and `builtAt` are null when the image was built without them.",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            commit: z.string().nullable().openapi({
              description: "The git commit the running image was built from.",
              example: "32fbca3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
            }),
            builtAt: z.string().nullable().openapi({
              description: "When the image was built, ISO-8601 UTC.",
              example: "2026-09-28T18:30:00Z",
            }),
          }),
        },
      },
    },
  },
});

export function buildRouter(
  deps: RouterDeps,
  log: Logger,
  opts: RouterOptions,
): OpenAPIHono<AppEnv> {
  const app = createOpenAPIApp();

  // One place maps every thrown error to the envelope — and logs the ones that
  // are unexpected (INTERNAL), so a 500 is never silent. A gRPC edge would have
  // its own version of this and nothing inward would change.
  app.onError((err, c) => {
    const m = mapError(err);
    if (m.code === "INTERNAL") {
      log.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
    }
    return c.json(toEnvelope(m), m.status);
  });

  // An unknown path, in the SAME envelope as every other refusal.
  //
  // Hono's own 404 is `text/plain` with no CORS headers, so a browser client
  // could not read it and a typed client could not parse it — the one response
  // in the product that did not look like the product. Registered here rather
  // than per-module because nobody owns a path that does not exist.
  app.notFound((c) =>
    c.json(
      toEnvelope({ status: 404, code: "NOT_FOUND", message: "no such endpoint" }),
      404,
    ),
  );

  // SECURITY HEADERS on every response, ops routes included.
  //
  // This is a JSON API and never a rendered page, so most of what a browser
  // could be told is irrelevant — except for two things it genuinely does with
  // these bytes. `nosniff` matters because document downloads echo an
  // uploader-supplied media type, and without it a browser may sniff an
  // uploaded file into script. `frame-ancestors 'none'` and X-Frame-Options
  // matter because /docs is a real page. The referrer policy keeps a token
  // that rode in a URL from travelling on in a Referer header.
  //
  // HSTS is set only in production-like: a Strict-Transport-Security header on
  // http://localhost pins the developer's browser to https for the whole host
  // and breaks every other local service on it.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Swagger UI, when it is served, loads its bundle and styles from
        // jsDelivr and runs an inline bootstrap — that is what @hono/swagger-ui
        // renders, and naming the host it actually uses is the difference
        // between a policy and a blank page. Everything here is behind
        // `docsEnabled`, which is off in every production-like environment, so
        // the policy a public deployment sends is the strict one below.
        scriptSrc: opts.docsEnabled
          ? ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"]
          : ["'none'"],
        styleSrc: opts.docsEnabled
          ? ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"]
          : ["'none'"],
        imgSrc: opts.docsEnabled ? ["'self'", "data:", "https://cdn.jsdelivr.net"] : ["'none'"],
        connectSrc: opts.docsEnabled ? ["'self'"] : ["'none'"],
      },
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
      strictTransportSecurity: opts.hstsEnabled
        ? "max-age=31536000; includeSubDomains"
        : false,
      // The default sends `require-corp`, which would refuse the cross-origin
      // fetches this whole API exists to answer.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: "cross-origin",
    }),
  );

  // Ops — always auth-free. Deliberately mounted BEFORE the guards: a load
  // balancer cannot hold a credential, and neither endpoint reveals anything
  // beyond which commit is running.
  //
  // /health SAYS WHICH BUILD IS LIVE (V0.2): the commit and the build time the
  // image was stamped with, or null for an unstamped one. Nobody could tell
  // which build QA ran, or whether a migration had gone out, without asking the
  // person who deployed it. It is in the OpenAPI spec, unlike /ready, because a
  // staff screen reads it through the generated client; and it gets its own
  // CORS for that reason, with the product surface's exact origin list.
  app.use("/health", cors({ origin: [...opts.corsOrigins], credentials: true }));
  app.openapi(healthRoute, (c) =>
    c.json({ status: "ok" as const, commit: opts.build.commit, builtAt: opts.build.builtAt }, 200),
  );
  app.get("/ready", (c) => c.json({ status: "ready" }));

  // CORS, first of all, and only on the product surface.
  //
  // The frontend is a separate app on a separate origin, so without this a
  // browser discards every response before the page sees it — T1.8's whole
  // acceptance ("calls a real endpoint through the generated client") is
  // unreachable until these headers exist.
  //
  // Mounted ahead of the rate limiter on purpose: a browser sends a preflight
  // OPTIONS before each credentialed request, and cors() answers it and stops.
  // Behind the limiter, every login would cost TWO of the ten attempts a minute
  // and the tight auth bucket would bite at five real sign-ins.
  //
  // Exact origins only, never a reflection of whatever Origin arrived. With
  // credentials: true, reflecting the origin lets any site on the internet make
  // authenticated requests with the user's cookie and read the replies.
  //
  // /internal gets NO CORS, deliberately: it is service-to-service and no
  // browser should reach it. Its preflight 404s, which is the correct answer.
  app.use(
    "/api/v1/*",
    cors({
      origin: [...opts.corsOrigins],
      credentials: true,
      // EVERY method any registered route actually uses. A method missing here
      // is the worst kind of failure: the browser discards the response before
      // either app sees it, with no server log and no error the API could have
      // returned — so it looks like the endpoint is broken rather than like a
      // header is short.
      //
      // PATCH was missing until T3.1 added the first routes that use it, and it
      // was found by clicking a checkbox on a screen, not by any test.
      // `tests/api/cors-methods.test.ts` now reads the registered routes and
      // fails if this list falls behind them again.
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      // Readable by the workspace, which waits this long before asking again
      // when the API is busy (429) instead of treating it as signed out (F15).
      exposeHeaders: ["Retry-After"],
      maxAge: 600,
    }),
  );

  // BODY LIMITS, before anything reads a body.
  //
  // Hono has no default: without this every route buffers whatever arrives, and
  // an unauthenticated caller could hand the login route thirty megabytes and
  // have the server scrypt-hash all of it. Mounted ahead of the guards for the
  // same reason the rate limiter is — the cost of a huge body is paid on the
  // way IN, before anything knows who is calling.
  //
  // Two sizes, because the product has two kinds of request. Everything that
  // carries JSON is a form somebody filled in and fits in a fraction of a
  // megabyte; the three multipart routes carry a scanned PDF and are the reason
  // BIB_MAX_UPLOAD_BYTES exists. The upload limit is the CONFIGURED one plus a
  // small allowance for the multipart envelope, so the edge refuses a file that
  // is genuinely over budget and never one the service would have accepted.
  // Typed to THIS app's env. `bodyLimit` is declared over an untyped one, and
  // handing it a typed context without saying so is an unsafe-argument error.
  const uploadLimit: MiddlewareHandler<AppEnv> = bodyLimit({
    maxSize: opts.maxUploadBytes + MULTIPART_OVERHEAD_BYTES,
    onError: (c) =>
      c.json(
        toEnvelope({
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: `the upload is larger than the ${String(opts.maxUploadBytes)} bytes this store accepts`,
        }),
        413,
      ),
  });
  const jsonLimit: MiddlewareHandler<AppEnv> = bodyLimit({
    maxSize: MAX_JSON_BODY_BYTES,
    onError: (c) =>
      c.json(
        toEnvelope({
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: `request body is larger than the ${String(MAX_JSON_BODY_BYTES)} bytes this API accepts`,
        }),
        413,
      ),
  });
  // Named and annotated rather than inline: an inline handler is inferred from
  // `app.use`'s overload with an untyped Input, and handing THAT context to
  // another middleware is an unsafe argument. One annotation settles both.
  const limitBody: MiddlewareHandler<AppEnv> = async (c, next) =>
    isUploadPath(c.req.path) ? uploadLimit(c, next) : jsonLimit(c, next);
  app.use("*", limitBody);

  // And a ceiling on any ONE string inside a body that is itself within the
  // limit. See bounds.ts: the body limit stops a caller sending a megabyte, this
  // stops them spending the whole allowance on a single stored field.
  app.use("*", boundedStrings());

  // CSRF, the half that does not depend on the cookie's SameSite. See origin.ts.
  // Only on the product surface: /internal is service-to-service and no browser
  // reaches it, so it has no origin to check.
  app.use("/api/v1/*", originGuard(opts.corsOrigins));

  // RATE LIMITING, before anything else that costs something. It runs ahead of
  // the guards so an unauthenticated flood is refused at the cheapest possible
  // point — on the login route in particular, reaching the handler means
  // spending ~32 MB and ~50 ms of scrypt on a caller who has proved nothing.
  //
  // The tight bucket covers exactly the routes that are reachable without
  // credentials, which is the same list the session guard exempts. Deriving it
  // from PUBLIC_PATHS rather than restating it means the two cannot drift.
  app.use("*", rateLimit(opts.rateLimiter, opts.rateLimit, PUBLIC_PATHS));

  // AUTHENTICATION, BY PREFIX. These two lines cover every route below them —
  // including routes nobody has written yet, which is the point. A per-handler
  // check is a thing a new file can forget; a prefix guard is not.
  //
  // They run before request validation, so an unauthenticated call gets 401
  // rather than a 400 that tells an anonymous caller about the request shape.
  app.use("/internal/*", internalGuard(opts.internalClients));
  app.use("/api/v1/*", sessionGuard(opts.principalOf));
  // The general budget for a SIGNED-IN request is the session's, not the
  // office's address (audit 2026-10-03, B28). Straight after the guard, so the
  // principal it counts against is the one the guard just resolved.
  app.use("/api/v1/*", sessionRateLimit(opts.rateLimiter, opts.rateLimit));
  // Gate 3 rides behind the session guard: by here the caller is authenticated
  // and their audience is settled, so the only question left is whether their
  // ROLE carries what this route needs.
  app.use("/api/v1/*", permissionGuard(opts.authz));

  // App + platform routes, one registrar per module.
  registerAuthRoutes(app, deps.auth);
  registerTenancyRoutes(app, deps.tenancy);
  registerStaffGradeRoutes(app, deps.staffGrades);
  registerServiceAxisRoutes(app, deps.serviceAxes);
  registerObligationRoutes(app, deps.obligations);
  registerEscalationRoutes(app, deps.escalations);
  registerClientAssignmentRoutes(app, deps.clientAssignments);
  registerClientImportRoutes(app, deps.clientImports);
  registerPortalAccessRoutes(app, deps.portalAccess);
  registerPortalInviteRoutes(app, deps.portalInvites);
  registerPortalHomeRoutes(app, deps.portalHome);
  registerClientAskRoutes(app, deps.clientAsks);
  registerClientRequestRoutes(app, deps.clientRequests);
  registerPortalAskRoutes(app, deps.portalAsks);
  registerPortalLibraryRoutes(app, deps.portalLibrary);
  registerPortalRequestRoutes(app, deps.portalRequests);
  registerChaserRoutes(app, deps.chaser);
  registerWorkItemRoutes(app, deps.workItems);
  registerOrchestratorRoutes(app, deps.orchestrator);
  registerSchedulerRoutes(app, deps.scheduler);
  registerPartyRoutes(app, deps.party);
  registerLedgerRoutes(app, deps.ledger);
  registerConfigRoutes(app, deps.config);
  registerLeadRoutes(app, deps.lead);
  registerProposalRoutes(app, deps.proposal);
  registerEngagementRoutes(app, deps.engagement);
  registerDocumentRoutes(app, deps.document);
  registerInvoiceRoutes(app, deps.invoice);
  registerBillingRoutes(app, deps.billing);
  registerFileStoreRoutes(app, deps.filestore);
  registerDashboardRoutes(app, deps.dashboard);
  registerReadinessRoutes(app, deps.readiness);

  // Docs are generated FROM the routes above, so this must come after them.
  if (opts.docsEnabled) {
    app.doc("/openapi.json", {
      openapi: "3.0.0",
      info: { title: "BiB Backend API", version: "0.1.0" },
    });
    app.get("/docs", swaggerUI({ url: "/openapi.json" }));
    log.info("API docs served at /docs (spec at /openapi.json)");
  }

  return app;
}
