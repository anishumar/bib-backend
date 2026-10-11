// Fin's 503 against a real Postgres (F0.6): what the driver ACTUALLY throws
// when fin's statement timeout fires, or when there is no database to reach,
// is what `withFinRead` turns into `FinUnavailable`. A unit test can only hand
// the helper a code somebody typed; this proves the code Postgres sends.
//
// The timeout is 50 ms against a one-second sleep rather than fin's five
// seconds, through the parameter that exists for exactly this.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withFinRead } from "../../src/infrastructure/fin/unavailable";
import { PostgresFinFirms, PostgresIntakeRepository } from "../../src/infrastructure/fin/postgres-intake";
import { FinUnavailable } from "../../src/domain/fin/errors";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
// Nothing listens on port 1: the connection is refused at once.
const nowhere = postgres("postgres://bib_app:nothing@127.0.0.1:1/nowhere", {
  max: 1,
  connect_timeout: 2,
  onnotice: () => undefined,
});
const stamp = Date.now().toString(36);
let firm = "";

beforeAll(async () => {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status, fin_enabled_since)
    VALUES (${`fin-503-${stamp}`}, 'Fin 503', 'SGD', 'active', now()) RETURNING id
  `;
  firm = row?.id ?? "";
});

afterAll(async () => {
  await Promise.all([
    owner.end({ timeout: 5 }),
    app.end({ timeout: 5 }),
    nowhere.end({ timeout: 0 }),
  ]);
});

describe("fin's reads when the database does not answer", () => {
  it("turns its statement timeout (57014) into FinUnavailable, with the driver's error as the cause", async () => {
    const failure = await withFinRead(app, firm, "a slow read", (db) => db`SELECT pg_sleep(1)`, 50).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(FinUnavailable);
    expect((failure as FinUnavailable).cause).toMatchObject({ code: "57014" });
  });

  it("sets the timeout for that transaction only: the same connection is not capped after it", async () => {
    // ONE connection, so the read after it is on the very session the timeout
    // was set on: `set_config(..., true)` is SET LOCAL and ends with the
    // transaction, and a core request borrowing that connection next must not
    // inherit fin's five seconds.
    const single = postgres(cfg.db.appUrl, { max: 1 });
    try {
      await withFinRead(single, firm, "a slow read", (db) => db`SELECT pg_sleep(1)`, 50).catch(() => undefined);
      const [row] = await single<{ t: string }[]>`SELECT current_setting('statement_timeout') AS t`;
      expect(row?.t).not.toBe("50ms");
    } finally {
      await single.end({ timeout: 5 });
    }
  });

  it("turns a database it cannot reach into FinUnavailable", async () => {
    await expect(withFinRead(nowhere, firm, "a read", (db) => db`SELECT 1`)).rejects.toBeInstanceOf(
      FinUnavailable,
    );
    await expect(new PostgresFinFirms(nowhere).enabledSince(firm)).rejects.toBeInstanceOf(FinUnavailable);
    await expect(new PostgresIntakeRepository(nowhere).summary(firm, null)).rejects.toBeInstanceOf(
      FinUnavailable,
    );
  });

  it("leaves a real bug alone: a failing query still reaches the mapper as itself", async () => {
    const failure = await withFinRead(app, firm, "a broken read", (db) => db`SELECT 1 / 0`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).not.toBeInstanceOf(FinUnavailable);
    expect(failure).toMatchObject({ code: "22012" });
  });

  it("answers normally when the database is fine", async () => {
    expect(await new PostgresFinFirms(app).enabledSince(firm)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await new PostgresIntakeRepository(app).summary(firm, null)).toMatchObject({ total: 0 });
  });
});
