// Architecture as a test. This runs the same dependency-cruiser rule set as
// `npm run arch`, so the import wall (§ CLAUDE.md) is verified on every test
// run — a violation goes red here, naming the file and the rule, before it can
// reach a reviewer. This is the slowest test in the suite by design; that is
// the price of making architectural erosion impossible.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("architecture", () => {
  it("import boundaries hold (dependency-cruiser)", () => {
    const bin = resolve("node_modules/.bin/depcruise");
    try {
      execFileSync(bin, ["src", "--config", ".dependency-cruiser.cjs"], { stdio: "pipe" });
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      const out = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`.trim();
      expect.fail(`architecture violations:\n${out}`);
    }
  });
});
