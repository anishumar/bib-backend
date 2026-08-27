// The API edge, exercised through the router with in-memory ports — no server,
// no database. Proves three things the OpenAPI adoption must hold:
//   1. the spec is generated from the routes (single source of truth),
//   2. a validation failure returns the SAME envelope as every other error,
//   3. the principal gate still answers 401 with that envelope.
import { describe, expect, it } from "vitest";
import { buildRouter } from "../../src/api/router";
import type { RouterDeps } from "../../src/api/router";
import type { PrincipalResolver } from "../../src/api/handler/tenancy";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { PartyService } from "../../src/usecase/party/service";
import { LedgerService } from "../../src/usecase/ledger/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import { makePartyFakes } from "../../src/testfakes/party";
import { makeLedgerFakes } from "../../src/testfakes/ledger";

const silentLog = { info() {}, warn() {}, error() {} };

const devPrincipal: PrincipalResolver = (getHeader) => {
  const userId = getHeader("x-user-id");
  return userId ? { userId } : null;
};

function deps(): RouterDeps {
  return {
    tenancy: { service: new TenancyService(makeFakes()), principalOf: devPrincipal },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
  };
}

function app() {
  return buildRouter(deps(), silentLog, { docsEnabled: true });
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
    expect(paths).toContain("/internal/v1/tenants/{tenantId}/organizations");
    expect(paths).toContain("/internal/v1/tenants/{tenantId}/parties/{partyId}");
    expect(paths).toContain("/internal/v1/tenants/{tenantId}/events");
  });

  it("is not served when docs are disabled", async () => {
    const res = await buildRouter(deps(), silentLog, { docsEnabled: false }).request("/openapi.json");
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  it("maps a schema failure to the shared error envelope", async () => {
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
