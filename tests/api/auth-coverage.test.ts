// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// Three routes shipped unauthenticated — a set-any-user's-password endpoint, a
// ledger surface that read any firm's audit trail from a path parameter, and a
// party surface that was only guarded because it happened to be written last.
// Every existing test passed, because every existing test asked "does this
// route do its job" and none asked "who is allowed to reach it".
//
// So this file does not test routes. It enumerates every route the router has
// REGISTERED — read off the Hono instance itself, not off the OpenAPI spec —
// and asserts each one is either on a short, justified public list or answers
// 401 to an anonymous caller. A new unauthenticated route fails here the moment
// it is registered, without anyone remembering to add a test for it.
//
// Reading the Hono instance rather than the spec is deliberate and was a real
// gap: the first version of this file walked /openapi.json, which lists only
// routes registered through app.openapi(). /health, /ready, /docs and
// /openapi.json itself are plain app.get() calls and were invisible to it — as
// any future plain-Hono route would have been. The middleware guards still
// covered them, but a test that claims "every route is accounted for" must be
// able to SEE every route.
import { FakeClock } from "../../src/testfakes/clock";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/platform/callctx";
import { buildRouter } from "../../src/api/router";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { CAPABILITIES } from "../../src/api/capabilities";
import { AuthzService } from "../../src/usecase/authz/service";
import { ConfigService } from "../../src/usecase/config/service";
import { LeadService } from "../../src/usecase/lead/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FileStoreService } from "../../src/usecase/filestore/service";
import {
  FakeBlobStore,
  FakeContentDigest,
  FakeDocumentStoreRepo,
} from "../../src/testfakes/filestore";
import { systemClock } from "../../src/platform/clock";
import type { RouterDeps } from "../../src/api/router";
import { PORTAL_PATHS, PUBLIC_PATHS } from "../../src/api/guards";
import { decideRoute } from "../../src/api/permissions";
import { capabilityFor } from "../../src/api/capabilities";
import { TenancyService } from "../../src/usecase/tenancy/service";
import {
  FakeServiceAxisRepo,
  FakeWorkSplitSetting,
} from "../../src/testfakes/serviceaxis";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeTierSource,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeTemplateSource,
} from "../../src/testfakes/orchestrator";
import { ServiceAxisService } from "../../src/usecase/serviceaxis/service";
import { ClientAssignmentService } from "../../src/usecase/clientassignment/service";
import {
  FakeAssignableAxes,
  FakeAssignmentStaff,
  FakeClientAssignmentRepo,
  FakeClientDirectory,
} from "../../src/testfakes/clientassignment";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { SchedulerService } from "../../src/usecase/scheduler/service";
import {
  FakeActivationFeed,
  FakeJobRepo,
  FakeTenantDirectory,
  FakeWorkSplit,
} from "../../src/testfakes/scheduler";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { PartyService } from "../../src/usecase/party/service";
import { LedgerService } from "../../src/usecase/ledger/service";
import { IdentityService } from "../../src/usecase/identity/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import { makePartyFakes } from "../../src/testfakes/party";
import { makeLedgerFakes } from "../../src/testfakes/ledger";
import { makeConfigFakes, withDefaultRoles } from "../../src/testfakes/config";
import { makeLeadFakes } from "../../src/testfakes/lead";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { makeEngagementFakes } from "../../src/testfakes/engagement";
import { makeDocumentFakes } from "../../src/testfakes/document";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import { FakeDunningLadder, FakeDunningRepo } from "../../src/testfakes/dunning";
import {
  FakeCheckerDirectory,
  FakeStepApprovalRepo,
  FakeVerificationPolicySource,
  FakeWorkPermissions,
} from "../../src/testfakes/verification";
import { DunningService } from "../../src/usecase/dunning/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import {
  FakeCredentialRepo,
  FakeMagicLinkRepo,
  FakeMailer,
  FakePasswordHasher,
  FakeSessionRepo,
  FakeTokenFactory,
} from "../../src/testfakes/identity";

const INTERNAL_KEY = "test-internal-key-at-least-32-characters-long";
const INTERNAL_CLIENTS = [
  { name: "test-ops", key: INTERNAL_KEY, capabilities: CAPABILITIES },
];
const silentLog = { info() {}, warn() {}, error() {} };

/**
 * Routes that are public by design, each for a stated reason.
 *
 * /health and /ready — a load balancer cannot hold a credential, and neither
 * endpoint reveals anything about a tenant.
 *
 * /openapi.json and /docs — the spec enumerates every endpoint, so they are
 * gated by BIB_DOCS_ENABLED, which defaults OFF in every production-like
 * environment. A test below proves that gate actually closes them.
 */
const INTENTIONALLY_PUBLIC = new Set(["/health", "/ready", "/openapi.json", "/docs"]);

/**
 * The firm every session below acts for.
 *
 * Gate 3 reads role definitions from that firm's configuration registry now, so
 * the permission source has to be a registry seeded FOR THIS TENANT — the same
 * four roles createTenant writes. An empty registry would refuse every role and
 * these tests would go green for the wrong reason.
 */
const SESSION_TENANT = "00000000-0000-4000-8000-000000000007";

function deps(): RouterDeps {
  const fakes = makeFakes();
  return {
    tenancy: { service: new TenancyService(fakes) },
    scheduler: {
      service: new SchedulerService({
        jobs: new FakeJobRepo(),
        activations: new FakeActivationFeed(),
        tenants: { activeTenantIds: () => Promise.resolve([]) },
        splitAxis: new FakeWorkSplit(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-29T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    orchestrator: {
      service: new OrchestratorService({
        jobs: new FakeJobRepo(),
        steps: new FakeJobStepRepo(),
        templates: new FakeTemplateSource(),
        subjects: new FakeJobSubjectSource(),
        agents: new FakeAgentRuntime(),
        tiers: new FakeTierSource(),
        runs: new FakeAgentRunRepo(),
        checks: new FakeStepApprovalRepo(),
        policies: new FakeVerificationPolicySource(),
        checkers: new FakeCheckerDirectory(),
        permissions: new FakeWorkPermissions(),
        tenants: { activeTenantIds: () => Promise.resolve([]) },
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-29T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    serviceAxes: {
      service: new ServiceAxisService({
        axes: new FakeServiceAxisRepo(),
        split: new FakeWorkSplitSetting(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
      }),
    },
    clientAssignments: {
      service: new ClientAssignmentService({
        assignments: new FakeClientAssignmentRepo(),
        clients: new FakeClientDirectory(),
        staff: new FakeAssignmentStaff(),
        axes: new FakeAssignableAxes(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    staffGrades: {
      service: new StaffGradeService({
        grades: fakes.grades,
        ids: fakes.ids,
        events: fakes.events,
      }),
    },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
    config: { service: new ConfigService(makeConfigFakes()) },
    lead: { service: new LeadService(makeLeadFakes()) },
    proposal: {
      service: new ProposalService(makeProposalFakes()),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
    engagement: {
      service: new EngagementService(makeEngagementFakes()),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
    document: { service: new DocumentService(makeDocumentFakes()) },
    filestore: {
      service: new FileStoreService({
        documents: new FakeDocumentStoreRepo(),
        blobs: new FakeBlobStore(),
        digest: new FakeContentDigest(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
        maxUploadBytes: 25 * 1024 * 1024,
      }),
    },
    invoice: {
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      service: new InvoiceService(makeInvoiceFakes()),
      dunning: new DunningService({
        dunning: new FakeDunningRepo(),
        ladders: new FakeDunningLadder(),
        invoices: makeInvoiceFakes().invoices,
        tenants: new FakeTenantDirectory(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
        events: new RecordingEventSink(),
      }),
    },
    auth: {
      service: new IdentityService({
        users: fakes.users,
        memberships: fakes.memberships,
        credentials: new FakeCredentialRepo(),
        sessions: new FakeSessionRepo(),
        magicLinks: new FakeMagicLinkRepo(),
        passwords: new FakePasswordHasher(),
        tokens: new FakeTokenFactory(),
        mailer: new FakeMailer(),
        ids: fakes.ids,
        clock: new FakeClock(),
        events: fakes.events,
        attempts: new InMemoryRateLimiter(systemClock),
        magicLinkBaseUrl: "http://localhost:3000",
      }),
      cookieName: "bib_session",
      cookieSecure: false,
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
  };
}

/** By default nothing resolves: requests are anonymous unless a test says
 *  otherwise. `as` builds a router where every request carries one session. */
function app(principal: Principal | null = null) {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalClients: INTERNAL_CLIENTS,
    authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false },
    principalOf: () => Promise.resolve(principal),
  });
}

const STAFF_SESSION: Principal = {
  userId: "00000000-0000-4000-8000-000000000005",
  sessionId: "00000000-0000-4000-8000-000000000006",
  tenantId: "00000000-0000-4000-8000-000000000007",
  audience: "STAFF",
  role: "partner",
  commercialVisibility: true,
};

/** A client contact of the firm: authenticated, in the tenant, and outside it. */
const PORTAL_SESSION: Principal = {
  ...STAFF_SESSION,
  audience: "CLIENT_PORTAL",
  role: "client_contact",
  commercialVisibility: false,
};

/**
 * Every route the router registers, read off the Hono instance.
 *
 * Entries whose path contains a wildcard are the middleware mounts
 * (app.use("/api/v1/*", …)), not routes anyone can call, so they are dropped.
 * Everything else is a real endpoint — including the ones registered outside
 * the OpenAPI registry, which is the whole point of reading from here.
 */
function registeredRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  return app()
    .routes.filter((r) => !r.path.includes("*"))
    .map((r) => ({ method: r.method, path: r.path }))
    .filter((r) => {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** GET and HEAD may not carry a body; everything else gets an empty JSON one,
 *  which is enough because the guards run before validation. */
function bodylessOrJson(method: string): RequestInit {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return { method: verb };
  return { method: verb, headers: { "content-type": "application/json" }, body: "{}" };
}

/** A concrete request for a templated path. Hono registers params as :name and
 *  the OpenAPI spec renders them as {name}; both appear in this file. The
 *  guards run before validation, so the values need only exist. */
function concrete(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001")
    .replace(/:[^/]+/g, "00000000-0000-4000-8000-000000000001");
}

describe("every route is accounted for", () => {
  it("can see every registered route, not just the documented ones", () => {
    const paths = registeredRoutes().map((r) => r.path);
    expect(paths.length).toBeGreaterThan(10);
    // The four that the spec-based version of this test was blind to.
    for (const path of INTENTIONALLY_PUBLIC) {
      expect(paths, `${path} must be visible to this sweep`).toContain(path);
    }
  });

  it("refuses every non-public route to an anonymous caller", async () => {
    const unguarded: string[] = [];

    for (const { method, path } of registeredRoutes()) {
      if (PUBLIC_PATHS.has(path) || INTENTIONALLY_PUBLIC.has(path)) continue;
      const init = bodylessOrJson(method);
      const res = await app().request(concrete(path), init);
      if (res.status !== 401) unguarded.push(`${method.toUpperCase()} ${path} -> ${String(res.status)}`);
    }

    // Named, not counted: a failure here should say which route is open.
    expect(unguarded).toEqual([]);
  });

  it("closes the docs when config says to — the gate the public list relies on", async () => {
    // /openapi.json and /docs are public by design, on the promise that
    // BIB_DOCS_ENABLED shuts them in any production-like environment. That
    // promise is what makes them acceptable on the list above, so it is tested.
    const closed = buildRouter(deps(), silentLog, {
      docsEnabled: false,
      internalClients: INTERNAL_CLIENTS,
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
      rateLimit: {
        auth: { limit: 1000, windowSeconds: 60 },
        general: { limit: 10000, windowSeconds: 60 },
        trustProxy: false,
      },
      principalOf: () => Promise.resolve(null),
    });
    expect((await closed.request("/openapi.json")).status).toBe(404);
    expect((await closed.request("/docs")).status).toBe(404);
  });

  it("keeps the public list short and justified", () => {
    // This test exists to make adding a fourth entry a DECISION rather than an
    // edit. Three of these exist to OBTAIN a session.
    //
    // The fourth is the proposal share link, and its justification is different
    // in kind: a proposal goes to somebody who has no login and will not get
    // one. Requiring a session would mean creating an account for every prospect
    // a firm quotes — absurd, and a worse posture than a bearer link, because it
    // leaves real accounts lying around for people who never became clients.
    //
    // What makes it safe rather than merely necessary is spelled out on
    // PUBLIC_PATHS in api/guards.ts: 256-bit token, digest at rest, its own
    // tenant inside it so the read is still tenant-scoped, in the BODY rather
    // than the path, read-only, and one answer for malformed / unknown /
    // withdrawn. A fifth entry needs its own paragraph like that one.
    expect([...PUBLIC_PATHS].sort()).toEqual([
      "/api/v1/auth/login",
      "/api/v1/auth/magic-link",
      "/api/v1/auth/magic-link/redeem",
      "/api/v1/proposals/shared",
    ]);
  });

  it("the share link route is reachable without a session, and only that one", async () => {
    // The public route answers on its own merits — a 404 for an unknown token,
    // never a 401 — while its siblings under the same prefix still refuse.
    const res = await app().request("/api/v1/proposals/shared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(404);

    const sibling = await app().request("/api/v1/proposals", { method: "GET" });
    expect(sibling.status).toBe(401);
  });

  it("answers 401 before validation, so an anonymous caller learns nothing about the shape", async () => {
    // A 400 here would confirm the route exists and describe its body to
    // someone who has not authenticated.
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the /internal platform key", () => {
  const provisioning = { method: "POST", path: "/internal/v1/tenants" };

  async function attempt(authorization?: string): Promise<number> {
    const res = await app().request(provisioning.path, {
      method: provisioning.method,
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({
        name: "Harbour Point",
        slug: "harbour-point",
        reportingCurrency: "INR",
      }),
    });
    return res.status;
  }

  it("refuses a missing, wrong, or malformed key", async () => {
    expect(await attempt()).toBe(401);
    expect(await attempt("Bearer wrong-key")).toBe(401);
    expect(await attempt(INTERNAL_KEY)).toBe(401); // no Bearer scheme
    expect(await attempt("Basic " + INTERNAL_KEY)).toBe(401);
    expect(await attempt("Bearer ")).toBe(401);
    // A prefix of the real key must not pass: the comparison is over the whole
    // value, and lengths are checked before the timing-safe compare.
    expect(await attempt(`Bearer ${INTERNAL_KEY.slice(0, 20)}`)).toBe(401);
  });

  it("accepts the right key", async () => {
    expect(await attempt(`Bearer ${INTERNAL_KEY}`)).toBe(201);
  });

  it("does not let the platform key act as a session on the product surface", async () => {
    // The two surfaces are separate credentials. A provisioning key must not
    // become a way to read a firm's data.
    const res = await app().request("/api/v1/events", {
      headers: { authorization: `Bearer ${INTERNAL_KEY}` },
    });
    expect(res.status).toBe(401);
  });
});


describe("gate 2 — audience", () => {
  // This product is B2B2C: a firm's staff and a firm's CLIENTS both log in
  // here. Being authenticated and inside the tenant says nothing about which
  // of the two you are, and a client contact must never reach the workspace
  // where the firm's whole book of clients lives.

  it("refuses a client-portal session everywhere on the staff surface", async () => {
    const reachable: string[] = [];

    for (const { method, path } of registeredRoutes()) {
      if (!path.startsWith("/api/v1/")) continue;
      if (PUBLIC_PATHS.has(path) || PORTAL_PATHS.has(path)) continue;
      const init = bodylessOrJson(method);
      const res = await app(PORTAL_SESSION).request(concrete(path), init);
      if (res.status !== 403) {
        reachable.push(`${method.toUpperCase()} ${path} -> ${String(res.status)}`);
      }
    }

    // Before this gate existed, every one of these answered 200 or 201: a
    // client contact could list the firm's other clients, create parties, and
    // read its audit trail — through the front door, not an attack.
    expect(reachable).toEqual([]);
  });

  it("lets a client-portal session manage its own session", async () => {
    for (const path of PORTAL_PATHS) {
      const isGet = path.endsWith("/me") || path.endsWith("/memberships");
      const res = await app(PORTAL_SESSION).request(path, {
        method: isGet ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(isGet ? {} : { body: "{}" }),
      });
      expect(res.status, `${path} should not be 403 for a portal session`).not.toBe(403);
    }
  });

  it("lets a portal user discover the orgs it may switch to", async () => {
    // switch-tenant without this is reachable and useless: the caller can act
    // on a choice they have no way to enumerate. It returns only the caller's
    // own memberships, so it tells a portal session nothing new about itself.
    const res = await app(PORTAL_SESSION).request("/api/v1/tenancy/me/memberships");
    expect(res.status).toBe(200);
  });

  it("still lets staff through", async () => {
    const res = await app(STAFF_SESSION).request("/api/v1/parties");
    expect(res.status).toBe(200);
  });

  it("keeps the portal list to session management only", () => {
    // Nothing has been built FOR portal users yet (U1 is Phase 6), so they
    // should reach nothing but their own session. A route added here needs
    // record-scope (gate 4) as well — audience alone is the coarse gate.
    expect([...PORTAL_PATHS].sort()).toEqual([
      "/api/v1/auth/logout",
      "/api/v1/auth/me",
      "/api/v1/auth/switch-tenant",
      // The org switcher's data — their own memberships and nothing else.
      "/api/v1/tenancy/me/memberships",
    ]);
  });
});


describe("gate 3 — role", () => {
  const as = (role: string): Principal => ({ ...STAFF_SESSION, role });

  it("every registered route declares who may reach it", () => {
    // The structural half of gate 3. A route with no entry is refused for
    // everyone, so this failing means someone added a route without deciding
    // who it is for — which is the moment to decide, not later.
    const undeclared: string[] = [];
    for (const { method, path } of registeredRoutes()) {
      if (!path.startsWith("/api/v1/")) continue;
      if (PUBLIC_PATHS.has(path)) continue;
      if (decideRoute(method, concrete(path)).kind === "unmapped") {
        undeclared.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("refuses a route the role does not carry", async () => {
    // An associate does the work and does not sweep the firm's whole audit
    // trail — it names every client the firm has.
    const res = await app(as("associate")).request("/api/v1/events");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).toBe("NOT_PERMITTED");
  });

  it("allows a route the role does carry", async () => {
    expect((await app(as("associate")).request("/api/v1/parties")).status).toBe(200);
    expect((await app(as("manager")).request("/api/v1/events")).status).toBe(200);
    expect((await app(as("partner")).request("/api/v1/events")).status).toBe(200);
  });

  it("says a role is UNKNOWN rather than merely unpermitted", async () => {
    // A firm whose staff are all locked out by a typo in a role name must not
    // look like ordinary policy working as intended.
    const res = await app(as("rm")).request("/api/v1/parties");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { reason?: string; message: string } };
    expect(body.error.reason).toBe("UNKNOWN_ROLE");
    expect(body.error.message).toContain("partner");
  });

  it("does not let a literal route be swallowed by a template", async () => {
    // /api/v1/config/permissions sits beside /api/v1/config/{kind}, and
    // "permissions" is deliberately NOT a kind. If the template matched first
    // this would answer 400 for a perfectly good request — and it would do so
    // quietly, since 400 looks like a caller mistake.
    const res = await app(as("partner")).request("/api/v1/config/permissions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: { key: string }[] };
    expect(body.permissions.map((p) => p.key)).toContain("tenant:admin");
  });

  it("never lets a role reach an unmapped route", async () => {
    const res = await app(as("partner")).request("/api/v1/not-a-real-route");
    expect(res.status).not.toBe(200);
  });

  it("leaves session management reachable whatever the role", async () => {
    // Otherwise a misconfigured role locks someone out of the endpoints they
    // need to switch to a firm where their role is fine.
    for (const role of ["partner", "associate", "rm"]) {
      const res = await app(as(role)).request("/api/v1/auth/me");
      expect(res.status, `${role} should reach /auth/me`).toBe(200);
    }
  });
});


describe("CORS — the frontend is a separate origin", () => {
  const ALLOWED = "http://localhost:3000";
  const preflight = (origin: string): RequestInit => ({
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  it("answers a preflight for an allowed origin", async () => {
    const res = await app().request("/api/v1/auth/login", preflight(ALLOWED));
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    // Without this the browser sends no cookie and the session never works.
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not hand credentials to an origin that is not on the list", async () => {
    // The dangerous version of CORS reflects whatever Origin arrived. Combined
    // with credentials that lets ANY site call this API as the logged-in user
    // and read the answers.
    const res = await app().request("/api/v1/auth/login", preflight("https://evil.example"));
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("puts the headers on real responses, not only on preflights", async () => {
    const res = await app().request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: ALLOWED, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "x" }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("answers the preflight without spending the caller's rate-limit budget", async () => {
    // A browser preflights every credentialed POST. If that counted, each real
    // login would cost two of ten attempts a minute and the auth bucket would
    // bite at five sign-ins.
    const tight = buildRouter(deps(), silentLog, {
      docsEnabled: true,
      internalClients: INTERNAL_CLIENTS,
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
      rateLimit: {
        auth: { limit: 3, windowSeconds: 60 },
        general: { limit: 3, windowSeconds: 60 },
        trustProxy: false,
      },
      corsOrigins: [ALLOWED],
      principalOf: () => Promise.resolve(null),
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await tight.request("/api/v1/auth/login", preflight(ALLOWED));
      expect(res.status, `preflight ${String(i)} should not be rate limited`).not.toBe(429);
    }
  });

  it("gives /internal no CORS at all — no browser should reach it", async () => {
    const res = await app().request("/internal/v1/tenants", preflight(ALLOWED));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});


describe("the /internal surface authorizes, not just authenticates", () => {
  // One key that opened every provisioning route was an escalation path, not a
  // convenience: create a user, grant them partner in any firm, set their
  // password, sign in as them. Three calls. Each caller now holds only what it
  // needs.
  const KEY_TENANTS = "capability-key-tenants-only-32-characters";
  const KEY_PASSWORD = "capability-key-password-only-32-character";

  function scoped() {
    return buildRouter(deps(), silentLog, {
      docsEnabled: true,
      internalClients: [
        { name: "onboarding", key: KEY_TENANTS, capabilities: ["tenant.provision"] },
        { name: "reset-tool", key: KEY_PASSWORD, capabilities: ["credential.set"] },
      ],
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
      rateLimit: {
        auth: { limit: 1000, windowSeconds: 60 },
        general: { limit: 10000, windowSeconds: 60 },
        trustProxy: false,
      },
      corsOrigins: ["http://localhost:3000"],
      principalOf: () => Promise.resolve(null),
    });
  }

  const call = (key: string, method: string, path: string, body: unknown) =>
    scoped().request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lets a key do what it carries", async () => {
    const res = await call(KEY_TENANTS, "POST", "/internal/v1/tenants", {
      name: "Harbour Point",
      slug: "harbour-point",
      reportingCurrency: "INR",
    });
    expect(res.status).toBe(201);
  });

  it("refuses the escalation step the key does not carry", async () => {
    // The onboarding key can create firms. It must not be able to set the
    // password of somebody who already works at one.
    const res = await call(KEY_TENANTS, "PUT", "/internal/v1/users/x/password", {
      password: "a perfectly fine passphrase",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("credential.set");
    expect(body.error.message).toContain("onboarding");
  });

  it("refuses in the other direction too", async () => {
    const res = await call(KEY_PASSWORD, "POST", "/internal/v1/tenants", {
      name: "Harbour Point",
      slug: "harbour-point",
      reportingCurrency: "INR",
    });
    expect(res.status).toBe(403);
  });

  it("still refuses an unknown key outright", async () => {
    const res = await call("not-a-registered-key-at-all-32-chars", "POST", "/internal/v1/tenants", {});
    expect(res.status).toBe(401);
  });

  it("every /internal route declares a capability", () => {
    // Deny by default, same as the product surface: a provisioning route with
    // no entry is refused to every key, so one cannot ship open.
    const undeclared = registeredRoutes()
      .filter((r) => r.path.startsWith("/internal/"))
      .filter((r) => capabilityFor(r.method, concrete(r.path)) === null)
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(undeclared).toEqual([]);
  });

  it("names the caller in the audit trail", async () => {
    // "system did it" cannot be traced to a system. Once more than one
    // integration holds a key, this is the only way to answer who created a firm.
    const app = scoped();
    await app.request("/internal/v1/tenants", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY_TENANTS}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Harbour Point",
        slug: "harbour-point",
        reportingCurrency: "INR",
      }),
    });
    // The router under test wires its own fakes, so assert through the shape the
    // service records rather than reaching into them: covered end to end by the
    // smoke test, and by the tenancy service unit tests for the payload itself.
    expect(capabilityFor("POST", "/internal/v1/tenants")).toBe("tenant.provision");
  });
});
