import { describe, expect, it } from "vitest";

import {
  ClientImportAlreadyConfirmed,
  ClientImportBlocked,
  ClientImportNotFound,
  ClientSheetRequired,
  SheetEmpty,
  SheetHeaderMissing,
} from "../../src/domain/clientimport/errors";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { CALENDAR_REACH_BACK_DAYS, ClientImportService, clausesFor } from "../../src/usecase/clientimport/service";
import { REACH_BACK_DAYS } from "../../src/usecase/obligation/service";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FakeClientImportStore,
  FakeImportDirectory,
  FakePortalMemberFinder,
  FakeSheetReader,
  RecordingAssignmentWriter,
  RecordingLetterWriter,
  RecordingPartyWriter,
  RecordingPortalAccessGranter,
  RecordingPortalInviteWriter,
  sheetBytes,
} from "../../src/testfakes/clientimport";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = SYSTEM_ACTOR;
const TODAY = "2026-09-07";

const CLIENTS = [
  "Client Name,Known As,Client Since,Group,Country,Entity Type,Incorporated On,Financial Year End,PAN,Key Manager,SPOC: TRC,Signatory,Portal Invite,Portal Email",
  "Kaveri Group,,2019-04-01,,,,,,,anita@firm.test,,Rajesh Kumar,TRUE,rajesh@kaveri.test",
  "Kaveri Foods Private Limited,Kaveri Foods,,Kaveri Group,IN,private_limited,2019-06-11,03-31,AAACK1111K,,ravi@firm.test,,,",
  "Cobalt Foods Private Limited,,2021-01-15,,IN,private_limited,2020-11-03,03-31,AAACC1234F,anita@firm.test,ravi@firm.test,Priya Menon,TRUE,priya.menon@cobalt.test",
].join("\n");

const PEOPLE = [
  "Client,Of,Name,Relationship,Since,Email,Phone",
  "Kaveri Group,Kaveri Foods Private Limited,Meera Nair,director,2019-06-11,meera@kaveri.test,+91 98450 00000",
  "Cobalt Foods Private Limited,,Priya Menon,signatory,,priya@cobalt.test,",
].join("\n");

const ENGAGEMENTS = [
  "Company,Service,Started On,Billed,Fee,Currency,Where,Basis",
  "Kaveri Foods Private Limited,A1,2025-04-01,monthly,6000,INR,,EL 2025-04",
  "Cobalt Foods Private Limited,A1,2026-08-01,,7500,INR,,",
  "Cobalt Foods Private Limited,H1,2026-08-01,quarterly,,,,Drive/Cobalt/EL",
].join("\n");

function directory(): FakeImportDirectory {
  return new FakeImportDirectory()
    .withFirm({ selfPartyId: "party-firm", reportingCurrency: "INR" })
    .withService({ serviceId: "svc-a1", serviceVersionId: "ver-a1", code: "A1", name: "GST filing", module: "TRC", billingFrequency: "monthly" })
    .withService({ serviceId: "svc-h1", serviceVersionId: "ver-h1", code: "H1", name: "Payroll", module: "FRC", billingFrequency: null })
    .withAxis({ id: "axis-trc", axis: "dept", code: "TRC", name: "Tax", isActive: true })
    .withAxis({ id: "axis-frc", axis: "dept", code: "FRC", name: "Finance", isActive: true })
    .withStaff("anita@firm.test", "user-anita")
    .withStaff("ravi@firm.test", "user-ravi")
    .withClause({ versionId: "clause-in", jurisdictions: ["IN"], governingLawJurisdiction: "IN", courtsJurisdiction: null })
    .withClause({ versionId: "clause-everywhere", jurisdictions: [], governingLawJurisdiction: null, courtsJurisdiction: null })
    .withClause({ versionId: "clause-us-law", jurisdictions: [], governingLawJurisdiction: "US", courtsJurisdiction: "US" })
    .withComplianceFloor("2026-04-01");
}

interface Harness {
  service: ClientImportService;
  store: FakeClientImportStore;
  dir: FakeImportDirectory;
  parties: RecordingPartyWriter;
  assignments: RecordingAssignmentWriter;
  letters: RecordingLetterWriter;
  portalInvites: RecordingPortalInviteWriter;
  portalAccess: RecordingPortalAccessGranter;
  portalMembers: FakePortalMemberFinder;
  events: RecordingEventSink;
}

function harness(dir: FakeImportDirectory = directory()): Harness {
  const store = new FakeClientImportStore().withUser(ADMIN, "admin@firm.test", "Sid");
  const parties = new RecordingPartyWriter();
  const assignments = new RecordingAssignmentWriter();
  const letters = new RecordingLetterWriter();
  const portalInvites = new RecordingPortalInviteWriter();
  const portalAccess = new RecordingPortalAccessGranter();
  const portalMembers = new FakePortalMemberFinder();
  const events = new RecordingEventSink();
  const service = new ClientImportService({
    store,
    sheets: new FakeSheetReader(),
    directory: dir,
    parties,
    assignments,
    letters,
    portalInvites,
    portalAccess,
    portalMembers,
    ids: new FakeIds(),
    clock: new FakeClock(new Date(`${TODAY}T09:00:00.000Z`)),
    events,
  });
  return { service, store, dir, parties, assignments, letters, portalInvites, portalAccess, portalMembers, events };
}

function upload(text: string, filename: string) {
  return { bytes: sheetBytes(text), filename };
}

async function stageAll(h: Harness) {
  return h.service.stage(
    {
      tenantId: TENANT,
      stagedBy: ADMIN,
      clients: upload(CLIENTS, "clients.csv"),
      people: upload(PEOPLE, "people.csv"),
      engagements: upload(ENGAGEMENTS, "engagements.csv"),
    },
    ACTOR,
  );
}

describe("the reach-back the import warns about", () => {
  it("is the calendar's own constant, not a number of its own", () => {
    expect(CALENDAR_REACH_BACK_DAYS).toBe(REACH_BACK_DAYS);
  });
});

describe("staging a sheet", () => {
  it("parses the three sheets, checks them, stores the verdict and writes nothing else", async () => {
    const h = harness();
    const staged = await stageAll(h);

    expect(staged.status).toBe("staged");
    expect(staged.fileNames).toEqual({ clients: "clients.csv", people: "people.csv", engagements: "engagements.csv" });
    expect(staged.report.blocking).toBe(0);
    expect(staged.report.counts).toMatchObject({
      clientsToCreate: 3,
      entitiesToRegister: 2,
      peopleToCreate: 2,
      engagementsToCreate: 3,
      lettersToDraft: 2,
      assignmentsToRecord: 4,
    });
    expect(staged.stagedBy).toEqual({ userId: ADMIN, email: "admin@firm.test", name: "Sid" });

    expect(h.parties.calls).toHaveLength(0);
    expect(h.assignments.calls).toHaveLength(0);
    expect(h.letters.calls).toHaveLength(0);
    expect(h.events.verbs()).toEqual(["client_import.staged"]);
    expect(h.events.recorded[0]?.payload).toMatchObject({ clientRows: 3, peopleRows: 2, engagementRows: 3, blocking: 0 });
  });

  it("needs the client sheet, and refuses a sheet with no header row or no rows", async () => {
    const h = harness();
    await expect(
      h.service.stage({ tenantId: TENANT, stagedBy: ADMIN, clients: null, people: null, engagements: null }, ACTOR),
    ).rejects.toThrow(ClientSheetRequired);
    await expect(
      h.service.stage(
        { tenantId: TENANT, stagedBy: ADMIN, clients: upload("Name,Email\nPriya,p@x.test", "wrong.csv"), people: null, engagements: null },
        ACTOR,
      ),
    ).rejects.toThrow(SheetHeaderMissing);
    await expect(
      h.service.stage(
        { tenantId: TENANT, stagedBy: ADMIN, clients: upload("Client Name,Country\n", "empty.csv"), people: null, engagements: null },
        ACTOR,
      ),
    ).rejects.toThrow(SheetEmpty);
  });

  it("stages a sheet WITH blocking findings — the report is the point — and refuses to confirm it", async () => {
    const h = harness();
    const staged = await h.service.stage(
      {
        tenantId: TENANT,
        stagedBy: ADMIN,
        clients: upload("Client Name,Country,Entity Type\nAlpha Ltd,IN,", "clients.csv"),
        people: null,
        engagements: null,
      },
      ACTOR,
    );
    expect(staged.report.blocking).toBe(1);
    await expect(h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR)).rejects.toThrow(
      ClientImportBlocked,
    );
    expect(h.parties.calls).toHaveLength(0);
  });

  it("lists what was uploaded, newest first, without the sheet", async () => {
    const h = harness();
    const staged = await stageAll(h);
    const list = await h.service.list(TENANT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: staged.id, status: "staged", blocking: 0 });
    await expect(h.service.get(TENANT, "00000000-0000-4000-8000-00000000dead")).rejects.toThrow(ClientImportNotFound);
  });
});

describe("confirming an import", () => {
  it("walks every row through the ordinary doors, groups first, and signs one letter per client", async () => {
    const h = harness();
    const staged = await stageAll(h);
    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.outcome?.created).toEqual({ clients: 3, entities: 2, people: 2, roles: 2, assignments: 4, letters: 2, engagements: 3, portalInvites: 2 });
    expect(confirmed.outcome?.failed).toBe(0);
    expect(confirmed.confirmedBy?.userId).toBe(ADMIN);

    // The order: the group, then the two registered companies.
    const orgs = h.parties.of("createOrganization").map((c) => (c.input as { legalName: string }).legalName);
    expect(orgs).toEqual(["Kaveri Group", "Cobalt Foods Private Limited", "Kaveri Foods Private Limited"]);

    // The group's company is filed under it; the standalone clients are
    // recorded as clients of the firm, from the day the sheet says.
    const relationships = h.parties.of("addRelationship").map((c) => c.input as { type: string; fromPartyId: string; toPartyId: string; validFrom: string });
    expect(relationships.filter((r) => r.type === "parent_of")).toEqual([
      { tenantId: TENANT, fromPartyId: "party-0001", toPartyId: "party-0003", type: "parent_of", validFrom: "2019-06-11" },
    ]);
    const clientOf = relationships.filter((r) => r.type === "client_of");
    expect(clientOf.map((r) => [r.fromPartyId, r.toPartyId, r.validFrom])).toEqual([
      ["party-0001", "party-firm", "2019-04-01"],
      ["party-0002", "party-firm", "2021-01-15"],
    ]);

    // The account team: one Key Manager on each standalone client, a TRC
    // SPOC on the company and on Cobalt.
    const assigned = h.assignments.of("assign").map((c) => c.input as { clientPartyId: string; role: string; axisId?: string | null; validFrom?: string });
    expect(assigned).toEqual([
      { tenantId: TENANT, clientPartyId: "party-0001", role: "key_manager", userId: "user-anita", validFrom: "2019-04-01" },
      { tenantId: TENANT, clientPartyId: "party-0002", role: "key_manager", userId: "user-anita", validFrom: "2021-01-15" },
      { tenantId: TENANT, clientPartyId: "party-0002", role: "spoc", axisId: "axis-trc", userId: "user-ravi", validFrom: "2021-01-15" },
      { tenantId: TENANT, clientPartyId: "party-0003", role: "spoc", axisId: "axis-trc", userId: "user-ravi", validFrom: TODAY },
    ]);

    // People: created, identified by email and phone, and attached to the
    // company they hold the role at — Meera to Kaveri Foods, not the group.
    const people = h.parties.of("createPerson").map((c) => (c.input as { fullName: string }).fullName);
    expect(people).toEqual(["Meera Nair", "Priya Menon"]);
    const roles = relationships.filter((r) => r.type === "director_of" || r.type === "authorised_signatory_of");
    expect(roles.map((r) => [r.type, r.toPartyId, r.validFrom])).toEqual([
      ["director_of", "party-0003", "2019-06-11"],
      ["authorised_signatory_of", "party-0002", TODAY],
    ]);

    // Letters: drafted, lined, claused, sent, signed — in that order, and
    // the paper letter's whereabouts on the signature.
    expect(h.letters.calls.map((c) => c.method)).toEqual([
      "draft", "addLine", "addClause", "addClause", "send", "sign",
      "draft", "addLine", "addLine", "addClause", "addClause", "send", "sign",
    ]);
    const drafts = h.letters.of("draft").map((c) => c.input as Record<string, unknown>);
    expect(drafts[0]).toMatchObject({ partyId: "party-0001", jurisdiction: "IN", currency: "INR", fxRate: "1", fxRateDate: "2025-04-01", advanceRequired: false, issuedOn: "2025-04-01", effectiveFrom: "2025-04-01" });
    expect(drafts[1]).toMatchObject({ partyId: "party-0002", effectiveFrom: "2026-08-01" });
    const lines = h.letters.of("addLine").map((c) => c.input as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ entityPartyId: "party-0003", serviceVersionId: "ver-a1", unitAmount: "6000", billingFrequency: "monthly", effectiveFrom: "2025-04-01", discountPercent: "0" });
    expect(lines[2]).toMatchObject({ entityPartyId: "party-0002", serviceVersionId: "ver-h1", billingFrequency: "quarterly", pricingNote: "As per the paper letter — see the signature reference" });
    expect(lines[2]).not.toHaveProperty("unitAmount", expect.anything());
    // Only clauses whose law is India's or unstated — never the US-law one.
    expect(h.letters.of("addClause").map((c) => (c.input as { clauseVersionId: string }).clauseVersionId)).toEqual([
      "clause-in", "clause-everywhere", "clause-in", "clause-everywhere",
    ]);
    const signatures = h.letters.of("sign").map((c) => c.input as { signedByName: string; reference: string });
    expect(signatures[0]).toMatchObject({ signedByName: "Rajesh Kumar", reference: `Migrated on ${TODAY}, EL 2025-04` });
    expect(signatures[1]).toMatchObject({ signedByName: "Priya Menon", reference: `Migrated on ${TODAY}, Drive/Cobalt/EL` });

    expect(confirmed.outcome?.letters.map((l) => [l.clientName, l.action, l.engagementIds.length])).toEqual([
      ["Kaveri Group", "created", 1],
      ["Cobalt Foods Private Limited", "created", 2],
    ]);

    // Portal invites: one per TRUE row, sent after everyone has a party.
    expect(h.portalInvites.of("invite")).toEqual([
      { method: "invite", input: { tenantId: TENANT, email: "rajesh@kaveri.test", clientPartyId: "party-0001", validFrom: TODAY, invitedBy: ADMIN } },
      { method: "invite", input: { tenantId: TENANT, email: "priya.menon@cobalt.test", clientPartyId: "party-0002", validFrom: TODAY, invitedBy: ADMIN } },
    ]);
    expect(confirmed.outcome?.portalInvites).toEqual([
      { clientName: "Kaveri Group", email: "rajesh@kaveri.test", action: "invited", detail: null },
      { clientName: "Cobalt Foods Private Limited", email: "priya.menon@cobalt.test", action: "invited", detail: null },
    ]);
    expect(h.events.verbs()).toEqual(["client_import.staged", "client_import.confirmed"]);
    expect(h.events.recorded[1]?.payload).toMatchObject({ created: { clients: 3, letters: 2 }, skipped: 0, failed: 0 });
  });

  it("refuses to confirm twice", async () => {
    const h = harness();
    const staged = await stageAll(h);
    await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);
    await expect(h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR)).rejects.toThrow(
      ClientImportAlreadyConfirmed,
    );
  });

  it("re-checks at confirm time and refuses when the firm's records have moved underneath the sheet", async () => {
    const dir = directory();
    const h = harness(dir);
    const staged = await stageAll(h);
    // Somebody retired Ravi between the upload and the confirm.
    const d = dir as unknown as { staff: { email: string; userId: string }[] };
    d.staff.splice(d.staff.findIndex((s) => s.email === "ravi@firm.test"), 1);
    await expect(h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR)).rejects.toThrow(
      /records changed since this sheet was checked/,
    );
    expect(h.parties.calls).toHaveLength(0);
  });

  it("reports a row that fails halfway, keeps going, and leaves the rest loadable on a re-run", async () => {
    const h = harness();
    h.parties.failOn("registerLegalEntity", (input) => (input as { organizationPartyId: string }).organizationPartyId === "party-0002");
    const staged = await stageAll(h);
    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);

    const cobalt = confirmed.outcome?.rows.find((r) => r.sheet === "clients" && r.name === "Cobalt Foods Private Limited");
    expect(cobalt).toMatchObject({ action: "failed", partyId: "party-0002" });
    expect(cobalt?.detail).toMatch(/^registering the legal entity: party refused registerLegalEntity. Already done: the company$/);
    // Cobalt's letter has a client, and its two lines have an entity, so it is
    // still written — an entity the party service created is real.
    expect(confirmed.outcome?.letters.map((l) => l.action)).toEqual(["created", "created"]);
    // Kaveri loaded in full regardless.
    expect(confirmed.outcome?.created.clients).toBe(2);
    expect(confirmed.outcome?.failed).toBe(1);
  });

  it("skips what is already on file, and still writes the letter for an on-file entity", async () => {
    const dir = directory()
      .withOrganization({ partyId: "party-cobalt", legalName: "Cobalt Foods Private Limited", tradeName: null, displayName: "Cobalt Foods Private Limited", registered: true, jurisdiction: "IN", parentPartyId: null, archived: false })
      .withIdentifier("pan", "AAACC1234F", "party-cobalt");
    const h = harness(dir);
    const staged = await stageAll(h);
    expect(staged.report.rows.find((r) => r.sheet === "clients" && r.lineNo === 4)?.action).toBe("skip");

    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);
    expect(h.parties.of("createOrganization")).toHaveLength(2);
    expect(confirmed.outcome?.skipped).toBe(1);
    const cobaltLetter = h.letters.of("draft").map((c) => c.input as { partyId: string }).find((d) => d.partyId === "party-cobalt");
    expect(cobaltLetter).toBeDefined();
    // And Priya, whose client is on file, is still attached to it.
    const signatory = h.parties.of("addRelationship").map((c) => c.input as { type: string; toPartyId: string }).find((r) => r.type === "authorised_signatory_of");
    expect(signatory?.toPartyId).toBe("party-cobalt");
  });

  it("marks a letter failed when its client was not created, and says so on every line", async () => {
    const h = harness();
    h.parties.failOn("createOrganization", (input) => (input as { legalName: string }).legalName === "Cobalt Foods Private Limited");
    const staged = await stageAll(h);
    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);
    const cobalt = confirmed.outcome?.letters.find((l) => l.clientName === "Cobalt Foods Private Limited");
    expect(cobalt).toMatchObject({ action: "failed", letterId: null, lineNos: [3, 4] });
    expect(cobalt?.detail).toMatch(/was not created, so there is nobody to bill/);
    const lines = confirmed.outcome?.rows.filter((r) => r.sheet === "engagements" && r.action === "failed");
    expect(lines).toHaveLength(2);
    // Priya's row fails too — her company has nothing to attach to.
    expect(confirmed.outcome?.rows.find((r) => r.sheet === "people" && r.name === "Priya Menon")?.action).toBe("failed");
  });

  it("leaves a half-written letter as a draft and says so", async () => {
    const h = harness();
    h.letters.failOn("send");
    const staged = await stageAll(h);
    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);
    const first = confirmed.outcome?.letters[0];
    expect(first?.action).toBe("failed");
    expect(first?.letterId).toBe("letter-0001");
    expect(first?.detail).toMatch(/^marking it sent: letter refused send — the draft is left/);
  });
});

describe("one person, several companies", () => {
  // The shape a group's directors sheet actually has, and the one that used to
  // be refused: the same director on three companies is three rows carrying
  // one email. The party is created ONCE and each row records its own role.

  const CLIENTS_GROUP = [
    "Client Name,Client Since,Group,Country,Entity Type,Incorporated On,Financial Year End,PAN,Key Manager",
    "Kaveri Group,2019-04-01,,,,,,,anita@firm.test",
    "Kaveri Foods Private Limited,,Kaveri Group,IN,private_limited,2019-06-11,03-31,AAACK1111K,",
    "Kaveri Logistics Private Limited,,Kaveri Group,IN,private_limited,2020-02-01,03-31,AAACL2222L,",
  ].join("\n");

  const PEOPLE_GROUP = [
    "Client,Of,Name,Relationship,Since,Email,Phone",
    "Kaveri Group,Kaveri Foods Private Limited,Anil Kaveri,director,2019-06-11,anil@kaveri.test,+91 98450 00000",
    "Kaveri Group,Kaveri Logistics Private Limited,Anil Kaveri,director,2020-02-01,anil@kaveri.test,",
  ].join("\n");

  async function stageGroup(h: Harness) {
    return h.service.stage(
      {
        tenantId: TENANT,
        stagedBy: ADMIN,
        clients: upload(CLIENTS_GROUP, "clients.csv"),
        people: upload(PEOPLE_GROUP, "people.csv"),
        engagements: null,
      },
      ACTOR,
    );
  }

  it("creates the party ONCE and records a role from each row", async () => {
    const h = harness();
    const staged = await stageGroup(h);
    expect(staged.report.blocking).toBe(0);

    const confirmed = await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);
    expect(confirmed.outcome?.failed).toBe(0);

    // ONE person and TWO roles — the two numbers differ on purpose, and
    // reporting "2 people created" for one director would be a lie the firm
    // would only find by counting the parties themselves.
    expect(confirmed.outcome?.created.people).toBe(1);
    expect(confirmed.outcome?.created.roles).toBe(2);

    // ONE person...
    const created = h.parties.of("createPerson").map((c) => (c.input as { fullName: string }).fullName);
    expect(created).toEqual(["Anil Kaveri"]);
    // ...and their email recorded once, not twice.
    const emails = h.parties
      .of("addIdentifier")
      .map((c) => c.input as { type: string; value: string })
      .filter((i) => i.type === "email");
    expect(emails).toHaveLength(1);

    // TWO directorships, one per company, each dated from its own row.
    const directorships = h.parties
      .of("addRelationship")
      .map((c) => c.input as { type: string; fromPartyId: string; toPartyId: string; validFrom: string })
      .filter((r) => r.type === "director_of");
    expect(directorships).toHaveLength(2);
    expect(new Set(directorships.map((r) => r.fromPartyId)).size).toBe(1);
    expect(directorships.map((r) => r.validFrom)).toEqual(["2019-06-11", "2020-02-01"]);
    expect(new Set(directorships.map((r) => r.toPartyId)).size).toBe(2);
  });

  it("adds the role to somebody ALREADY ON FILE instead of skipping the row", async () => {
    const h = harness(
      directory().withPerson({
        email: "anil@kaveri.test",
        partyId: "party-anil",
        name: "Anil Kaveri",
        roles: [],
      }),
    );
    const staged = await stageGroup(h);
    await h.service.confirm({ tenantId: TENANT, importId: staged.id, confirmedBy: ADMIN }, ACTOR);

    // Nobody new, and no second email identifier on an existing person.
    expect(h.parties.of("createPerson")).toHaveLength(0);
    const directorships = h.parties
      .of("addRelationship")
      .map((c) => c.input as { type: string; fromPartyId: string })
      .filter((r) => r.type === "director_of");
    expect(directorships).toHaveLength(2);
    expect(directorships.every((r) => r.fromPartyId === "party-anil")).toBe(true);
  });
});

describe("which clauses a migrated letter carries", () => {
  it("takes those that apply to the country and name no other country's law or courts", () => {
    const clauses = [
      { versionId: "in", jurisdictions: ["IN"], governingLawJurisdiction: "IN", courtsJurisdiction: null },
      { versionId: "any", jurisdictions: [], governingLawJurisdiction: null, courtsJurisdiction: null },
      { versionId: "us", jurisdictions: [], governingLawJurisdiction: "US", courtsJurisdiction: "US" },
      { versionId: "sg", jurisdictions: ["SG"], governingLawJurisdiction: null, courtsJurisdiction: null },
    ];
    expect(clausesFor(clauses, "IN")).toEqual(["in", "any"]);
    expect(clausesFor(clauses, "US")).toEqual(["any", "us"]);
    expect(clausesFor(clauses, "AE")).toEqual(["any"]);
  });
});
