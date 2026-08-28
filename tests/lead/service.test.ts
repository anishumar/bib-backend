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
  InvalidStage,
  LeadClosed,
  LeadNotFound,
  LostReasonNotApplicable,
  LostReasonRequired,
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
    const captured = await service.capture(capture(), ACTOR);
    const record = await service.get(TENANT, captured.lead.id);
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
    const record = await service.get(TENANT, lead.id);

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
