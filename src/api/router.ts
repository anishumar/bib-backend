// The service's public surface, composed in one place. A reviewer reads this to
// see every route the service exposes, how it is gated, and where the docs are:
//
//   /health, /ready                    ops, auth-free
//   /api/v1/auth/...                   sign in / prove / switch org / sign out
//   /internal/v1/...                   service-to-service / platform (not app-facing)
//   /api/v1/tenancy/...                app-facing (user principal)
//   /openapi.json, /docs               generated spec + Swagger UI (gated)
//
// Per-module routes live in their handler module's registrar (registerTenancy…)
// and are mounted here; ops, error mapping and docs are cross-cutting and stay.
import { swaggerUI } from "@hono/swagger-ui";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "./guards";
import { internalGuard, sessionGuard } from "./guards";
import type { PrincipalResolver } from "./principal";
import type { RateLimiter } from "../platform/ratelimit";
import { rateLimit } from "./ratelimit";
import type { RateLimitConfig } from "./ratelimit";
import { PUBLIC_PATHS } from "./guards";
import type { Logger } from "../platform/log";
import { createOpenAPIApp } from "./openapi";
import { registerTenancyRoutes } from "./handler/tenancy";
import type { TenancyDeps } from "./handler/tenancy";
import { registerPartyRoutes } from "./handler/party";
import type { PartyDeps } from "./handler/party";
import { registerLedgerRoutes } from "./handler/ledger";
import type { LedgerDeps } from "./handler/ledger";
import { registerAuthRoutes } from "./handler/auth";
import type { AuthDeps } from "./handler/auth";
import { mapError } from "./domainerr";
import { toEnvelope } from "./httpresp";

export interface RouterOptions {
  /** Serve /openapi.json and /docs. Off in production-like environments unless
   *  BIB_DOCS_ENABLED is set — the spec enumerates every endpoint. */
  readonly docsEnabled: boolean;
  /** The shared secret every /internal route requires. */
  readonly internalApiKey: string;
  /** How a request becomes a principal on the /api/v1 surface. */
  readonly principalOf: PrincipalResolver;
  readonly rateLimiter: RateLimiter;
  readonly rateLimit: RateLimitConfig;
}

/** Per-module dependencies the router mounts. One field per capability. */
export interface RouterDeps {
  readonly tenancy: TenancyDeps;
  readonly party: PartyDeps;
  readonly ledger: LedgerDeps;
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
  app.use("/internal/*", internalGuard(opts.internalApiKey));
  app.use("/api/v1/*", sessionGuard(opts.principalOf));

  // App + platform routes, one registrar per module.
  registerAuthRoutes(app, deps.auth);
  registerTenancyRoutes(app, deps.tenancy);
  registerPartyRoutes(app, deps.party);
  registerLedgerRoutes(app, deps.ledger);

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
