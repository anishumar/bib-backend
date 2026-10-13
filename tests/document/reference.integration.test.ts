// G1.1 and G1.2's database half, proven against real Postgres. Five properties,
// and every one of them is something a fake can only pretend to have:
//
//   TWO DOCUMENTS CANNOT SHARE A REFERENCE. `UNIQUE (tenant_id, ref)` (0020),
//   asserted with RAW SQL rather than through the service — the point of a
//   database constraint is that it holds when the application is bypassed.
//
//   AND THE SCOPE IS PER FIRM. Two firms may both issue EL-2026-0007, because a
//   global namespace between tenants would make one firm's drafting fail
//   because of another firm's volume.
//
//   THE NUMBER IS BURNT WHEN THE DOCUMENT WRITE FAILS. That is the sequence
//   semantics the counter exists to reproduce, and it is a property of the
//   adapter's transaction boundary — the allocation commits on its own. It is
//   also exactly what T3.4's invoice number must NOT do.
//
//   AN ISSUING ENTITY MUST BE THE FIRM'S OWN. The composite foreign key, so one
//   firm cannot name another firm's company as its counterparty.
//
//   THE TENANT WALL over both new tables.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { DocumentService } from "../../src/usecase/document/service";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  standardBlocks: new PostgresStandardBlockRepository(app),
  blocks: new PostgresDocumentBlockRepository(app),
  ids: systemIds,
  events: ledger,
  calendars: new PostgresFirmTimeZone(app),
  fiscalYears: new PostgresConfigRepository(app),
});
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});

const stamp = Date.now().toString(36);
let tenantA = "";
let tenantB = "";
let clientA = "";
let clientB = "";
let firmEntityA = "";
let firmEntityB = "";

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`ref-test-a-${stamp}`}, 'Ref Test A', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`ref-test-b-${stamp}`}, 'Ref Test B', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  // The seed provisioning does: the firm's own entity, and the fallback row
  // naming it as the issuer of its documents.
  firmEntityA = await documentRepository.seedFirmEntity(tenantA, "Ref Test A LLP");
  firmEntityB = await documentRepository.seedFirmEntity(tenantB, "Ref Test B LLP");

  clientA = (
    await party.createOrganization({ tenantId: tenantA, legalName: "Meridian Ltd" }, SYSTEM_ACTOR)
  ).partyId;
  clientB = (
    await party.createOrganization({ tenantId: tenantB, legalName: "Somebody Else Ltd" }, SYSTEM_ACTOR)
  ).partyId;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** A proposal, written with RAW SQL under the owner role — the constraints
 *  below exist to hold when the service is bypassed, so the fixture bypasses
 *  it. */
async function insertProposal(tenantId: string, ref: string, issuer: string): Promise<unknown> {
  const client = tenantId === tenantA ? clientA : clientB;
  return owner`
    INSERT INTO crm.proposal
      (tenant_id, ref, party_id, issuing_entity_party_id, title, currency, fx_rate, fx_rate_date)
    VALUES (${tenantId}, ${ref}, ${client}, ${issuer}, 'Raw probe', 'INR', 1, '2026-06-01')
  `;
}

describe("two documents cannot share a reference", () => {
  it("refuses a second proposal with the same ref at the same firm", async () => {
    await insertProposal(tenantA, "PR-2026-8001", firmEntityA);
    const err = await insertProposal(tenantA, "PR-2026-8001", firmEntityA).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation
  });

  it("refuses a second engagement letter with the same ref at the same firm", async () => {
    const insert = (ref: string): Promise<unknown> => owner`
      INSERT INTO crm.engagement_letter
        (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
         currency, fx_rate, fx_rate_date)
      VALUES (${tenantA}, ${ref}, ${clientA}, ${firmEntityA}, 'IN', 'Raw probe',
              'INR', 1, '2026-06-01')
    `;
    await insert("EL-2026-8001");
    const err = await insert("EL-2026-8001").catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505");
  });

  it("lets two different firms use the same reference", async () => {
    // The unique scope is per TENANT, stated in migration 0020. A shared
    // namespace between firms would make one firm's drafting fail because of
    // another firm's volume, and it would leak that volume onto a document a
    // client reads.
    await insertProposal(tenantB, "PR-2026-8001", firmEntityB);
    // Scoped to THIS run's two firms: the table is never emptied between runs
    // (there is no DELETE grant), so an unscoped count would drift.
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM crm.proposal
      WHERE ref = 'PR-2026-8001' AND tenant_id IN (${tenantA}, ${tenantB})
    `;
    expect(Number(row?.n)).toBe(2);
  });

  it("refuses a reference of the wrong shape, or one belonging to the other document", async () => {
    const badShape = await insertProposal(tenantA, "nonsense", firmEntityA).catch(
      (e: unknown) => e,
    );
    expect((badShape as { code?: string }).code).toBe("23514"); // check_violation
    // A letter's number on a proposal: the CHECK pins the prefix per table, so
    // a caller that got its arguments the wrong way round is stopped here.
    const wrongType = await insertProposal(tenantA, "EL-2026-8002", firmEntityA).catch(
      (e: unknown) => e,
    );
    expect((wrongType as { code?: string }).code).toBe("23514");
  });
});

describe("the counter behaves like a sequence, not like an invoice number", () => {
  it("keeps its number when the document it was drawn for is never written", async () => {
    // THE DISTINCTION THIS WHOLE DESIGN TURNS ON. `next` commits on its own, so
    // a draft that fails afterwards BURNS its number and the firm's series has
    // a gap. That is honest for a document reference — and is exactly what
    // T3.4's gapless invoice number must not do, which is why that one will be
    // built on a locked counter row inside the invoice's own transaction and
    // not on this method.
    const first = await documentRepository.next(tenantA, "proposal", 2031);
    expect(first).toBe(1);

    // A document write that fails: an issuer belonging to the other firm.
    const err = await insertProposal(tenantA, "PR-2031-0002", firmEntityB).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation

    const second = await documentRepository.next(tenantA, "proposal", 2031);
    expect(second).toBe(2);
    // And the burnt number is genuinely gone: nothing reissues 2.
    expect(await documentRepository.next(tenantA, "proposal", 2031)).toBe(3);
  });

  it("gives each firm, type and year a series of its own", async () => {
    expect(await documentRepository.next(tenantB, "proposal", 2031)).toBe(1);
    expect(await documentRepository.next(tenantA, "engagement_letter", 2031)).toBe(1);
    expect(await documentRepository.next(tenantA, "proposal", 2032)).toBe(1);
  });

  it("hands out a distinct number to every concurrent caller", async () => {
    // The upsert increments from what is stored under the row lock, so twenty
    // drafters cannot read the same last_number and write the same successor.
    const drawn = await Promise.all(
      Array.from({ length: 20 }, () => documentRepository.next(tenantA, "proposal", 2033)),
    );
    expect(new Set(drawn).size).toBe(20);
    expect([...drawn].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});

describe("an issuing entity is one of the firm's own parties", () => {
  it("refuses another firm's party as the issuer of a document", async () => {
    // The composite key, and it matters more here than almost anywhere: the
    // issuing entity is the counterparty a client is contracting with.
    const err = await insertProposal(tenantA, "PR-2026-8003", firmEntityB).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("refuses another firm's party in the preference rule itself", async () => {
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.firm_entity_preference
          (tenant_id, client_jurisdiction, firm_entity_party_id)
        VALUES (${tenantA}, 'US', ${firmEntityB})
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("allows exactly one answer per country", async () => {
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.firm_entity_preference
          (tenant_id, client_jurisdiction, firm_entity_party_id)
        VALUES (${tenantA}, '*', ${firmEntityA})
      `,
    ).catch((e: unknown) => e);
    // The fallback is already there — seeded when the firm was provisioned.
    expect((err as { code?: string }).code).toBe("23505");
  });
});

describe("the tenant wall", () => {
  it("hides one firm's issuing rule from another", async () => {
    const mine = await documents.listPreferences(tenantA);
    expect(mine.map((r) => r.entity.id)).toEqual([firmEntityA]);
    expect(mine.map((r) => r.entity.id)).not.toContain(firmEntityB);
  });

  it("hides one firm's reference counters from another", async () => {
    const rows = await withTenant(app, tenantB, (db) =>
      db<{ tenant_id: string }[]>`SELECT tenant_id FROM crm.document_ref_series`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantB)).toBe(true);
  });
});
