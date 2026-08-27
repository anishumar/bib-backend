// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Config } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import type { Logger } from "../platform/log";
import type { Principal } from "../platform/callctx";
import { PostgresTenantRepository } from "../infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { PostgresPartyRepository } from "../infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import { TenancyService } from "../usecase/tenancy/service";
import { PartyService } from "../usecase/party/service";
import { LedgerService } from "../usecase/ledger/service";
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

  const tenancyDeps: TenancyDeps = { service: tenancy, principalOf: devPrincipal };

  // The ledger is constructed BEFORE the services that will write to it: every
  // module that records events receives this one instance through its own
  // EventSink port, so there is exactly one implementation of the event
  // contract in the process and no service can reach the table around it.
  const ledger = new LedgerService({
    events: new PostgresEventStore(pools.app),
    ids: systemIds,
  });

  const party = new PartyService({
    parties: new PostgresPartyRepository(pools.app),
    identifiers: new PostgresIdentifierRepository(pools.app),
    relationships: new PostgresRelationshipRepository(pools.app),
    ids: systemIds,
  });

  return {
    app: buildRouter(
      { tenancy: tenancyDeps, party: { service: party }, ledger: { service: ledger } },
      log,
      { docsEnabled: cfg.docsEnabled },
    ),
    pools,
    assertReady: async () => {
      await assertTenantWall(pools.app);
      await assertLedgerAppendOnly(pools.app);
    },
  };
}
