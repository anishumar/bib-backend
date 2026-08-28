// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../api/guards";
import type { Config } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import { systemClock } from "../platform/clock";
import { InMemoryRateLimiter } from "../platform/ratelimit";
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
import { RandomTokenFactory, Sha256ContentHasher } from "../infrastructure/crypto/random-tokens";
import { LoggingMailer } from "../infrastructure/mail/logging-mailer";
import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import { PostgresStaffGradeRepository } from "../infrastructure/postgres/staff-grade-repository";
import { PostgresLeadRepository } from "../infrastructure/postgres/lead-repository";
import { PostgresRoundRobinAssignment } from "../infrastructure/postgres/lead-assignment";
import { PostgresProposalRepository } from "../infrastructure/postgres/proposal-repository";
import { PostgresEngagementRepository } from "../infrastructure/postgres/engagement-repository";
import { AttestedSigner } from "../infrastructure/esign/attested-signer";
import { TenancyService } from "../usecase/tenancy/service";
import { PartyService } from "../usecase/party/service";
import { LedgerService } from "../usecase/ledger/service";
import { AuthzService } from "../usecase/authz/service";
import { ConfigService } from "../usecase/config/service";
import { StaffGradeService } from "../usecase/staffgrade/service";
import { LeadService } from "../usecase/lead/service";
import { ProposalService } from "../usecase/proposal/service";
import { EngagementService } from "../usecase/engagement/service";
import { IdentityService } from "../usecase/identity/service";
import type { TenancyDeps } from "../api/handler/tenancy";
import { devHeaderResolver, firstOf, sessionResolver } from "../api/principal";
import { buildRouter } from "../api/router";

export interface Wired {
  readonly app: OpenAPIHono<AppEnv>;
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

  // ONE adapter over the config tables, serving TWO ports. The registry uses it
  // as its repository; gate 3 uses it as its PermissionSource, because "what
  // does the role `partner` carry here" is a config read like any other. Two
  // adapters over the same two tables would eventually disagree about what
  // "published" means, and one of them would be answering an authorization
  // question.
  const configRepository = new PostgresConfigRepository(pools.app);

  // ONE adapter over the ladder, serving TWO ports, on the same reasoning as
  // the config adapter above. The staff-grade use case holds it as its
  // repository; tenancy holds it as its GradeDirectory, because "does this firm
  // have this rung, and does it still promote through it" is a ladder read like
  // any other. Two adapters would eventually disagree about what "retired"
  // means, and one of them would be answering an assignment question.
  const staffGradeRepository = new PostgresStaffGradeRepository(pools.app);

  const staffGrades = new StaffGradeService({
    grades: staffGradeRepository,
    ids: systemIds,
    events: ledger,
  });

  const config = new ConfigService({
    registry: configRepository,
    // The registry can see that a role carries tenant:admin; only the roster
    // knows whether anybody has that role. Both halves are needed to refuse a
    // publish that would leave the firm with no administrator.
    holders: memberships,
    ids: systemIds,
    events: ledger,
  });

  // Creating a firm now also gives it its own role definitions, in the same
  // call — gate 3 reads those rows and has no built-in table to fall back on,
  // so a tenant without them is a tenant nobody can sign in to. The seam is a
  // port on tenancy (RoleRegistrySeeder) rather than a direct call, so neither
  // use case knows the other exists; this is the one place they meet.
  const tenancy = new TenancyService({
    tenants: new PostgresTenantRepository(pools.app),
    users,
    memberships,
    roleSeeder: {
      seedDefaultRoles: (tenantId, actor) => config.seedDefaultRoles(tenantId, actor),
    },
    // The other direction of the same relationship: administration has to know
    // which roles this firm actually publishes, so it can refuse to assign one
    // that does not exist and refuse to remove its last administrator. The
    // config adapter already answers both questions for gate 3.
    roleDirectory: configRepository,
    // And the same pair again for seniority (G3.3): the firm gets its ladder as
    // part of coming into existence, and administration asks the ladder whether
    // a rung is real and still in use before putting anybody on it.
    gradeSeeder: {
      seedDefaultGrades: (tenantId, actor) => staffGrades.seedDefaultGrades(tenantId, actor),
    },
    gradeDirectory: staffGradeRepository,
    ids: systemIds,
    events: ledger,
  });

  // ONE limiter instance, two very different uses: the edge keys it on the
  // client address, identity keys it on the account. Sharing the store is safe
  // because the keys are namespaced, and it keeps a single eviction budget.
  //
  // HONEST LIMITATION: this state is per-process, so behind N pods every limit
  // is effectively N times looser. Acceptable at one pod; the Redis adapter
  // behind the same port is the fix when there are more.
  const rateLimiter = new InMemoryRateLimiter(systemClock);

  // Gate 3 reads the firm's own role rows. The seeded four-role matrix that used
  // to answer this is now only what a NEW tenant's rows are initialised from
  // (domain/authz/model.ts, DEFAULT_ROLES); nothing consults it at request time.
  // The port did not change and neither did any call site — which was the point
  // of putting a port here before there was anything to swap in.
  const authz = new AuthzService({ permissions: configRepository });

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
    attempts: rateLimiter,
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
  log.info(
    {
      clients: cfg.auth.internalClients.map((c) => ({
        name: c.name,
        capabilities: c.capabilities,
      })),
    },
    "provisioning clients registered (keys redacted)",
  );

  if (cfg.auth.devAuthEnabled) {
    log.warn(
      "DEV AUTH IS ON: an x-user-id header is accepted as a principal. Local development only.",
    );
  }

  const tenancyDeps: TenancyDeps = { service: tenancy };

  const party = new PartyService({
    parties: new PostgresPartyRepository(pools.app),
    identifiers: new PostgresIdentifierRepository(pools.app),
    relationships: new PostgresRelationshipRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });

  // The pipeline sits ON TOP of the party module rather than beside it: a lead
  // is an opportunity about a party, so capture creates prospects through
  // PartyService — which owns display-name derivation, identifier normalisation
  // and the party.created / party_identifier.added events. Wiring the party
  // REPOSITORIES in here instead would produce parties the party module never
  // saw, with no events and none of its rules.
  //
  // ProspectDirectory is declared by the lead use case in its own vocabulary and
  // PartyService satisfies it structurally, so neither module imports the other.
  // This line is where they meet, and where a drift in party's inputs would
  // fail — at compile time, in one place.
  //
  // ASSIGNMENT is the second seam on this service, and this line is the whole
  // of the territory decision: round robin is what a firm gets today, and the
  // day an axis is agreed with the client, a territory strategy is constructed
  // HERE and no caller changes. That is what the port bought.
  const lead = new LeadService({
    leads: new PostgresLeadRepository(pools.app),
    prospects: party,
    staff: memberships,
    assignment: new PostgresRoundRobinAssignment(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // Quoting meets the configuration registry HERE, and nowhere else. The
  // proposal use case declares two narrow ports in its own vocabulary —
  // "resolve this pin" and "what is the discount limit right now" — and the
  // config adapter satisfies both structurally, so neither module imports the
  // other. Same seam, same reason, as leads meeting parties above.
  const proposal = new ProposalService({
    proposals: new PostgresProposalRepository(pools.app),
    catalogue: configRepository,
    policies: configRepository,
    // The same token adapter identity uses for sessions and magic links. Both
    // want 32 bytes from the OS CSPRNG and only the digest at rest; one
    // implementation of that is the right number.
    shareTokens: new RandomTokenFactory(),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // Engagement letters meet the configuration registry the same way proposals
  // do — one narrow port, satisfied structurally, so neither module imports the
  // other. The clause library and the service catalogue are the same two tables.
  //
  // HONEST REGISTRY: `AttestedSigner` is the third stub in this codebase, and
  // `validateServer` has already refused this config in any production-like
  // environment by the time this line runs.
  const engagement = new EngagementService({
    letters: new PostgresEngagementRepository(pools.app),
    library: configRepository,
    esign: new AttestedSigner(),
    hasher: new Sha256ContentHasher(),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  return {
    app: buildRouter(
      {
        auth: {
          service: identity,
          authz,
          cookieName: cfg.auth.sessionCookieName,
          cookieSecure: cfg.auth.sessionCookieSecure,
        },
        tenancy: tenancyDeps,
        staffGrades: { service: staffGrades },
        party: { service: party },
        ledger: { service: ledger },
        config: { service: config },
        lead: { service: lead },
        proposal: { service: proposal, authz },
        engagement: { service: engagement, authz },
      },
      log,
      {
        docsEnabled: cfg.docsEnabled,
        internalClients: cfg.auth.internalClients,
        principalOf,
        authz,
        rateLimiter,
        corsOrigins: cfg.cors.origins,
        rateLimit: {
          auth: { limit: cfg.rateLimit.authPerMinute, windowSeconds: 60 },
          general: { limit: cfg.rateLimit.generalPerMinute, windowSeconds: 60 },
          trustProxy: cfg.rateLimit.trustProxy,
        },
      },
    ),
    pools,
    assertReady: async () => {
      await assertTenantWall(pools.app);
      await assertLedgerAppendOnly(pools.app);
    },
  };
}
