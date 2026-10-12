// FinCompliance findings against real Postgres (0387): the properties no fake
// can prove. The GLOBAL table's grants and its one-value-a-day constraint; the
// seeded values held to the fake's copy; the dedupe key and one event per row
// created; RLS and the composite keys; the decision CHECKs and the 0308 blank;
// append-only by grant; and the membership key that says WHO decided works here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { systemIds } from "../../src/platform/ids";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { PostgresFinFirms } from "../../src/infrastructure/fin/postgres-intake";
import { PostgresFindingStore, PostgresRuleParameters } from "../../src/infrastructure/fin/postgres-findings";
import { LedgerService } from "../../src/usecase/ledger/service";
import { FindingService } from "../../src/usecase/fin/findings";
import { DeciderNotStaff, FindingNotFound } from "../../src/domain/fin/errors";
import type { FindingDraft } from "../../src/domain/fin/finding";
import { SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

const service = new FindingService({
  firms: new PostgresFinFirms(app),
  store: new PostgresFindingStore(app),
  parameters: new PostgresRuleParameters(app),
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
  ids: systemIds,
});

let firm = "";
let other = "";
let client = "";
let theirClient = "";
let priya = "";
let left = "";
let portalUser = "";
let stranger = "";
/** Whether the coordinator has added 0386's line key (see 0387's header). */
let lineKeyExists = false;

async function tenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status, fin_enabled_since)
    VALUES (${slug}, ${slug}, 'SGD', 'active', now()) RETURNING id
  `;
  return row?.id ?? "";
}

async function party(tenantId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  return row?.id ?? "";
}

async function person(
  tenantId: string,
  label: string,
  over: { audience?: string; active?: boolean; name?: string | null } = {},
): Promise<string> {
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`fin-${label}-${stamp}@example.test`}, ${over.name === undefined ? null : over.name}) RETURNING id
  `;
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenantId}, ${user?.id ?? ""}, ${over.audience ?? "STAFF"}, 'partner', ${over.active ?? true})
  `;
  return user?.id ?? "";
}

function draft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    lane: "rule",
    checkKey: "doc.gst_rate",
    clientPartyId: client,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    lineIds: [],
    facts: { gst: "46.00", expectedGst: "51.75", copies: 2, known: true, note: null },
    dedupeKey: `doc.gst_rate:${stamp}:${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

beforeAll(async () => {
  firm = await tenant(`fin-findings-${stamp}`);
  other = await tenant(`fin-findings-other-${stamp}`);
  client = await party(firm, "Lumen Cloudworks Pte Ltd");
  theirClient = await party(other, "Somebody Else Pte Ltd");
  priya = await person(firm, "priya", { name: "Priya Sharma" });
  left = await person(firm, "left", { active: false });
  portalUser = await person(firm, "portal", { audience: "CLIENT_PORTAL" });
  stranger = await person(other, "stranger");
  const [fk] = await owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conrelid = 'fin.finding_line'::regclass AND contype = 'f'
       AND confrelid = to_regclass('fin.transaction_line')
  `;
  lineKeyExists = (fk?.n ?? 0) > 0;
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("fin.rule_parameter: the law, GLOBAL and dated", () => {
  it("holds exactly the values the unit tests and the backtest use", async () => {
    const rows = await new PostgresRuleParameters(app).rows("SG");
    const strip = (r: { key: string; validFrom: string; validTo: string | null; value: unknown }) => ({
      key: r.key,
      validFrom: r.validFrom,
      validTo: r.validTo,
      value: r.value,
    });
    const byKeyDay = (a: { key: string; validFrom: string }, b: { key: string; validFrom: string }) =>
      a.key === b.key ? (a.validFrom < b.validFrom ? -1 : 1) : a.key < b.key ? -1 : 1;
    expect(rows.map(strip).sort(byKeyDay)).toEqual(SINGAPORE_PARAMETERS.map(strip).sort(byKeyDay));
    for (const r of rows) expect(r.source.length, r.key).toBeGreaterThan(20);
  });

  it("reads through the service into a set the checks can use", async () => {
    const sg = await service.parameters("SG");
    expect(sg.value("cpf.ow_ceiling", "2025-12-31")?.amount).toBe(740000n);
    expect(sg.value("cpf.ow_ceiling", "2026-01-01")?.amount).toBe(800000n);
  });

  it("is readable by the app role and nothing else: no write, no delete", async () => {
    const [n] = await app<{ n: number }[]>`SELECT count(*)::int AS n FROM fin.rule_parameter`;
    expect(n?.n).toBeGreaterThan(0);
    const refused = async (q: Promise<unknown>) => expect((await q.catch((e: unknown) => e)) as { code?: string }).toMatchObject({ code: "42501" });
    await refused(app`INSERT INTO fin.rule_parameter (jurisdiction, key, valid_from, value, source) VALUES ('SG', 'gst.standard_rate', '2030-01-01', '{"percent":"10"}', 'x')`);
    await refused(app`UPDATE fin.rule_parameter SET source = 'edited' WHERE key = 'gst.standard_rate'`);
    await refused(app`DELETE FROM fin.rule_parameter WHERE key = 'gst.standard_rate'`);
  });

  it("refuses two values for one key on one day, and a range that ends before it starts", async () => {
    // Rolled back whatever happens, so a constraint that failed to refuse
    // leaves no law behind it.
    const attempt = (sql: string) =>
      owner
        .begin(async (tx) => {
          await tx.unsafe(sql);
          throw new Error("the insert was accepted");
        })
        .catch((e: unknown) => e);
    expect(
      await attempt(`INSERT INTO fin.rule_parameter (jurisdiction, key, valid_from, valid_to, value, source)
                     VALUES ('SG', 'gst.standard_rate', '2025-06-01', '2025-07-01', '{"percent":"9"}', 'overlap')`),
    ).toMatchObject({ code: "23P01" });
    expect(
      await attempt(`INSERT INTO fin.rule_parameter (jurisdiction, key, valid_from, valid_to, value, source)
                     VALUES ('ZZ', 'gst.standard_rate', '2025-06-01', '2025-06-01', '{"percent":"9"}', 'empty')`),
    ).toMatchObject({ code: "23514" });
  });
});

describe("raising findings, once", () => {
  it("writes each once and one ledger event per row created", async () => {
    const drafts = [draft({ dedupeKey: `once-a-${stamp}` }), draft({ dedupeKey: `once-b-${stamp}`, checkKey: "doc.cutoff" })];
    expect(await service.raise(firm, drafts)).toMatchObject({ created: 2, existing: 0 });
    expect(await service.raise(firm, drafts)).toMatchObject({ created: 0, existing: 2 });
    const [rows] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM fin.finding WHERE tenant_id = ${firm} AND dedupe_key LIKE ${`once-%-${stamp}`}`;
    expect(rows?.n).toBe(2);
    const [events] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger.event WHERE tenant_id = ${firm} AND verb = 'fin.finding_raised'
    `;
    expect(events?.n).toBe(2);
  });

  it("two runs at once raise one row between them", async () => {
    const same = draft({ dedupeKey: `race-${stamp}` });
    const [a, b] = await Promise.all([service.raise(firm, [same]), service.raise(firm, [same])]);
    expect((a?.created ?? 0) + (b?.created ?? 0)).toBe(1);
  });

  it("keeps facts as a jsonb OBJECT, and refuses one that is not flat", async () => {
    const report = await service.raise(firm, [draft({ dedupeKey: `facts-${stamp}` })]);
    const [row] = await owner<{ kind: string; gst: string }[]>`
      SELECT jsonb_typeof(facts) AS kind, facts->>'gst' AS gst FROM fin.finding WHERE id = ${report.createdIds[0] ?? ""}
    `;
    expect(row).toEqual({ kind: "object", gst: "46.00" });
    const err = await withTenant(app, firm, (db) => db`
      INSERT INTO fin.finding (tenant_id, lane, check_key, client_party_id, period_start, period_end, facts, dedupe_key)
      VALUES (${firm}, 'rule', 'doc.x', ${client}, '2025-01-01', '2025-01-31', '{"nested":{"a":1}}'::jsonb, ${`nested-${stamp}`})
    `).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "23514" });
  });

  it("keeps the lines it is about (and, once 0386's key is added, only real ones)", async () => {
    const line = "00000000-0000-4000-8000-00000000e001";
    const attempt = service.raise(firm, [draft({ dedupeKey: `lines-${stamp}`, lineIds: [line, line] })]);
    if (lineKeyExists) {
      await expect(attempt).rejects.toMatchObject({ code: "23503" });
      return;
    }
    const report = await attempt;
    const found = await service.get(firm, report.createdIds[0] ?? "");
    expect(found.lineIds).toEqual([line]);
  });

  it("refuses a finding about another firm's client, by the composite key", async () => {
    await expect(service.raise(firm, [draft({ clientPartyId: theirClient, dedupeKey: `theirs-${stamp}` })])).rejects.toMatchObject({
      code: "23503",
    });
  });
});

describe("the tenant wall", () => {
  it("another firm sees none of this firm's findings, lines or decisions", async () => {
    const report = await service.raise(firm, [draft({ dedupeKey: `wall-${stamp}` })]);
    const id = report.createdIds[0] ?? "";
    await service.decide(firm, id, { decision: "correct", reasonCode: null, reasonText: null }, { userId: priya, actor: { type: "human", id: priya } });
    const seen = await withTenant(app, other, (db) => db<{ f: number; d: number; l: number }[]>`
      SELECT (SELECT count(*)::int FROM fin.finding WHERE tenant_id = ${firm}) AS f,
             (SELECT count(*)::int FROM fin.finding_decision WHERE tenant_id = ${firm}) AS d,
             (SELECT count(*)::int FROM fin.finding_line WHERE tenant_id = ${firm}) AS l
    `);
    expect(seen[0]).toEqual({ f: 0, d: 0, l: 0 });
    await expect(service.get(other, id)).rejects.toBeInstanceOf(FindingNotFound);
    // Another firm's id as the cursor is an empty page, never theirs.
    const page = await service.list(other, { clientPartyId: null, lane: null, checkKey: null, status: null, before: id, limit: 10 });
    expect(page.items).toEqual([]);
  });
});

describe("a person's decision", () => {
  let id = "";
  beforeAll(async () => {
    const report = await service.raise(firm, [draft({ dedupeKey: `decide-${stamp}`, checkKey: "payroll.sdl_missing" })]);
    id = report.createdIds[0] ?? "";
  });

  it("is appended, read back newest first with who made it, and logged by code", async () => {
    const by = { userId: priya, actor: { type: "human" as const, id: priya } };
    await service.decide(firm, id, { decision: "correct", reasonCode: null, reasonText: null }, by);
    const after = await service.decide(firm, id, { decision: "dismiss", reasonCode: "other", reasonText: "Ravi says the levy was paid separately." }, by);
    expect(after.status).toBe("dismiss");
    expect(after.decisions.map((d) => [d.decision, d.decidedByName])).toEqual([
      ["dismiss", "Priya Sharma"],
      ["correct", "Priya Sharma"],
    ]);
    expect(after.latestDecision?.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const events = await owner<{ payload: Record<string, unknown>; actor_id: string }[]>`
      SELECT payload, actor_id FROM ledger.event WHERE tenant_id = ${firm} AND verb = 'fin.finding_decided' AND object_id = ${id}
    `;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor_id === priya)).toBe(true);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("Ravi");
  });

  it("lists and counts by the latest decision", async () => {
    const all = { clientPartyId: client, lane: null, checkKey: "payroll.sdl_missing", before: null, limit: 50 } as const;
    const dismissed = await service.list(firm, { ...all, status: "dismiss" });
    expect(dismissed.items.map((f) => f.id)).toContain(id);
    expect(dismissed.items.find((f) => f.id === id)).toMatchObject({ clientName: "Lumen Cloudworks Pte Ltd", status: "dismiss" });
    const open = await service.list(firm, { ...all, status: "open" });
    expect(open.items.map((f) => f.id)).not.toContain(id);
    const sdl = dismissed.summary.byCheck.find((c) => c.checkKey === "payroll.sdl_missing");
    expect(sdl?.byStatus.dismiss).toBeGreaterThanOrEqual(1);
    expect(dismissed.summary.total).toBe(dismissed.summary.byCheck.reduce((n, c) => n + c.total, 0));
  });

  it("refuses somebody who has left, in the service", async () => {
    await expect(
      service.decide(firm, id, { decision: "correct", reasonCode: null, reasonText: null }, { userId: left, actor: { type: "human", id: left } }),
    ).rejects.toBeInstanceOf(DeciderNotStaff);
  });

  const insert = (over: { by?: string; decision?: string; code?: string | null; text?: string | null }) =>
    withTenant(app, firm, (db) => db`
      INSERT INTO fin.finding_decision (tenant_id, finding_id, decision, reason_code, reason_text, decided_by_user_id)
      VALUES (${firm}, ${id}, ${over.decision ?? "dismiss"}, ${over.code === undefined ? "expected" : over.code},
              ${over.text === undefined ? null : over.text}, ${over.by ?? priya})
    `).catch((e: unknown) => e);

  it("F4.2's CHECK: a dismissal with no reason code is refused by the database", async () => {
    expect(await insert({ code: null })).toMatchObject({ code: "23514" });
  });

  it("`other` needs words, and 0308's blank is no words", async () => {
    expect(await insert({ code: "other", text: null })).toMatchObject({ code: "23514" });
    expect(await insert({ code: "other", text: "\n\t\u00a0 \u3000" })).toMatchObject({ code: "23514" });
    expect(await insert({ code: "other", text: "x".repeat(2001) })).toMatchObject({ code: "23514" });
    expect(await insert({ code: "other", text: "Written off with the partner." })).not.toBeInstanceOf(Error);
  });

  it("a reason only on a dismissal", async () => {
    expect(await insert({ decision: "correct", code: "one_off" })).toMatchObject({ code: "23514" });
    expect(await insert({ decision: "correct", code: null, text: "because" })).toMatchObject({ code: "23514" });
    expect(await insert({ decision: "ask_client", code: null })).not.toBeInstanceOf(Error);
  });

  it("the decider is STAFF of THIS firm: not another firm's, not a portal login", async () => {
    expect(await insert({ by: stranger })).toMatchObject({ code: "23503" });
    expect(await insert({ by: portalUser })).toMatchObject({ code: "23503" });
  });

  it("is append-only for the app role, as are the findings and their lines", async () => {
    const refused = async (q: Promise<unknown>) => expect((await q.catch((e: unknown) => e)) as { code?: string }).toMatchObject({ code: "42501" });
    await refused(withTenant(app, firm, (db) => db`UPDATE fin.finding_decision SET decision = 'correct' WHERE finding_id = ${id}`));
    await refused(withTenant(app, firm, (db) => db`DELETE FROM fin.finding_decision WHERE finding_id = ${id}`));
    await refused(withTenant(app, firm, (db) => db`UPDATE fin.finding SET check_key = 'doc.x' WHERE id = ${id}`));
    await refused(withTenant(app, firm, (db) => db`DELETE FROM fin.finding WHERE id = ${id}`));
    await refused(withTenant(app, firm, (db) => db`DELETE FROM fin.finding_line WHERE finding_id = ${id}`));
  });
});
