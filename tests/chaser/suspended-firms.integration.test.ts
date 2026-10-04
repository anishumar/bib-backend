// A suspended firm's clients are never chased or nudged (audit 2026-10-03,
// B14). The chaser's and the nudge's tenant lists read every row of
// `tenancy.tenant` with no `status = 'active'`, unlike every other sweep, so a
// firm suspended through /internal kept emailing its clients reminders.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresChaserTenants } from "../../src/infrastructure/postgres/chaser-repository";
import { PostgresNudgeTenants } from "../../src/infrastructure/postgres/nudge-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

let active = "";
let suspended = "";

beforeAll(async () => {
  const rows = await owner<{ id: string; slug: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status)
    VALUES (${`chase-on-${stamp}`}, 'Still trading', 'INR', 'active'),
           (${`chase-off-${stamp}`}, 'Suspended', 'INR', 'suspended')
    RETURNING id, slug
  `;
  active = rows.find((r) => r.slug.startsWith("chase-on"))?.id ?? "";
  suspended = rows.find((r) => r.slug.startsWith("chase-off"))?.id ?? "";
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("the tenant lists the chaser and the nudge sweep", () => {
  it("leave out a suspended firm and keep an active one (chaser)", async () => {
    const ids = await new PostgresChaserTenants(app).activeTenantIds();
    expect(ids).toContain(active);
    expect(ids).not.toContain(suspended);
  });

  it("leave out a suspended firm and keep an active one (nudge)", async () => {
    const ids = await new PostgresNudgeTenants(app).activeTenantIds();
    expect(ids).toContain(active);
    expect(ids).not.toContain(suspended);
  });
});
