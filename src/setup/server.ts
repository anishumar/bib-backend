// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Config } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import type { Logger } from "../platform/log";
import type { Principal } from "../platform/callctx";
import { PostgresTenantRepository } from "../infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { TenancyService } from "../usecase/tenancy/service";
import type { PrincipalResolver, TenancyDeps } from "../api/handler/tenancy";
import { buildRouter } from "../api/router";

export interface Wired {
  readonly app: OpenAPIHono;
  readonly pools: Pools;
  /** Fail-closed readiness: throws if the tenant wall is not intact. */
  assertReady(): Promise<void>;
}

export function wire(cfg: Config, log: Logger): Wired {
  const pools = createPools(cfg.db);

  const tenancy = new TenancyService({
    tenants: new PostgresTenantRepository(pools.app),
    users: new PostgresUserRepository(pools.app),
    memberships: new PostgresMembershipRepository(pools.app),
    ids: systemIds,
  });

  // HONEST REGISTRY: this is the ONLY principal resolver registered today — a
  // dev adapter that trusts an x-user-id header. It is safe locally and must
  // never be the resolver in a production-like environment. The real session /
  // SSO adapter (ADR-03) is implemented as a port here and plugged in when a
  // deal requires it; until then it is deliberately unregistered.
  const devPrincipal: PrincipalResolver = (getHeader): Principal | null => {
    const userId = getHeader("x-user-id");
    return userId ? { userId } : null;
  };

  const deps: TenancyDeps = { service: tenancy, principalOf: devPrincipal };

  return {
    app: buildRouter(deps, log, { docsEnabled: cfg.docsEnabled }),
    pools,
    assertReady: () => assertTenantWall(pools.app),
  };
}
