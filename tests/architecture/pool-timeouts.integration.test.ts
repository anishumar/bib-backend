// F-06-2 (audit 2026-09-23) against a REAL database: every app connection
// carries the server-side limits, so a stuck statement is ended by Postgres
// and its pool slot comes back.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/architecture/pool-timeouts.integration.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { load } from "../../src/config/config";
import { createPools } from "../../src/db/pool";

const cfg = load();
const pools = createPools({ ...cfg.db, statementTimeoutMs: 400, idleInTransactionTimeoutMs: 60_000 });

afterAll(async () => {
  await pools.close();
});

describe("the app pool's server-side limits (F-06-2)", () => {
  it("are set on the connection, from the config", async () => {
    const [st] = await pools.app<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    const [idle] = await pools.app<{ idle_in_transaction_session_timeout: string }[]>`SHOW idle_in_transaction_session_timeout`;
    expect(st?.statement_timeout).toBe("400ms");
    expect(idle?.idle_in_transaction_session_timeout).toBe("1min");
  });

  it("end a statement that runs past it, and the pool still answers", async () => {
    await expect(pools.app`SELECT pg_sleep(2)`).rejects.toThrow(/statement timeout/);
    const [one] = await pools.app<{ n: number }[]>`SELECT 1 AS n`;
    expect(one?.n).toBe(1);
  });

  it("default to 30 s and 60 s, connecting gives up after 10 s", () => {
    expect([cfg.db.statementTimeoutMs, cfg.db.idleInTransactionTimeoutMs, cfg.db.connectTimeoutSeconds]).toEqual([
      30_000, 60_000, 10,
    ]);
  });
});
