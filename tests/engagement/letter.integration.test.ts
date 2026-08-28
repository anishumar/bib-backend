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
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresTenantRepository } from "../../src/infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../../src/infrastructure/postgres/user-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { DocumentService } from "../../src/usecase/document/service";
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
const memberships = new PostgresMembershipRepository(app);
// The real tenancy service, because the firm's standing signatory is a column
// on the tenant row and G1.4's whole point is that it is a ROW: a fake here
// would be asserting its own behaviour rather than the schema's.
const tenancy = new TenancyService({
  tenants: new PostgresTenantRepository(app),
  users: new PostgresUserRepository(app),
  memberships,
  roleSeeder: { seedDefaultRoles: (tenantId, actor) => config.seedDefaultRoles(tenantId, actor) },
  issuingEntitySeeder: { seedFirmEntity: (t, n) => documentRepository.seedFirmEntity(t, n) },
  roleDirectory: configRepository,
  ids: systemIds,
  events: ledger,
});
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  ids: systemIds,
  events: ledger,
});
const service = new EngagementService({
  letters,
  library: configRepository,
  documents,
  firm: tenancy,
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
/** The FIRM's own entity — who is contracting on its side of the letter. */
let firmEntityA = "";
/** Two of the CLIENT's own companies. An engagement is `service × one legal
 *  entity`, so a letter covering both must fan out into engagements that differ
 *  in exactly this field — the acceptance G0.1 exists for. */
let entityA1 = "";
let entityA2 = "";
/** The named individual a letter is addressed to, care-of the client. */
let contactA = "";
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

  // These tenants are created with raw SQL rather than through createTenant, so
  // they do not get the fallback issuing entity provisioning seeds. Each firm
  // gets its own here: `issuing_entity_party_id` is NOT NULL, and a firm that
  // has named no entity cannot draft a letter at all.
  firmEntityA = await documentRepository.seedFirmEntity(tenantA, "EL Test A LLP");
  await documentRepository.seedFirmEntity(tenantB, "EL Test B LLP");

  partyA = (
    await party.createOrganization({ tenantId: tenantA, legalName: "Acme Ltd" }, SYSTEM_ACTOR)
  ).partyId;

  entityA1 = (
    await party.createOrganization({ tenantId: tenantA, legalName: "Acme Foods Ltd" }, SYSTEM_ACTOR)
  ).partyId;
  entityA2 = (
    await party.createOrganization(
      { tenantId: tenantA, legalName: "Acme Logistics Ltd" },
      SYSTEM_ACTOR,
    )
  ).partyId;

  contactA = (
    await party.createPerson({ tenantId: tenantA, fullName: "R Sharma" }, SYSTEM_ACTOR)
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

/** A fresh number for each raw-SQL probe: `UNIQUE (tenant_id, ref)` is real, and
 *  two probes sharing one would fail on that constraint rather than on the rule
 *  the test is about. */
let probes = 0;
function refProbe(): number {
  probes += 1;
  return probes;
}

/** A party at the OTHER firm, for the cross-tenant probes. Created lazily so the
 *  ordinary tests do not pay for it. */
let partyBId = "";
async function partyAtB(): Promise<string> {
  if (partyBId === "") {
    partyBId = (
      await party.createOrganization({ tenantId: tenantB, legalName: "Other Firm Client" }, SYSTEM_ACTOR)
    ).partyId;
  }
  return partyBId;
}

/**
 * A signed letter with EVERY field G1.3–G1.5 added actually filled in — a
 * background, an addressee, an issue date, a lineage link, an effective date,
 * both signature blocks and the capacity each side signed in.
 *
 * It exists because a freeze that compares rows is only exercised by columns
 * that hold something: "set a null column to null" is not a change and is
 * rightly allowed.
 */
async function fullyFilledSignedLetter(): Promise<string> {
  const previous = await signedLetter();
  await nameTheFirmSignatory();
  const letter = await service.draft(
    {
      tenantId: tenantA,
      partyId: partyA,
      jurisdiction: "IN",
      title: "Acme — FY27, replacing FY26",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: false,
      background: "Acme has separated its logistics arm and needs both entities filed for.",
      addressedToPartyId: contactA,
      issuedOn: "2026-09-01",
      supersedesId: previous,
      effectiveFrom: "2026-10-01",
    },
    SYSTEM_ACTOR,
  );
  await service.addLine({
    tenantId: tenantA,
    letterId: letter.id,
    entityPartyId: entityA1,
    serviceVersionId: gstV1,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
    effectiveFrom: "2026-12-01",
  });
  await service.addClause(tenantA, letter.id, scopeV1);
  await service.send(tenantA, letter.id, SYSTEM_ACTOR);
  await service.sign(
    {
      tenantId: tenantA,
      letterId: letter.id,
      signedByName: "Priya Menon",
      signedByTitle: "Director",
      reference: "paper-full",
    },
    SYSTEM_ACTOR,
  );
  return letter.id;
}

/** Give firm A a standing signatory, once. The membership is inserted directly
 *  because this tenant was created with raw SQL and has no seeded roles — what
 *  is being exercised is the signature block, not the invite flow. */
let signatoryNamed = false;
async function nameTheFirmSignatory(): Promise<void> {
  if (signatoryNamed) return;
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`firm-signatory-${stamp}@example.test`}, 'Siddharth Jain') RETURNING id
  `;
  if (!user) throw new Error("could not create the firm's signatory");
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility)
    VALUES (${tenantA}, ${user.id}, 'STAFF', 'partner', true)
  `;
  await tenancy.setFirmSignatory(
    { tenantId: tenantA, userId: user.id, title: "Director" },
    SYSTEM_ACTOR,
  );
  signatoryNamed = true;
}

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
    entityPartyId: entityA1,
    serviceVersionId: gstV1,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await service.addLine({
    tenantId: tenantA,
    letterId: letter.id,
    entityPartyId: entityA2,
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

describe("the head a letter prints from", () => {
  it("carries a reference and names the firm's own entity, by name", async () => {
    // G1.1 and G1.2, through the whole stack. The read model carries the
    // issuing entity's NAME because a letterhead prints a name — the rule
    // CLAUDE.md says has now been learnt several times.
    const id = await signedLetter();
    const record = await letters.describeLetter(tenantA, id);
    expect(record?.letter.ref).toMatch(/^EL-\d{4}-\d{4,}$/);
    expect(record?.letter.issuingEntityPartyId).toBe(firmEntityA);
    expect(record?.issuingEntity).toEqual({ id: firmEntityA, displayName: "EL Test A LLP" });

    const [summary] = await letters.listLetters(tenantA, { partyId: partyA });
    expect(summary?.issuingEntity.displayName).toBe("EL Test A LLP");
  });

  it("freezes every column G1.3-G1.5 added, the day they exist", async () => {
    // The structural sweep in tests/architecture/signed-letter-freeze.integration.test.ts
    // already covers these WITHOUT naming them — it asks the catalogue — which
    // is why nobody had to remember to extend the trigger for nine new columns.
    // This names them anyway, because "the background, the addressee and the
    // effective date are part of what the client agreed to" is an acceptance,
    // and an acceptance nobody can read in a test file is one that quietly
    // stops being true.
    //
    // The letter is filled COMPLETELY first, and that is the point of the
    // fixture rather than an accident of it: the freeze compares rows, so
    // setting an already-null column to NULL changes nothing and is correctly
    // allowed. A probe that did that would pass while proving nothing — which
    // is exactly the trap `probeValueFor` exists to avoid in the structural
    // sweep, met here from the other direction.
    //
    // Verified the other way round while writing this: adding a column to
    // `crm.signed_letter_mutable_columns()` makes the structural test fail on
    // its pinned allow-list, so widening the freeze cannot happen quietly.
    const id = await fullyFilledSignedLetter();
    const [before] = await owner<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(l) AS row FROM crm.engagement_letter l WHERE id = ${id}
    `;
    const columns = [
      "background",
      "addressed_to_party_id",
      "issued_on",
      "supersedes_id",
      "effective_from",
      "signed_by_title",
      "firm_signatory_user_id",
      "firm_signatory_title",
      "firm_signed_at",
    ];
    // The fixture is only worth anything if it actually filled them.
    expect(columns.filter((c) => before?.row[c] === null || before?.row[c] === undefined)).toEqual(
      [],
    );

    const escaped: string[] = [];
    for (const column of columns) {
      const outcome = await owner
        .unsafe(`UPDATE crm.engagement_letter SET "${column}" = NULL WHERE id = $1`, [id])
        .then(() => `${column}: the UPDATE SUCCEEDED after signature`)
        .catch((e: unknown) =>
          (e as { code?: string }).code === "23001"
            ? null
            : `${column}: refused with ${(e as { code?: string }).code ?? "(none)"}`,
        );
      if (outcome) escaped.push(outcome);
    }
    expect(escaped).toEqual([]);
  });

  it("refuses to change the reference or the issuer after signature", async () => {
    // Raw SQL as the OWNER: both columns are part of what the client agreed to,
    // and migration 0019 made the freeze cover a column the day it exists
    // rather than the day somebody remembers to list it.
    const id = await signedLetter();
    for (const statement of [
      owner`UPDATE crm.engagement_letter SET ref = 'EL-2026-9998' WHERE id = ${id}`,
      owner`
        UPDATE crm.engagement_letter SET issuing_entity_party_id = ${partyA} WHERE id = ${id}
      `,
    ]) {
      const err = await statement.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
    }
  });
});

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

  it("carries the entity from the LINE, and the client from the letter", async () => {
    // G0.1's acceptance. The two lines name two different companies of the same
    // client; before this, every engagement got `letter.partyId` and the group's
    // four companies were indistinguishable from each other on the one object
    // the compliance calendar generates against.
    const id = await signedLetter();
    const engagements = await letters.listEngagements(tenantA, id);
    expect(new Set(engagements.map((e) => e.entityPartyId))).toEqual(
      new Set([entityA1, entityA2]),
    );
    // And the client is still on every one of them: invoicing needs who is
    // billed, the calendar needs who the work is for, and both are stored.
    expect(engagements.every((e) => e.partyId === partyA)).toBe(true);
  });

  it("the database refuses a letter line with no entity", async () => {
    // NOT NULL in the schema rather than a check in the service, because a rule
    // in a service is one an import, a backfill or an agent walks straight past.
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.engagement_letter_line
          (tenant_id, engagement_letter_id, service_version_id, description, position,
           quantity, unit_amount, currency, discount_percent)
        VALUES (${tenantA}, ${crypto.randomUUID()}, ${gstV1}, 'x', 1, 1, 1, 'INR', 0)
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23502"); // not_null_violation
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
          (tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
           entity_party_id, status, activated_at, effective_from)
        VALUES (${tenantA}, ${id}, ${existing.engagementLetterLineId}, ${partyA},
                ${entityA1}, 'active', now(), current_date)
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
    expect(released.every((e) => e.engagement.status === "active")).toBe(true);
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

// ── G1.3 · lineage, and why it cannot loop ─────────────────────────────────
//
// `supersedes_id` is the one self-reference in this schema, so the question it
// always has to answer is whether a cycle is representable. It is not, and the
// argument is structural rather than a check somebody runs: an edge A→B can
// only be created when B is already SIGNED, a signed letter is FROZEN so its
// own edge can never change afterwards, and a letter cannot point at itself.
// Every edge therefore points at a row that was frozen before the edge existed.
// These tests exercise each leg of that argument against real Postgres, as the
// OWNER role, because an application-level version of it protects against the
// application only.

describe("superseding, in the database", () => {
  it("refuses to supersede a letter nobody signed — as the OWNER role", async () => {
    const draft = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — still being written",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      SYSTEM_ACTOR,
    );
    const err = await owner`
      INSERT INTO crm.engagement_letter
        (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
         currency, fx_rate, fx_rate_date, supersedes_id)
      VALUES (${tenantA}, ${`EL-2026-8${String(refProbe()).padStart(3, "0")}`}, ${partyA},
              ${firmEntityA}, 'IN', 'Replacement', 'INR', 1, '2026-07-01', ${draft.id})
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
    expect((err as Error).message).toContain("only a SIGNED letter is superseded");
  });

  it("makes a two-letter cycle impossible", async () => {
    // B supersedes A, legally: A is signed. Turning A round to point at B is
    // the cycle, and it is refused — by the FREEZE, because A is signed, which
    // is precisely why the DAG argument holds without a recursive check.
    const a = await signedLetter();
    const b = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — FY26, replacing the first",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        supersedesId: a,
      },
      SYSTEM_ACTOR,
    );

    const err = await owner`
      UPDATE crm.engagement_letter SET supersedes_id = ${b.id} WHERE id = ${a}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
    expect((err as Error).message).toContain("frozen");
  });

  it("refuses a letter that supersedes itself", async () => {
    const id = await signedLetter();
    const err = await owner`
      UPDATE crm.engagement_letter SET supersedes_id = id WHERE id = ${id}
    `.catch((e: unknown) => e);
    // The freeze gets there first on a signed letter, which is the right
    // complaint; the CHECK is what covers a draft, below.
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("refuses a DRAFT that points at itself, where the freeze does not apply", async () => {
    // The trigger gets here first — a BEFORE trigger runs ahead of the CHECK —
    // and it refuses for the more specific reason: a draft is not a signed
    // letter, so it is not something to supersede. `el_supersedes_not_self_chk`
    // stays as the backstop underneath it: if the trigger's rule is ever
    // relaxed (superseding a `sent` letter, say), a letter pointing at itself
    // is still unrepresentable without anybody having to remember why.
    const draft = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — pointing at itself",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      SYSTEM_ACTOR,
    );
    const err = await owner`
      UPDATE crm.engagement_letter SET supersedes_id = id WHERE id = ${draft.id}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");

    // And the backstop is really there, rather than being a line in a migration
    // nobody applied.
    const [constraint] = await owner<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = 'crm.engagement_letter'::regclass
        AND conname = 'el_supersedes_not_self_chk'
    `;
    expect(constraint?.name).toBe("el_supersedes_not_self_chk");
  });

  it("allows only one LIVE successor, and a withdrawn one frees the slot", async () => {
    const original = await signedLetter();
    const first = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Replacement",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        supersedesId: original,
      },
      SYSTEM_ACTOR,
    );

    // The service refuses the second one by name. The INDEX is what makes that
    // true when the service is bypassed, so it is asserted with raw SQL.
    const err = await owner`
      INSERT INTO crm.engagement_letter
        (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
         currency, fx_rate, fx_rate_date, supersedes_id)
      VALUES (${tenantA}, ${`EL-2026-7${String(refProbe()).padStart(3, "0")}`}, ${partyA},
              ${firmEntityA}, 'IN', 'Rival replacement', 'INR', 1, '2026-07-01', ${original})
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation

    // Drafting a replacement, pulling it, and drafting a better one is an
    // ordinary afternoon — a total unique index would block it forever.
    await service.withdraw(tenantA, first.id, SYSTEM_ACTOR);
    const second = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "The replacement we meant",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        supersedesId: original,
      },
      SYSTEM_ACTOR,
    );
    const record = await service.describe(tenantA, original);
    expect(record.supersededBy).toEqual({ id: second.id, ref: second.ref });
  });

  it("refuses to supersede another firm's letter", async () => {
    // The composite foreign key, not RLS: a foreign-key check runs as a system
    // operation RLS does not filter, so an id-only reference would let one
    // firm's letter claim to replace another firm's contract.
    const ours = await signedLetter();
    const err = await owner`
      INSERT INTO crm.engagement_letter
        (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
         currency, fx_rate, fx_rate_date, supersedes_id)
      VALUES (${tenantB}, ${`EL-2026-6${String(refProbe()).padStart(3, "0")}`},
              ${await partyAtB()}, ${await partyAtB()}, 'IN', 'Not yours to replace',
              'INR', 1, '2026-07-01', ${ours})
    `.catch((e: unknown) => e);
    // The trigger looks the target up WITHIN the tenant and finds nothing, so
    // it refuses before the key does. Either way it never lands.
    expect((err as { code?: string }).code).toBe("23001");
  });
});

// ── G1.4 · half a signature block is unrepresentable ───────────────────────

describe("the firm's signature block, in the database", () => {
  it("refuses a name with no capacity and no date", async () => {
    // 0017 gave the CLIENT's signature this property; 0022 gives the firm's
    // half the same one. A block that looks signed and proves nothing is worse
    // than none, because it reads as evidence.
    const draft = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — half a signature",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      SYSTEM_ACTOR,
    );
    const [signatory] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email)
      VALUES (${`signatory-${stamp}-${String(refProbe())}@example.test`}) RETURNING id
    `;
    if (!signatory) throw new Error("could not create the signatory");

    for (const statement of [
      owner`
        UPDATE crm.engagement_letter SET firm_signatory_user_id = ${signatory.id}
        WHERE id = ${draft.id}
      `,
      owner`
        UPDATE crm.engagement_letter SET firm_signatory_title = 'Director' WHERE id = ${draft.id}
      `,
      owner`
        UPDATE crm.engagement_letter
           SET firm_signatory_user_id = ${signatory.id}, firm_signatory_title = 'Director'
         WHERE id = ${draft.id}
      `,
    ]) {
      const err = await statement.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23514"); // check_violation
    }

    // All three together is the only shape that lands.
    await owner`
      UPDATE crm.engagement_letter
         SET firm_signatory_user_id = ${signatory.id},
             firm_signatory_title = 'Director',
             firm_signed_at = now()
       WHERE id = ${draft.id}
    `;
    const record = await service.describe(tenantA, draft.id);
    expect(record.firmSignatory?.title).toBe("Director");
  });
});

// ── G1.5 · the dates, through the whole stack ──────────────────────────────

describe("effective dates", () => {
  it("carries the resolved start date onto every engagement", async () => {
    // The acceptance, end to end: a letter signed today opening work that
    // begins in October, with one line that begins later still.
    const letter = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — FY27, starting October",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        effectiveFrom: "2026-10-01",
      },
      SYSTEM_ACTOR,
    );
    await service.addLine({
      tenantId: tenantA,
      letterId: letter.id,
      entityPartyId: entityA1,
      serviceVersionId: gstV1,
      description: "GST filing, from October",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "0",
    });
    await service.addLine({
      tenantId: tenantA,
      letterId: letter.id,
      entityPartyId: entityA2,
      serviceVersionId: gstV1,
      description: "Annual return, from December",
      quantity: "1",
      unitAmount: "18000",
      discountPercent: "0",
      effectiveFrom: "2026-12-01",
    });
    await service.addClause(tenantA, letter.id, scopeV1);
    await service.send(tenantA, letter.id, SYSTEM_ACTOR);
    const { engagements } = await service.sign(
      { tenantId: tenantA, letterId: letter.id, signedByName: "Priya Menon" },
      SYSTEM_ACTOR,
    );

    const byEntity = new Map(engagements.map((e) => [e.engagement.entityPartyId, e]));
    expect(byEntity.get(entityA1)?.engagement.effectiveFrom).toBe("2026-10-01");
    expect(byEntity.get(entityA2)?.engagement.effectiveFrom).toBe("2026-12-01");
    // Signed and paid for, and not started — which is the distinction the
    // whole task exists for.
    expect(engagements.every((e) => e.engagement.status === "active")).toBe(true);
    expect(engagements.every((e) => e.state === "pending_start")).toBe(true);
  });

  it("refuses an engagement with no start date at all", async () => {
    // NOT NULL in the schema rather than a default in the service, because a
    // scheduler that has to guess when work begins will guess today.
    const id = await signedLetter();
    const [existing] = await letters.listEngagements(tenantA, id);
    if (!existing) throw new Error("expected an engagement");
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.engagement
          (tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
           entity_party_id, status, activated_at)
        VALUES (${tenantA}, ${id}, ${existing.engagementLetterLineId}, ${partyA},
                ${entityA1}, 'active', now())
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23502"); // not_null_violation
  });
});
