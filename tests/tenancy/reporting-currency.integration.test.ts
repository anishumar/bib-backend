// The reporting currency, proven where it actually has to hold: the database.
//
// The design of T2.2's money modelling rests on one claim — a firm cannot exist
// without somebody having said what its books are kept in. Every FX rate stored
// later is struck against this code, so a wrong one does not fail: it silently
// makes every converted total wrong, with no error anywhere. That claim is only
// true if the COLUMN enforces it, not merely the zod schema and the service.
// Both of those can be bypassed by a migration, a backfill, or a psql session —
// the same reasoning that put the config-version freeze in a trigger rather than
// in application code (0005).
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });

const stamp = Date.now().toString(36);

afterAll(async () => {
  await owner`DELETE FROM tenancy.tenant WHERE slug LIKE ${`currency-test-%${stamp}`}`;
  await owner.end();
});

describe("tenancy.tenant.reporting_currency", () => {
  it("refuses a firm that does not state one — there is no default to fall back on", async () => {
    await expect(
      owner`
        INSERT INTO tenancy.tenant (slug, name)
        VALUES (${`currency-test-none-${stamp}`}, 'No Books')
      `,
    ).rejects.toMatchObject({ code: "23502" }); // not_null_violation
  });

  it.each([["inr"], ["Rs"], ["RUPEE"], ["IN1"]])(
    "refuses %j as a currency code, even from the owner role",
    async (currency) => {
      // The owner is the role migrations run as. If the check lived only in the
      // application, a backfill written six months from now would walk straight
      // past it and leave rows nothing downstream can compare.
      await expect(
        owner`
          INSERT INTO tenancy.tenant (slug, name, reporting_currency)
          VALUES (${`currency-test-bad-${stamp}`}, 'Bad Books', ${currency})
        `,
      ).rejects.toMatchObject({ code: "23514" }); // check_violation
    },
  );

  it("accepts a well-formed code", async () => {
    const [row] = await owner<{ reporting_currency: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`currency-test-ok-${stamp}`}, 'Gulf Advisory', 'AED')
      RETURNING reporting_currency
    `;
    expect(row?.reporting_currency).toBe("AED");
  });
});
