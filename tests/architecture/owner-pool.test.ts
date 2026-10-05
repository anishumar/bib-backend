// B37 (audit 2026-10-03): the API and the worker built the OWNER pool, the
// one that bypasses RLS (bib_owner owns every table and no table forces its
// policies), and never used it. A connection pool nothing queries is still a
// credential loaded into the request process, and the first person to reach
// for `pools.owner` would have had a tenant-wall bypass waiting for them.
//
// The owner credential is now dialled by the migrator, plus one development-only
// command, `demo-history.ts`, which refuses to run outside development and
// back-dates the demo seed's one overdue invoice.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPools } from "../../src/db/pool";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the owner credential on the request path", () => {
  it("is not a pool the API or the worker holds", async () => {
    // postgres.js connects lazily, so building the pools dials nothing.
    const pools = createPools({
      ownerUrl: "postgres://bib_owner@127.0.0.1:1/never",
      appUrl: "postgres://bib_app:x@127.0.0.1:1/never",
      appPassword: "x",
      appPoolSize: 1,
      statementTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 60_000,
      connectTimeoutSeconds: 10,
    });
    expect(Object.keys(pools).sort()).toEqual(["app", "close"]);
    await pools.close();
  });

  it("is read by the migrator (and the development-only demo history) and nothing else in src/", () => {
    const readers = sourceFiles(join(process.cwd(), "src"))
      .filter((f) => readFileSync(f, "utf8").includes(".ownerUrl"))
      .map((f) => f.replace(process.cwd(), "").replace(/\\/g, "/"))
      .sort();
    expect(readers).toEqual(["/src/cmd/demo-history.ts", "/src/cmd/migrate.ts", "/src/config/config.ts"]);
  });
});
