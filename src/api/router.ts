// The service's public surface, composed in one place. A reviewer reads this to
// see every route the service exposes, how it is gated, and where the docs are:
//
//   /health, /ready                    ops, auth-free
//   /api/v1/auth/...                   sign in / prove / switch org / sign out
//   /internal/v1/...                   service-to-service / platform (not app-facing)
//   /api/v1/tenancy/...                app-facing (user principal)
//   /api/v1/config/...                 the firm's own services and roles (T2.5)
//   /api/v1/leads/...                  the commercial pipeline (T2.1)
//   /api/v1/firm-entities/...          which of the firm's own entities issues (G1.2)
//   /api/v1/invoices/...               invoicing, and the one gapless series (T3.4)
//   /api/v1/documents/...              the document store — bytes, versions, links (T3.6)
//   /openapi.json, /docs               generated spec + Swagger UI (gated)
//
// Per-module routes live in their handler module's registrar (registerTenancy…)
// and are mounted here; ops, error mapping and docs are cross-cutting and stay.
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "./guards";
import { internalGuard, permissionGuard, sessionGuard } from "./guards";
import type { PrincipalResolver } from "./principal";
import type { AuthzService } from "../usecase/authz/service";
import type { RateLimiter } from "../platform/ratelimit";
import { rateLimit } from "./ratelimit";
import type { RateLimitConfig } from "./ratelimit";
import { PUBLIC_PATHS } from "./guards";
import type { InternalClient } from "./capabilities";
import type { Logger } from "../platform/log";
import { createOpenAPIApp } from "./openapi";
import { registerTenancyRoutes } from "./handler/tenancy";
import type { TenancyDeps } from "./handler/tenancy";
import { registerStaffGradeRoutes } from "./handler/staffgrade";
import type { StaffGradeDeps } from "./handler/staffgrade";
import { registerServiceAxisRoutes } from "./handler/serviceaxis";
import type { ServiceAxisDeps } from "./handler/serviceaxis";
import { registerClientAssignmentRoutes } from "./handler/clientassignment";
import type { ClientAssignmentDeps } from "./handler/clientassignment";
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
import { registerFileStoreRoutes } from "./handler/filestore";
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
}

/** Per-module dependencies the router mounts. One field per capability. */
export interface RouterDeps {
  readonly tenancy: TenancyDeps;
  readonly staffGrades: StaffGradeDeps;
  readonly serviceAxes: ServiceAxisDeps;
  readonly clientAssignments: ClientAssignmentDeps;
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
  readonly filestore: FileStoreDeps;
  readonly auth: AuthDeps;
}

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

  // Ops — always auth-free. Deliberately mounted BEFORE the guards: a load
  // balancer cannot hold a credential, and neither endpoint reveals anything.
  app.get("/health", (c) => c.json({ status: "ok" }));
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
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

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
  // Gate 3 rides behind the session guard: by here the caller is authenticated
  // and their audience is settled, so the only question left is whether their
  // ROLE carries what this route needs.
  app.use("/api/v1/*", permissionGuard(opts.authz));

  // App + platform routes, one registrar per module.
  registerAuthRoutes(app, deps.auth);
  registerTenancyRoutes(app, deps.tenancy);
  registerStaffGradeRoutes(app, deps.staffGrades);
  registerServiceAxisRoutes(app, deps.serviceAxes);
  registerClientAssignmentRoutes(app, deps.clientAssignments);
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
  registerFileStoreRoutes(app, deps.filestore);

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
