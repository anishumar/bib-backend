// Every route the service exposes, and how it is gated. Prefixes: /health, /ready (ops,
// auth-free); /api/v1/... (app, session); /internal/v1/... (S2S); /openapi.json, /docs (gated).
// Module routes come from each handler's registrar; ops, error mapping and docs stay here.
// Origin tasks: config T2.5, leads T2.1, work-items/work-vocabulary T3.1, escalations T4.5,
// firm-entities G1.2, invoices T3.4, documents T3.6, dashboard T3.7 (behind the fee axis).
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
import { registerNotificationRoutes } from "./handler/notification";
import type { NotificationDeps } from "./handler/notification";
import type { BillingDeps } from "./handler/billing";
import { registerFileStoreRoutes } from "./handler/filestore";
import { registerDashboardRoutes } from "./handler/dashboard";
import type { DashboardDeps } from "./handler/dashboard";
import { registerReadinessRoutes } from "./handler/readiness";
import { registerClientMailRoutes } from "./handler/clientmail";
import type { ClientMailDeps } from "./handler/clientmail";
import { registerFxRoutes } from "./handler/fx";
import type { FxDeps } from "./handler/fx";
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

/** Largest JSON body, in bytes. Deliberately not configurable: an env-var limit gets raised
 *  the first time a request is refused. */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Allowance for the multipart envelope; the SERVICE's check on the file's bytes decides. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * The routes that carry a file, matched on the concrete path. Not mounted per path:
 * `app.use(path, …)` adds a route-table entry, and `tests/api/auth-coverage.test.ts` reads
 * that table, so a body limit must not look like a route.
 */
const UPLOAD_PATHS = [
  /^\/api\/v1\/documents$/,
  /^\/api\/v1\/documents\/[^/]+\/versions$/,
  /^\/api\/v1\/portal\/asks\/[^/]+\/documents$/,
  // Client import: three spreadsheets in one multipart body.
  /^\/api\/v1\/client-imports$/,
] as const;

function isUploadPath(path: string): boolean {
  return UPLOAD_PATHS.some((p) => p.test(path));
}

export interface RouterOptions {
  /** Serve /openapi.json and /docs. Off in production-like unless BIB_DOCS_ENABLED: the spec
   *  enumerates every endpoint. */
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
  /** BIB_MAX_UPLOAD_BYTES. The edge needs it: by the time the service measures,
   *  `parseBody()` has already buffered the whole multipart body. */
  readonly maxUploadBytes: number;
  /** Send HSTS. Production-like only: on localhost it pins the whole host to https. */
  readonly hstsEnabled: boolean;
  /** This build, for GET /health (V0.2). Nulls when the image was not stamped. */
  readonly build: { readonly commit: string | null; readonly builtAt: string | null };
}

/** Per-module dependencies the router mounts. */
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
  /** Firm and portal handlers share ONE ask service; only the adapter's scope differs. */
  readonly clientAsks: ClientAskDeps;
  readonly clientRequests: ClientRequestDeps;
  readonly portalAsks: PortalAskDeps;
  readonly portalLibrary: PortalLibraryDeps;
  readonly portalRequests: PortalRequestDeps;
  /** Stopping the chaser on one client (T4.4). The sweep has no route: it is a worker cron,
   *  and a "chase now" button would make the ledger's SYSTEM actor untrue on some rows. */
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
  readonly notifications: NotificationDeps;
  readonly filestore: FileStoreDeps;
  readonly dashboard: DashboardDeps;
  readonly readiness: ReadinessDeps;
  readonly clientMail: ClientMailDeps;
  /** The day's exchange rate, as a suggestion (0345). */
  readonly fx: FxDeps;
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

  // Every thrown error maps to the envelope here; INTERNAL is logged so a 500 is never silent.
  app.onError((err, c) => {
    const m = mapError(err);
    if (m.code === "INTERNAL") {
      log.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
    }
    return c.json(toEnvelope(m), m.status);
  });

  // Unknown path, in the same envelope: Hono's own 404 is text/plain with no CORS headers.
  app.notFound((c) =>
    c.json(
      toEnvelope({ status: 404, code: "NOT_FOUND", message: "no such endpoint" }),
      404,
    ),
  );

  // Security headers on every response. `nosniff`: downloads echo an uploader-supplied media
  // type. frame-ancestors/X-Frame-Options: /docs is a real page. no-referrer: a token in a URL
  // must not travel on. HSTS only in production-like (see hstsEnabled).
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Swagger UI loads from jsDelivr with an inline bootstrap. Only when docsEnabled,
        // which is off in production-like, so a public deployment sends the strict policy.
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
      // The default `require-corp` would refuse the cross-origin fetches this API serves.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: "cross-origin",
    }),
  );

  // Ops, auth-free and before the guards: a load balancer holds no credential. /health names
  // the live build (V0.2) and, unlike /ready, is in the spec with its own CORS because a staff
  // screen reads it through the generated client.
  app.use("/health", cors({ origin: [...opts.corsOrigins], credentials: true }));
  app.openapi(healthRoute, (c) =>
    c.json({ status: "ok" as const, commit: opts.build.commit, builtAt: opts.build.builtAt }, 200),
  );
  app.get("/ready", (c) => c.json({ status: "ready" }));

  // CORS on the product surface only; the frontend is another origin (T1.8). Ahead of the rate
  // limiter: cors() answers the preflight, which would otherwise cost a second login attempt.
  // Exact origins, never reflected: with credentials, reflection lets any site read replies.
  // /internal gets none; its preflight 404s, which is correct.
  app.use(
    "/api/v1/*",
    cors({
      origin: [...opts.corsOrigins],
      credentials: true,
      // Every method a registered route uses: a missing one fails silently in the browser.
      // `tests/api/cors-methods.test.ts` fails if this falls behind the routes.
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      // The workspace waits this long on a 429 instead of treating it as signed out (F15).
      exposeHeaders: ["Retry-After"],
      maxAge: 600,
    }),
  );

  // Body limits before anything reads a body or knows the caller: Hono has none by default, so
  // an anonymous caller could make login scrypt-hash 30 MB. JSON forms get MAX_JSON_BODY_BYTES;
  // upload routes get the configured limit plus the envelope, so the edge never refuses a file
  // the service would accept. Typed to AppEnv: `bodyLimit` is declared over an untyped env.
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
  // Annotated, not inline: an inline handler infers an untyped Input (unsafe-argument).
  const limitBody: MiddlewareHandler<AppEnv> = async (c, next) =>
    isUploadPath(c.req.path) ? uploadLimit(c, next) : jsonLimit(c, next);
  app.use("*", limitBody);

  // A ceiling on any ONE string inside an in-limit body (see bounds.ts).
  app.use("*", boundedStrings());

  // CSRF, the half that does not rely on SameSite (see origin.ts). /internal has no browser.
  app.use("/api/v1/*", originGuard(opts.corsOrigins));

  // Rate limiting ahead of the guards: reaching login costs ~32 MB and ~50 ms of scrypt. The
  // tight bucket is derived from PUBLIC_PATHS, the session guard's exemptions, so they agree.
  app.use("*", rateLimit(opts.rateLimiter, opts.rateLimit, PUBLIC_PATHS));

  // Authentication by prefix, so a route nobody has written yet is covered too. Before
  // validation: an anonymous call gets 401, not a 400 that reveals the request shape.
  app.use("/internal/*", internalGuard(opts.internalClients));
  app.use("/api/v1/*", sessionGuard(opts.principalOf));
  // A signed-in request's budget is per session, not per office IP (audit 2026-10-03, B28).
  app.use("/api/v1/*", sessionRateLimit(opts.rateLimiter, opts.rateLimit));
  // Gate 3 (role), once the caller and audience are settled.
  app.use("/api/v1/*", permissionGuard(opts.authz));

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
  registerNotificationRoutes(app, deps.notifications);
  registerFileStoreRoutes(app, deps.filestore);
  registerDashboardRoutes(app, deps.dashboard);
  registerReadinessRoutes(app, deps.readiness);
  registerClientMailRoutes(app, deps.clientMail);
  registerFxRoutes(app, deps.fx);

  // Docs are generated from the routes above, so this comes after them.
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
