// The commercial pipeline (T2.1), at the use-case level. The acceptance this
// file exists for: "a duplicate lead merges to the existing party, appends
// timeline."
//
// The party module underneath is REAL (see testfakes/lead.ts) — only the
// repositories are in memory — so these also fail if capture stops normalising
// an identifier or stops recording party.created. The database half (RLS, the
// one-open-lead-per-party index, the closed-lead CHECK) is proven against real
// Postgres in pipeline.integration.test.ts.
import { describe, expect, it } from "vitest";
import { LeadService } from "../../src/usecase/lead/service";
import { makeLeadFakes } from "../../src/testfakes/lead";
import type { FakeLeadRepo, FakeStaffDirectory } from "../../src/testfakes/lead";
import type { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  LEAD_SOURCES,
  LEAD_STAGES,
  TERMINAL_STAGES,
  canMoveStage,
  isOpen,
} from "../../src/domain/lead/model";
import { SOURCE_VALUES, STAGE_VALUES } from "../../src/api/handler/lead";
import {
  AmbiguousMatch,
  BlankTitle,
  InvalidSource,
  InvalidLeadJurisdiction,
  InvalidEstimatedValue,
  InvalidStage,
  LeadClosed,
  LeadNotFound,
  LostReasonNotApplicable,
  LeadPartyArchived,
  LeadMatchesOwnCompany,
  LostReasonRequired,
  NoContactDetail,
  OwnerNotStaff,
  SameStage,
} from "../../src/domain/lead/errors";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000d1" };
const STAFF = "00000000-0000-4000-8000-0000000000d2";
const OUTSIDER = "00000000-0000-4000-8000-0000000000d3";
/** A second desk, for the territory rule to name. */
const SPECIALIST = "00000000-0000-4000-8000-0000000000d4";

const EMAIL = "priya@meridian.example";
const PHONE = "+919876543210";
const PAN = "AABCM1234K";

function setup(): {
  service: LeadService;
  leads: FakeLeadRepo;
  staff: FakeStaffDirectory;
  events: RecordingEventSink;
} {
  const fakes = makeLeadFakes();
  fakes.staff.add(TENANT, STAFF);
  return {
    service: new LeadService(fakes),
    leads: fakes.leads,
    staff: fakes.staff,
    events: fakes.events,
  };
}

const TITLE = "FY27 statutory audit";

/** The everyday capture: a company with an email and a PAN. */
function capture(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    source: "inbound",
    title: TITLE,
    kind: "organization" as const,
    name: "Meridian Textiles Private Limited",
    identifiers: [
      { type: "email" as const, value: EMAIL },
      { type: "pan" as const, value: PAN },
    ],
    ...over,
  };
}

describe("capturing a lead nobody has seen before", () => {
  it("creates the prospect and starts an opportunity at the beginning", async () => {
    const { service } = setup();
    const result = await service.capture(capture(), ACTOR);

    expect(result.merged).toBe(false);
    expect(result.matchedExistingParty).toBe(false);
    expect(result.lead.stage).toBe("new");
    expect(result.lead.closedAt).toBeNull();
    expect(result.lead.partyId).toBeTruthy();
  });

  it("records the capture, the party and every identifier in one timeline", async () => {
    const { service, events } = setup();
    await service.capture(capture(), ACTOR);
    expect(events.verbs()).toEqual([
      "party.created",
      "party_identifier.added",
      "party_identifier.added",
      "lead.captured",
    ]);
    for (const e of events.recorded) expect(e.actorId).toBe(ACTOR.id);
  });

  it("puts no contact detail in the log, only the kinds of it", async () => {
    // The ledger cannot be erased. An email or a PAN in it is precisely what the
    // event contract's no-personal-data rule exists to stop, and the party rows
    // holding them can be erased on request.
    const { service, events } = setup();
    await service.capture(capture(), ACTOR);
    const dump = JSON.stringify(events.recorded);
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain(PAN);
    expect(dump).toContain("identifierType");
  });

  it("can capture a person, not only a company", async () => {
    const { service } = setup();
    const result = await service.capture(
      capture({
        kind: "person",
        name: "Priya Menon",
        identifiers: [{ type: "phone", value: PHONE }],
      }),
      ACTOR,
    );
    expect(result.lead.stage).toBe("new");
  });
});

describe("the duplicate — the acceptance", () => {
  it("lands on the existing opportunity instead of starting a rival one", async () => {
    const { service, leads } = setup();
    const first = await service.capture(capture(), ACTOR);
    const second = await service.capture(
      capture({ source: "referral", identifiers: [{ type: "pan", value: PAN }] }),
      ACTOR,
    );

    expect(second.merged).toBe(true);
    expect(second.matchedExistingParty).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
    // The whole point: one prospect, one live opportunity, one party.
    expect(leads.rows).toHaveLength(1);
    expect(second.lead.partyId).toBe(first.lead.partyId);
  });

  it("appends to the timeline rather than writing anything", async () => {
    const { service, events } = setup();
    await service.capture(capture(), ACTOR);
    const before = events.recorded.length;
    await service.capture(capture({ identifiers: [{ type: "pan", value: PAN }] }), ACTOR);

    const appended = events.recorded.slice(before);
    expect(appended.map((e) => e.verb)).toEqual(["lead.merged"]);
    expect(appended[0]?.payload["capturedSource"]).toBe("inbound");
  });

  it("does not overwrite what somebody already decided about the lead", async () => {
    // A duplicate web-form submission is not grounds to reassign the lead or
    // rewrite where it came from.
    const { service } = setup();
    const first = await service.capture(
      capture({ source: "referral", ownerUserId: STAFF, notes: "warm intro from Anand" }),
      ACTOR,
    );
    const second = await service.capture(capture({ source: "inbound" }), ACTOR);

    expect(second.lead.source).toBe("referral");
    expect(second.lead.ownerUserId).toBe(STAFF);
    expect(second.lead.notes).toBe("warm intro from Anand");
    expect(second.lead.id).toBe(first.lead.id);
  });

  it("attaches the contact details the second capture brought, and only those", async () => {
    const { service, events } = setup();
    await service.capture(capture({ identifiers: [{ type: "email", value: EMAIL }] }), ACTOR);
    const before = events.recorded.length;
    await service.capture(
      capture({
        identifiers: [
          { type: "email", value: EMAIL },
          { type: "phone", value: PHONE },
        ],
      }),
      ACTOR,
    );

    const appended = events.recorded.slice(before);
    // The phone is new and is attached; re-adding the email would be refused as
    // a duplicate, and rightly — it is the same fact.
    expect(appended.map((e) => e.verb)).toEqual(["party_identifier.added", "lead.merged"]);
    expect(appended.at(-1)?.payload["addedIdentifierTypes"]).toEqual(["phone"]);
    expect(appended.at(-1)?.payload["matchedIdentifierTypes"]).toEqual(["email"]);
  });

  it("matches however the detail was typed", async () => {
    // Normalisation is the party module's, and dedup depends on it entirely: a
    // capital letter in an email address must not create a second prospect.
    const { service, leads } = setup();
    await service.capture(capture({ identifiers: [{ type: "email", value: EMAIL }] }), ACTOR);
    const again = await service.capture(
      capture({ identifiers: [{ type: "email", value: "  Priya@Meridian.EXAMPLE " }] }),
      ACTOR,
    );
    expect(again.merged).toBe(true);
    expect(leads.rows).toHaveLength(1);
  });

  it("matches a phone written with spaces and dashes", async () => {
    const { service } = setup();
    await service.capture(
      capture({ identifiers: [{ type: "phone", value: PHONE }] }),
      ACTOR,
    );
    const again = await service.capture(
      capture({ identifiers: [{ type: "phone", value: "+91 98765-43210" }] }),
      ACTOR,
    );
    expect(again.merged).toBe(true);
  });

  it("matches a phone typed without its country code, completed with the lead's country", async () => {
    const { service } = setup();
    await service.capture(capture({ identifiers: [{ type: "phone", value: PHONE }] }), ACTOR);
    const again = await service.capture(
      capture({ jurisdiction: "IN", identifiers: [{ type: "phone", value: "098765 43210" }] }),
      ACTOR,
    );
    expect(again.merged).toBe(true);
  });

  it("refuses a malformed phone before anything is written", async () => {
    const { service, events } = setup();
    await expect(
      service.capture(capture({ identifiers: [{ type: "phone", value: "+91 98765" }] }), ACTOR),
    ).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
    // No prospect, no lead: the refusal came before the party was created.
    expect(events.recorded).toHaveLength(0);
  });
});

describe("a prospect who comes back", () => {
  it("is a NEW opportunity once the old one is closed", async () => {
    // Two attempts should count as two in a conversion rate, not as one that
    // took nine months. This is what the partial index leaves room for.
    const { service, leads } = setup();
    const first = await service.capture(capture(), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: first.lead.id, stage: "lost", lostReason: "went with PwC" },
      ACTOR,
    );

    const second = await service.capture(capture(), ACTOR);
    expect(second.merged).toBe(false);
    expect(second.lead.id).not.toBe(first.lead.id);
    // Same prospect, though — the party is not duplicated.
    expect(second.matchedExistingParty).toBe(true);
    expect(second.lead.partyId).toBe(first.lead.partyId);
    expect(leads.rows).toHaveLength(2);
  });
});

describe("a client the firm has ARCHIVED (0305)", () => {
  // A web enquiry carrying an archived client's PAN used to attach a fresh lead
  // to a party the firm had put away. Refused rather than quietly restored:
  // restoring is its own act on the client page (Shrestha, 2026-09-25).
  async function archivedMeridian() {
    const fakes = makeLeadFakes();
    fakes.staff.add(TENANT, STAFF);
    const org = await fakes.party.createOrganization(
      { tenantId: TENANT, legalName: "Meridian Textiles Private Limited" },
      ACTOR,
    );
    await fakes.party.addIdentifier(
      { tenantId: TENANT, partyId: org.partyId, type: "pan", value: PAN, validFrom: "2026-01-01" },
      ACTOR,
    );
    await fakes.party.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);
    return { fakes, service: new LeadService(fakes), partyId: org.partyId };
  }

  it("refuses the capture, naming the client and where to restore them", async () => {
    const { service } = await archivedMeridian();
    const err = await service.capture(capture(), ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeadPartyArchived);
    expect((err as LeadPartyArchived).code).toBe("PARTY_ARCHIVED");
    expect((err as Error).message).toMatch(/Meridian Textiles Private Limited is archived/);
    expect((err as Error).message).toMatch(/restore them from their client page/);
  });

  it("writes nothing: no lead, no new contact detail, no event", async () => {
    const { fakes, service } = await archivedMeridian();
    const before = fakes.events.recorded.length;
    await service.capture(capture(), ACTOR).catch(() => undefined);
    expect(fakes.leads.rows).toEqual([]);
    // The email on the capture was NOT attached to the archived party.
    expect(await fakes.prospects.findByIdentifier(TENANT, "email", EMAIL)).toBeNull();
    expect(fakes.events.recorded).toHaveLength(before);
  });

  it("captures normally once the firm has restored the client", async () => {
    const { fakes, service, partyId } = await archivedMeridian();
    await fakes.party.unarchiveParty({ tenantId: TENANT, partyId }, ACTOR);
    const result = await service.capture(capture(), ACTOR);
    expect(result.lead.partyId).toBe(partyId);
    expect(result.matchedExistingParty).toBe(true);
  });
});

describe("contact details that are one of the firm's OWN companies (0313)", () => {
  // The firm's own phone, email or PAN typed as a prospect's landed the lead
  // on the firm's own company, and the firm became its own prospect.
  async function ownCompanyMatched() {
    const fakes = makeLeadFakes();
    fakes.staff.add(TENANT, STAFF);
    const org = await fakes.party.createOrganization(
      { tenantId: TENANT, legalName: "10x Global FZE" },
      ACTOR,
    );
    await fakes.party.addIdentifier(
      { tenantId: TENANT, partyId: org.partyId, type: "pan", value: PAN, validFrom: "2026-01-01" },
      ACTOR,
    );
    fakes.partyRepo.markOwnCompany(org.partyId);
    return { fakes, service: new LeadService(fakes) };
  }

  it("refuses the capture by name, as the invoice's BILLS_THE_FIRM does", async () => {
    const { service } = await ownCompanyMatched();
    const err = await service.capture(capture(), ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeadMatchesOwnCompany);
    expect((err as LeadMatchesOwnCompany).code).toBe("CLIENT_IS_OWN_COMPANY");
    expect((err as Error).message).toMatch(/belong to 10x Global FZE, one of your own companies/);
  });

  it("writes nothing: no lead, no new contact detail, no event", async () => {
    const { fakes, service } = await ownCompanyMatched();
    const before = fakes.events.recorded.length;
    await service.capture(capture(), ACTOR).catch(() => undefined);
    expect(fakes.leads.rows).toEqual([]);
    expect(await fakes.prospects.findByIdentifier(TENANT, "email", EMAIL)).toBeNull();
    expect(fakes.events.recorded).toHaveLength(before);
  });
});

describe("what capture refuses, before it writes anything", () => {
  it("refuses a lead with no way to reach the prospect", async () => {
    const { service, leads, events } = setup();
    const err = await service
      .capture(capture({ identifiers: [{ type: "cin", value: "U17110MH2019PTC123456" }] }), ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoContactDetail);
    // Nothing half-written: no party, no lead, no events.
    expect(leads.rows).toEqual([]);
    expect(events.recorded).toEqual([]);
  });

  it("refuses an owner who does not work at the firm", async () => {
    const { service, leads, events } = setup();
    const err = await service
      .capture(capture({ ownerUserId: OUTSIDER }), ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerNotStaff);
    // Checked BEFORE the party is created, so a rejected capture leaves no
    // prospect nobody asked for.
    expect(events.recorded).toEqual([]);
    expect(leads.rows).toEqual([]);
  });

  it("refuses a source it cannot report on", async () => {
    await expect(
      setup().service.capture(capture({ source: "linkedin" }), ACTOR),
    ).rejects.toBeInstanceOf(InvalidSource);
  });

  it("refuses to guess when the details point at two different parties", async () => {
    // This is not a merge — it means the firm's records already hold the same
    // counterparty twice, and picking one would attach the opportunity to
    // whichever the query happened to return first.
    const { service, leads } = setup();
    await service.capture(capture({ identifiers: [{ type: "email", value: EMAIL }] }), ACTOR);
    await service.capture(
      capture({ name: "Meridian Exports LLP", identifiers: [{ type: "pan", value: PAN }] }),
      ACTOR,
    );

    const err = await service
      .capture(
        capture({
          identifiers: [
            { type: "email", value: EMAIL },
            { type: "pan", value: PAN },
          ],
        }),
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousMatch);
    expect((err as Error).message).toContain("2 different parties");
    expect(leads.rows).toHaveLength(2); // nothing new written
  });

  it("does not merge on an identifier that is not a dedup key", async () => {
    // A GSTIN is not in the dedup set (a lead seldom arrives with one), so it
    // must not quietly act as one — the set is a decision, not a suggestion.
    const { service, leads } = setup();
    const GSTIN = "27AABCM1234K1Z5";
    await service.capture(
      capture({
        identifiers: [
          { type: "gstin", value: GSTIN },
          { type: "email", value: EMAIL },
        ],
      }),
      ACTOR,
    );
    const other = await service.capture(
      capture({
        name: "Someone Else Ltd",
        identifiers: [
          { type: "gstin", value: GSTIN },
          { type: "phone", value: PHONE },
        ],
      }),
      ACTOR,
    );
    expect(other.merged).toBe(false);
    expect(leads.rows).toHaveLength(2);
  });
});

describe("moving through the pipeline", () => {
  async function openLead() {
    const s = setup();
    const { lead } = await s.service.capture(capture(), ACTOR);
    return { ...s, lead };
  }

  it("records the move, naming where it came from", async () => {
    const { service, events, lead } = await openLead();
    const moved = await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "qualified" },
      ACTOR,
    );
    expect(moved.stage).toBe("qualified");
    expect(moved.closedAt).toBeNull();

    const last = events.recorded.at(-1);
    expect(last?.verb).toBe("lead.stage_changed");
    expect(last?.payload["from"]).toBe("new");
    expect(last?.payload["to"]).toBe("qualified");
  });

  it("closes the lead when it reaches a terminal stage", async () => {
    const { service, lead } = await openLead();
    const won = await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "converted" },
      ACTOR,
    );
    expect(won.closedAt).not.toBeNull();
  });

  it("lets a lead go backwards, because real pipelines do", async () => {
    // A qualified prospect who stops answering is contacted again. Forbidding it
    // just teaches people to lie to the system.
    const { service, lead } = await openLead();
    await service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "qualified" }, ACTOR);
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "contacted" }, ACTOR),
    ).resolves.toBeDefined();
  });

  it("refuses to reopen a finished lead", async () => {
    const { service, lead } = await openLead();
    await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "lost", lostReason: "went with PwC" },
      ACTOR,
    );
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "contacted" }, ACTOR),
    ).rejects.toBeInstanceOf(LeadClosed);
  });

  it("refuses a move that is not a move", async () => {
    const { service, lead } = await openLead();
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "new" }, ACTOR),
    ).rejects.toBeInstanceOf(SameStage);
  });

  it("refuses a stage the pipeline does not have", async () => {
    const { service, lead } = await openLead();
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "nurturing" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidStage);
  });

  it("refuses a lead that is not this firm's", async () => {
    const { service } = setup();
    await expect(
      service.moveStage(
        { tenantId: TENANT, leadId: "00000000-0000-4000-8000-00000000dead", stage: "contacted" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LeadNotFound);
  });
});

describe("whose desk it is on", () => {
  /** An open lead that nobody owns. `ownerUserId: null` is the instruction, not
   *  an omission: since T2.1b an OMITTED owner is the one the rotation fills
   *  in, so a test about manual assignment has to ask for the queue by name. */
  async function openLead() {
    const s = setup();
    const { lead } = await s.service.capture(capture({ ownerUserId: null }), ACTOR);
    return { ...s, lead };
  }

  it("assigns to staff and records it", async () => {
    const { service, events, lead } = await openLead();
    const assigned = await service.assignOwner(
      { tenantId: TENANT, leadId: lead.id, ownerUserId: STAFF },
      ACTOR,
    );
    expect(assigned.ownerUserId).toBe(STAFF);
    expect(events.recorded.at(-1)?.verb).toBe("lead.owner_assigned");
    expect(events.recorded.at(-1)?.payload["previousOwnerUserId"]).toBeNull();
  });

  it("refuses somebody who is not active staff at this firm", async () => {
    // A client contact of the firm is a real, active membership — and putting a
    // prospect's file on their desk would hand it outside the firm.
    const { service, lead } = await openLead();
    await expect(
      service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: OUTSIDER }, ACTOR),
    ).rejects.toBeInstanceOf(OwnerNotStaff);
  });

  it("takes a lead back into the unassigned queue", async () => {
    const { service, lead } = await openLead();
    await service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: STAFF }, ACTOR);
    const freed = await service.assignOwner(
      { tenantId: TENANT, leadId: lead.id, ownerUserId: null },
      ACTOR,
    );
    expect(freed.ownerUserId).toBeNull();
  });

  it("is idempotent — re-assigning the current owner records nothing", async () => {
    // A screen that PUTs its current state should not write a reassignment
    // nobody performed.
    const { service, events, lead } = await openLead();
    await service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: STAFF }, ACTOR);
    const before = events.recorded.length;
    await service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: STAFF }, ACTOR);
    expect(events.recorded).toHaveLength(before);
  });

  it("still allows attribution to be corrected on a won deal", async () => {
    // Ownership is credit, and correcting who gets it changes no pipeline state.
    const { service, lead } = await openLead();
    await service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "converted" }, ACTOR);
    await expect(
      service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: STAFF }, ACTOR),
    ).resolves.toBeDefined();
  });
});

describe("reading the pipeline", () => {
  it("lists newest first and filters to one stage", async () => {
    const { service } = setup();
    const first = await service.capture(capture(), ACTOR);
    await service.capture(
      capture({ name: "Other Ltd", identifiers: [{ type: "phone", value: PHONE }] }),
      ACTOR,
    );
    await service.moveStage({ tenantId: TENANT, leadId: first.lead.id, stage: "qualified" }, ACTOR);

    expect(await service.list(TENANT)).toHaveLength(2);
    const qualified = await service.list(TENANT, "qualified");
    expect(qualified.map((r) => r.lead.id)).toEqual([first.lead.id]);
  });

  it("names the prospect, so a board does not render a uuid", async () => {
    // The gap that made the pipeline endpoint unusable by any screen: a lead
    // carries partyId and ownerUserId, and both are meaningless to look at.
    const { service } = setup();
    await service.capture(capture({ ownerUserId: STAFF }), ACTOR);
    const [row] = await service.list(TENANT);
    expect(row?.party.displayName).toBe("Meridian Textiles Private Limited");
    expect(row?.party.kind).toBe("organization");
  });

  it("returns no owner for a lead in the unassigned queue", async () => {
    // Present-and-null, not absent: "nobody is working this" is a real state a
    // board shows differently from "somebody is".
    const { service } = setup();
    const captured = await service.capture(capture({ ownerUserId: null }), ACTOR);
    const record = await service.get(TENANT, captured.lead.id, false);
    expect(record.owner).toBeNull();
  });

  it("refuses a stage filter the pipeline does not have", async () => {
    await expect(setup().service.list(TENANT, "nurturing")).rejects.toBeInstanceOf(InvalidStage);
  });
});

describe("a lead has a name of its own — G3.1's first acceptance", () => {
  it("keeps the title the capture gave it, distinct from the party's name", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture({ title: "GST registration, Pune plant" }), ACTOR);
    const record = await service.get(TENANT, lead.id, false);

    expect(record.lead.title).toBe("GST registration, Pune plant");
    // The point of the field: the list shows both, and they are not the same
    // string. Before 0030 the second was the only one there was.
    expect(record.party.displayName).toBe("Meridian Textiles Private Limited");
  });

  it("makes two opportunities for one client tell themselves apart in a list", async () => {
    // THE ACCEPTANCE. The first is closed so the second may be opened at all —
    // one open lead per party — but both stay in the list, and it is the title
    // that says which is which. Rendering the party would print the same row
    // twice.
    const { service } = setup();
    const first = await service.capture(capture({ title: "GST registration" }), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: first.lead.id, stage: "converted" },
      ACTOR,
    );
    await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);

    const rows = await service.list(TENANT);
    expect(rows.map((r) => r.party.displayName)).toEqual([
      "Meridian Textiles Private Limited",
      "Meridian Textiles Private Limited",
    ]);
    expect([...rows.map((r) => r.lead.title)].sort()).toEqual([
      "FY27 statutory audit",
      "GST registration",
    ]);
  });

  it("refuses a title that is only whitespace", async () => {
    // NOT NULL is satisfied by "   " and renders as the blank row the column
    // was added to prevent.
    const { service, leads, events } = setup();
    await expect(service.capture(capture({ title: "   " }), ACTOR)).rejects.toBeInstanceOf(
      BlankTitle,
    );
    // Refused before anything is written, like every other capture refusal.
    expect(leads.rows).toEqual([]);
    expect(events.recorded).toEqual([]);
  });

  it("trims it once, in the service, so every caller stores the same thing", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture({ title: "  FY27 audit \n" }), ACTOR);
    expect(lead.title).toBe("FY27 audit");
  });

  it("keeps the title out of the ledger, because it can name a person", async () => {
    // A lead's title names the counterparty, and a lead can be about a human
    // being. `findPiiKey` denies KEYS and `title` is not one of them, so nothing
    // would have stopped this — the payload carries partyId and the erasable
    // row carries the words.
    const { service, events } = setup();
    await service.capture(
      capture({ kind: "person", name: "Priya Menon", title: "Priya Menon — personal tax" }),
      ACTOR,
    );
    expect(JSON.stringify(events.recorded)).not.toContain("Priya Menon");
  });

  it("does not let a duplicate capture rename the live opportunity", async () => {
    // A duplicate web-form submission is not grounds to rename somebody's deal,
    // for the same reason it does not reassign it.
    const { service } = setup();
    const first = await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);
    const second = await service.capture(capture({ title: "web form enquiry" }), ACTOR);

    expect(second.merged).toBe(true);
    expect(second.lead.title).toBe("FY27 statutory audit");
    expect(second.lead.id).toBe(first.lead.id);
  });

  it("hands the discarded title back instead of dropping it in silence", async () => {
    // The merge is right and stays. What was wrong is that the caller typed
    // "Transfer pricing study", got back a lead called "FY26 statutory audit",
    // and had no way to learn their words were gone or why. They are the only
    // party who can act on it — re-title the live lead, close it first, or
    // recognise their own duplicate — so it comes back to them.
    const { service } = setup();
    await service.capture(capture({ title: "FY26 statutory audit" }), ACTOR);
    const second = await service.capture(capture({ title: "Transfer pricing study" }), ACTOR);

    expect(second.merged).toBe(true);
    expect(second.discardedTitle).toBe("Transfer pricing study");
    expect(second.lead.title).toBe("FY26 statutory audit");
  });

  it("reports no discard when the second capture sent the same words", async () => {
    // Non-null must mean "words were lost", not "you merged". A form submitted
    // twice with the same title lost nothing: the caller's title IS the lead's
    // title. Flagging a discard there would train callers to ignore the field.
    // Compared after trimming, because that is what would have been stored.
    const { service } = setup();
    await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);
    const second = await service.capture(capture({ title: "  FY27 statutory audit  " }), ACTOR);

    expect(second.merged).toBe(true);
    expect(second.discardedTitle).toBeNull();
  });

  it("reports no discard on a capture that actually created something", async () => {
    const { service } = setup();
    const created = await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);
    expect(created.merged).toBe(false);
    expect(created.discardedTitle).toBeNull();
    expect(created.lead.title).toBe("FY27 statutory audit");
  });

  it("tells the ledger THAT a title was dropped, never what it said", async () => {
    // Same rule and same shape as `lostReasonRecorded` on lead.stage_changed. A
    // title names the counterparty and a lead can be about a human being, so
    // the words are sometimes personal data and this log cannot be erased —
    // EVENT-CONTRACT §3.4. `findPiiKey` denies KEYS and `title` is not one, so
    // nothing but this rule would have stopped the words going in.
    const { service, events } = setup();
    await service.capture(
      capture({ kind: "person", name: "Priya Menon", title: "FY26 return" }),
      ACTOR,
    );
    const before = events.recorded.length;
    const second = await service.capture(
      capture({ kind: "person", name: "Priya Menon", title: "Priya Menon — capital gains" }),
      ACTOR,
    );

    const merged = events.recorded.slice(before).at(-1);
    expect(merged?.verb).toBe("lead.merged");
    expect(merged?.payload["titleDiscarded"]).toBe(true);
    expect(second.discardedTitle).toBe("Priya Menon — capital gains");
    expect(JSON.stringify(events.recorded)).not.toContain("capital gains");
  });

  it("records the machine fact as false when the merge lost nothing", async () => {
    // The boolean is the only record of how often the one-open-lead-per-party
    // rule costs a DISTINCT piece of work rather than absorbing a duplicate
    // submission, so it has to be able to say no.
    const { service, events } = setup();
    await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);
    const before = events.recorded.length;
    await service.capture(capture({ title: "FY27 statutory audit" }), ACTOR);

    expect(events.recorded.slice(before).at(-1)?.payload["titleDiscarded"]).toBe(false);
  });
});

describe("a lost deal says why — G3.1's second acceptance", () => {
  async function openLead() {
    const s = setup();
    const { lead } = await s.service.capture(capture(), ACTOR);
    return { ...s, lead };
  }

  it("records the closer's own words on the lead", async () => {
    const { service, lead } = await openLead();
    const closed = await service.moveStage(
      {
        tenantId: TENANT,
        leadId: lead.id,
        stage: "lost",
        lostReason: "their CFO went with his old audit partner; fee was never discussed",
      },
      ACTOR,
    );
    expect(closed.lostReason).toBe(
      "their CFO went with his old audit partner; fee was never discussed",
    );
    expect(closed.closedAt).not.toBeNull();
  });

  it("refuses to close a deal as lost with no explanation", async () => {
    // The one fact that is obvious today and unrecoverable in a month.
    const { service, lead } = await openLead();
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "lost" }, ACTOR),
    ).rejects.toBeInstanceOf(LostReasonRequired);
  });

  it("refuses a whitespace reason, which is the same as none", async () => {
    const { service, lead } = await openLead();
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "lost", lostReason: " " }, ACTOR),
    ).rejects.toBeInstanceOf(LostReasonRequired);
  });

  it("asks abandoned for a reason too, so neither stage is the cheap one", async () => {
    // Making it optional here would put a friction gradient between the two
    // unwon stages, and the cheapest way past a text box is to file a
    // competitor loss as "went quiet" — destroying the exact signal G3.1 adds.
    const { service, lead } = await openLead();
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "abandoned" }, ACTOR),
    ).rejects.toBeInstanceOf(LostReasonRequired);
  });

  it("refuses a reason on a stage that has nothing to explain", async () => {
    const { service, lead } = await openLead();
    await expect(
      service.moveStage(
        { tenantId: TENANT, leadId: lead.id, stage: "converted", lostReason: "we won on price" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LostReasonNotApplicable);
    await expect(
      service.moveStage(
        { tenantId: TENANT, leadId: lead.id, stage: "qualified", lostReason: "not yet" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LostReasonNotApplicable);
  });

  it("leaves a converted lead with no reason at all", async () => {
    const { service, lead } = await openLead();
    const won = await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "converted" },
      ACTOR,
    );
    expect(won.lostReason).toBeNull();
  });

  it("puts whether it was explained in the ledger, never the explanation", async () => {
    // A closing reason is a sentence about a named human being, written into a
    // column that can be erased. This log cannot be.
    const { service, events, lead } = await openLead();
    const REASON = "Priya said their board had already picked Deloitte";
    await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "lost", lostReason: REASON },
      ACTOR,
    );

    const last = events.recorded.at(-1);
    expect(last?.verb).toBe("lead.stage_changed");
    expect(last?.payload["lostReasonRecorded"]).toBe(true);
    expect(JSON.stringify(events.recorded)).not.toContain(REASON);
    expect(JSON.stringify(events.recorded)).not.toContain("Deloitte");
  });
});

describe("went quiet and chose a competitor are different rows — the third acceptance", () => {
  it("closes one lead abandoned and another lost, and the list keeps them apart", async () => {
    const { service } = setup();
    const quiet = await service.capture(capture({ title: "Q1 vCFO retainer" }), ACTOR);
    await service.moveStage(
      {
        tenantId: TENANT,
        leadId: quiet.lead.id,
        stage: "abandoned",
        lostReason: "three follow-ups over five weeks, no reply after the scoping call",
      },
      ACTOR,
    );
    const beaten = await service.capture(
      capture({
        title: "FY27 statutory audit",
        name: "Other Ltd",
        identifiers: [{ type: "phone", value: PHONE }],
      }),
      ACTOR,
    );
    await service.moveStage(
      {
        tenantId: TENANT,
        leadId: beaten.lead.id,
        stage: "lost",
        lostReason: "beaten on fee by roughly 20 percent",
      },
      ACTOR,
    );

    // A follow-up problem and a pricing problem, filed as what they are. One
    // stage for both would have made these the same row.
    const abandoned = await service.list(TENANT, "abandoned");
    const lost = await service.list(TENANT, "lost");
    expect(abandoned.map((r) => r.lead.id)).toEqual([quiet.lead.id]);
    expect(lost.map((r) => r.lead.id)).toEqual([beaten.lead.id]);
    expect(abandoned[0]?.lead.lostReason).toContain("no reply");
    expect(lost[0]?.lead.lostReason).toContain("beaten on fee");
  });

  it("closes the lead, so an abandoned prospect can be approached again", async () => {
    // The failure this would have had if `abandoned` were left open: the
    // one-open-lead-per-party index would count it as live and the prospect
    // could never be captured again.
    const { service, leads } = setup();
    const first = await service.capture(capture(), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: first.lead.id, stage: "abandoned", lostReason: "went quiet" },
      ACTOR,
    );
    expect(first.lead.id).toBeTruthy();

    const again = await service.capture(capture({ title: "FY28 statutory audit" }), ACTOR);
    expect(again.merged).toBe(false);
    expect(again.matchedExistingParty).toBe(true);
    expect(again.lead.partyId).toBe(first.lead.partyId);
    expect(leads.rows).toHaveLength(2);
  });

  it("will not reopen an abandoned lead, any more than a lost one", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "abandoned", lostReason: "went quiet" },
      ACTOR,
    );
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "contacted" }, ACTOR),
    ).rejects.toBeInstanceOf(LeadClosed);
  });
});

describe("the vocabulary the wire offers matches the domain's", () => {
  it("offers every source and every stage", () => {
    // zod needs literal tuples, so the DTO lists are separate from the domain's.
    // `satisfies` stops them naming something that does not exist; this stops
    // them missing something, which would 400 a perfectly valid request.
    expect([...SOURCE_VALUES].sort()).toEqual([...LEAD_SOURCES].sort());
    expect([...STAGE_VALUES].sort()).toEqual([...LEAD_STAGES].sort());
  });

  it("never lets a finished lead move", () => {
    // Every terminal stage, read from the domain rather than listed here, so a
    // sixth one added next month is covered the day it exists — which is how
    // `abandoned` would otherwise have shipped as a reopenable stage.
    for (const from of TERMINAL_STAGES) {
      for (const to of LEAD_STAGES) {
        expect(canMoveStage(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("counts abandoned as finished, not as a sixth open stage", () => {
    // If `abandoned` were open, the party would keep its live opportunity and
    // lead_one_open_per_party would lock the prospect out of the pipeline for
    // good — the index that exists to stop duplicates blocking the re-approach.
    expect(TERMINAL_STAGES).toContain("abandoned");
    expect(isOpen("abandoned")).toBe(false);
  });
});

// ── T2.1b · the desk an unclaimed lead lands on ──────────────────────────────
//
// The acceptance: "N leads captured with no owner distribute evenly." These
// prove that, and the three instructions the owner field can carry, against the
// in-memory rotation. The two properties a fake cannot have — that counting and
// claiming are one atomic act, and that simultaneous captures cannot collide —
// are in tests/lead/assignment.integration.test.ts against real Postgres, which
// is the only place they are true.
describe("assigning a lead nobody named an owner for", () => {
  const DESKS = [
    "00000000-0000-4000-8000-0000000000e1",
    "00000000-0000-4000-8000-0000000000e2",
    "00000000-0000-4000-8000-0000000000e3",
  ];

  function firmWithThreeStaff() {
    const fakes = makeLeadFakes();
    for (const userId of DESKS) fakes.staff.add(TENANT, userId);
    return { ...fakes, service: new LeadService(fakes) };
  }

  /** A distinct prospect each time, so every capture starts a NEW lead rather
   *  than merging onto the last one — the merge path assigns nobody. */
  function nth(n: number) {
    return capture({
      name: `Prospect ${String(n)} Private Limited`,
      identifiers: [{ type: "email" as const, value: `p${String(n)}@example.test` }],
    });
  }

  /** `from` keeps every prospect distinct across calls — repeating one would
   *  MERGE onto its existing lead and assign nobody, which is the merge rule
   *  working, not the rotation failing. */
  async function captureMany(
    service: LeadService,
    count: number,
    from = 0,
  ): Promise<string[]> {
    const owners: string[] = [];
    for (let n = from; n < from + count; n += 1) {
      const { lead } = await service.capture(nth(n), ACTOR);
      owners.push(lead.ownerUserId ?? "unassigned");
    }
    return owners;
  }

  it("distributes N leads evenly over the firm's active staff", async () => {
    // THE ACCEPTANCE. Nine captures, three desks, three each — not "roughly",
    // exactly, because the rule is deterministic and a rotation that is only
    // approximately fair is one nobody can audit.
    const { service } = firmWithThreeStaff();
    const owners = await captureMany(service, 9);

    const perDesk = DESKS.map((d) => owners.filter((o) => o === d).length);
    expect(perDesk).toEqual([3, 3, 3]);
  });

  it("goes round, rather than filling one desk and moving on", async () => {
    // Even totals could also be produced by AAA BBB CCC, which is not a
    // rotation — it is a queue with a batch size, and the third colleague waits
    // six leads for their first. The ORDER is the property.
    const { service } = firmWithThreeStaff();
    expect(await captureMany(service, 6)).toEqual([...DESKS, ...DESKS]);
  });

  it("gives the next lead to whoever a close has just freed up", async () => {
    // The rotation is DERIVED from the pipeline rather than stored as a
    // pointer, so it reflects what is actually on each desk. Close the first
    // desk's lead and that desk is the emptiest again.
    const { service, leads } = firmWithThreeStaff();
    const first = await service.capture(nth(0), ACTOR);
    await service.capture(nth(1), ACTOR);
    await service.capture(nth(2), ACTOR);
    expect(first.lead.ownerUserId).toBe(DESKS[0]);

    await service.moveStage(
      { tenantId: TENANT, leadId: first.lead.id, stage: "lost", lostReason: "went elsewhere" },
      ACTOR,
    );
    const next = await service.capture(nth(3), ACTOR);
    expect(next.lead.ownerUserId).toBe(DESKS[0]);
    expect(leads.rows).toHaveLength(4);
  });

  it("picks somebody who joined this morning before anybody else", async () => {
    // The self-healing property, and the one a stored pointer cannot have: a
    // pointer knows nothing about a colleague who did not exist when it was
    // last written, so a new joiner waits a full lap for their first lead.
    const fakes = makeLeadFakes();
    fakes.staff.add(TENANT, DESKS[0] ?? "").add(TENANT, DESKS[1] ?? "");
    const service = new LeadService(fakes);
    await service.capture(nth(0), ACTOR);
    await service.capture(nth(1), ACTOR);

    fakes.staff.add(TENANT, DESKS[2] ?? "");
    const joiner = await service.capture(nth(2), ACTOR);
    expect(joiner.lead.ownerUserId).toBe(DESKS[2]);
  });

  it("stops giving work to somebody who has left", async () => {
    // The other half of self-healing. `FakeStaffDirectory.remove` is the fake's
    // stand-in for is_active going false; the real predicate is proved against
    // Postgres, where the SAME notion also refuses them as a manual owner.
    const { service, staff } = firmWithThreeStaff();
    await captureMany(service, 3);
    staff.remove(TENANT, DESKS[1] ?? "");

    const owners = await captureMany(service, 2, 3);
    expect(owners).not.toContain(DESKS[1]);
  });

  it("does not overrule a person who named an owner", async () => {
    const { service } = firmWithThreeStaff();
    const { lead } = await service.capture(nth(0), { ...ACTOR });
    expect(lead.ownerUserId).toBe(DESKS[0]);

    const named = await service.capture(
      { ...nth(1), ownerUserId: DESKS[2] ?? "" },
      ACTOR,
    );
    // Not the rotation's pick (which would still be DESKS[1]): a human decided.
    expect(named.lead.ownerUserId).toBe(DESKS[2]);
  });

  it("leaves it in the unassigned queue when asked to, in so many words", async () => {
    // null is an INSTRUCTION, absent is a delegation. Collapsing them would
    // either abolish the triage queue or never rotate at all.
    const { service } = firmWithThreeStaff();
    const { lead } = await service.capture({ ...nth(0), ownerUserId: null }, ACTOR);
    expect(lead.ownerUserId).toBeNull();
  });

  it("captures the lead anyway when the firm has nobody to give it to", async () => {
    // Declining is a real answer. A capture lost because assignment had nobody
    // to pick is strictly worse than a lead sitting in a queue somebody works.
    const fakes = makeLeadFakes();
    const { lead } = await new LeadService(fakes).capture(nth(0), ACTOR);
    expect(lead.ownerUserId).toBeNull();
  });

  it("refuses a named owner who is not active staff, before the rotation ever runs", async () => {
    const { service } = firmWithThreeStaff();
    await expect(
      service.capture({ ...nth(0), ownerUserId: OUTSIDER }, ACTOR),
    ).rejects.toBeInstanceOf(OwnerNotStaff);
  });

  it("says on the timeline HOW the owner got there, not just who", async () => {
    // "The rotation chose Anand" and "the partner chose Anand" are different
    // facts, and only the first is evidence about whether assignment works.
    const { service, events } = firmWithThreeStaff();
    await service.capture(nth(0), ACTOR);
    expect(events.recorded.at(-1)?.payload["ownerAssignedBy"]).toBe("round_robin");
    expect(events.recorded.at(-1)?.payload["ownerUserId"]).toBe(DESKS[0]);

    await service.capture({ ...nth(1), ownerUserId: DESKS[1] ?? "" }, ACTOR);
    expect(events.recorded.at(-1)?.payload["ownerAssignedBy"]).toBe("requested");

    await service.capture({ ...nth(2), ownerUserId: null }, ACTOR);
    expect(events.recorded.at(-1)?.payload["ownerAssignedBy"]).toBeNull();
  });

  it("records the rotation as part of the capture, not as a second action", async () => {
    // One thing happened — somebody captured a lead — so the timeline gets one
    // row. A `lead.owner_assigned` beside it would say a colleague reassigned
    // something a moment after capturing it, which nobody did.
    const { service, events } = firmWithThreeStaff();
    await service.capture(nth(0), ACTOR);
    expect(events.verbs().filter((v) => v.startsWith("lead."))).toEqual(["lead.captured"]);
  });

  it("never reassigns the live opportunity a duplicate capture lands on", async () => {
    // The merge appends; it does not redecide. The owner on a live lead was
    // somebody's decision and a second web-form submission is not grounds to
    // undo it — and a rotation that fired on every duplicate would hand the
    // same prospect to a different colleague each time the form was resubmitted.
    const { service } = firmWithThreeStaff();
    const first = await service.capture(nth(0), ACTOR);
    const second = await service.capture(nth(0), ACTOR);

    expect(second.merged).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.ownerUserId).toBe(first.lead.ownerUserId);
  });
});

describe("T2.1b — a territory rule overrides the rotation", () => {
  // THE HALF OF T2.1b THAT WAS NEVER BUILT, and the board said why honestly:
  // the axis had never been chosen. The reason it could not be turns out to be
  // concrete — A LEAD HAD NO AXIS ON IT. Not geography, not industry, not
  // service line: `crm.lead` held a title, a party, a source, a stage and an
  // owner, so whichever axis was picked, the column did not exist.
  //
  // Migration 0026 adds `jurisdiction` — where the PROSPECT is — and it earns
  // its place independently of assignment: every other stage of this product
  // already keys on a jurisdiction, and `ProposalService.draft` takes a
  // `clientJurisdiction` that nothing supplied, so a lead that converted
  // re-asked a question the firm answered at capture.

  /** Two desks, and a rule that gives one of them the UK. */
  function firmWithTerritory(): ReturnType<typeof setup> & {
    fakes: ReturnType<typeof makeLeadFakes>;
  } {
    const fakes = makeLeadFakes();
    fakes.staff.add(TENANT, STAFF);
    fakes.staff.add(TENANT, SPECIALIST);
    return {
      fakes,
      service: new LeadService(fakes),
      leads: fakes.leads,
      staff: fakes.staff,
      events: fakes.events,
    };
  }

  it("sends a lead from the rule's country to that desk", async () => {
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST, note: "UK desk" },
      ACTOR,
    );
    const { lead } = await s.service.capture(capture({ jurisdiction: "GB" }), ACTOR);
    expect(lead.ownerUserId).toBe(SPECIALIST);
  });

  it("…and the timeline says the RULE chose, not the rotation", async () => {
    // The reason `AssignmentOutcome` carries the policy instead of the strategy
    // declaring one. "The rotation chose Anand" and "the UK desk rule chose
    // Anand" are different facts, and only the first is evidence about whether
    // the rotation is working.
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    await s.service.capture(capture({ jurisdiction: "GB" }), ACTOR);
    const captured = s.events.recorded.find((e) => e.verb === "lead.captured");
    expect(captured?.payload).toMatchObject({ ownerAssignedBy: "territory" });
  });

  it("overrides the rotation even when that desk is the busiest", async () => {
    // "OVERRIDES" is the acceptance's own word, and this is what it has to mean
    // to be worth anything: the rotation would pick the emptiest desk, and the
    // rule wins anyway. Without this the two are indistinguishable whenever
    // they happen to agree.
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    // Load the specialist's desk up so the rotation would never choose them.
    for (let n = 0; n < 3; n += 1) {
      await s.service.capture(
        capture({
          title: `Filler ${String(n)}`,
          ownerUserId: SPECIALIST,
          identifiers: [{ type: "email" as const, value: `filler-${String(n)}@x.example` }],
          name: `Filler Co ${String(n)}`,
        }),
        ACTOR,
      );
    }
    const { lead } = await s.service.capture(capture({ jurisdiction: "GB" }), ACTOR);
    expect(lead.ownerUserId).toBe(SPECIALIST);
  });

  it("falls through to the rotation for a country no rule covers", async () => {
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    const { lead } = await s.service.capture(capture({ jurisdiction: "IN" }), ACTOR);
    expect(lead.ownerUserId).not.toBeNull();
    const captured = s.events.recorded.find((e) => e.verb === "lead.captured");
    expect(captured?.payload).toMatchObject({ ownerAssignedBy: "round_robin" });
  });

  it("…and for a lead whose country nobody knows", async () => {
    // The everyday capture. An unknown country is ordinary and must stay cheap:
    // it is exactly why there is no wildcard territory rule — the rotation IS
    // the fallback, and a catch-all row would be a worse one somebody has to
    // remember to maintain.
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    const { lead } = await s.service.capture(capture(), ACTOR);
    expect(lead.jurisdiction).toBeNull();
    const captured = s.events.recorded.find((e) => e.verb === "lead.captured");
    expect(captured?.payload).toMatchObject({ ownerAssignedBy: "round_robin" });
  });

  it("never overrules a person who named the owner", async () => {
    // A rule outranks the rotation; neither outranks a human. Same reasoning as
    // `AND owner_user_id IS NULL` in both adapters.
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    const { lead } = await s.service.capture(
      capture({ jurisdiction: "GB", ownerUserId: STAFF }),
      ACTOR,
    );
    expect(lead.ownerUserId).toBe(STAFF);
    const captured = s.events.recorded.find((e) => e.verb === "lead.captured");
    expect(captured?.payload).toMatchObject({ ownerAssignedBy: "requested" });
  });

  it("declines when the rule names somebody who has left", async () => {
    // A membership is revoked long after the rule was written, and no foreign
    // key can express "active". Without this check the lead parks on a dead
    // desk where nobody sees it — worse than the unassigned queue, because it
    // LOOKS assigned.
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    s.staff.remove(TENANT, SPECIALIST);
    const { lead } = await s.service.capture(capture({ jurisdiction: "GB" }), ACTOR);
    expect(lead.ownerUserId).toBe(STAFF);
  });

  it("refuses to write a rule naming somebody who is not staff", async () => {
    const s = firmWithTerritory();
    await expect(
      s.service.setTerritoryRule(
        { tenantId: TENANT, jurisdiction: "GB", ownerUserId: OUTSIDER },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(OwnerNotStaff);
  });

  it("keeps one desk per country — setting it again MOVES it", async () => {
    const s = firmWithTerritory();
    const first = await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST },
      ACTOR,
    );
    const moved = await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: STAFF },
      ACTOR,
    );
    // The row keeps its identity, so anything that referenced it still can.
    expect(moved.id).toBe(first.id);
    expect(await s.service.listTerritoryRules(TENANT)).toHaveLength(1);
    const { lead } = await s.service.capture(capture({ jurisdiction: "GB" }), ACTOR);
    expect(lead.ownerUserId).toBe(STAFF);
  });

  it("records the rule and never the note", async () => {
    const s = firmWithTerritory();
    await s.service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "GB", ownerUserId: SPECIALIST, note: "Ravi lives there" },
      ACTOR,
    );
    const set = s.events.recorded.find((e) => e.verb === "territory_rule.set");
    expect(set?.payload).toEqual({ jurisdiction: "GB", ownerUserId: SPECIALIST });
    expect(JSON.stringify(set?.payload)).not.toContain("Ravi");
  });

  it("refuses a jurisdiction it could never compare", async () => {
    // Refused rather than dropped, on both the lead and the rule. A caller
    // sending "gb" would otherwise get the rotation and no clue why — a silent
    // fallback indistinguishable from the ordinary unknown-country case.
    const s = firmWithTerritory();
    await expect(
      s.service.capture(capture({ jurisdiction: "gb" }), ACTOR),
    ).rejects.toBeInstanceOf(InvalidLeadJurisdiction);
    await expect(
      s.service.setTerritoryRule(
        { tenantId: TENANT, jurisdiction: "United Kingdom", ownerUserId: SPECIALIST },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidLeadJurisdiction);
  });
});

describe("the day a captured contact detail is in force from (item 4, 2026-09-25)", () => {
  // It was the server's UTC day: a PAN captured at 02:00 in Delhi was "in
  // force from" the day before the firm learned it.
  it("is the FIRM's day, not the server's", async () => {
    const fakes = makeLeadFakes();
    fakes.timeZones.set("Asia/Kolkata");
    fakes.clock.set("2026-03-01T20:30:00.000Z");
    const service = new LeadService(fakes);
    const { lead } = await service.capture(capture(), ACTOR);
    const pan = await fakes.party.findByIdentifier(TENANT, "pan", PAN);
    expect(pan?.partyId).toBe(lead.partyId);
    expect(pan?.validFrom).toBe("2026-03-02");
  });

  it("is the caller's own day when it sends one", async () => {
    const fakes = makeLeadFakes();
    fakes.timeZones.set("Asia/Kolkata");
    fakes.clock.set("2026-03-01T20:30:00.000Z");
    const service = new LeadService(fakes);
    await service.capture(capture({ asOf: "2026-03-01" }), ACTOR);
    const pan = await fakes.party.findByIdentifier(TENANT, "pan", PAN);
    expect(pan?.validFrom).toBe("2026-03-01");
  });

  it("REFUSES an asOf that is not today anywhere, before writing anything", async () => {
    const fakes = makeLeadFakes();
    const service = new LeadService(fakes);
    await expect(service.capture(capture({ asOf: "2025-01-01" }), ACTOR)).rejects.toMatchObject({
      code: "NOT_CALLERS_TODAY",
    });
    expect(fakes.leads.rows).toEqual([]);
    expect(await fakes.party.findByIdentifier(TENANT, "pan", PAN)).toBeNull();
  });
});

describe("0310 — a lead says where the prospect is and what it could be worth", () => {
  it("captures an estimate in the firm's reporting currency, in one spelling", async () => {
    const { service } = setup();
    const { lead } = await service.capture(
      capture({ jurisdiction: "SG", estimatedValue: "0500000" }),
      ACTOR,
    );
    expect(lead.jurisdiction).toBe("SG");
    // Canonical before it is written: no leading zero, two places — what
    // numeric(18,2) hands back, so "did this change" compares like with like.
    expect(lead.estimatedValue).toEqual({ amount: "500000.00", currency: "INR" });
  });

  it("captures with no estimate at all, because nobody knows one yet", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    expect(lead.estimatedValue).toBeNull();
  });

  it.each(["5,00,000", "5e5", "-100", "12.345", "", " 100", "₹100"])(
    "refuses %j as an estimate before anything is written",
    async (bad) => {
      const { service, leads, events } = setup();
      await expect(
        service.capture(capture({ estimatedValue: bad }), ACTOR),
      ).rejects.toBeInstanceOf(InvalidEstimatedValue);
      expect(leads.rows).toHaveLength(0);
      expect(events.recorded).toHaveLength(0);
    },
  );

  it("sets and corrects both facts, recording both sides of each", async () => {
    const { service, events } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    const saved = await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: "AE", estimatedValue: "250000.5" },
      ACTOR,
    );
    expect(saved.jurisdiction).toBe("AE");
    expect(saved.estimatedValue).toEqual({ amount: "250000.50", currency: "INR" });

    const last = events.recorded.at(-1);
    expect(last?.verb).toBe("lead.details_changed");
    expect(last?.payload).toMatchObject({
      jurisdictionFrom: null,
      jurisdictionTo: "AE",
      estimatedValueFrom: null,
      estimatedValueTo: "250000.50",
      currency: "INR",
    });
  });

  it("records nothing when a save changes nothing — the same value in another spelling included", async () => {
    const { service, events } = setup();
    const { lead } = await service.capture(
      capture({ jurisdiction: "IN", estimatedValue: "100000" }),
      ACTOR,
    );
    const before = events.recorded.length;
    await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: "IN", estimatedValue: "100000.00" },
      ACTOR,
    );
    expect(events.recorded).toHaveLength(before);
  });

  it("clears either fact with null — 'we no longer know' is a real answer", async () => {
    const { service } = setup();
    const { lead } = await service.capture(
      capture({ jurisdiction: "IN", estimatedValue: "100000" }),
      ACTOR,
    );
    const cleared = await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: null, estimatedValue: null },
      ACTOR,
    );
    expect(cleared.jurisdiction).toBeNull();
    expect(cleared.estimatedValue).toBeNull();
  });

  it("keeps the value when the save does not mention it (B33: a login that cannot see it changes the country)", async () => {
    const { service, events } = setup();
    const { lead } = await service.capture(
      capture({ jurisdiction: "IN", estimatedValue: "100000" }),
      ACTOR,
    );
    const saved = await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: "AE", estimatedValue: undefined },
      ACTOR,
    );
    expect(saved.jurisdiction).toBe("AE");
    expect(saved.estimatedValue).toEqual({ amount: "100000.00", currency: "INR" });
    expect(events.recorded.at(-1)?.payload).toMatchObject({
      jurisdictionTo: "AE",
      estimatedValueFrom: "100000.00",
      estimatedValueTo: "100000.00",
    });
  });

  it("refuses a country that is not an upper-case ISO code, and an unknown lead", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await expect(
      service.setDetails(
        { tenantId: TENANT, leadId: lead.id, jurisdiction: "in", estimatedValue: null },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidLeadJurisdiction);
    await expect(
      service.setDetails(
        {
          tenantId: TENANT,
          leadId: "00000000-0000-4000-8000-00000000ffff",
          jurisdiction: null,
          estimatedValue: null,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LeadNotFound);
  });

  it("is allowed on a closed lead — what a won deal was worth is worth being right about", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "converted" }, ACTOR);
    const saved = await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: "IN", estimatedValue: "750000" },
      ACTOR,
    );
    expect(saved.estimatedValue?.amount).toBe("750000.00");
  });

  it("does not reassign the lead when its country changes", async () => {
    const fakes = makeLeadFakes();
    fakes.staff.add(TENANT, STAFF).add(TENANT, SPECIALIST);
    const service = new LeadService(fakes);
    await service.setTerritoryRule(
      { tenantId: TENANT, jurisdiction: "AE", ownerUserId: SPECIALIST },
      ACTOR,
    );
    const { lead } = await service.capture(capture({ ownerUserId: STAFF }), ACTOR);
    const saved = await service.setDetails(
      { tenantId: TENANT, leadId: lead.id, jurisdiction: "AE", estimatedValue: null },
      ACTOR,
    );
    expect(saved.ownerUserId).toBe(STAFF);
  });
});
