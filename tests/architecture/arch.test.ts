// Architecture as a test. This runs the same dependency-cruiser rule set as
// `npm run arch`, so the import wall (§ CLAUDE.md) is verified on every test
// run — a violation goes red here, naming the file and the rule, before it can
// reach a reviewer. This is the slowest test in the suite by design; that is
// the price of making architectural erosion impossible.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// dependency-cruiser runs in a child process over the whole tree: three
// seconds quiet, past vitest's default 5 s on a loaded machine. Real work,
// not a hang: this file gets room for it (S7).
vi.setConfig({ testTimeout: 30_000 });

describe("architecture", () => {
  it("import boundaries hold (dependency-cruiser)", () => {
    // The package's own entry point rather than node_modules/.bin/depcruise:
    // that shim is extensionless, which execFileSync cannot spawn on Windows
    // (ENOENT), and its .cmd sibling needs a shell. Going through node is the
    // one form that works on every platform without one.
    const cli = resolve("node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
    try {
      execFileSync(process.execPath, [cli, "src", "--config", ".dependency-cruiser.cjs"], {
        stdio: "pipe",
      });
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      const out = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`.trim();
      expect.fail(`architecture violations:\n${out}`);
    }
  });
});
