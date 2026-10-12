// 0388 against real Postgres: `books:write` reaches every role carrying
// `work:write`, the firm's own included, by 0382's method. The migration is
// re-runnable, so the test runs its UP file again over a firm built for it:
// a published role (archived and re-published with it), a draft (edited in
// place), a role without `work:write` (left alone), and one that already has
// it (left alone). A second run changes nothing.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const stamp = Date.now().toString(36);
const UP = readFileSync("migrations/0388_books_write_permission.up.sql", "utf8");

let firm = "";
const entries: Record<string, string> = {};

async function role(key: string, status: "published" | "draft", permissions: string[]): Promise<void> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${firm}, 'role', ${key}) RETURNING id
  `;
  entries[key] = entry?.id ?? "";
  const body = JSON.stringify({ label: key, permissions });
  await owner`
    INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
    VALUES (${firm}, ${entry?.id ?? ""}, 1, ${status}, ${body}::text::jsonb,
            CASE WHEN ${status} = 'published' THEN now() END)
  `;
}

async function versions(key: string) {
  return owner<{ version: number; status: string; permissions: string[] }[]>`
    SELECT version, status, ARRAY(SELECT jsonb_array_elements_text(body -> 'permissions')) AS permissions
      FROM config.version WHERE entry_id = ${entries[key] ?? ""} ORDER BY version
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`books-write-${stamp}`}, 'Books Write', 'SGD') RETURNING id
  `;
  firm = t?.id ?? "";
  // The firm's OWN role, renamed and edited: still carries work:write.
  await role("senior_analyst", "published", ["party:read", "work:write", "books:read"]);
  await role("trainee", "draft", ["party:read", "work:write"]);
  await role("viewer", "published", ["party:read", "books:read"]);
  await role("already", "published", ["work:write", "books:write"]);
  await owner.begin((tx) => tx.unsafe(UP));
}, 120_000);

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("0388: books:write onto every role carrying work:write", () => {
  it("re-publishes a published role with it, archiving what it replaced", async () => {
    const rows = await versions("senior_analyst");
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, "archived"],
      [2, "published"],
    ]);
    expect(rows[1]?.permissions).toEqual(["party:read", "work:write", "books:read", "books:write"]);
    expect(rows[0]?.permissions).not.toContain("books:write");
  });

  it("edits a draft in place, so publishing it later keeps it", async () => {
    const rows = await versions("trainee");
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "draft"]]);
    expect(rows[0]?.permissions).toContain("books:write");
  });

  it("leaves a role without work:write, and one already carrying it, alone", async () => {
    expect((await versions("viewer")).map((r) => [r.version, r.permissions.includes("books:write")])).toEqual([[1, false]]);
    expect((await versions("already")).map((r) => r.version)).toEqual([1]);
  });

  it("changes nothing the second time", async () => {
    await owner.begin((tx) => tx.unsafe(UP));
    expect((await versions("senior_analyst")).map((r) => r.version)).toEqual([1, 2]);
    expect((await versions("trainee"))[0]?.permissions.filter((p) => p === "books:write")).toHaveLength(1);
  });

  it("leaves no published role anywhere with work:write and without books:write", async () => {
    const [n] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM config.version v JOIN config.entry e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id
       WHERE e.kind = 'role' AND v.status IN ('published', 'draft')
         AND jsonb_typeof(v.body -> 'permissions') = 'array'
         AND jsonb_exists(v.body -> 'permissions', 'work:write')
         AND NOT jsonb_exists(v.body -> 'permissions', 'books:write')
    `;
    expect(n?.n).toBe(0);
  });
});
