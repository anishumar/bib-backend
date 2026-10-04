// CA#6 (audit 2026-10-03), proven against real Postgres: 0335 gives
// `invoice:issue` to EXACTLY the roles that held `tenant:admin`, so nothing
// changes for any firm the day issuing is split off administration.
//
// "Every role carrying tenant:admin" and not "the default partner role": a
// firm that renamed its partner role, or made an "Office admin" of its own,
// must not lose the ability to issue on the day of a deploy. So this test
// builds a firm with its OWN roles, a draft pending beside one of them, then
// runs 0335 over it (it is written to be re-runnable) and reads the rows back.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const MIGRATION = readFileSync("migrations/0335_invoice_issue_permission.up.sql", "utf8");

const stamp = String(Date.now());
let tenant = "";

interface RoleRow {
  version: number;
  status: string;
  permissions: string[];
}

async function versionsOf(key: string): Promise<RoleRow[]> {
  return owner<RoleRow[]>`
    SELECT v.version, v.status, ARRAY(SELECT jsonb_array_elements_text(v.body -> 'permissions')) AS permissions
      FROM config.version v
      JOIN config.entry e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id
     WHERE e.tenant_id = ${tenant} AND e.kind = 'role' AND e.key = ${key}
     ORDER BY v.version
  `;
}

async function role(key: string, versions: { status: string; permissions: string[] }[]): Promise<void> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenant}, 'role', ${key}) RETURNING id
  `;
  if (!entry) throw new Error("no entry");
  let n = 0;
  for (const v of versions) {
    n += 1;
    const body = { label: key, permissions: v.permissions };
    await owner`
      INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at, archived_at)
      VALUES (${tenant}, ${entry.id}, ${n}, ${v.status}, ${owner.json(body)},
              ${v.status === "draft" ? null : new Date()}, ${v.status === "archived" ? new Date() : null})
    `;
  }
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`invoice-issue-${stamp}`}, 'Invoice Issue Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;

  // The firm's OWN administrator role, not the default's name.
  await role("office_admin", [{ status: "published", permissions: ["party:read", "tenant:admin"] }]);
  // A role that never administered.
  await role("accounts", [{ status: "published", permissions: ["party:read", "party:write"] }]);
  // An administrator with a draft waiting beside what is in force.
  await role("senior_partner", [
    { status: "published", permissions: ["party:read", "tenant:admin", "proposal:approve"] },
    { status: "draft", permissions: ["party:read", "tenant:admin"] },
  ]);
  // Archived history is history: it is not rewritten.
  await role("old_admin", [
    { status: "archived", permissions: ["tenant:admin"] },
    { status: "published", permissions: ["party:read"] },
  ]);

  await owner.begin(async (tx) => {
    await tx.unsafe(MIGRATION);
  });
});

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("0335: invoice:issue for the roles that administered", () => {
  it("publishes a new version of a firm's own administrator role carrying invoice:issue", async () => {
    const rows = await versionsOf("office_admin");
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, "archived"],
      [2, "published"],
    ]);
    expect(rows[1]?.permissions).toEqual(["party:read", "tenant:admin", "invoice:issue"]);
    // The old version is untouched: a published version is frozen.
    expect(rows[0]?.permissions).toEqual(["party:read", "tenant:admin"]);
  });

  it("gives it to nobody who did not administer", async () => {
    const rows = await versionsOf("accounts");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permissions).not.toContain("invoice:issue");
    const old = await versionsOf("old_admin");
    expect(old.map((r) => r.permissions.includes("invoice:issue"))).toEqual([false, false]);
  });

  it("carries it into a draft waiting to be published, so publishing it later takes nothing away", async () => {
    const rows = await versionsOf("senior_partner");
    const draft = rows.find((r) => r.status === "draft");
    const live = rows.find((r) => r.status === "published");
    expect(draft?.permissions).toContain("invoice:issue");
    expect(live?.permissions).toContain("invoice:issue");
  });

  it("runs twice without doing anything the second time", async () => {
    const before = await versionsOf("office_admin");
    await owner.begin(async (tx) => {
      await tx.unsafe(MIGRATION);
    });
    expect(await versionsOf("office_admin")).toEqual(before);
  });
});
