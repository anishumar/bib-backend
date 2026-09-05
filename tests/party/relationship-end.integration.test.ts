// Closing a relationship, proven against real Postgres.
//
// `PartyService.endRelationship` reads the row and then updates it — two
// statements — so everything that actually keeps the ledger honest lives in the
// database, and a fake can only show that our code passes the answer along:
//
//   · the transition is ATOMIC. `valid_to IS NULL` is in the WHERE, so the
//     second of two concurrent closes updates no row. Driven at the REPOSITORY
//     here, because the service's own pre-read would decide the race before
//     Postgres ever saw it — the same reason the archive suite drops to the
//     repository for its concurrency case.
//   · the DATE RULE is a check constraint (`party_relationship_dates_chk`,
//     0002), so an import, an agent or a psql session gets the same refusal the
//     API gives.
//   · the TENANT WALL covers it. A relationship belonging to another firm is
//     not closed, not refused with a message naming it — simply not there.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: rows are left behind; core has no DELETE grant, which the
// archive suite asserts. The tenants are uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { RelationshipAlreadyEnded } from "../../src/domain/party/errors";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
/** Held separately as well as injected — see the note at the top about the
 *  race: the repository is what the concurrency case has to drive. */
const relationships = new PostgresRelationshipRepository(app);
const service = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships,
  ids: systemIds,
  events: ledger,
});

const stamp = String(Date.now());
let tenant = "";
let otherTenant = "";

/** A fresh open directorship, so every assertion starts from a live one. */
async function openDirectorship(name: string, tenantId = tenant): Promise<string> {
  const org = await service.createOrganization(
    { tenantId, legalName: `${name} Holdings ${stamp}` },
    SYSTEM_ACTOR,
  );
  const person = await service.createPerson(
    { tenantId, fullName: `${name} Director ${stamp}` },
    SYSTEM_ACTOR,
  );
  const rel = await service.addRelationship(
    {
      tenantId,
      fromPartyId: person.partyId,
      toPartyId: org.partyId,
      type: "director_of",
      validFrom: "2021-04-01",
    },
    SYSTEM_ACTOR,
  );
  return rel.id;
}

beforeAll(async () => {
  const rows = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`rel-end-test-${stamp}`}, 'Relationship End Test', 'INR'),
           (${`rel-end-other-${stamp}`}, 'Relationship End Other', 'INR')
    RETURNING id
  `;
  const [mine, theirs] = rows;
  if (!mine || !theirs) throw new Error("could not create the test tenants");
  tenant = mine.id;
  otherTenant = theirs.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("closing is atomic, in the database", () => {
  it("the second close updates no row, driven at the repository", async () => {
    const id = await openDirectorship("Atomic");

    const first = await relationships.endIfOpen(tenant, id, "2026-08-12");
    expect(first?.validTo).toBe("2026-08-12");

    // The guard is `AND valid_to IS NULL`, so this is not "an error we catch" —
    // it is a statement that matched nothing. Null is what the service turns
    // into the same refusal a repeat click gets.
    const second = await relationships.endIfOpen(tenant, id, "2026-09-01");
    expect(second).toBeNull();

    // And the date did not move.
    const row = await relationships.find(tenant, id);
    expect(row?.validTo).toBe("2026-08-12");
  });

  it("two concurrent closes leave ONE ended event", async () => {
    const id = await openDirectorship("Race");
    const results = await Promise.allSettled([
      service.endRelationship({ tenantId: tenant, relationshipId: id, validTo: "2026-08-12" }, SYSTEM_ACTOR),
      service.endRelationship({ tenantId: tenant, relationshipId: id, validTo: "2026-08-13" }, SYSTEM_ACTOR),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RelationshipAlreadyEnded);

    // The ledger is the point of all of this: one relationship, one ending.
    const events = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ledger.event
       WHERE verb = 'party_relationship.ended' AND object_id = ${id}
    `;
    expect(events[0]?.n).toBe("1");
  });
});

describe("the date rule is the database's, not ours", () => {
  it("refuses an end on the day it began, even from raw SQL", async () => {
    const id = await openDirectorship("Constraint");
    // No service, no validation of ours: this is the import / agent path.
    const failure = await withTenant(app, tenant, (db) =>
      db`UPDATE core.party_relationship SET valid_to = valid_from WHERE id = ${id}`,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).not.toBeNull();
    expect(String(failure)).toContain("party_relationship_dates_chk");

    const row = await relationships.find(tenant, id);
    expect(row?.validTo).toBeNull();
  });
});

describe("the tenant wall covers closing one", () => {
  it("another firm's close matches nothing and changes nothing", async () => {
    const id = await openDirectorship("Walled");

    // Not an error naming the row — the row is not there to be named.
    expect(await relationships.endIfOpen(otherTenant, id, "2026-08-12")).toBeNull();
    expect(await relationships.find(otherTenant, id)).toBeNull();

    const row = await relationships.find(tenant, id);
    expect(row?.validTo).toBeNull();
  });
});
