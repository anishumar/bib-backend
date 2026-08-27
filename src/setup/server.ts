// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Config } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import { systemClock } from "../platform/clock";
import type { Logger } from "../platform/log";
import { PostgresTenantRepository } from "../infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { PostgresPartyRepository } from "../infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import {
  PostgresCredentialRepository,
  PostgresMagicLinkRepository,
  PostgresSessionRepository,
} from "../infrastructure/postgres/identity-repository";
import { ScryptPasswordHasher } from "../infrastructure/crypto/scrypt-hasher";
import { RandomTokenFactory } from "../infrastructure/crypto/random-tokens";
import { LoggingMailer } from "../infrastructure/mail/logging-mailer";
import { TenancyService } from "../usecase/tenancy/service";
import { PartyService } from "../usecase/party/service";
import { LedgerService } from "../usecase/ledger/service";
import { IdentityService } from "../usecase/identity/service";
import type { TenancyDeps } from "../api/handler/tenancy";
import { devHeaderResolver, firstOf, sessionResolver } from "../api/principal";
import { buildRouter } from "../api/router";

export interface Wired {
  readonly app: OpenAPIHono;
  readonly pools: Pools;
  /** Fail-closed readiness: throws if the tenant wall is not intact. */
  assertReady(): Promise<void>;
}

export function wire(cfg: Config, log: Logger): Wired {
  const pools = createPools(cfg.db);

  // The ledger is constructed BEFORE the services that will write to it: every
  // module that records events receives this one instance through its own
  // EventSink port, so there is exactly one implementation of the event
  // contract in the process and no service can reach the table around it.
  const ledger = new LedgerService({
    events: new PostgresEventStore(pools.app),
    ids: systemIds,
  });

  // The users and memberships repositories serve two use cases: tenancy
  // creates them, identity reads them. Identity states its needs as its own
  // narrow ports (UserDirectory / MembershipDirectory), which these satisfy —
  // so one adapter, two consumers, and neither use case knows about the other.
  const users = new PostgresUserRepository(pools.app);
  const memberships = new PostgresMembershipRepository(pools.app);

  const tenancy = new TenancyService({
    tenants: new PostgresTenantRepository(pools.app),
    users,
    memberships,
    ids: systemIds,
    events: ledger,
  });

  const identity = new IdentityService({
    users,
    memberships,
    credentials: new PostgresCredentialRepository(pools.app),
    sessions: new PostgresSessionRepository(pools.app),
    magicLinks: new PostgresMagicLinkRepository(pools.app),
    passwords: new ScryptPasswordHasher(),
    tokens: new RandomTokenFactory(),
    // HONEST REGISTRY: the only mailer registered writes the link to the log
    // instead of sending it. validateServer refuses to boot a production-like
    // environment with it — see config/validate.ts.
    mailer: new LoggingMailer(log),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
    magicLinkBaseUrl: cfg.auth.appBaseUrl,
  });

  // HONEST REGISTRY, the second half. The session resolver is the real one and
  // is always registered. The dev resolver — which trusts an x-user-id header
  // and is not authentication — is added ONLY when config says so, and
  // validateServer has already refused that config in any public environment.
  // So there is no fallback to fall back to in production; there is one
  // resolver, and it requires a session.
  const principalOf = cfg.auth.devAuthEnabled
    ? firstOf(sessionResolver(identity, cfg.auth.sessionCookieName), devHeaderResolver())
    : sessionResolver(identity, cfg.auth.sessionCookieName);
  if (cfg.auth.devAuthEnabled) {
    log.warn(
      "DEV AUTH IS ON: an x-user-id header is accepted as a principal. Local development only.",
    );
  }

  const tenancyDeps: TenancyDeps = { service: tenancy, principalOf };

  const party = new PartyService({
    parties: new PostgresPartyRepository(pools.app),
    identifiers: new PostgresIdentifierRepository(pools.app),
    relationships: new PostgresRelationshipRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });

  return {
    app: buildRouter(
      {
        auth: {
          service: identity,
          principalOf,
          cookieName: cfg.auth.sessionCookieName,
          cookieSecure: cfg.auth.sessionCookieSecure,
        },
        tenancy: tenancyDeps,
        party: { service: party, principalOf },
        ledger: { service: ledger },
      },
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
