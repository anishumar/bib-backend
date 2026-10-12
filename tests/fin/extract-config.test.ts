// The AI reader's configuration (F2.4): off unless chosen, fail closed on a
// half-made choice, and the key is a credential that no log, no config dump and
// no refusal ever prints. Also what `setup/fin.ts` builds from it.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { load, redacted } from "../../src/config/config";
import { validateServer } from "../../src/config/validate";
import { createPools } from "../../src/db/pool";
import { UnavailableVisionReader, VisionReader } from "../../src/usecase/fin/extract";
import { extractOneFile, visionReader } from "../../src/setup/fin";
import { FakeImageNormaliser } from "../../src/testfakes/fin-extract";

const KEY = "sk-ant-api03-NOT-A-REAL-KEY-config-test-0123456789";

function stubBase(): void {
  vi.stubEnv("BIB_ENVIRONMENT", "development");
  vi.stubEnv("BIB_DATABASE_URL", "postgres://owner:secret@localhost:5434/bib");
  vi.stubEnv("BIB_APP_DATABASE_URL", "postgres://bib_app:secret@localhost:5434/bib");
  vi.stubEnv(
    "BIB_INTERNAL_KEYS",
    '[{"name":"ci","key":"ci-internal-key-not-for-any-real-environment","capabilities":["tenant.provision"]}]',
  );
  for (const k of [
    "BIB_FIN_AI_PROVIDER",
    "BIB_FIN_ANTHROPIC_API_KEY",
    "BIB_FIN_AI_MODEL",
    "BIB_FIN_AI_RUN_CAP",
    "BIB_FIN_AI_MONTHLY_TOKENS",
    "BIB_FIN_AI_TIMEOUT_MS",
  ]) {
    vi.stubEnv(k, undefined);
  }
}

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a refusal");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the AI provider", () => {
  it("is none when unset, with the defaults the reader is built for", () => {
    stubBase();
    expect(load().finAi).toEqual({
      provider: "none",
      anthropicApiKey: null,
      model: "claude-sonnet-5-5",
      runCap: 50,
      monthlyTokens: 20_000_000,
      timeoutMs: 120_000,
    });
  });

  it("takes anthropic with a key, and the three models the request is shaped for", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_AI_PROVIDER", "anthropic");
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", KEY);
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]) {
      vi.stubEnv("BIB_FIN_AI_MODEL", model);
      const cfg = load();
      expect(cfg.finAi.provider).toBe("anthropic");
      expect(cfg.finAi.model).toBe(model);
      expect(cfg.finAi.anthropicApiKey?.reveal()).toBe(KEY);
    }
  });

  it("refuses a provider, a model or a cap nobody defined", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_AI_PROVIDER", "openai");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_PROVIDER/);
    stubBase();
    vi.stubEnv("BIB_FIN_AI_MODEL", "claude-3-opus");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_MODEL/);
    stubBase();
    vi.stubEnv("BIB_FIN_AI_RUN_CAP", "0");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_RUN_CAP/);
    stubBase();
    vi.stubEnv("BIB_FIN_AI_RUN_CAP", "501");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_RUN_CAP/);
    stubBase();
    vi.stubEnv("BIB_FIN_AI_MONTHLY_TOKENS", "-5");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_MONTHLY_TOKENS/);
    stubBase();
    vi.stubEnv("BIB_FIN_AI_TIMEOUT_MS", "100");
    expect(refusal(() => load())).toMatch(/BIB_FIN_AI_TIMEOUT_MS/);
  });

  it("reads an empty key as unset, as Docker writes a variable nobody passed", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", "");
    expect(load().finAi.anthropicApiKey).toBeNull();
  });

  it("refuses anthropic with no key at boot, naming the variable, in any environment", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_AI_PROVIDER", "anthropic");
    const message = refusal(() => {
      validateServer(load());
    });
    expect(message).toMatch(/^BIB_FIN_AI_PROVIDER=anthropic but BIB_FIN_ANTHROPIC_API_KEY is not set/);
  });

  it("boots with no provider, and with a key that is set but unused", () => {
    stubBase();
    expect(() => {
      validateServer(load());
    }).not.toThrow();
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", KEY);
    expect(() => {
      validateServer(load());
    }).not.toThrow();
  });
});

describe("the key is a credential", () => {
  it("is refused when malformed, and the refusal never repeats it", () => {
    stubBase();
    const typo = `"${KEY}"`;
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", typo);
    const message = refusal(() => load());
    expect(message).toMatch(/BIB_FIN_ANTHROPIC_API_KEY/);
    expect(message).toContain("the value is not shown");
    expect(message).not.toContain("NOT-A-REAL-KEY");
  });

  it("prints as [redacted] however the config is logged", () => {
    stubBase();
    vi.stubEnv("BIB_FIN_AI_PROVIDER", "anthropic");
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", KEY);
    const cfg = load();
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    expect(inspect(cfg, { depth: 10 })).not.toContain(KEY);
    expect(String(cfg.finAi.anthropicApiKey)).toBe("[redacted]");
    expect(`${String(cfg.finAi.anthropicApiKey)}`).not.toContain(KEY);
    const dump = redacted(cfg);
    expect(JSON.stringify(dump)).not.toContain(KEY);
    expect(dump.finAi).toMatchObject({ provider: "anthropic", anthropicApiKey: "***" });
  });
});

describe("what setup builds", () => {
  it("builds the reader that answers later when there is no provider, still named vision", async () => {
    stubBase();
    const cfg = load();
    const pools = createPools({ ...cfg.db, appPoolSize: 1 });
    try {
      const reader = visionReader(cfg, pools.app, { images: new FakeImageNormaliser(), pdfText: null });
      expect(reader).toBeInstanceOf(UnavailableVisionReader);
      expect(reader.name).toBe("vision");
    } finally {
      await pools.close();
    }
  });

  it("builds the Claude reader when a provider and key are set, without calling anything", async () => {
    stubBase();
    vi.stubEnv("BIB_FIN_AI_PROVIDER", "anthropic");
    vi.stubEnv("BIB_FIN_ANTHROPIC_API_KEY", KEY);
    const cfg = load();
    const pools = createPools({ ...cfg.db, appPoolSize: 1 });
    try {
      const reader = visionReader(cfg, pools.app, { images: new FakeImageNormaliser(), pdfText: null });
      expect(reader).toBeInstanceOf(VisionReader);
      expect(JSON.stringify(reader)).not.toContain(KEY);
    } finally {
      await pools.close();
    }
  });

  it("refuses the one-file try with no provider, before reading anything", async () => {
    stubBase();
    await expect(
      extractOneFile(load(), { bytes: new Uint8Array([1]), filename: "x.pdf", mediaType: "application/pdf" }, null),
    ).rejects.toThrow(/BIB_FIN_AI_PROVIDER=none/);
  });
});
