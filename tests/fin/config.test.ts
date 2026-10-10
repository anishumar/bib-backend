// FinCompliance's kill switch and the fin job's pool (docs/FIN_BUILD_PLAN.md
// F0.3, F0.5). An unset switch must never turn on a module that reads clients'
// books, and the fin job's pool must stay small on a shared database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { load } from "../../src/config/config";
import { wireFinJob } from "../../src/setup/fin";

function stubBase(): void {
  vi.stubEnv("BIB_ENVIRONMENT", "development");
  vi.stubEnv("BIB_DATABASE_URL", "postgres://owner:secret@localhost:5434/bib");
  vi.stubEnv("BIB_APP_DATABASE_URL", "postgres://bib_app:secret@localhost:5434/bib");
  vi.stubEnv(
    "BIB_INTERNAL_KEYS",
    '[{"name":"ci","key":"ci-internal-key-not-for-any-real-environment","capabilities":["tenant.provision"]}]',
  );
}

describe("the fin kill switch (BIB_FIN_ENABLED)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when unset, in every environment", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_ENABLED", undefined);
    expect(load().fin.enabled).toBe(false);
    vi.stubEnv("BIB_ENVIRONMENT", "production");
    vi.stubEnv("BIB_SESSION_COOKIE_SECURE", "true");
    expect(load().fin.enabled).toBe(false);
  });

  it("is on only for the exact word", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_ENABLED", "true");
    expect(load().fin.enabled).toBe(true);
    vi.stubEnv("BIB_FIN_ENABLED", "false");
    expect(load().fin.enabled).toBe(false);
    vi.stubEnv("BIB_FIN_ENABLED", "yes");
    expect(() => load()).toThrow(/BIB_FIN_ENABLED/);
  });
});

describe("the fin job's pool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is its own, capped at BIB_FIN_DB_POOL (3 by default), not the API's", async () => {
    stubBase();
    vi.stubEnv("BIB_FIN_DB_POOL", undefined);
    vi.stubEnv("BIB_DB_POOL_APP", "10");
    const wired = wireFinJob(load());
    // postgres.js connects lazily, so nothing here touches a database.
    expect(wired.pools.app.options.max).toBe(3);
    await wired.pools.close();
  });

  it("refuses a pool larger than ten", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_DB_POOL", "25");
    expect(() => load()).toThrow(/BIB_FIN_DB_POOL/);
  });
});
