// FinCompliance's routes over HTTP (docs/FIN_BUILD_PLAN.md F0.6): the three
// answers a fin screen has to tell apart, each with the status the frontend
// branches on.
//
//   404  fin is not there: the deployment's switch is off (no route at all) or
//        this firm's is (`FIN_NOT_ENABLED`, from the service)
//   503  fin's database did not answer (`UNAVAILABLE`, reason
//        `FIN_UNAVAILABLE`, with `Retry-After`); never the 500 an unmapped
//        driver error becomes, which is what `StaffGradeError` taught
//   403  the role may not read the books (gate 3, `books:read`)
//
// The app here is the fin registrar on a bare Hono app, with the router's error
// mapping (`mapError` + `errorHeaders`, the very functions `buildRouter` uses)
// and, for the 403, the router's own permission guard. Translating a real
// SQLSTATE into `FinUnavailable` is the adapter's, proven against Postgres in
// `unavailable.integration.test.ts`; here the fake throws what the adapter
// throws.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import { createOpenAPIApp } from "../../src/api/openapi";
import { FIN_RETRY_AFTER_SECONDS, mapError } from "../../src/api/domainerr";
import { errorHeaders, toEnvelope } from "../../src/api/httpresp";
import { permissionGuard } from "../../src/api/guards";
import type { AppEnv } from "../../src/api/guards";
import { registerFinRoutes } from "../../src/api/handler/fin";
import { AuthzService } from "../../src/usecase/authz/service";
import type { PermissionSource, StoredRole } from "../../src/usecase/authz/ports";
import type { Permission } from "../../src/domain/authz/model";
import { FinIntakeService } from "../../src/usecase/fin/intake";
import type { IntakeFilter, IntakeItemView, IntakeSummary } from "../../src/usecase/fin/ports";
import { FinUnavailable } from "../../src/domain/fin/errors";
import { FakeFinFirms, FakeFinIntakeStore } from "../../src/testfakes/fin";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { load } from "../../src/config/config";
import { finApiDeps, wireFinJob } from "../../src/setup/fin";

const FIRM = "00000000-0000-4000-8000-0000000000f1";
const USER = "00000000-0000-4000-8000-0000000000f2";

/** The store as the adapter behaves when fin's statement timeout fires. */
class TimingOutStore extends FakeFinIntakeStore {
  override list(_tenantId: string, _filter: IntakeFilter): Promise<readonly IntakeItemView[]> {
    return Promise.reject(new FinUnavailable("the intake list", { code: "57014" }));
  }
  override summary(_tenantId: string, _clientPartyId: string | null): Promise<IntakeSummary> {
    return Promise.reject(new FinUnavailable("the intake counts", { code: "57014" }));
  }
}

/** The firm switch as the adapter behaves when the database cannot be reached. */
class UnreachableFirms extends FakeFinFirms {
  override enabledSince(_tenantId: string): Promise<string | null> {
    return Promise.reject(new FinUnavailable("whether fin is on for this firm", { code: "ECONNREFUSED" }));
  }
}

/**
 * A firm's own roles: a partner who reads the books and a clerk who does not.
 * Every DEFAULT staff role carries `books:read` (0382), so the refusal needs a
 * role the firm wrote itself, which is exactly the case gate 3 is for.
 */
class FirmRoles implements PermissionSource {
  private readonly roles: Record<string, StoredRole> = {
    partner: { audience: "STAFF", permissions: ["party:read", "work:write", "books:read"] },
    clerk: { audience: "STAFF", permissions: ["party:read", "work:write"] },
  };
  permissionsFor(_tenantId: string, role: string): Promise<readonly Permission[]> {
    return Promise.resolve(this.roles[role]?.permissions ?? []);
  }
  roleFor(_tenantId: string, role: string): Promise<StoredRole | null> {
    return Promise.resolve(this.roles[role] ?? null);
  }
  knownRoles(_tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(Object.keys(this.roles));
  }
}

function app(opts: {
  firms?: FakeFinFirms;
  store?: FakeFinIntakeStore;
  role?: string;
  gate3?: boolean;
} = {}) {
  const firms = opts.firms ?? new FakeFinFirms();
  const service = new FinIntakeService({
    firms,
    candidates: opts.store ?? new FakeFinIntakeStore(),
    items: opts.store ?? new FakeFinIntakeStore(),
    events: new RecordingEventSink(),
    ids: new FakeIds(),
  });
  const http = createOpenAPIApp();
  http.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status, errorHeaders(m));
  });
  const principal: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000000f3",
      tenantId: FIRM,
      audience: "STAFF",
      role: opts.role ?? "partner",
      commercialVisibility: false,
    });
    await next();
  };
  http.use("*", principal);
  if (opts.gate3 === true) http.use("*", permissionGuard(new AuthzService({ permissions: new FirmRoles() })));
  registerFinRoutes(http, { intake: service });
  return { http, firms };
}

async function get(http: ReturnType<typeof app>["http"], path: string) {
  const res = await http.request(path);
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: (await res.json()) as { error?: { code: string; reason?: string; message: string } },
  };
}

describe("fin is not there (404)", () => {
  it("answers FIN_NOT_ENABLED on both routes for a firm that has not switched it on", async () => {
    const { http } = app();
    for (const path of ["/api/v1/fin/status", "/api/v1/fin/intake"]) {
      const res = await get(http, path);
      expect(res.status, path).toBe(404);
      expect(res.body.error).toMatchObject({ code: "NOT_FOUND", reason: "FIN_NOT_ENABLED" });
      expect(res.retryAfter, path).toBeNull();
    }
  });

  describe("and with the deployment's switch off, the routes do not exist", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("hands the router nothing to mount", async () => {
      vi.stubEnv("BIB_ENVIRONMENT", "development");
      vi.stubEnv("BIB_DATABASE_URL", "postgres://owner:secret@localhost:5434/bib");
      vi.stubEnv("BIB_APP_DATABASE_URL", "postgres://bib_app:secret@localhost:5434/bib");
      vi.stubEnv(
        "BIB_INTERNAL_KEYS",
        '[{"name":"ci","key":"ci-internal-key-not-for-any-real-environment","capabilities":["tenant.provision"]}]',
      );
      vi.stubEnv("BIB_FIN_ENABLED", undefined);
      const cfg = load();
      // postgres.js connects lazily, so nothing here touches a database.
      const wired = wireFinJob(cfg);
      try {
        expect(finApiDeps(cfg, wired.pools.app, new RecordingEventSink())).toBeUndefined();
        vi.stubEnv("BIB_FIN_ENABLED", "true");
        expect(finApiDeps(load(), wired.pools.app, new RecordingEventSink())).toBeDefined();
      } finally {
        await wired.pools.close();
      }
    });
  });
});

describe("fin's database did not answer (503)", () => {
  it("answers the intake list's timeout with 503 UNAVAILABLE and Retry-After, never 500", async () => {
    const firms = new FakeFinFirms();
    firms.enabled.add(FIRM);
    const { http } = app({ firms, store: new TimingOutStore() });
    const res = await get(http, "/api/v1/fin/intake");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "UNAVAILABLE", reason: "FIN_UNAVAILABLE" });
    expect(res.retryAfter).toBe(String(FIN_RETRY_AFTER_SECONDS));
    // What a person reads: says the rest works and what to do, names no driver.
    expect(res.body.error?.message).toMatch(/^FinCompliance did not answer/);
    expect(res.body.error?.message).not.toMatch(/57014|statement|timeout|ECONN/i);
  });

  it("answers the status read the same way when the database cannot be reached", async () => {
    const { http } = app({ firms: new UnreachableFirms() });
    const res = await get(http, "/api/v1/fin/status");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "UNAVAILABLE", reason: "FIN_UNAVAILABLE" });
    expect(res.retryAfter).toBe(String(FIN_RETRY_AFTER_SECONDS));
  });

  it("still answers 200 when fin's database is fine", async () => {
    const firms = new FakeFinFirms();
    firms.enabled.add(FIRM);
    const { http } = app({ firms });
    const status = await get(http, "/api/v1/fin/status");
    expect(status.status).toBe(200);
    const intake = await get(http, "/api/v1/fin/intake");
    expect(intake.status).toBe(200);
  });
});

describe("the role may not read the books (403)", () => {
  it("refuses a role without books:read on both routes, before fin is asked anything", async () => {
    const { http } = app({ firms: new UnreachableFirms(), role: "clerk", gate3: true });
    for (const path of ["/api/v1/fin/status", "/api/v1/fin/intake"]) {
      // The firm switch would answer 503 if it were reached: gate 3 runs first.
      const res = await get(http, path);
      expect(res.status, path).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", reason: "NOT_PERMITTED" });
    }
  });

  it("lets a role holding books:read through", async () => {
    const firms = new FakeFinFirms();
    firms.enabled.add(FIRM);
    const { http } = app({ firms, role: "partner", gate3: true });
    expect((await get(http, "/api/v1/fin/status")).status).toBe(200);
    expect((await get(http, "/api/v1/fin/intake")).status).toBe(200);
  });
});
