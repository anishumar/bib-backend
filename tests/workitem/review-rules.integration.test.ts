// The firm's review rules, read where it has to hold: the database (audit
// 2026-10-03, CA#27).
//
// A task names no rule, so the one the firm has in force is applied when the
// sender names none. That makes `publishedPolicies` a read every Send for
// review leans on, and three things about it only a real database can show:
// only PUBLISHED versions count (a draft is not a rule in force), a body that
// no longer reads as a policy is left out rather than thrown, and RLS keeps one
// firm's rules out of another's answer.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/workitem/review-rules.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const config = new PostgresConfigRepository(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();

let firmA: string;
let firmB: string;

async function firm(slug: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${slug}, ${slug}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("no firm");
  // A complete task and filing vocabulary: calendar.integration.test.ts checks
  // every firm in the database has one.
  await owner`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${t.id}, 'not_started', 'Not Started', true, false, false, 10),
           (${t.id}, 'completed', 'Completed', false, true, true, 90)
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${t.id}, 'pending', 'Pending', true, 10)
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${t.id}, 'filed', 'Filed', true, true, 90)
  `;
  return t.id;
}

async function rule(
  tenantId: string,
  key: string,
  body: Record<string, unknown>,
  status: "published" | "draft",
): Promise<string> {
  const entryId = ref();
  await owner`INSERT INTO config.entry (id, tenant_id, kind, key) VALUES (${entryId}, ${tenantId}, 'verification_policy', ${key})`;
  const versionId = ref();
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${versionId}, ${tenantId}, ${entryId}, 1, ${status},
            ${owner.json(body as postgres.JSONValue)},
            ${status === "published" ? new Date().toISOString() : null}::timestamptz)
  `;
  return versionId;
}

let managerVersion: string;

beforeAll(async () => {
  firmA = await firm(`rules-a-${stamp}`);
  firmB = await firm(`rules-b-${stamp}`);
  managerVersion = await rule(
    firmA,
    "manager_review",
    { label: "Manager review", rule: "rank_threshold", minGradeRank: 7, minGradeCode: "manager" },
    "published",
  );
  await rule(
    firmA,
    "eqcr",
    { label: "Quality review", rule: "rank_threshold", minGradeRank: 10, minGradeCode: "partner" },
    "draft",
  );
  // Published, and no longer a policy body: left out, never thrown.
  await rule(firmA, "broken", { label: "Broken" }, "published");
  await rule(
    firmB,
    "line_manager",
    { label: "Their line manager", rule: "reporting_line", minGradeRank: null, minGradeCode: null },
    "published",
  );
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("the review rules a task is checked under (CA#27)", () => {
  it("are the firm's PUBLISHED, readable rules, by key, and no other firm's", async () => {
    const rules = await config.publishedPolicies(firmA);
    expect(rules.map((r) => ({ key: r.key, versionId: r.versionId, label: r.policy.label }))).toEqual([
      { key: "manager_review", versionId: managerVersion, label: "Manager review" },
    ]);
    expect((await config.publishedPolicies(firmB)).map((r) => r.key)).toEqual(["line_manager"]);
  });
});
