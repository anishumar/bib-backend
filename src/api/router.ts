// The service's public surface, composed in one place. A reviewer reads this to
// see every route the service exposes, how it is gated, and where the docs are:
//
//   /health, /ready                    ops, auth-free
//   /internal/v1/...                   service-to-service / platform (not app-facing)
//   /api/v1/tenancy/...                app-facing (user principal)
//   /openapi.json, /docs               generated spec + Swagger UI (gated)
//
// Per-module routes live in their handler module's registrar (registerTenancy…)
// and are mounted here; ops, error mapping and docs are cross-cutting and stay.
import { swaggerUI } from "@hono/swagger-ui";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Logger } from "../platform/log";
import { createOpenAPIApp } from "./openapi";
import { registerTenancyRoutes } from "./handler/tenancy";
import type { TenancyDeps } from "./handler/tenancy";
import { registerPartyRoutes } from "./handler/party";
import type { PartyDeps } from "./handler/party";
import { registerLedgerRoutes } from "./handler/ledger";
import type { LedgerDeps } from "./handler/ledger";
import { mapError } from "./domainerr";
import { toEnvelope } from "./httpresp";

export interface RouterOptions {
  /** Serve /openapi.json and /docs. Off in production-like environments unless
   *  BIB_DOCS_ENABLED is set — the spec enumerates every endpoint. */
  readonly docsEnabled: boolean;
}

/** Per-module dependencies the router mounts. One field per capability. */
export interface RouterDeps {
  readonly tenancy: TenancyDeps;
  readonly party: PartyDeps;
  readonly ledger: LedgerDeps;
}

export function buildRouter(deps: RouterDeps, log: Logger, opts: RouterOptions): OpenAPIHono {
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

  // Ops — always auth-free.
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", (c) => c.json({ status: "ready" }));

  // App + platform routes, one registrar per module.
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
