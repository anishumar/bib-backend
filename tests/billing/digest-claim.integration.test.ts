// The weekly advance summary's claim, against real SQL (audit 2026-10-03,
// B16): a claim given back because every send failed can be taken again on
// the next pass, and a week actually sent cannot be given back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresAdvanceDigestStore } from "../../src/infrastructure/postgres/advance-reminders";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const store = new PostgresAdvanceDigestStore(app);
const stamp = Date.now().toString(36);
let tenant = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`digest-${stamp}`}, 'Digest firm', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  tenant = t?.id ?? "";
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("a digest week's claim", () => {
  it("is held until released, and a released week is claimed again", async () => {
    expect(await store.claim(tenant, "2026-10-12")).toBe(true);
    // Held: a second pass the same hour does not send it twice.
    expect(await store.claim(tenant, "2026-10-12")).toBe(false);
    await store.release(tenant, "2026-10-12");
    expect(await store.claim(tenant, "2026-10-12")).toBe(true);
  });

  it("cannot be released once the week was sent", async () => {
    expect(await store.claim(tenant, "2026-10-19")).toBe(true);
    await store.markSent(tenant, "2026-10-19", 2, 1);
    await store.release(tenant, "2026-10-19");
    expect(await store.claim(tenant, "2026-10-19")).toBe(false);
  });
});
