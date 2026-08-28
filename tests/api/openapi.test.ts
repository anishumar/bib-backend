// The API edge, exercised through the router with in-memory ports — no server,
// no database. Proves three things the OpenAPI adoption must hold:
//   1. the spec is generated from the routes (single source of truth),
//   2. a validation failure returns the SAME envelope as every other error,
//   3. the principal gate still answers 401 with that envelope.
import { describe, expect, it } from "vitest";
import { buildRouter } from "../../src/api/router";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { CAPABILITIES } from "../../src/api/capabilities";
import { AuthzService } from "../../src/usecase/authz/service";
import { StaticPermissionSource } from "../../src/infrastructure/authz/static-permissions";
import { systemClock } from "../../src/platform/clock";
import type { RouterDeps } from "../../src/api/router";
import type { PrincipalResolver } from "../../src/api/principal";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { PartyService } from "../../src/usecase/party/service";
import { LedgerService } from "../../src/usecase/ledger/service";
import { IdentityService } from "../../src/usecase/identity/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import { makePartyFakes } from "../../src/testfakes/party";
import { makeLedgerFakes } from "../../src/testfakes/ledger";
import {
  FakeClock,
  FakeCredentialRepo,
  FakeMagicLinkRepo,
  FakeMailer,
  FakePasswordHasher,
  FakeSessionRepo,
  FakeTokenFactory,
} from "../../src/testfakes/identity";

const silentLog = { info() {}, warn() {}, error() {} };

// The dev resolver, as the composition root registers it locally: an x-user-id
// header stands in for a session. Not authentication — see api/principal.ts.
const devPrincipal: PrincipalResolver = (getHeader) => {
  const userId = getHeader("x-user-id");
  return Promise.resolve(
    userId
      ? {
          userId,
          sessionId: DEV_SESSION,
          tenantId: null,
          audience: null,
          role: null,
          commercialVisibility: null,
        }
      : null,
  );
};

const DEV_SESSION = "00000000-0000-0000-0000-0000000000de";

function identityService(): IdentityService {
  const fakes = makeFakes();
  return new IdentityService({
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
    magicLinkBaseUrl: "http://localhost:3000",
    events: fakes.events,
    attempts: new InMemoryRateLimiter(systemClock),
  });
}

function deps(): RouterDeps {
  return {
    tenancy: { service: new TenancyService(makeFakes()) },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
    auth: { service: identityService(), cookieName: "bib_session", cookieSecure: false },
  };
}

const INTERNAL_KEY = "test-internal-key-at-least-32-characters-long";
const INTERNAL_CLIENTS = [
  { name: "test-ops", key: INTERNAL_KEY, capabilities: CAPABILITIES },
];
const internal = { authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" };

function app() {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalClients: INTERNAL_CLIENTS,
    authz: new AuthzService({ permissions: new StaticPermissionSource() }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false },
    principalOf: devPrincipal,
  });
}

describe("OpenAPI spec", () => {
  it("is generated from the registered routes", async () => {
    const res = await app().request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    // Tenancy, party and ledger routes are all mounted; assert a representative set.
    expect(paths).toContain("/internal/v1/tenants");
    expect(paths).toContain("/api/v1/tenancy/me/memberships");
    expect(paths).toContain("/api/v1/events");
    expect(paths).toContain("/api/v1/parties/organizations");
    expect(paths).toContain("/api/v1/parties/{partyId}");
    expect(paths).toContain("/api/v1/auth/login");
  });

  it("is not served when docs are disabled", async () => {
    const res = await buildRouter(deps(), silentLog, {
      docsEnabled: false,
      internalClients: INTERNAL_CLIENTS,
    authz: new AuthzService({ permissions: new StaticPermissionSource() }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false },
      principalOf: devPrincipal,
    }).request("/openapi.json");
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  it("maps a schema failure to the shared error envelope", async () => {
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({ name: "Acme" }), // slug missing
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.reason).toContain("slug");
  });
});

describe("happy path", () => {
  it("creates a tenant and echoes it", async () => {
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({ name: "Harbour Point", slug: "harbour-point" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; status: string };
    expect(body.slug).toBe("harbour-point");
    expect(body.status).toBe("active");
  });
});

describe("principal gate", () => {
  it("answers 401 with the envelope when no principal is present", async () => {
    const res = await app().request("/api/v1/tenancy/me/memberships");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns memberships for a present principal", async () => {
    const res = await app().request("/api/v1/tenancy/me/memberships", {
      headers: { "x-user-id": "00000000-0000-0000-0000-000000000001" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberships: unknown[] };
    expect(Array.isArray(body.memberships)).toBe(true);
  });
});


describe("transport-level faults", () => {
  it("answers a malformed JSON body 400, not 500", async () => {
    // Hono raises HTTPException before any handler runs. Falling through to
    // INTERNAL blamed the server for the client's bad request AND logged every
    // one as an unhandled error, which is how a real 500 gets lost.
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("answers an unknown /internal path 403, not 404", async () => {
    // The capability guard runs before routing, so it cannot tell a route that
    // forgot its entry from a path that never existed — and answers "no" to
    // both. Losing the accurate 404 is the price of deny-by-default, and the
    // right side of that trade: no provisioning route can be open by omission.
    const res = await app().request("/internal/v1/nope", { headers: internal });
    expect(res.status).toBe(403);
  });

  it("still answers an unknown path outside /internal with a 404", async () => {
    expect((await app().request("/no/such/thing")).status).toBe(404);
  });
});
