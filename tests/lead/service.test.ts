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
import { LEAD_SOURCES, LEAD_STAGES, canMoveStage } from "../../src/domain/lead/model";
import { SOURCE_VALUES, STAGE_VALUES } from "../../src/api/handler/lead";
import {
  AmbiguousMatch,
  InvalidSource,
  InvalidStage,
  LeadClosed,
  LeadNotFound,
  NoContactDetail,
  OwnerNotStaff,
  SameStage,
} from "../../src/domain/lead/errors";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000d1" };
const STAFF = "00000000-0000-4000-8000-0000000000d2";
const OUTSIDER = "00000000-0000-4000-8000-0000000000d3";

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

/** The everyday capture: a company with an email and a PAN. */
function capture(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    source: "inbound",
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
});

describe("a prospect who comes back", () => {
  it("is a NEW opportunity once the old one is closed", async () => {
    // Two attempts should count as two in a conversion rate, not as one that
    // took nine months. This is what the partial index leaves room for.
    const { service, leads } = setup();
    const first = await service.capture(capture(), ACTOR);
    await service.moveStage({ tenantId: TENANT, leadId: first.lead.id, stage: "lost" }, ACTOR);

    const second = await service.capture(capture(), ACTOR);
    expect(second.merged).toBe(false);
    expect(second.lead.id).not.toBe(first.lead.id);
    // Same prospect, though — the party is not duplicated.
    expect(second.matchedExistingParty).toBe(true);
    expect(second.lead.partyId).toBe(first.lead.partyId);
    expect(leads.rows).toHaveLength(2);
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
    await service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "lost" }, ACTOR);
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
  async function openLead() {
    const s = setup();
    const { lead } = await s.service.capture(capture(), ACTOR);
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
    expect(qualified.map((l) => l.id)).toEqual([first.lead.id]);
  });

  it("refuses a stage filter the pipeline does not have", async () => {
    await expect(setup().service.list(TENANT, "nurturing")).rejects.toBeInstanceOf(InvalidStage);
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
    for (const to of LEAD_STAGES) {
      expect(canMoveStage("converted", to), `converted -> ${to}`).toBe(false);
      expect(canMoveStage("lost", to), `lost -> ${to}`).toBe(false);
    }
  });
});
