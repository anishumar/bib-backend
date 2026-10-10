// FinCompliance intake against real Postgres (0381): the properties no fake can
// prove — the switch's cut, the anti-join, the insert conflict, the tenant wall
// and the append-only grant.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { systemIds } from "../../src/platform/ids";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import {
  PostgresFinFirms,
  PostgresIntakeCandidates,
  PostgresIntakeRepository,
} from "../../src/infrastructure/fin/postgres-intake";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PostgresTenantRepository } from "../../src/infrastructure/postgres/tenant-repository";
import { FinIntakeService } from "../../src/usecase/fin/intake";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

const service = new FinIntakeService({
  firms: new PostgresFinFirms(app),
  candidates: new PostgresIntakeCandidates(app),
  items: new PostgresIntakeRepository(app),
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
  ids: systemIds,
});

let firm = "";
let other = "";
let off = "";
let client = "";
const versions: Record<string, string> = {};

async function tenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status)
    VALUES (${slug}, ${slug}, 'SGD', 'active') RETURNING id
  `;
  return row?.id ?? "";
}

async function store(
  tenantId: string,
  label: string,
  over: { origin?: string; kind?: string; storedAt?: string; mediaType?: string; filename?: string; partyId?: string | null } = {},
): Promise<string> {
  const [doc] = await owner<{ id: string }[]>`
    INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
    VALUES (${tenantId}, ${label}, ${over.origin ?? "uploaded"}, ${over.kind ?? "books_input"}, ${over.partyId === undefined ? null : over.partyId})
    RETURNING id
  `;
  const hash = Buffer.from(`${label}-${stamp}`).toString("hex").padEnd(64, "0").slice(0, 64);
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO files.document_version
      (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename, storage_key, created_at)
    VALUES (${tenantId}, ${doc?.id ?? ""}, 1, ${hash}, 1024, ${over.mediaType ?? "application/pdf"},
            ${over.filename ?? `${label}.pdf`}, ${`${tenantId}/${hash.slice(0, 2)}/${hash}`},
            ${over.storedAt ?? new Date().toISOString()})
    RETURNING id
  `;
  return version?.id ?? "";
}

beforeAll(async () => {
  firm = await tenant(`fin-on-${stamp}`);
  other = await tenant(`fin-other-${stamp}`);
  off = await tenant(`fin-off-${stamp}`);
  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${firm}, 'organization', 'Lumen Cloudworks Pte Ltd') RETURNING id
  `;
  client = party?.id ?? "";

  // Stored BEFORE the switch: a firm's earlier uploads are already in its books.
  versions.before = await store(firm, "before", { storedAt: "2020-01-01T00:00:00Z", partyId: client });
  await owner`UPDATE tenancy.tenant SET fin_enabled_since = now() - interval '1 minute' WHERE id IN (${firm}, ${other})`;

  versions.invoice = await store(firm, "INV-25-1001", { partyId: client });
  versions.statement = await store(firm, "statement", { mediaType: "text/csv", filename: "Statement October 2025.csv", partyId: client });
  versions.doc = await store(firm, "notes", { mediaType: "application/msword", filename: "notes.doc", partyId: client });
  versions.generated = await store(firm, "letter", { origin: "generated", partyId: client });
  versions.kyc = await store(firm, "passport", { kind: "identity_proof", partyId: client });
  // Not filed for the books: fin leaves it alone (0383).
  versions.notes = await store(firm, "meeting-notes", { kind: "other", partyId: client });
  versions.otherFirm = await store(other, "other-firm-invoice");
  versions.offFirm = await store(off, "off-firm-invoice");
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

async function taken(tenantId: string): Promise<string[]> {
  const rows = await owner<{ v: string }[]>`
    SELECT document_version_id AS v FROM fin.intake_item WHERE tenant_id = ${tenantId}
  `;
  return rows.map((r) => r.v);
}

describe("the fin intake sweep, in Postgres", () => {
  it("lists only firms that switched fin on", async () => {
    const firms = new PostgresFinFirms(app);
    const ids = await firms.enabledFirmIds();
    expect(ids).toEqual(expect.arrayContaining([firm, other]));
    expect(ids).not.toContain(off);
    expect(await firms.isEnabled(off)).toBe(false);
  });

  it("takes in what clients supplied since the switch, and nothing else", async () => {
    const report = (await service.sweepFirm(firm));
    expect(report).toMatchObject({ taken: 3, manual: 1 });
    expect((await taken(firm)).sort()).toEqual([versions.invoice, versions.statement, versions.doc].sort());
  });

  it("takes nothing the second time and writes no second event", async () => {
    const again = await service.sweepFirm(firm);
    expect(again).toMatchObject({ taken: 0 });
    expect(await taken(firm)).toHaveLength(3);
    const [events] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger.event WHERE tenant_id = ${firm} AND verb = 'fin.intake_routed'
    `;
    expect(events?.n).toBe(3);
  });

  it("keeps each firm's files to that firm", async () => {
    await service.sweepFirm(other);
    expect(await taken(other)).toEqual([versions.otherFirm]);
    // RLS: inside the other firm's context, this firm's items do not exist.
    const seen = await withTenant(app, other, (db) => db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fin.intake_item WHERE tenant_id = ${firm}
    `);
    expect(seen[0]?.n).toBe(0);
    expect(await taken(off)).toEqual([]);
  });

  it("reads the list back with the client and the route, newest first", async () => {
    const items = await service.recent(firm, 10);
    expect(items).toHaveLength(3);
    const statement = items.find((i) => i.documentVersionId === versions.statement);
    expect(statement).toMatchObject({
      clientName: "Lumen Cloudworks Pte Ltd",
      filename: "Statement October 2025.csv",
      route: "sheet",
      routeBasis: "media_type",
    });
    expect(statement?.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("is switched by the platform: on keeps its cut, off clears it, on again cuts afresh", async () => {
    const tenants = new PostgresTenantRepository(app);
    const cut = await tenants.finEnabledSince(firm);
    expect(cut).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await tenants.setFinEnabled(firm, true)).toBe(cut);
    expect(await tenants.setFinEnabled(off, false)).toBeNull();
    const fresh = await tenants.setFinEnabled(off, true);
    expect(fresh).not.toBeNull();
    expect(await tenants.setFinEnabled(off, false)).toBeNull();
    expect(await tenants.finEnabledSince("00000000-0000-4000-8000-00000000dead")).toBeUndefined();
  });

  it("is append-only for the app role", async () => {
    await expect(
      withTenant(app, firm, (db) => db`UPDATE fin.intake_item SET route = 'pdf' WHERE tenant_id = ${firm}`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
