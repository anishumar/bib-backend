// T2.1's database half, proven against real Postgres: one open lead per party,
// a closed lead always carries a closing date, a lead can only be about a party
// in its own firm, and nothing can be deleted.
//
// A fake can show our code never opens a second lead for a prospect. Only the
// database can show that a second one is impossible — which is the property the
// pipeline actually depends on, because the failure mode is two people ringing
// the same company and two forecasts counting it.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: this test leaves its rows behind — crm.lead has no DELETE
// grant, which is itself asserted below. The tenants it creates are uniquely
// named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { LeadService } from "../../src/usecase/lead/service";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});
const leads = new PostgresLeadRepository(app);
const service = new LeadService({
  leads,
  prospects: party,
  staff: new PostgresMembershipRepository(app),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = String(Date.now());
let tenantA = "";
let tenantB = "";
let leadId = "";
let partyId = "";

const EMAIL = `priya-${stamp}@meridian.example`;

/** Unique-per-call suffix, so repeated captures inside one run do not collide
 *  on an identifier and accidentally test the merge path instead. */
let suffix = 0;
function nextSuffix(): number {
  suffix += 1;
  return suffix;
}

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name)
    VALUES (${`lead-test-a-${stamp}`}, 'Lead Test A') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name)
    VALUES (${`lead-test-b-${stamp}`}, 'Lead Test B') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  const captured = await service.capture(
    {
      tenantId: tenantA,
      source: "inbound",
      kind: "organization",
      name: "Meridian Textiles Private Limited",
      identifiers: [{ type: "email", value: EMAIL }],
    },
    SYSTEM_ACTOR,
  );
  leadId = captured.lead.id;
  partyId = captured.lead.partyId;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("one open lead per party", () => {
  it("the database refuses a second open lead for the same prospect", async () => {
    // The partial unique index IS the merge rule. Two live opportunities for
    // one prospect means two people ringing them and two forecasts counting it.
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.lead (tenant_id, party_id, source, stage)
        VALUES (${tenantA}, ${partyId}, 'outbound', 'contacted')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation
  });

  it("allows a second one once the first is closed", async () => {
    // A prospect who went cold in March and came back in September is two
    // opportunities, and should be counted as two.
    await service.moveStage({ tenantId: tenantA, leadId, stage: "lost" }, SYSTEM_ACTOR);
    const again = await service.capture(
      {
        tenantId: tenantA,
        source: "referral",
        kind: "organization",
        name: "Meridian Textiles Private Limited",
        identifiers: [{ type: "email", value: EMAIL }],
      },
      SYSTEM_ACTOR,
    );
    expect(again.merged).toBe(false);
    expect(again.matchedExistingParty).toBe(true);
    expect(again.lead.partyId).toBe(partyId);
    expect(again.lead.id).not.toBe(leadId);
  });
});

describe("a closed lead always has a closing date", () => {
  /** A prospect with a live opportunity, made fresh — these assertions are
   *  about an OPEN lead, and the shared one has been closed by the block above. */
  async function openLead(): Promise<string> {
    const captured = await service.capture(
      {
        tenantId: tenantA,
        source: "outbound",
        kind: "organization",
        name: `Check Test ${String(Math.round(Date.parse("2026-03-01") / 1000))}`,
        identifiers: [{ type: "email", value: `check-${stamp}-${String(nextSuffix())}@x.example` }],
      },
      SYSTEM_ACTOR,
    );
    return captured.lead.id;
  }

  it("refuses a terminal stage with no closed_at", async () => {
    // Otherwise "how long is the pipeline taking" is answered from a column
    // that is sometimes set and sometimes not, and nobody notices which.
    const id = await openLead();
    const err = await withTenant(app, tenantA, (db) =>
      db`UPDATE crm.lead SET stage = 'converted' WHERE id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514"); // check_violation
  });

  it("refuses an open stage that carries one", async () => {
    const id = await openLead();
    const err = await withTenant(app, tenantA, (db) =>
      db`UPDATE crm.lead SET stage = 'new', closed_at = now() WHERE id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514");
  });

  it("the service moves both together, so neither is ever alone", async () => {
    const id = await openLead();
    await service.moveStage({ tenantId: tenantA, leadId: id, stage: "converted" }, SYSTEM_ACTOR);
    const [row] = await owner<{ stage: string; closed_at: Date | null }[]>`
      SELECT stage, closed_at FROM crm.lead WHERE id = ${id}
    `;
    expect(row?.stage).toBe("converted");
    expect(row?.closed_at).not.toBeNull();
  });
});

describe("the tenant wall covers the pipeline", () => {
  it("one firm's leads are invisible to another", async () => {
    expect((await service.list(tenantA)).length).toBeGreaterThan(0);
    expect(await service.list(tenantB)).toEqual([]);
  });

  it("the joined read stays inside the tenant wall", async () => {
    // The read joins core.party and tenancy.user_account. The party side is
    // under RLS and filtered with the lead; if that ever stopped being true,
    // one firm's board would start naming another firm's prospects.
    // By party, not by position: earlier blocks capture their own leads and the
    // list is newest-first, so [0] is whichever ran last.
    const rows = await service.list(tenantA);
    const meridian = rows.find((r) => r.party.id === partyId);
    expect(meridian?.party.displayName).toBe("Meridian Textiles Private Limited");
    expect(meridian?.lead.tenantId).toBe(tenantA);
  });

  it("a lead cannot be about another firm's party", async () => {
    // The composite foreign key. Without the tenant travelling with the
    // reference, firm B could open an opportunity on firm A's client — RLS
    // would hide the row, but the row would exist and point across the wall.
    //
    // The party used here deliberately has NO lead of its own. Reusing one that
    // does would make lead_one_open_per_party fire first — a unique violation
    // rather than a foreign-key one — and this test would pass while proving
    // something else entirely. (That index is global rather than per-tenant,
    // which is correct: a party belongs to exactly one firm, and the key being
    // asserted here is what guarantees it.)
    const spare = await party.createOrganization(
      { tenantId: tenantA, legalName: `Unleaded Holdings ${stamp}` },
      SYSTEM_ACTOR,
    );
    const err = await withTenant(app, tenantB, (db) =>
      db`
        INSERT INTO crm.lead (tenant_id, party_id, source)
        VALUES (${tenantB}, ${spare.partyId}, 'outbound')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  it("an insert cannot be addressed to another tenant", async () => {
    const err = await withTenant(app, tenantB, (db) =>
      db`
        INSERT INTO crm.lead (tenant_id, party_id, source)
        VALUES (${tenantA}, ${partyId}, 'outbound')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // RLS WITH CHECK violation
  });

  it("dedup does not reach across firms", async () => {
    // The same email at another firm is another firm's prospect, and must not
    // merge into this one's.
    const elsewhere = await service.capture(
      {
        tenantId: tenantB,
        source: "inbound",
        kind: "organization",
        name: "Meridian Textiles Private Limited",
        identifiers: [{ type: "email", value: EMAIL }],
      },
      SYSTEM_ACTOR,
    );
    expect(elsewhere.merged).toBe(false);
    expect(elsewhere.matchedExistingParty).toBe(false);
    expect(elsewhere.lead.partyId).not.toBe(partyId);
  });
});

describe("the pipeline's own history is not editable away", () => {
  it("the app role holds no DELETE on crm.lead", async () => {
    // A lead that went nowhere is `lost`, not erased — the pipeline's history
    // is what makes a conversion rate mean anything.
    const [p] = await app<
      { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]
    >`
      SELECT has_table_privilege('crm.lead', 'SELECT') AS can_select,
             has_table_privilege('crm.lead', 'INSERT') AS can_insert,
             has_table_privilege('crm.lead', 'UPDATE') AS can_update,
             has_table_privilege('crm.lead', 'DELETE') AS can_delete
    `;
    expect(p?.can_select).toBe(true);
    expect(p?.can_insert).toBe(true);
    expect(p?.can_update).toBe(true);
    expect(p?.can_delete).toBe(false);
  });

  it("every step of the lead is in the ledger, in order", async () => {
    // "Appends timeline", the other half of the acceptance — and there is no
    // timeline table to keep in step, because the audit log IS the timeline.
    const timeline = await ledger.forObject(tenantA, "lead", leadId);
    const verbs = timeline.map((e) => e.verb).reverse();
    expect(verbs).toEqual(["lead.captured", "lead.stage_changed"]);
  });
});
