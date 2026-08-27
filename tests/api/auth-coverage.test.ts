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
import { buildRouter } from "../../src/api/router";
import type { RouterDeps } from "../../src/api/router";
import { PUBLIC_PATHS } from "../../src/api/guards";
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
        magicLinkBaseUrl: "http://localhost:3000",
      }),
      cookieName: "bib_session",
      cookieSecure: false,
    },
  };
}

function app() {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalApiKey: INTERNAL_KEY,
    // No session ever resolves: every request in this file is anonymous.
    principalOf: () => Promise.resolve(null),
  });
}

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
