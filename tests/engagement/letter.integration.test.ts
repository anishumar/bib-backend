// T2.3's database half. Four properties, and each is one a fake could only
// pretend to have:
//
//   THE FREEZE. A signed letter cannot be changed, and the trigger refuses it
//   for the OWNER role too — so a migration or a psql session cannot quietly
//   restate what a client agreed to. That is the point of putting it in the
//   database rather than in the service.
//
//   THE FAN-OUT, in one transaction, one engagement per line, enforced by a
//   unique constraint rather than by care.
//
//   THE PIN. An archived clause still resolves, with the wording it had.
//
//   THE TENANT WALL, and no DELETE.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: new PostgresMembershipRepository(app),
  ids: systemIds,
  events: ledger,
});
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});
const letters = new PostgresEngagementRepository(app);
const service = new EngagementService({
  letters,
  library: configRepository,
  esign: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = Date.now().toString(36);
let tenantA = "";
let tenantB = "";
let partyA = "";
let gstV1 = "";
/** The clause published, then superseded — the pin has to survive that. */
let scopeV1 = "";

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`el-test-a-${stamp}`}, 'EL Test A', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`el-test-b-${stamp}`}, 'EL Test B', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  partyA = (
    await party.createOrganization({ tenantId: tenantA, legalName: "Acme Ltd" }, SYSTEM_ACTOR)
  ).partyId;

  const service1 = await config.define(
    {
      tenantId: tenantA,
      kind: "service",
      key: "gst-filing",
      body: { name: "GST monthly filing", billingBasis: "fixed" },
    },
    SYSTEM_ACTOR,
  );
  await config.publish(
    { tenantId: tenantA, kind: "service", key: "gst-filing", version: 1 },
    SYSTEM_ACTOR,
  );
  gstV1 = service1.draft.id;

  const clause1 = await config.define(
    {
      tenantId: tenantA,
      kind: "clause",
      key: "scope",
      body: {
        title: "Scope of work",
        text: "The firm will perform the services listed above.",
        jurisdictions: [],
      },
    },
    SYSTEM_ACTOR,
  );
  await config.publish({ tenantId: tenantA, kind: "clause", key: "scope", version: 1 }, SYSTEM_ACTOR);
  scopeV1 = clause1.draft.id;

  // Supersede it, so the pin has something to survive.
  await config.addVersion({
    tenantId: tenantA,
    kind: "clause",
    key: "scope",
    body: {
      title: "Scope of work",
      text: "REWRITTEN 2026: the firm will perform only the services listed above.",
      jurisdictions: [],
    },
  });
  await config.publish({ tenantId: tenantA, kind: "clause", key: "scope", version: 2 }, SYSTEM_ACTOR);
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function signedLetter(advance?: string): Promise<string> {
  const letter = await service.draft(
    {
      tenantId: tenantA,
      partyId: partyA,
      jurisdiction: "IN",
      title: "Acme — FY26",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: advance !== undefined,
      ...(advance === undefined ? {} : { advanceAmount: advance }),
    },
    SYSTEM_ACTOR,
  );
  await service.addLine({
    tenantId: tenantA,
    letterId: letter.id,
    serviceVersionId: gstV1,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await service.addLine({
    tenantId: tenantA,
    letterId: letter.id,
    serviceVersionId: gstV1,
    description: "Annual return",
    quantity: "1",
    unitAmount: "18000",
    discountPercent: "0",
  });
  await service.addClause(tenantA, letter.id, scopeV1);
  await service.send(tenantA, letter.id, SYSTEM_ACTOR);
  await service.sign(
    { tenantId: tenantA, letterId: letter.id, signedByName: "Priya Menon", reference: "paper-001" },
    SYSTEM_ACTOR,
  );
  return letter.id;
}

describe("the freeze", () => {
  it("refuses to change a signed letter, even as the OWNER role", async () => {
    // The reason this is a trigger and not a service check. bib_owner is the
    // role migrations run as; if the rule lived in the application, a backfill
    // written next year would walk straight past it and restate what a client
    // agreed to.
    const id = await signedLetter();
    const err = await owner`
      UPDATE crm.engagement_letter SET title = 'quietly different' WHERE id = ${id}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
    expect((err as Error).message).toContain("frozen");
  });

  it("refuses to change the TERMS underneath a signed letter", async () => {
    // The freeze above would be decorative if the lines could still move.
    const id = await signedLetter();
    const err = await owner`
      UPDATE crm.engagement_letter_line SET unit_amount = 1
      WHERE engagement_letter_id = ${id}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("refuses to add a clause to a signed letter", async () => {
    const id = await signedLetter();
    const err = await owner`
      INSERT INTO crm.engagement_letter_clause
        (tenant_id, engagement_letter_id, clause_version_id, position)
      VALUES (${tenantA}, ${id}, ${scopeV1}, 99)
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("refuses to delete a signed letter", async () => {
    const id = await signedLetter();
    const err = await owner`DELETE FROM crm.engagement_letter WHERE id = ${id}`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });
});

describe("the fan-out", () => {
  it("creates exactly one engagement per line", async () => {
    const id = await signedLetter();
    const engagements = await letters.listEngagements(tenantA, id);
    expect(engagements).toHaveLength(2);
    const lineIds = new Set(engagements.map((e) => e.engagementLetterLineId));
    expect(lineIds.size).toBe(2);
  });

  it("the database refuses a second engagement for the same line", async () => {
    // The acceptance as a constraint rather than a convention: fanning out
    // twice would double the work and the revenue.
    const id = await signedLetter();
    const [existing] = await letters.listEngagements(tenantA, id);
    if (!existing) throw new Error("expected an engagement");
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.engagement
          (tenant_id, engagement_letter_id, engagement_letter_line_id, party_id, status, activated_at)
        VALUES (${tenantA}, ${id}, ${existing.engagementLetterLineId}, ${partyA}, 'active', now())
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation
  });
});

describe("the pin", () => {
  it("still reads the wording that was agreed, after the library moved on", async () => {
    // The whole reason clauses are pinned. `scope` has been rewritten and
    // republished; this letter must still say what the client signed.
    const id = await signedLetter();
    const record = await service.describe(tenantA, id);
    expect(record.clauses).toHaveLength(1);
    expect(record.clauses[0]?.text).toBe("The firm will perform the services listed above.");
    expect(record.clauses[0]?.text).not.toContain("REWRITTEN");
    expect(record.clauses[0]?.version).toBe(1);

    // …while the library itself has moved on.
    const live = await configRepository.readPinnedVersion(tenantA, scopeV1);
    expect(live?.status).toBe("archived");
  });

  it("records a verifiable fingerprint of what was signed", async () => {
    const id = await signedLetter();
    const record = await service.describe(tenantA, id);
    expect(record.letter.signedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.letter.signatureMethod).toBe("attested");
    expect(record.letter.signatureReference).toBe("paper-001");
  });
});

describe("the advance gate", () => {
  it("holds the engagements, then releases them all at once", async () => {
    const id = await signedLetter("10000");
    const held = await letters.listEngagements(tenantA, id);
    expect(held.every((e) => e.status === "pending_advance")).toBe(true);

    const [user] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email)
      VALUES (${`advance-${stamp}@example.test`}) RETURNING id
    `;
    if (!user) throw new Error("could not create the recorder");

    const { released } = await service.recordAdvance(tenantA, id, user.id, SYSTEM_ACTOR);
    expect(released).toHaveLength(2);
    expect(released.every((e) => e.status === "active")).toBe(true);
  });
});

describe("the tenant wall", () => {
  it("one firm cannot read another's letters", async () => {
    const id = await signedLetter();
    expect(await letters.findLetter(tenantB, id)).toBeNull();
    expect(await letters.describeLetter(tenantB, id)).toBeNull();
    expect(await letters.listLetters(tenantB, {})).toEqual([]);
  });

  it("nothing can be deleted through the app role", async () => {
    const id = await signedLetter();
    const err = await withTenant(app, tenantA, (db) =>
      db`DELETE FROM crm.engagement WHERE engagement_letter_id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // insufficient_privilege
  });
});
