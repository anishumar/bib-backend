// V0.2: which build is running. The Dockerfile turns its COMMIT_SHA and
// BUILD_TIME build args into BIB_BUILD_COMMIT and BIB_BUILD_TIME, and GET
// /health reports them. Docker makes an ARG with no value an EMPTY variable, so
// "built without the args" arrives as "" and must read as not stamped, while a
// value that IS present must be well-formed: a garbled stamp is refused at boot
// rather than reported as a SHA nobody can check out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { load } from "../../src/config/config";

function stubBase(): void {
  // The four variables with no default, so load() runs without a .env (CI).
  // BIB_INTERNAL_KEYS was missing: a checkout with a .env passed and CI, which
  // has none, did not.
  vi.stubEnv("BIB_ENVIRONMENT", "development");
  vi.stubEnv("BIB_DATABASE_URL", "postgres://owner:secret@localhost:5434/bib");
  vi.stubEnv("BIB_APP_DATABASE_URL", "postgres://bib_app:secret@localhost:5434/bib");
  vi.stubEnv(
    "BIB_INTERNAL_KEYS",
    '[{"name":"ci","key":"ci-internal-key-not-for-any-real-environment","capabilities":["tenant.provision"]}]',
  );
}

describe("the build stamp (V0.2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when the image was not stamped", () => {
    stubBase();
    vi.stubEnv("BIB_BUILD_COMMIT", "");
    vi.stubEnv("BIB_BUILD_TIME", "");
    expect(load().build).toEqual({ commit: null, builtAt: null });
  });

  it("carries the commit and the build time when it was", () => {
    stubBase();
    vi.stubEnv("BIB_BUILD_COMMIT", "32fbca3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a");
    vi.stubEnv("BIB_BUILD_TIME", "2026-09-28T18:30:00Z");
    expect(load().build).toEqual({
      commit: "32fbca3c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
      builtAt: "2026-09-28T18:30:00Z",
    });
  });

  it("refuses a stamp that is not a commit SHA, naming the variable", () => {
    stubBase();
    vi.stubEnv("BIB_BUILD_COMMIT", "manual");
    expect(() => load()).toThrow(/BIB_BUILD_COMMIT/);
  });

  it("refuses a build time that is not an instant, naming the variable", () => {
    stubBase();
    vi.stubEnv("BIB_BUILD_TIME", "yesterday");
    expect(() => load()).toThrow(/BIB_BUILD_TIME/);
  });
});
