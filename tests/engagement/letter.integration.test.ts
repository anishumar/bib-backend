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
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { CLIENT_DATE_ANCHOR, CLIENT_SIGN_ANCHOR } from "../../src/domain/render/model";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresTenantRepository } from "../../src/infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../../src/infrastructure/postgres/user-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { EngagementService, RECORDED_ACCEPTANCE_METHOD } from "../../src/usecase/engagement/service";
import { EvidenceNotFiledHere } from "../../src/domain/acceptance/errors";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { DocumentService } from "../../src/usecase/document/service";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { WorkVocabularyService } from "../../src/usecase/workitem/service";
import { PostgresWorkVocabularyRepository } from "../../src/infrastructure/postgres/work-vocabulary-repository";
import { PostgresStaffGradeRepository } from "../../src/infrastructure/postgres/staff-grade-repository";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  PostgresObligationExceptionRepository,
  PostgresObligationStateRepository,
  PostgresResolutionOptionRepository,
  PostgresObligationTemplateRepository,
} from "../../src/infrastructure/postgres/obligation-rule-repository";
import {
  PostgresCalendarSource,
  PostgresObligationInstanceRepository,
} from "../../src/infrastructure/postgres/obligation-instance-repository";
import { PostgresRuleServiceLinkRepository } from "../../src/infrastructure/postgres/obligation-link-repository";
import { ObligationService } from "../../src/usecase/obligation/service";
import { FakeAcceptedQuotes } from "../../src/testfakes/engagement";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: new PostgresMembershipRepository(app),
  // The real adapter, so a service body's Dept is checked against a real list.
  // These firms define none, which is the rule's own "not in use" case.
  axes: new PostgresServiceAxisRepository(app),
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
// G3.3's seniority ladder. A tenant is seeded with one at creation, so this
// test's firms have to be provisioned the same way the product provisions them
// — otherwise it is exercising a firm that could not exist.
const staffGradeRepository = new PostgresStaffGradeRepository(app);
const staffGrades = new StaffGradeService({
  grades: staffGradeRepository,
  ids: systemIds,
  events: ledger,
});
// T3.2's seeder, built once and passed as both ports — they are two methods on
// one service, and constructing it twice would give a firm two rule packs.
const obligationServiceForSeeding = new ObligationService({
  timeZones: new FakeFirmTimeZone(),
  templates: new PostgresObligationTemplateRepository(app),
  exceptions: new PostgresObligationExceptionRepository(app),
  states: new PostgresObligationStateRepository(app),
  resolutionOptions: new PostgresResolutionOptionRepository(app),
  instances: new PostgresObligationInstanceRepository(app),
  links: new PostgresRuleServiceLinkRepository(app),
  compliancePolicy: configRepository,
  calendarSource: new PostgresCalendarSource(app),
  services: configRepository,
  // Nothing in a provisioning test raises a task, so the raiser refuses rather
  // than pretending — a fake that silently returned an id would let a broken
  // wiring pass.
  workItems: {
    raiseForObligation: () => Promise.reject(new Error("not used in this test")),
  },
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const tenancy = new TenancyService({
  tenants: new PostgresTenantRepository(app),
  users: new PostgresUserRepository(app),
  memberships,
  roleSeeder: { seedDefaultRoles: (tenantId, actor) => config.seedDefaultRoles(tenantId, actor) },
  issuingEntitySeeder: { seedFirmEntity: (t, n) => documentRepository.seedFirmEntity(t, n) },
  roleDirectory: configRepository,
  gradeSeeder: { seedDefaultGrades: (t, a) => staffGrades.seedDefaultGrades(t, a) },
  gradeDirectory: staffGradeRepository,
  // T3.1. The real service over the real table, like the two seeders above:
  // provisioning that stopped giving a firm its work-item states would leave it
  // unable to record a single task, and this test is what would catch it.
  // T3.2. The real service over the real tables, on the same reasoning: a firm
  // provisioned without obligation STATES cannot have a filing generated at
  // all, and one without RULES gets an empty calendar with nothing explaining
  // why — which is the exact silence the coverage screen exists to break.
  obligationVocabularySeeder: obligationServiceForSeeding,
  obligationRuleSeeder: obligationServiceForSeeding,
  workVocabularySeeder: new WorkVocabularyService({
    vocabulary: new PostgresWorkVocabularyRepository(app),
    ids: systemIds,
    events: ledger,
  }),
  ids: systemIds,
  events: ledger,
});
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  standardBlocks: new PostgresStandardBlockRepository(app),
  blocks: new PostgresDocumentBlockRepository(app),
  ids: systemIds,
  events: ledger,
});
const service = new EngagementService({
  letters,
  library: configRepository,
  documents,
  firm: tenancy,
  // No brand asset is uploaded in this file, so the mark is always absent — the
  // state every letter sent before 0081 is in, and the one that must go on
  // rendering a bare rule.
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(app),
  // This file exercises the SQL behind a letter, not the quote it may have come
  // from, so the seam answers "no such proposal" for everything. A real
  // `ProposalService` here would drag the whole commercial module into a test
  // about `crm.engagement_letter`.
  quotes: new FakeAcceptedQuotes(),
  // The client's structure (F-10-1), read from the real relationships the
  // setup records below: a letter's lines and its addressee are checked
  // against it.
  structure: new PostgresRelationshipRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  // Attested sends nothing, so there is no envelope to raise or watch; the
  // request table is exercised by its own integration test.
  signatures: new PostgresSignatureRequestRepository(app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
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

  // THE CLIENT'S STRUCTURE (F-10-1). Both companies are Acme's and R Sharma
  // sits on its board, so a letter to Acme may cover the one and be addressed
  // to the other. Without these the letter would be refused, which is the
  // point: another client's company is not something a letter can name.
  for (const company of [entityA1, entityA2]) {
    await party.addRelationship(
      { tenantId: tenantA, fromPartyId: partyA, toPartyId: company, type: "parent_of", validFrom: "2020-04-01" },
      SYSTEM_ACTOR,
    );
  }
  await party.addRelationship(
    { tenantId: tenantA, fromPartyId: contactA, toPartyId: partyA, type: "director_of", validFrom: "2020-04-01" },
    SYSTEM_ACTOR,
  );

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

async function signedLetter(advance?: string, layout?: "classic"): Promise<string> {
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
  // A letter in the layout every letter issued before 0083 went out in. Set
  // while it is a DRAFT, the only time anything may set it; nothing in the
  // product does, because the product drafts in the current layout.
  if (layout !== undefined) {
    await owner`UPDATE crm.engagement_letter SET layout = ${layout} WHERE id = ${letter.id}`;
  }
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

  it("serves the catalogue the line CITES, as that version stated it", async () => {
    // G2.2 says a letter is "ASSEMBLED from the catalogue's own words", and until
    // this join existed a grep for the four scope blocks outside the config model
    // returned nothing — zero consumers. The same read carries `slaDays`, which
    // is what T3.1 snapshots onto a work item at creation and the reason a
    // LETTER pins a service version at all rather than reading the catalogue
    // live: work already agreed must not become retroactively late.
    const defined = await config.define(
      {
        tenantId: tenantA,
        kind: "service",
        key: "vcfo",
        body: {
          name: "Virtual CFO",
          ref: "V2",
          module: "RAA",
          group: "VCFO CONSOLE",
          billingBasis: "retainer",
          recurrence: "monthly",
          slaDays: 10,
          listPrice: { amount: "90000.00", currency: "INR" },
          scope: "Monthly management accounts, cash forecast and a board pack.",
          clientObligations: "Bank statements and ledgers by the 7th.",
          volumeLimits: "One entity; under 8 bank accounts.",
          exclusions: "Statutory audit and transfer-pricing studies.",
        },
      },
      SYSTEM_ACTOR,
    );
    await config.publish(
      { tenantId: tenantA, kind: "service", key: "vcfo", version: 1 },
      SYSTEM_ACTOR,
    );

    const letter = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — vCFO",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      SYSTEM_ACTOR,
    );
    await service.addLine({
      tenantId: tenantA,
      letterId: letter.id,
      entityPartyId: entityA1,
      serviceVersionId: defined.draft.id,
      description: "Virtual CFO, 12 months",
      quantity: "12",
      unitAmount: "85000",
      discountPercent: "0",
    });

    // The firm rewrites the service AFTER the letter was drafted.
    await config.addVersion({
      tenantId: tenantA,
      kind: "service",
      key: "vcfo",
      body: {
        name: "Virtual CFO",
        ref: "V2",
        billingBasis: "retainer",
        recurrence: "quarterly",
        slaDays: 30,
        scope: "REWRITTEN 2027: quarterly management accounts only.",
      },
    });
    await config.publish(
      { tenantId: tenantA, kind: "service", key: "vcfo", version: 2 },
      SYSTEM_ACTOR,
    );

    const record = await service.describe(tenantA, letter.id);
    const pinnedService = record.lines[0]?.service;
    expect(pinnedService?.slaDays).toBe(10);
    expect(pinnedService?.recurrence).toBe("monthly");
    expect(pinnedService?.version).toBe(1);
    // The firm's own code, on the letter, with no registry call per line.
    expect(pinnedService?.ref).toBe("V2");
    expect(pinnedService?.module).toBe("RAA");
    // The words the letter is assembled FROM — as the version it cites stated
    // them, not as the catalogue reads today.
    expect(pinnedService?.scope).toBe(
      "Monthly management accounts, cash forecast and a board pack.",
    );
    expect(pinnedService?.scope).not.toContain("REWRITTEN");
    expect(pinnedService?.volumeLimits).toBe("One entity; under 8 bank accounts.");
    // The other half of "list 90,000, agreed 85,000" — which migration 0017
    // says is the reason a letter line pins a version.
    expect(pinnedService?.listPrice).toEqual({ amount: "90000.00", currency: "INR" });
    expect(record.lines[0]?.line.unitAmount).toBe("85000.0000");
  });

  it("keeps THIS client's own wording after the catalogue is rewritten", async () => {
    // G1.6's second half, and the reason the overrides exist at all: without
    // them, tailoring one client's scope means editing the catalogue, which
    // silently rewrites the standard scope for every document issued
    // afterwards. With them the letter carries its own words, so a revision
    // next year cannot change what a signed document says.
    const defined = await config.define(
      {
        tenantId: tenantA,
        kind: "service",
        key: "payroll",
        body: {
          name: "Payroll processing",
          billingBasis: "fixed",
          recurrence: "monthly",
          scope: "Monthly payroll run for up to 50 employees.",
          clientObligations: "Attendance inputs by the 25th.",
          volumeLimits: "Up to 50 employees.",
          exclusions: "Payroll tax litigation.",
        },
      },
      SYSTEM_ACTOR,
    );
    await config.publish(
      { tenantId: tenantA, kind: "service", key: "payroll", version: 1 },
      SYSTEM_ACTOR,
    );

    const letter = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — payroll",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      SYSTEM_ACTOR,
    );
    await service.addLine({
      tenantId: tenantA,
      letterId: letter.id,
      entityPartyId: entityA1,
      serviceVersionId: defined.draft.id,
      description: "Payroll, 12 months",
      quantity: "12",
      unitAmount: "12000",
      discountPercent: "0",
      scopeOverride: "Monthly payroll run for up to 120 employees ACROSS BOTH ENTITIES.",
      jurisdiction: "IN",
      billingFrequency: "quarterly",
      oopEstimate: { min: "5000", max: "6000", currency: "USD" },
    });
    // A second line the two sides genuinely have not priced. On a letter that
    // is a TERM, not a gap.
    await service.addLine({
      tenantId: tenantA,
      letterId: letter.id,
      entityPartyId: entityA2,
      serviceVersionId: defined.draft.id,
      description: "Group restructuring support",
      quantity: "1",
      pricingNote: "As mutually agreed",
      discountPercent: "0",
    });
    await service.addClause(tenantA, letter.id, scopeV1);
    await service.send(tenantA, letter.id, SYSTEM_ACTOR);
    await service.sign(
      {
        tenantId: tenantA,
        letterId: letter.id,
        signedByName: "Priya Menon",
        reference: "paper-g16",
      },
      SYSTEM_ACTOR,
    );

    // The catalogue is rewritten AFTER the client signed.
    await config.addVersion({
      tenantId: tenantA,
      kind: "service",
      key: "payroll",
      body: {
        name: "Payroll processing",
        billingBasis: "fixed",
        recurrence: "annually",
        scope: "REWRITTEN 2027: payroll for up to 20 employees.",
        exclusions: "REWRITTEN 2027: everything else.",
      },
    });
    await config.publish(
      { tenantId: tenantA, kind: "service", key: "payroll", version: 2 },
      SYSTEM_ACTOR,
    );

    const record = await service.describe(tenantA, letter.id);
    const line = record.lines[0];
    // The tailored block is THIS letter's, and it says so.
    expect(line?.terms.scope).toEqual({
      text: "Monthly payroll run for up to 120 employees ACROSS BOTH ENTITIES.",
      tailored: true,
    });
    // The blocks nobody tailored come from the version the line PINNED — not
    // from the catalogue as it reads now.
    expect(line?.terms.exclusions).toEqual({
      text: "Payroll tax litigation.",
      tailored: false,
    });
    expect(line?.terms.exclusions.text).not.toContain("REWRITTEN");
    // A monthly service billed quarterly, which is the arrangement a derived
    // billing frequency would have made unrepresentable.
    expect(line?.line.billingFrequency).toBe("quarterly");
    expect(line?.service?.recurrence).toBe("monthly");
    // Out-of-pockets in a currency the letter is not in, outside the money.
    expect(line?.line.oopEstimate).toEqual({
      min: "5000.0000",
      max: "6000.0000",
      currency: "USD",
    });

    // AND THE TOTALS SAY WHAT THEY DO NOT COVER. 12 × 12,000 is the whole of
    // the priced work; the second line is agreed and unpriced, and a figure
    // that did not admit it would be a number a partner acts on.
    expect(Number(record.totals.net)).toBe(144000);
    expect(record.totals.unpricedLineCount).toBe(1);
    expect(record.lines[1]?.line.unitAmount).toBeNull();
    expect(record.lines[1]?.net).toBeNull();
    expect(record.lines[1]?.line.pricingNote).toBe("As mutually agreed");

    // And the wording cannot be edited out from under the signature — as the
    // OWNER role, which is where an application rule would not reach.
    const err = await owner`
      UPDATE crm.engagement_letter_line
         SET scope_override = 'quietly narrowed'
       WHERE id = ${line?.line.id ?? ""}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
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
  it("starts every engagement at signature, advance or not (0322)", async () => {
    const id = await signedLetter("10000");
    const started = await letters.listEngagements(tenantA, id);
    expect(started).toHaveLength(2);
    expect(started.every((e) => e.status === "active" && e.activatedAt !== null)).toBe(true);
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


describe("what a client can be BILLED for (T3.5b)", () => {
  // The other half of the carry-forward, and it is a JOIN — so only Postgres
  // can say whether it reads the right columns. The whole finding was that the
  // letter's agreed price reached nothing, so the one thing that matters here
  // is WHERE THE MONEY COMES FROM.

  it("carries the LETTER LINE's agreed price, not the catalogue's list price", async () => {
    const id = await signedLetter();

    // Scoped to the letter this test signed. Every case in this file writes to
    // the same firm and the suite is single-threaded by design, so a read of
    // "everything partyA has signed" grows with the file.
    const billable = (await letters.listBillable(tenantA, partyA)).filter(
      (b) => b.letterId === id,
    );

    const gst = billable.find((b) => b.description === "GST filing, 12 months");
    expect(gst).toBeDefined();
    // 2000 is what this client agreed on the line. The catalogue's own figure
    // is a different number and reading it here would quietly bill a
    // negotiated discount away.
    expect(Number(gst?.unitAmount)).toBe(2000);
    expect(Number(gst?.quantity)).toBe(12);
    expect(gst?.currency).toBe("INR");
  });

  it("says which COMPANY each one is for — a group bills as several", async () => {
    const id = await signedLetter();

    const billable = (await letters.listBillable(tenantA, partyA)).filter(
      (b) => b.letterId === id,
    );

    // An engagement is one service for one legal entity, so the two lines of
    // one letter are two billable rows naming two different companies. An
    // invoice line that got this wrong would bill the wrong entity.
    expect(new Set(billable.map((b) => b.entityPartyId))).toEqual(
      new Set([entityA1, entityA2]),
    );
    expect(billable.every((b) => b.entityName.length > 0)).toBe(true);
  });

  it("names the letter it came from, so a screen can cite the signed document", async () => {
    const id = await signedLetter();

    const billable = await letters.listBillable(tenantA, partyA);

    const mine = billable.filter((b) => b.letterId === id);
    expect(mine).toHaveLength(2);
    expect(mine.every((b) => b.letterRef.length > 0)).toBe(true);
  });

  it("names the firm's company that signed the letter, which is the one that charges", async () => {
    const id = await signedLetter();
    const letter = await letters.findLetter(tenantA, id);

    const mine = (await letters.listBillable(tenantA, partyA)).filter((b) => b.letterId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((b) => b.issuingEntityPartyId === letter?.issuingEntityPartyId)).toBe(true);
    expect(mine.every((b) => b.issuingEntityName.length > 0)).toBe(true);
  });

  it("returns work still behind the ADVANCE GATE, marked, rather than hiding it", async () => {
    // Filtering here would leave a screen unable to explain why a service the
    // client signed for is missing from the picker — the blank-versus-absent
    // failure this codebase has paid for several times. The caller decides what
    // to OFFER; this says what is true.
    // Since 0322 a signature starts the work, so the only work still behind
    // the gate is a letter signed before it: put one engagement back there.
    const id = await signedLetter("50000");
    await owner`
      UPDATE crm.engagement SET status = 'pending_advance', activated_at = NULL
       WHERE engagement_letter_id = ${id}
    `;

    const billable = (await letters.listBillable(tenantA, partyA)).filter(
      (b) => b.letterId === id,
    );

    expect(billable.length).toBeGreaterThan(0);
    expect(billable.every((b) => b.status === "pending_advance")).toBe(true);
  });

  it("does not reach another firm's engagements", async () => {
    await signedLetter();

    // The tenant wall, stated as a test rather than trusted: this read joins
    // four tables and a missing `tenant_id` on any one of them is invisible
    // until somebody else's contract appears in a picker.
    expect(await letters.listBillable(tenantB, partyA)).toEqual([]);
  });

  it("is empty for a client with nothing signed — not an error", async () => {
    expect(await letters.listBillable(tenantA, partyBId)).toEqual([]);
  });
});

describe("a letter's signature request, in the database (0080)", () => {
  const requests = new PostgresSignatureRequestRepository(app);

  /** A SENT letter at firm A — what a request hangs off. */
  async function sentLetter(): Promise<string> {
    const letter = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — out for signature",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
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
    await service.addClause(tenantA, letter.id, scopeV1);
    await service.send(tenantA, letter.id, SYSTEM_ACTOR);
    return letter.id;
  }

  async function opened(letterId: string) {
    return requests.open({
      id: crypto.randomUUID(),
      tenantId: tenantA,
      letterId,
      provider: "docusign",
      signer: { name: "Priya Menon", email: "priya@acme.example" },
      requestedBy: null,
    });
  }

  it("keeps one request per letter: a second open replaces the signer until an envelope exists, then changes nothing", async () => {
    const letterId = await sentLetter();
    const first = await opened(letterId);

    const renamed = await requests.open({
      id: crypto.randomUUID(),
      tenantId: tenantA,
      letterId,
      provider: "docusign",
      signer: { name: "P. Menon", email: "p.menon@acme.example" },
      requestedBy: null,
    });
    expect(renamed.id).toBe(first.id);
    expect(renamed.signer.email).toBe("p.menon@acme.example");

    await requests.recordRaised(tenantA, first.id, crypto.randomUUID(), new Date().toISOString());
    const after = await opened(letterId);
    expect(after.signer.email).toBe("p.menon@acme.example");
  });

  it("lets exactly one of two racing claims win, and a stale claim be taken again", async () => {
    const request = await opened(await sentLetter());
    const now = new Date();
    const at = now.toISOString();
    const staleBefore = new Date(now.getTime() - 120_000).toISOString();

    const [a, b] = await Promise.all([
      requests.claim(tenantA, request.id, at, staleBefore),
      requests.claim(tenantA, request.id, at, staleBefore),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);

    // A claim newer than the lease is honoured; one older than it is presumed dead.
    expect(await requests.claim(tenantA, request.id, at, staleBefore)).toBeNull();
    const later = new Date(now.getTime() + 5 * 60_000);
    const retaken = await requests.claim(
      tenantA,
      request.id,
      later.toISOString(),
      new Date(later.getTime() - 120_000).toISOString(),
    );
    expect(retaken?.attempts).toBe(2);
  });

  it("releases the claim on failure and keeps the provider's words, cleared by a success", async () => {
    const request = await opened(await sentLetter());
    const at = new Date().toISOString();
    await requests.claim(tenantA, request.id, at, at);

    const failed = await requests.recordFailure(tenantA, request.id, "HTTP 400 INVALID_EMAIL");
    expect(failed.lastFailure).toBe("HTTP 400 INVALID_EMAIL");
    expect(await requests.claim(tenantA, request.id, at, at)).not.toBeNull();

    const raised = await requests.recordRaised(tenantA, request.id, crypto.randomUUID(), at);
    expect(raised.lastFailure).toBeNull();
    expect(raised.raisedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await requests.claim(tenantA, request.id, at, new Date(Date.now() + 1e6).toISOString())).toBeNull();
  });

  it("lists only raised, unsettled requests for the sweep, and settles each once", async () => {
    const waiting = await opened(await sentLetter());
    const notRaised = await opened(await sentLetter());
    await requests.recordRaised(tenantA, waiting.id, crypto.randomUUID(), new Date().toISOString());

    const ids = (await requests.listAwaiting(tenantA)).map((r) => r.id);
    expect(ids).toContain(waiting.id);
    expect(ids).not.toContain(notRaised.id);

    await requests.settle(tenantA, waiting.id, "completed", new Date().toISOString());
    await requests.settle(tenantA, waiting.id, "declined", new Date().toISOString());
    expect((await requests.listAwaiting(tenantA)).map((r) => r.id)).not.toContain(waiting.id);
    expect((await requests.findForLetter(tenantA, waiting.letterId))?.outcome).toBe("completed");
  });

  it("refuses to settle an envelope that never existed, and an address that is not one", async () => {
    const request = await opened(await sentLetter());
    await expect(
      owner`UPDATE crm.letter_signature_request SET outcome = 'completed', settled_at = now()
            WHERE id = ${request.id}`,
    ).rejects.toThrow(/settles_a_raised_one/);
    await expect(
      owner`UPDATE crm.letter_signature_request SET signer_email = 'Priya Menon' WHERE id = ${request.id}`,
    ).rejects.toThrow(/signer_email_check/);
  });

  it("lists a signed request until its copies are filed, and refuses copies on anything unsigned", async () => {
    const request = await opened(await sentLetter());
    await requests.recordRaised(tenantA, request.id, crypto.randomUUID(), new Date().toISOString());
    await expect(
      owner`UPDATE crm.letter_signature_request SET copies_filed_at = now() WHERE id = ${request.id}`,
    ).rejects.toThrow(/copies_of_a_signature/);

    await requests.settle(tenantA, request.id, "completed", new Date().toISOString());
    expect((await requests.listUnfiled(tenantA)).map((r) => r.id)).toContain(request.id);

    await requests.recordCopiesFiled(tenantA, request.id, new Date().toISOString());
    expect((await requests.listUnfiled(tenantA)).map((r) => r.id)).not.toContain(request.id);
    expect((await requests.findForLetter(tenantA, request.letterId))?.copiesFiledAt).toMatch(/Z$/);
  });

  it("is invisible to another firm, and cannot hang off another firm's letter", async () => {
    const letterId = await sentLetter();
    await opened(letterId);

    expect(await requests.findForLetter(tenantB, letterId)).toBeNull();
    expect(await requests.listAwaiting(tenantB)).toEqual([]);
    await expect(
      requests.open({
        id: crypto.randomUUID(),
        tenantId: tenantB,
        letterId,
        provider: "docusign",
        signer: { name: "Mallory", email: "mallory@example.test" },
        requestedBy: null,
      }),
    ).rejects.toThrow(/letter_signature_request_letter_fkey/);
  });
});

describe("the signature blocks a letter PRINTS (0080)", () => {
  // The render source's SQL, run: the firm's signatory is a join on a GLOBAL
  // table, and a join nobody executed is how a PDF ships with a blank name.
  const source = new PostgresRenderSource(app, () => Promise.resolve(null));

  // EVERY LETTER DRAFTED SINCE 0083 PRINTS IN THE ANNEXURE LAYOUT, where both
  // blocks sit on the cover letter: the firm's under "Yours sincerely", the
  // client's under the acceptance.
  it("prints the firm's block by NAME once sent, and the client's block on the anchors DocuSign looks for", async () => {
    await nameTheFirmSignatory();
    const id = await signedLetter();

    const described = await source.describe({ tenantId: tenantA, kind: "engagement_letter", subjectRef: id });
    const cover = described?.document.annexureLetter?.cover;

    expect(cover?.firm).toEqual({
      heading: "For EL Test A LLP",
      // The signatory's address under their name — "you may reach out to the
      // undersigned" — as the firm's own template prints it.
      lines: ["Siddharth Jain", "Director", `firm-signatory-${stamp}@example.test`],
      signAnchor: null,
      dateAnchor: null,
      // No brand asset was uploaded, so nothing was pinned at send and the
      // block prints a bare rule (0081).
      image: null,
    });
    expect(cover?.client).toEqual({
      // WHO the client signs for: itself, and every company a line is for.
      heading:
        "Accepted for and on behalf of Acme Ltd, for itself and on behalf of Acme Foods Ltd " +
        "and Acme Logistics Ltd",
      lines: ["Priya Menon"],
      signAnchor: CLIENT_SIGN_ANCHOR,
      dateAnchor: CLIENT_DATE_ANCHOR,
    });
    // And none of the classic document's parts: the annexure letter IS the
    // document.
    expect(described?.document.signatures).toBeUndefined();
    expect(described?.document.terms).toBeUndefined();
  });

  // THE CLIENT'S BLOCK NEVER CARRIES A MARK, whatever the firm has uploaded.
  // Drawing on a line the client has not signed would be a forgery this product
  // produced itself; the provider stamps that line, and the type is what keeps
  // it that way.
  it("never puts a mark on the client's block", async () => {
    await nameTheFirmSignatory();
    const id = await signedLetter();

    const described = await source.describe({ tenantId: tenantA, kind: "engagement_letter", subjectRef: id });

    expect(described?.document.annexureLetter?.cover.client).not.toHaveProperty("image");
  });

  // The clauses the letter PINNED reach the page — Annexure 2, numbered.
  it("prints the TERMS the letter was assembled from, as Annexure 2", async () => {
    await nameTheFirmSignatory();
    const id = await signedLetter();

    const described = await source.describe({ tenantId: tenantA, kind: "engagement_letter", subjectRef: id });
    const terms = described?.document.annexureLetter?.annexures[1];

    expect(terms?.label).toBe("Annexure 2");
    // The pinned wording, not the library's rewrite of it.
    expect(terms?.flow).toEqual([
      { kind: "heading", level: 2, text: "1. Scope of work" },
      { kind: "paragraph", text: "The firm will perform the services listed above.", muted: false },
    ]);
  });

  // A LETTER ISSUED IN THE CLASSIC LAYOUT RE-RENDERS IN IT (0083). Every letter
  // that went out before 0083 is `classic`, and its PDF has to come out as the
  // document its client holds — so the classic path is exercised on a letter
  // that says so, exactly as it did before.
  it("prints a CLASSIC letter as it always did — both blocks at the end, and the terms", async () => {
    await nameTheFirmSignatory();
    const id = await signedLetter(undefined, "classic");

    const described = await source.describe({ tenantId: tenantA, kind: "engagement_letter", subjectRef: id });

    expect(described?.document.annexureLetter).toBeUndefined();
    expect(described?.document.signatures).toEqual([
      {
        heading: "For EL Test A LLP",
        lines: ["Siddharth Jain", "Director"],
        signAnchor: null,
        dateAnchor: null,
        image: null,
      },
      {
        heading: "Accepted for and on behalf of Acme Ltd",
        lines: ["Priya Menon"],
        signAnchor: CLIENT_SIGN_ANCHOR,
        dateAnchor: CLIENT_DATE_ANCHOR,
      },
    ]);
    expect(described?.document.terms?.length ?? 0).toBeGreaterThan(0);
    for (const term of described?.document.terms ?? []) {
      expect(term.heading).toBeTruthy();
      expect(term.paragraphs.join("").trim()).not.toBe("");
    }
  });
});

describe("who a letter and an invoice name, in the database (F-10-1, 0306)", () => {
  // The composite keys prove a reference is THIS FIRM's and nothing more. These
  // prove the rest: that a line is for the client's own company, that the
  // addressee holds a role there, and — as walls a script or a psql session
  // meets — that an invoice is issued by the firm and bills the right client's
  // engagement, and that a letter cites a quote to its own client.
  const relationships = new PostgresRelationshipRepository(app);
  const invoices = new PostgresInvoiceRepository(app);
  const DAY = "2026-09-25";

  async function org(name: string): Promise<string> {
    return (await party.createOrganization({ tenantId: tenantA, legalName: `${name} ${stamp}` }, SYSTEM_ACTOR))
      .partyId;
  }
  async function person(name: string): Promise<string> {
    return (await party.createPerson({ tenantId: tenantA, fullName: `${name} ${stamp}` }, SYSTEM_ACTOR)).partyId;
  }
  async function relate(from: string, to: string, type: string, validFrom = "2020-04-01", validTo?: string) {
    await party.addRelationship(
      { tenantId: tenantA, fromPartyId: from, toPartyId: to, type, validFrom, ...(validTo ? { validTo } : {}) },
      SYSTEM_ACTOR,
    );
  }
  async function draftForA(over: { addressedToPartyId?: string } = {}) {
    return service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — structure",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        ...over,
      },
      SYSTEM_ACTOR,
    );
  }
  const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

  it("walks ownership to any depth, follows a stake, and survives a loop", async () => {
    const grandchild = await org("Acme Foods Exports");
    await relate(entityA1, grandchild, "parent_of");
    // A mistake a firm can make: the grandchild recorded as the group's parent.
    await relate(grandchild, partyA, "parent_of");
    const associate = await org("Acme Associate");
    await relate(partyA, associate, "shareholder_of");

    const s = await relationships.structureOf(tenantA, partyA, DAY);
    const ids = s.entities.map((e) => e.id);
    expect(ids[0]).toBe(partyA);
    expect(ids).toEqual(expect.arrayContaining([entityA1, entityA2, grandchild, associate]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts a relationship only on the days it is in force", async () => {
    const former = await person("Former Director");
    await relate(former, partyA, "director_of", "2019-04-01", "2021-04-01");
    const incoming = await person("Incoming Director");
    await relate(incoming, partyA, "director_of", "2027-04-01");
    const ended = await org("Sold Subsidiary");
    await relate(partyA, ended, "parent_of", "2019-04-01", "2022-04-01");

    const s = await relationships.structureOf(tenantA, partyA, DAY);
    expect(s.people.map((p) => p.id)).not.toContain(former);
    expect(s.people.map((p) => p.id)).not.toContain(incoming);
    expect(s.entities.map((e) => e.id)).not.toContain(ended);
    // And on a day inside the old window, the same rows answer the other way.
    const then = await relationships.structureOf(tenantA, partyA, "2020-06-30");
    expect(then.people.map((p) => p.id)).toContain(former);
    expect(then.entities.map((e) => e.id)).toContain(ended);
  });

  it("names the people with a role anywhere in the structure, and nobody else", async () => {
    const subsidiaryCfo = await person("Subsidiary CFO");
    await relate(subsidiaryCfo, entityA2, "employee_of");
    const outsider = await person("Somebody Else");
    const s = await relationships.structureOf(tenantA, partyA, DAY);
    const people = s.people.map((p) => p.id);
    expect(people).toEqual(expect.arrayContaining([contactA, subsidiaryCfo]));
    expect(people).not.toContain(outsider);
  });

  it("refuses a line for a company outside the client, and takes it once the link is recorded", async () => {
    const stray = await org("Unrelated Traders");
    const letter = await draftForA();
    const line = () =>
      service.addLine({
        tenantId: tenantA,
        letterId: letter.id,
        entityPartyId: stray,
        serviceVersionId: gstV1,
        description: "GST filing",
        quantity: "12",
        unitAmount: "2000",
        discountPercent: "0",
      });
    expect(codeOf(await line().catch((e: unknown) => e))).toBe("ENTITY_OUTSIDE_CLIENT");
    await relate(partyA, stray, "parent_of");
    await expect(line()).resolves.toMatchObject({ entityPartyId: stray });
  });

  it("refuses an addressee whose only role has ended", async () => {
    const retired = await person("Retired Signatory");
    await relate(retired, partyA, "authorised_signatory_of", "2018-04-01", "2020-04-01");
    const err = await draftForA({ addressedToPartyId: retired }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe("ADDRESSEE_NOT_LINKED");
  });

  it("walls an invoice issued by a client, or billing the firm, even past the service", async () => {
    const draft = {
      tenantId: tenantA,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      dueOn: null,
      notes: null,
      financialYear: 2026,
    };
    const issuedByClient = await invoices
      .create({ ...draft, id: systemIds.newId(), partyId: entityA1, entityPartyId: partyA })
      .catch((e: unknown) => e);
    expect(codeOf(issuedByClient)).toBe("23514");
    const billsTheFirm = await invoices
      .create({ ...draft, id: systemIds.newId(), partyId: firmEntityA, entityPartyId: firmEntityA })
      .catch((e: unknown) => e);
    expect(codeOf(billsTheFirm)).toBe("23514");
  });

  it("walls an invoice line billing another client's engagement", async () => {
    const letterId = await signedLetter();
    const [engagement] = await letters.listEngagements(tenantA, letterId);
    if (!engagement) throw new Error("the letter fanned out into nothing");
    const otherClient = await org("Other Client");
    const base = {
      tenantId: tenantA,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      dueOn: null,
      notes: null,
      financialYear: 2026,
      entityPartyId: firmEntityA,
    };
    const acmes = await invoices.create({ ...base, id: systemIds.newId(), partyId: partyA });
    const others = await invoices.create({ ...base, id: systemIds.newId(), partyId: otherClient });
    const line = (invoiceId: string) =>
      invoices.addLine({
        id: systemIds.newId(),
        tenantId: tenantA,
        invoiceId,
        engagementId: engagement.id,
        description: "GST filing, July",
        quantity: "1",
        unitAmount: "2000",
        currency: "INR",
        discountPercent: "0",
        taxPercent: "0",
      });
    await expect(line(acmes.id)).resolves.toMatchObject({ engagementId: engagement.id });
    expect(codeOf(await line(others.id).catch((e: unknown) => e))).toBe("23514");
  });

  it("walls a letter citing a quote made to another client", async () => {
    const otherClient = await org("Quoted Elsewhere");
    const [quote] = await owner<{ id: string }[]>`
      INSERT INTO crm.proposal
        (tenant_id, ref, party_id, issuing_entity_party_id, title, currency, fx_rate, fx_rate_date)
      VALUES (${tenantA}, 'PR-2026-9101', ${otherClient}, ${firmEntityA}, 'Raw probe', 'INR', 1, '2026-06-01')
      RETURNING id
    `;
    if (!quote) throw new Error("could not create the quote");
    const insert = (client: string, ref: string): Promise<unknown> => owner`
      INSERT INTO crm.engagement_letter
        (tenant_id, ref, party_id, issuing_entity_party_id, proposal_id, jurisdiction, title,
         currency, fx_rate, fx_rate_date)
      VALUES (${tenantA}, ${ref}, ${client}, ${firmEntityA}, ${quote.id},
              'IN', 'Raw probe', 'INR', 1, '2026-06-01')
    `;
    expect(codeOf(await insert(partyA, "EL-2026-9101").catch((e: unknown) => e))).toBe("23514");
    await expect(insert(otherClient, "EL-2026-9102")).resolves.toBeDefined();
  });
});

describe("a letter the client accepted outside bib, in the database (0317)", () => {
  /** A letter sent and waiting, and the client's email filed against it. */
  async function sentWithEvidence(): Promise<{ letterId: string; emailFile: string }> {
    const letter = await service.draft(
      {
        tenantId: tenantA,
        partyId: partyA,
        jurisdiction: "IN",
        title: "Acme — accepted by email",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
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
    await service.addClause(tenantA, letter.id, scopeV1);
    await service.send(tenantA, letter.id, SYSTEM_ACTOR);
    const [doc] = await owner<{ id: string }[]>`
      INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
      VALUES (${tenantA}, 'Email from R Sharma: go ahead', 'uploaded', 'correspondence', ${partyA})
      RETURNING id
    `;
    if (!doc) throw new Error("could not file the evidence");
    await owner`
      INSERT INTO files.document_link (tenant_id, document_id, subject_kind, subject_ref, role)
      VALUES (${tenantA}, ${doc.id}, 'engagement_letter', ${letter.id}, 'acceptance_evidence')
    `;
    return { letterId: letter.id, emailFile: doc.id };
  }

  async function recorder(): Promise<string> {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name)
      VALUES (${`recorder-${stamp}-${String(refProbe())}@example.test`}, 'Siddharth Kohli') RETURNING id
    `;
    if (!u) throw new Error("could not create the recorder");
    return u.id;
  }

  it("signs it, fans out, and writes the evidence in the same transaction", async () => {
    const { letterId, emailFile } = await sentWithEvidence();
    const partner = await recorder();

    const result = await service.recordAcceptance(
      {
        tenantId: tenantA,
        letterId,
        statement: {
          channel: "email",
          acceptedOn: (await service.describe(tenantA, letterId)).letter.sentAt?.slice(0, 10) ?? "",
          acceptedByName: "R Sharma",
          note: "Replied go ahead on the letter thread.",
          evidenceDocumentId: emailFile,
        },
      },
      partner,
      { type: "human", id: partner },
    );

    expect(result.letter).toMatchObject({ status: "signed", signatureMethod: RECORDED_ACCEPTANCE_METHOD });
    expect(result.engagements).toHaveLength(1);
    const view = await service.describe(tenantA, letterId);
    expect(view.recordedAcceptance).toMatchObject({
      channel: "email",
      acceptedByName: "R Sharma",
      evidenceDocumentId: emailFile,
      evidenceTitle: "Email from R Sharma: go ahead",
      recordedBy: { userId: partner, displayName: "Siddharth Kohli" },
    });
  });

  it("refuses a file filed against ANOTHER letter, and moves nothing", async () => {
    const first = await sentWithEvidence();
    const second = await sentWithEvidence();
    const partner = await recorder();
    // The first letter's email, offered as the second letter's evidence.
    await expect(
      letters.signAndFanOut(
        tenantA,
        second.letterId,
        {
          signedAt: new Date().toISOString(),
          signedByName: "R Sharma",
          signedByTitle: null,
          signatureMethod: RECORDED_ACCEPTANCE_METHOD,
          signatureReference: "probe",
          signedContentHash: "0".repeat(64),
        },
        [],
        {
          id: crypto.randomUUID(),
          tenantId: tenantA,
          channel: "email",
          acceptedOn: "2026-07-01",
          acceptedByName: "R Sharma",
          acceptedByTitle: null,
          note: "wrong file",
          evidenceDocumentId: first.emailFile,
          recordedByUserId: partner,
        },
      ),
    ).rejects.toBeInstanceOf(EvidenceNotFiledHere);
    // The rollback took the status with it.
    expect((await service.describe(tenantA, second.letterId)).letter.status).toBe("sent");
  });

  it("is append-only by GRANT, needs evidence on a letter, and is walled per firm", async () => {
    const { letterId } = await sentWithEvidence();
    const partner = await recorder();
    const codeOf = (e: unknown) => (e as { code?: string }).code;

    // A letter's row with no evidence: the CHECK.
    const noEvidence = await withTenant(app, tenantA, (db) => db`
      INSERT INTO crm.recorded_acceptance
        (tenant_id, engagement_letter_id, channel, accepted_on, accepted_by_name, note, recorded_by_user_id)
      VALUES (${tenantA}, ${letterId}, 'call', '2026-07-01', 'R Sharma', 'said yes', ${partner})
    `).catch((e: unknown) => e);
    expect(codeOf(noEvidence)).toBe("23514");

    // Written, then neither changed nor removed by the app role.
    const { letterId: other, emailFile } = await sentWithEvidence();
    await withTenant(app, tenantA, (db) => db`
      INSERT INTO crm.recorded_acceptance
        (tenant_id, engagement_letter_id, channel, accepted_on, accepted_by_name, note,
         evidence_document_id, recorded_by_user_id)
      VALUES (${tenantA}, ${other}, 'email', '2026-07-01', 'R Sharma', 'said yes', ${emailFile}, ${partner})
    `);
    const edit = await withTenant(app, tenantA, (db) => db`
      UPDATE crm.recorded_acceptance SET note = 'rewritten' WHERE engagement_letter_id = ${other}
    `).catch((e: unknown) => e);
    expect(codeOf(edit)).toBe("42501");
    const remove = await withTenant(app, tenantA, (db) => db`
      DELETE FROM crm.recorded_acceptance WHERE engagement_letter_id = ${other}
    `).catch((e: unknown) => e);
    expect(codeOf(remove)).toBe("42501");

    // The other firm sees nothing of it.
    const seen = await withTenant(app, tenantB, (db) => db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.recorded_acceptance WHERE engagement_letter_id = ${other}
    `);
    expect(seen[0]?.n).toBe(0);
  });
});
