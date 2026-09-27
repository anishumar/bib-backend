// Deleting a lead entered by mistake (0086), at the use-case level. The
// acceptance: a mistake comes OUT of the pipeline — out of the list and out of
// every count — without being recorded as a lost deal, while a real outcome, a
// won deal and anything a proposal rests on stay exactly where they are.
//
// The database half — the guard trigger, the one-open-lead index skipping a
// deleted lead, and a deleted lead being final — is proven against real
// Postgres in tests/deletion/deletion.integration.test.ts.
import { describe, expect, it } from "vitest";
import { LeadService } from "../../src/usecase/lead/service";
import { makeLeadFakes } from "../../src/testfakes/lead";
import type { FakeLeadRepo } from "../../src/testfakes/lead";
import type { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  ClosedLeadNeedsAdmin,
  ConvertedLeadNotDeletable,
  LeadDeleted,
  LeadHasProposals,
  LeadNotFound,
} from "../../src/domain/lead/errors";
import { leadDeletionBlock } from "../../src/domain/lead/model";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000d1" };
const STAFF = "00000000-0000-4000-8000-0000000000d2";

function setup(): { service: LeadService; leads: FakeLeadRepo; events: RecordingEventSink } {
  const fakes = makeLeadFakes();
  fakes.staff.add(TENANT, STAFF);
  fakes.leads.staff.set(ACTOR.id, { displayName: "Anish", email: "anish@firm.example" });
  return { service: new LeadService(fakes), leads: fakes.leads, events: fakes.events };
}

function capture(email = "priya@meridian.example") {
  return {
    tenantId: TENANT,
    source: "inbound",
    title: "FY27 statutory audit",
    kind: "organization" as const,
    name: "Meridian Textiles Private Limited",
    identifiers: [{ type: "email" as const, value: email }],
    ownerUserId: STAFF,
  };
}

function remove(leadId: string, callerAdministers = false) {
  return { tenantId: TENANT, leadId, callerAdministers };
}

describe("deleting a lead entered by mistake", () => {
  it("takes it out of the pipeline, and says who and when", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);

    const deleted = await service.delete(remove(lead.id), ACTOR);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedByUserId).toBe(ACTOR.id);
    // NOT a stage: a mistake is not a lost deal, so the stage it had reached
    // stays exactly as it was and the lost column never sees it.
    expect(deleted.stage).toBe("new");
    expect(deleted.lostReason).toBeNull();
    expect(await service.list(TENANT)).toEqual([]);
    expect(await service.list(TENANT, "new")).toEqual([]);
  });

  it("still opens by id, saying it was deleted and by whom", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.delete(remove(lead.id), ACTOR);

    const view = await service.get(TENANT, lead.id, false);
    expect(view.lead.deletedAt).not.toBeNull();
    expect(view.deletedBy?.displayName).toBe("Anish");
    expect(view.deleteRefusal?.code).toBe("LEAD_DELETED");
  });

  it("records one lead.deleted, with the stage and never the title", async () => {
    const { service, events } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.delete(remove(lead.id), ACTOR);

    const recorded = events.recorded.filter((e) => e.verb === "lead.deleted");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.objectId).toBe(lead.id);
    expect(recorded[0]?.actorId).toBe(ACTOR.id);
    expect(recorded[0]?.payload).toEqual({ partyId: lead.partyId, stage: "new" });
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain("statutory audit");
  });

  it("is final: a second delete, and every change, is refused", async () => {
    const { service, events } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.delete(remove(lead.id), ACTOR);

    await expect(service.delete(remove(lead.id, true), ACTOR)).rejects.toBeInstanceOf(LeadDeleted);
    await expect(
      service.moveStage({ tenantId: TENANT, leadId: lead.id, stage: "contacted" }, ACTOR),
    ).rejects.toBeInstanceOf(LeadDeleted);
    await expect(
      service.assignOwner({ tenantId: TENANT, leadId: lead.id, ownerUserId: null }, ACTOR),
    ).rejects.toBeInstanceOf(LeadDeleted);
    await expect(
      service.setDetails(
        { tenantId: TENANT, leadId: lead.id, jurisdiction: "IN", estimatedValue: null },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LeadDeleted);
    // One deletion in a log that cannot be corrected, however many presses.
    expect(events.verbs().filter((v) => v === "lead.deleted")).toHaveLength(1);
  });

  it("frees the client for a fresh lead, rather than merging into the mistake", async () => {
    // The one-open-lead rule would otherwise land every later capture for this
    // client on the lead somebody deleted — the mistake coming back.
    const { service } = setup();
    const first = await service.capture(capture(), ACTOR);
    await service.delete(remove(first.lead.id), ACTOR);

    const second = await service.capture(capture(), ACTOR);
    expect(second.merged).toBe(false);
    expect(second.lead.id).not.toBe(first.lead.id);
    expect(second.matchedExistingParty).toBe(true);
  });

  it("answers for a lead that does not exist as not found", async () => {
    await expect(
      setup().service.delete(remove("00000000-0000-4000-8000-00000000ffff"), ACTOR),
    ).rejects.toBeInstanceOf(LeadNotFound);
  });
});

describe("what a lead that is not a mistake keeps", () => {
  it("refuses a converted lead — a won deal is the record of a win", async () => {
    const { service, leads } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await leads.moveStage(TENANT, lead.id, "converted", "2026-03-02T00:00:00.000Z", null);

    await expect(service.delete(remove(lead.id, true), ACTOR)).rejects.toBeInstanceOf(
      ConvertedLeadNotDeletable,
    );
  });

  it("refuses while a live proposal was drafted from it, and names the proposal", async () => {
    const { service, leads } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    leads.draftFrom(lead.id, "PR-2026-0004");

    const refused = service.delete(remove(lead.id), ACTOR);
    await expect(refused).rejects.toBeInstanceOf(LeadHasProposals);
    await expect(refused).rejects.toThrow(/Proposal PR-2026-0004 was drafted from this lead/);
    expect((await service.get(TENANT, lead.id, false)).deleteRefusal?.code).toBe(
      "LEAD_HAS_PROPOSALS",
    );
  });

  it("allows it once that proposal was deleted too — deleting in order works", async () => {
    const { service, leads } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    leads.draftFrom(lead.id, "PR-2026-0004").dropProposal(lead.id, "PR-2026-0004");

    expect((await service.get(TENANT, lead.id, false)).deleteRefusal).toBeNull();
    await expect(service.delete(remove(lead.id), ACTOR)).resolves.toMatchObject({ id: lead.id });
  });
});

describe("a lead already closed as lost or abandoned is an administrator's to delete", () => {
  // It is in the pipeline's numbers — often exactly how a mistake was put away
  // while there was nothing else to do — and taking it out changes them.
  it("refuses anybody else, by WHO rather than by the lead", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "lost", lostReason: "Entered twice" },
      ACTOR,
    );

    await expect(service.delete(remove(lead.id, false), ACTOR)).rejects.toBeInstanceOf(
      ClosedLeadNeedsAdmin,
    );
    const view = await service.get(TENANT, lead.id, false);
    expect(view.deleteRefusal?.code).toBe("CLOSED_LEAD_NEEDS_ADMIN");
    expect(view.deleteRefusal?.message).toMatch(/only a firm administrator/);
  });

  it("allows an administrator, and the lost column loses it", async () => {
    const { service } = setup();
    const { lead } = await service.capture(capture(), ACTOR);
    await service.moveStage(
      { tenantId: TENANT, leadId: lead.id, stage: "abandoned", lostReason: "A test entry" },
      ACTOR,
    );
    expect((await service.get(TENANT, lead.id, true)).deleteRefusal).toBeNull();

    await service.delete(remove(lead.id, true), ACTOR);
    expect(await service.list(TENANT, "abandoned")).toEqual([]);
  });
});

describe("leadDeletionBlock — the rule, alone", () => {
  const live = { stage: "new" as const, deletedAt: null };

  it("lets an open lead with nothing drafted from it go", () => {
    expect(leadDeletionBlock(live, [], false)).toBeNull();
  });

  it("asks WHO before WHAT: a closed lead's proposals are not the first thing a non-admin hears", () => {
    expect(leadDeletionBlock({ stage: "lost", deletedAt: null }, ["PR-2026-0001"], false)).toEqual({
      kind: "closed",
      stage: "lost",
    });
    expect(leadDeletionBlock({ stage: "lost", deletedAt: null }, ["PR-2026-0001"], true)).toEqual({
      kind: "proposals",
      refs: ["PR-2026-0001"],
    });
  });

  it("says a deleted lead is deleted before anything else", () => {
    expect(
      leadDeletionBlock({ stage: "converted", deletedAt: "2026-03-02T00:00:00.000Z" }, [], true),
    ).toEqual({ kind: "deleted" });
  });
});
