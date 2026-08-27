// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// Three routes shipped unauthenticated — a set-any-user's-password endpoint, a
// ledger surface that read any firm's audit trail from a path parameter, and a
// party surface that was only guarded because it happened to be written last.
// Every existing test passed, because every existing test asked "does this
// route do its job" and none asked "who is allowed to reach it".
//
// So this file does not test routes. It enumerates the OpenAPI spec — the same
// spec generated from the real router — and asserts that EVERY path is either
// on a short, justified public list or answers 401 to an anonymous caller. A
// new unauthenticated route fails here the moment it is registered, without
// anyone remembering to add a test for it.
import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/platform/callctx";
import { buildRouter } from "../../src/api/router";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { AuthzService } from "../../src/usecase/authz/service";
import { StaticPermissionSource } from "../../src/infrastructure/authz/static-permissions";
import { systemClock } from "../../src/platform/clock";
import type { RouterDeps } from "../../src/api/router";
import { PORTAL_PATHS, PUBLIC_PATHS } from "../../src/api/guards";
import { decideRoute } from "../../src/api/permissions";
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

const INTERNAL_KEY = "test-internal-key-at-least-32-characters-long";
const silentLog = { info() {}, warn() {}, error() {} };

/** Ops endpoints. A load balancer cannot hold a credential, and neither of
 *  these reveals anything about a tenant. */
const OPS_PATHS = new Set(["/health", "/ready"]);

function deps(): RouterDeps {
  const fakes = makeFakes();
  return {
    tenancy: { service: new TenancyService(fakes) },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
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
    },
  };
}

/** By default nothing resolves: requests are anonymous unless a test says
 *  otherwise. `as` builds a router where every request carries one session. */
function app(principal: Principal | null = null) {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalApiKey: INTERNAL_KEY,
    authz: new AuthzService({ permissions: new StaticPermissionSource() }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
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

/** Every (method, path) the router actually registers, read from the spec it
 *  generates — so this cannot drift from the routes. */
async function registeredRoutes(): Promise<{ method: string; path: string }[]> {
  const res = await app().request("/openapi.json");
  const spec = (await res.json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({ method, path })),
  );
}

/** A concrete request for a templated path — the guards run before validation,
 *  so the values only have to exist, not to be meaningful. */
function concrete(path: string): string {
  return path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001");
}

describe("every route is accounted for", () => {
  it("registers something to check", async () => {
    expect((await registeredRoutes()).length).toBeGreaterThan(10);
  });

  it("refuses every non-public route to an anonymous caller", async () => {
    const unguarded: string[] = [];

    for (const { method, path } of await registeredRoutes()) {
      if (PUBLIC_PATHS.has(path) || OPS_PATHS.has(path)) continue;
      const init: RequestInit =
        method === "get"
          ? { method: "GET" }
          : { method: method.toUpperCase(), headers: { "content-type": "application/json" }, body: "{}" };
      const res = await app().request(concrete(path), init);
      if (res.status !== 401) unguarded.push(`${method.toUpperCase()} ${path} -> ${String(res.status)}`);
    }

    // Named, not counted: a failure here should say which route is open.
    expect(unguarded).toEqual([]);
  });

  it("keeps the public list short and justified", () => {
    // Each of these exists to OBTAIN a session; nothing else belongs here.
    expect([...PUBLIC_PATHS].sort()).toEqual([
      "/api/v1/auth/login",
      "/api/v1/auth/magic-link",
      "/api/v1/auth/magic-link/redeem",
    ]);
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
      body: JSON.stringify({ name: "Harbour Point", slug: "harbour-point" }),
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

    for (const { method, path } of await registeredRoutes()) {
      if (!path.startsWith("/api/v1/")) continue;
      if (PUBLIC_PATHS.has(path) || PORTAL_PATHS.has(path)) continue;
      const init: RequestInit =
        method === "get"
          ? { method: "GET" }
          : { method: method.toUpperCase(), headers: { "content-type": "application/json" }, body: "{}" };
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
      const res = await app(PORTAL_SESSION).request(path, {
        method: path.endsWith("/me") ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(path.endsWith("/me") ? {} : { body: "{}" }),
      });
      expect(res.status, `${path} should not be 403 for a portal session`).not.toBe(403);
    }
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
    ]);
  });
});


describe("gate 3 — role", () => {
  const as = (role: string): Principal => ({ ...STAFF_SESSION, role });

  it("every registered route declares who may reach it", async () => {
    // The structural half of gate 3. A route with no entry is refused for
    // everyone, so this failing means someone added a route without deciding
    // who it is for — which is the moment to decide, not later.
    const undeclared: string[] = [];
    for (const { method, path } of await registeredRoutes()) {
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
