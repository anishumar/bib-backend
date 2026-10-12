// The AI reader's call record against real Postgres (0389, F2.4): what no fake
// can prove. The tenant wall (RLS, and the intake item referenced WITH its
// tenant), append-only by grant, the CHECKs that tie a failure to a transport
// error and a class to an answer, and the two questions the reader asks of it:
// the firm's spend in its OWN month, and whether a refused file is the file's
// fault. And whose books a client's files are, for the prompt.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { NO_TOKENS } from "../../src/domain/fin/extraction-usage";
import {
  PostgresBooksOwners,
  PostgresExtractionUsage,
} from "../../src/infrastructure/fin/postgres-extraction";
import type { NewUsageRow } from "../../src/usecase/fin/extract-ports";
import { systemIds } from "../../src/platform/ids";

// Room per file (S7's rule): creating a firm validates its time zone against
// `pg_timezone_names`, which reads the zone database and takes seconds on a
// connection's first call.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

const usage = new PostgresExtractionUsage(app);
const owners = new PostgresBooksOwners(app);

let firm = "";
let other = "";
let client = "";
let otherClient = "";
const items: Record<string, string> = {};

async function tenant(slug: string, zone = "UTC"): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status, time_zone)
    VALUES (${slug}, ${slug}, 'SGD', 'active', ${zone}) RETURNING id
  `;
  return row?.id ?? "";
}

async function intakeItem(tenantId: string, label: string): Promise<string> {
  const [doc] = await owner<{ id: string }[]>`
    INSERT INTO files.document (tenant_id, title, origin, kind)
    VALUES (${tenantId}, ${label}, 'uploaded', 'books_input') RETURNING id
  `;
  const hash = Buffer.from(`${label}-${stamp}`).toString("hex").padEnd(64, "0").slice(0, 64);
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO files.document_version
      (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename, storage_key)
    VALUES (${tenantId}, ${doc?.id ?? ""}, 1, ${hash}, 2048, 'application/pdf', ${`${label}.pdf`},
            ${`${tenantId}/${hash.slice(0, 2)}/${hash}`})
    RETURNING id
  `;
  const [item] = await owner<{ id: string }[]>`
    INSERT INTO fin.intake_item (tenant_id, document_version_id, media_type, byte_size, route, route_basis)
    VALUES (${tenantId}, ${version?.id ?? ""}, 'application/pdf', 2048, 'pdf', 'media_type')
    RETURNING id
  `;
  return item?.id ?? "";
}

function row(over: Partial<NewUsageRow> & { tenantId: string; intakeItemId: string }): NewUsageRow {
  return {
    id: systemIds.newId(),
    model: "claude-sonnet-5-5",
    promptVersion: "fin-doc@1",
    attempt: 1,
    usage: { inputTokens: 4000, outputTokens: 800, cacheWriteTokens: 0, cacheReadTokens: 2600 },
    outcome: "ok",
    failure: null,
    docClass: "purchase_invoice",
    requestId: "req_011CTkIntegration",
    ...over,
  };
}

/** A row written as the owner, at a chosen instant: the month's edges. */
async function rowAt(tenantId: string, intakeItemId: string, at: string, inputTokens: number): Promise<void> {
  await owner`
    INSERT INTO fin.extraction_usage
      (tenant_id, intake_item_id, model, prompt_version, attempt, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens, outcome, doc_class, created_at)
    VALUES (${tenantId}, ${intakeItemId}, 'claude-sonnet-5-5', 'fin-doc@1', 1, ${inputTokens}, 0, 0, 0,
            'ok', 'receipt', ${at})
  `;
}

beforeAll(async () => {
  // Singapore: midnight on the 1st is 16:00 UTC the day before.
  firm = await tenant(`fin-x-${stamp}`, "Asia/Singapore");
  other = await tenant(`fin-x-other-${stamp}`);
  items.a = await intakeItem(firm, "a");
  items.b = await intakeItem(firm, "b");
  items.edges = await intakeItem(firm, "edges");
  items.otherFirm = await intakeItem(other, "other");

  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${firm}, 'organization', 'Lumen Cloudworks') RETURNING id
  `;
  client = party?.id ?? "";
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name, trade_name)
    VALUES (${client}, ${firm}, 'Lumen Cloudworks Pte Ltd', 'Lumen Cloudworks')
  `;
  await owner`
    INSERT INTO core.party_identifier (tenant_id, party_id, type, value, valid_from, valid_to)
    VALUES (${firm}, ${client}, 'uen', '202134890G', '2021-01-01', NULL),
           (${firm}, ${client}, 'vat', 'M1-0000000-0', '2021-01-01', '2024-01-01'),
           (${firm}, ${client}, 'vat', 'M2-9588401-7', '2024-01-01', NULL)
  `;
  const [theirs] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${other}, 'organization', 'Somebody Else Pte Ltd') RETURNING id
  `;
  otherClient = theirs?.id ?? "";
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("fin.extraction_usage", () => {
  it("records a call, every column the reader keeps", async () => {
    const r = row({ tenantId: firm, intakeItemId: items.a ?? "" });
    await usage.record(r);
    const [stored] = await owner<Record<string, unknown>[]>`
      SELECT model, prompt_version, attempt, input_tokens, output_tokens, cache_write_tokens,
             cache_read_tokens, outcome, failure, doc_class, provider_request_id
        FROM fin.extraction_usage WHERE id = ${r.id}
    `;
    expect(stored).toEqual({
      model: "claude-sonnet-5-5",
      prompt_version: "fin-doc@1",
      attempt: 1,
      input_tokens: 4000,
      output_tokens: 800,
      cache_write_tokens: 0,
      cache_read_tokens: 2600,
      outcome: "ok",
      failure: null,
      doc_class: "purchase_invoice",
      provider_request_id: "req_011CTkIntegration",
    });
  });

  it("records a call that got no answer, with its code and no tokens", async () => {
    const r = row({
      tenantId: firm,
      intakeItemId: items.a ?? "",
      outcome: "transport_error",
      failure: "overloaded",
      docClass: null,
      requestId: null,
      usage: NO_TOKENS,
    });
    await usage.record(r);
    const [stored] = await owner<{ failure: string }[]>`SELECT failure FROM fin.extraction_usage WHERE id = ${r.id}`;
    expect(stored?.failure).toBe("overloaded");
  });

  it("is behind the tenant wall: another firm sees none of it, and cannot write into it", async () => {
    const seen = await withTenant(app, other, (db) => db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fin.extraction_usage WHERE tenant_id = ${firm}
    `);
    expect(seen[0]?.n).toBe(0);
    await expect(
      withTenant(app, other, (db) => db`
        INSERT INTO fin.extraction_usage
          (tenant_id, intake_item_id, model, prompt_version, attempt, input_tokens, output_tokens,
           cache_write_tokens, cache_read_tokens, outcome, doc_class)
        VALUES (${firm}, ${items.a ?? ""}, 'm', 'p', 1, 0, 0, 0, 0, 'ok', 'receipt')
      `),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot hang one firm's call off another firm's file (the composite key)", async () => {
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: items.otherFirm ?? "" })),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("is append-only by grant: the app may read and add, never change or remove", async () => {
    const [grants] = await owner<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT has_table_privilege('bib_app', 'fin.extraction_usage', 'SELECT') AS sel,
             has_table_privilege('bib_app', 'fin.extraction_usage', 'INSERT') AS ins,
             has_table_privilege('bib_app', 'fin.extraction_usage', 'UPDATE') AS upd,
             has_table_privilege('bib_app', 'fin.extraction_usage', 'DELETE') AS del,
             has_table_privilege('bib_app', 'fin.extraction_usage', 'TRUNCATE') AS trunc
    `;
    expect(grants).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false });
    await expect(
      withTenant(app, firm, (db) => db`UPDATE fin.extraction_usage SET output_tokens = 0 WHERE tenant_id = ${firm}`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(app, firm, (db) => db`DELETE FROM fin.extraction_usage WHERE tenant_id = ${firm}`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a transport error with no reason, a reason on an answer, and an answer with no class", async () => {
    const item = items.a ?? "";
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: item, outcome: "transport_error", failure: null, docClass: null })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: item, outcome: "ok", failure: "timeout" })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: item, outcome: "ok", docClass: null })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: item, outcome: "invalid_output", docClass: "receipt" })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      usage.record(row({ tenantId: firm, intakeItemId: item, attempt: 0 })),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the month's spend", () => {
  // March 2027, a month nothing else in this file writes into. The firm is in
  // Singapore, where midnight on the 1st is 16:00 UTC the day before.
  it("sums the firm's OWN month, cut at midnight in its zone, and nothing of another firm's", async () => {
    const item = items.edges ?? "";
    // 23:30 on 28 February in Singapore: February.
    await rowAt(firm, item, "2027-02-28T15:30:00Z", 1_000);
    // 00:30 on 1 March in Singapore (still 28 February in UTC): March.
    await rowAt(firm, item, "2027-02-28T16:30:00Z", 20);
    await rowAt(firm, item, "2027-03-10T09:00:00Z", 300);
    // April, and another firm's March: neither is this firm's March.
    await rowAt(firm, item, "2027-04-01T09:00:00Z", 7_000);
    await rowAt(other, items.otherFirm ?? "", "2027-03-05T09:00:00Z", 50_000);

    const march = await usage.monthToDate(firm, "2027-03-11T02:00:00.000Z");
    expect(march).toEqual({ inputTokens: 320, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

    // Asked late on 28 February in Singapore, February is the month.
    const february = await usage.monthToDate(firm, "2027-02-28T15:45:00.000Z");
    expect(february.inputTokens).toBe(1_000);
  });

  it("is zero for a month the firm made no call in", async () => {
    expect(await usage.monthToDate(other, "2031-01-15T00:00:00.000Z")).toEqual(NO_TOKENS);
  });
});

describe("a file the provider refuses", () => {
  it("counts its refusals, and whether the firm had an answer since the first", async () => {
    // Dated after everything else this file writes, so "since the first
    // refusal" is decided by these rows alone.
    const item = items.b ?? "";
    expect(await usage.refusals(firm, item)).toEqual({ count: 0, okSinceFirst: false });

    await rowAtRefused(firm, item, "2030-01-01T01:00:00Z");
    expect(await usage.refusals(firm, item)).toEqual({ count: 1, okSinceFirst: false });

    // Another file of the firm refused too is not an answer.
    await rowAtRefused(firm, items.edges ?? "", "2030-01-01T01:02:00Z");
    expect(await usage.refusals(firm, item)).toEqual({ count: 1, okSinceFirst: false });

    await rowAt(firm, items.edges ?? "", "2030-01-01T01:05:00Z", 10);
    await rowAtRefused(firm, item, "2030-01-01T01:10:00Z");
    expect(await usage.refusals(firm, item)).toEqual({ count: 2, okSinceFirst: true });

    // Another firm's answer is not this firm's.
    expect(await usage.refusals(other, item)).toEqual({ count: 0, okSinceFirst: false });
  });
});

async function rowAtRefused(tenantId: string, intakeItemId: string, at: string): Promise<void> {
  await owner`
    INSERT INTO fin.extraction_usage
      (tenant_id, intake_item_id, model, prompt_version, attempt, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens, outcome, failure, created_at)
    VALUES (${tenantId}, ${intakeItemId}, 'claude-sonnet-5-5', 'fin-doc@1', 1, 0, 0, 0, 0,
            'transport_error', 'bad_request', ${at})
  `;
}

describe("whose books a client's files are", () => {
  it("names the client every way it trades, with its UEN and the GST number in force", async () => {
    expect(await owners.describe(firm, client)).toEqual({
      names: ["Lumen Cloudworks", "Lumen Cloudworks Pte Ltd"],
      uen: "202134890G",
      gstNo: "M2-9588401-7",
    });
  });

  it("knows nobody behind the wall", async () => {
    expect(await owners.describe(firm, otherClient)).toBeNull();
  });
});
