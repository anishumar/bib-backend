import { describe, expect, it } from "vitest";
import { PartyService } from "../../src/usecase/party/service";
import { makePartyFakes } from "../../src/testfakes/party";
import type { FakePartyRepo } from "../../src/testfakes/party";
import type { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  DuplicateIdentifier,
  InvalidDateRange,
  InvalidIdentifier,
  InvalidRelationshipType,
  NotAnOrganization,
  PartyAlreadyArchived,
  PartyHasReferences,
  PartyNotArchived,
  PartyNotFound,
  RelationshipAlreadyEnded,
  RelationshipEndsBeforeItBegan,
  RelationshipNotFound,
  SelfRelationship,
} from "../../src/domain/party/errors";

const TENANT = "11111111-1111-1111-1111-111111111111";
/** Every write names who did it — the ledger refuses an event that cannot. */
const ACTOR = { type: "human", id: "99999999-9999-4999-8999-999999999999" } as const;

function svc() {
  const fakes = makePartyFakes();
  return {
    service: new PartyService(fakes),
    fakes,
    // The sink is the REAL LedgerService over an in-memory store, so these
    // assertions are against the event contract itself, not a stub that
    // records whatever it is handed.
    events: fakes.events as RecordingEventSink,
  };
}

describe("createOrganization", () => {
  it("creates an organization party; display name prefers the trade name", async () => {
    const { service } = svc();
    const org = await service.createOrganization({
      tenantId: TENANT,
      legalName: "Harbour Point Advisory Private Limited",
      tradeName: "Harbour Point",
    }, ACTOR);
    expect(org.legalName).toBe("Harbour Point Advisory Private Limited");
    const parties = await service.listParties(TENANT, false);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.displayName).toBe("Harbour Point");
    expect(parties[0]?.kind).toBe("organization");
  });

  it("falls back to the legal name when there is no trade name", async () => {
    const { service } = svc();
    await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);
    const [party] = await service.listParties(TENANT, false);
    expect(party?.displayName).toBe("Acme LLP");
  });
});

describe("registerLegalEntity", () => {
  it("registers against an organization and upper-cases the jurisdiction", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme Pte Ltd" }, ACTOR);
    const entity = await service.registerLegalEntity({
      tenantId: TENANT,
      organizationPartyId: org.partyId,
      jurisdiction: "sg",
      entityType: "pte_ltd",
    }, ACTOR);
    expect(entity.jurisdiction).toBe("SG");
    expect(entity.status).toBe("active");
  });

  it("refuses to register against a person", async () => {
    const { service } = svc();
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    await expect(
      service.registerLegalEntity({
        tenantId: TENANT,
        organizationPartyId: person.partyId,
        jurisdiction: "IN",
        entityType: "private_limited",
      }, ACTOR),
    ).rejects.toBeInstanceOf(NotAnOrganization);
  });
});

describe("addIdentifier", () => {
  async function withOrg() {
    const { service, fakes } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" }, ACTOR);
    return { service, fakes, partyId: org.partyId };
  }

  it("normalises and stores a PAN", async () => {
    const { service, partyId } = await withOrg();
    const id = await service.addIdentifier({
      tenantId: TENANT,
      partyId,
      type: "pan",
      value: " abcde1234f ",
      validFrom: "2020-04-01",
    }, ACTOR);
    expect(id.value).toBe("ABCDE1234F");
  });

  it("rejects a malformed PAN", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "NOTAPAN", validFrom: "2020-04-01" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidIdentifier);
  });

  it("rejects a 14-char GSTIN but accepts a 15-char one", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "gstin", value: "27ABCDE1234F1Z", validFrom: "2020-04-01" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidIdentifier);
    const ok = await service.addIdentifier({
      tenantId: TENANT, partyId, type: "gstin", value: "27ABCDE1234F1Z5", validFrom: "2020-04-01",
    }, ACTOR);
    expect(ok.value).toBe("27ABCDE1234F1Z5");
  });

  it("rejects a duplicate identifier within the tenant", async () => {
    const { service, partyId } = await withOrg();
    await service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "ABCDE1234F", validFrom: "2020-04-01" }, ACTOR);
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "abcde1234f", validFrom: "2021-04-01" }, ACTOR),
    ).rejects.toBeInstanceOf(DuplicateIdentifier);
  });

  it("rejects an inverted date range", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({
        tenantId: TENANT, partyId, type: "pan", value: "ABCDE1234F",
        validFrom: "2021-04-01", validTo: "2020-04-01",
      }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidDateRange);
  });

  it("rejects an identifier on a party that does not exist", async () => {
    const { service } = svc();
    await expect(
      service.addIdentifier({
        tenantId: TENANT, partyId: "22222222-2222-2222-2222-222222222222",
        type: "pan", value: "ABCDE1234F", validFrom: "2020-04-01",
      }, ACTOR),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });

  it("findByIdentifier matches on the normalised value (the dedup key)", async () => {
    const { service, partyId } = await withOrg();
    await service.addIdentifier({ tenantId: TENANT, partyId, type: "email", value: "Info@Acme.COM", validFrom: "2020-04-01" }, ACTOR);
    const hit = await service.findByIdentifier(TENANT, "email", "info@acme.com");
    expect(hit?.partyId).toBe(partyId);
  });
});

describe("addRelationship", () => {
  async function twoParties() {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" }, ACTOR);
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    return { service, orgId: org.partyId, personId: person.partyId };
  }

  it("records a director relationship", async () => {
    const { service, orgId, personId } = await twoParties();
    const rel = await service.addRelationship({
      tenantId: TENANT,
      fromPartyId: personId,
      toPartyId: orgId,
      type: "director_of",
      validFrom: "2021-04-01",
      attributes: { din: "01234567" },
    }, ACTOR);
    expect(rel.type).toBe("director_of");
    expect(rel.attributes.din).toBe("01234567");
  });

  it("rejects a self-relationship", async () => {
    const { service, orgId } = await twoParties();
    await expect(
      service.addRelationship({ tenantId: TENANT, fromPartyId: orgId, toPartyId: orgId, type: "parent_of", validFrom: "2021-04-01" }, ACTOR),
    ).rejects.toBeInstanceOf(SelfRelationship);
  });

  it("rejects an unknown relationship type", async () => {
    const { service, orgId, personId } = await twoParties();
    await expect(
      service.addRelationship({ tenantId: TENANT, fromPartyId: personId, toPartyId: orgId, type: "wizard_of", validFrom: "2021-04-01" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidRelationshipType);
  });

  it("rejects a relationship whose party is missing", async () => {
    const { service, orgId } = await twoParties();
    await expect(
      service.addRelationship({
        tenantId: TENANT, fromPartyId: "33333333-3333-3333-3333-333333333333",
        toPartyId: orgId, type: "director_of", validFrom: "2021-04-01",
      }, ACTOR),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });
});

describe("endRelationship", () => {
  /**
   * The verb `party_relationship.ended` was in the ledger vocabulary with
   * nothing raising it. These are the four things that can happen to a firm
   * closing a directorship, and the fourth is the one a screen cannot prevent.
   */
  async function openDirectorship() {
    const { service, events } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" }, ACTOR);
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    const rel = await service.addRelationship({
      tenantId: TENANT,
      fromPartyId: person.partyId,
      toPartyId: org.partyId,
      type: "director_of",
      validFrom: "2021-04-01",
    }, ACTOR);
    return { service, events, rel };
  }

  it("closes an open relationship on the day given, and says so in the ledger", async () => {
    const { service, events, rel } = await openDirectorship();
    const ended = await service.endRelationship(
      { tenantId: TENANT, relationshipId: rel.id, validTo: "2026-08-12" },
      ACTOR,
    );
    expect(ended.validTo).toBe("2026-08-12");
    expect(events.verbs()).toContain("party_relationship.ended");
    const last = events.recorded[events.recorded.length - 1];
    expect(last?.objectId).toBe(rel.id);
    // The payload carries BOTH dates: a reader of the log should not have to
    // fetch the row to know how long the relationship ran.
    expect(last?.payload).toMatchObject({ validFrom: "2021-04-01", validTo: "2026-08-12" });
    // And no name. The ledger carries ids and dates; who Priya is belongs to
    // the party record.
    expect(JSON.stringify(events.recorded)).not.toContain("Priya Menon");
  });

  it("refuses a relationship that has already ended, and does not move the date", async () => {
    const { service, events, rel } = await openDirectorship();
    await service.endRelationship(
      { tenantId: TENANT, relationshipId: rel.id, validTo: "2026-08-12" },
      ACTOR,
    );
    await expect(
      service.endRelationship(
        { tenantId: TENANT, relationshipId: rel.id, validTo: "2026-09-01" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(RelationshipAlreadyEnded);
    // ONE `ended` event, not two. A log that says a relationship ended twice on
    // two different days cannot be corrected.
    expect(events.verbs().filter((v) => v === "party_relationship.ended")).toHaveLength(1);
  });

  it("refuses an end date that is not after the day it began, and names the day", async () => {
    const { service, rel } = await openDirectorship();
    // NOT `InvalidDateRange`. That message reads back both of the caller's own
    // dates, which is right for the form that sends both and useless to
    // somebody who typed one — measured on the screen before this error existed.
    const refusal = await service
      .endRelationship({ tenantId: TENANT, relationshipId: rel.id, validTo: "2021-04-01" }, ACTOR)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(RelationshipEndsBeforeItBegan);
    expect((refusal as Error).message).toContain("2021-04-01");
    expect((refusal as Error).message).toContain("began");
  });

  it("refuses an unknown relationship", async () => {
    const { service } = await openDirectorship();
    await expect(
      service.endRelationship(
        {
          tenantId: TENANT,
          relationshipId: "44444444-4444-4444-4444-444444444444",
          validTo: "2026-08-12",
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(RelationshipNotFound);
  });

  it("refuses another tenant's relationship rather than closing it", async () => {
    const { service, rel } = await openDirectorship();
    await expect(
      service.endRelationship(
        {
          tenantId: "22222222-2222-2222-2222-222222222222",
          relationshipId: rel.id,
          validTo: "2026-08-12",
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(RelationshipNotFound);
  });
});

describe("partyProfile (the compliance as-of question)", () => {
  it("filters relationships to those in force on the as-of date", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" }, ACTOR);
    const a = await service.createPerson({ tenantId: TENANT, fullName: "Director A" }, ACTOR);
    const b = await service.createPerson({ tenantId: TENANT, fullName: "Director B" }, ACTOR);
    // A served 2020-04-01 .. 2022-03-31; B is open-ended from 2022-04-01.
    await service.addRelationship({ tenantId: TENANT, fromPartyId: a.partyId, toPartyId: org.partyId, type: "director_of", validFrom: "2020-04-01", validTo: "2022-04-01" }, ACTOR);
    await service.addRelationship({ tenantId: TENANT, fromPartyId: b.partyId, toPartyId: org.partyId, type: "director_of", validFrom: "2022-04-01" }, ACTOR);

    const on2021 = await service.partyProfile(TENANT, org.partyId, "2021-03-31");
    expect(on2021.relationships.map((r) => r.relationship.fromPartyId)).toEqual([a.partyId]);

    const on2023 = await service.partyProfile(TENANT, org.partyId, "2023-03-31");
    expect(on2023.relationships.map((r) => r.relationship.fromPartyId)).toEqual([b.partyId]);

    const all = await service.partyProfile(TENANT, org.partyId);
    expect(all.relationships).toHaveLength(2);
  });

  it("names the party at the other end, rather than handing a screen a uuid", async () => {
    // The fifth time this codebase has learnt it: an aggregate carries ids,
    // which is right for the aggregate and useless for anything that has to
    // SHOW it. `director_of -> 2b9d5209-…` is what the screen rendered before.
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Meridian" }, ACTOR);
    const priya = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    await service.addRelationship(
      {
        tenantId: TENANT,
        fromPartyId: priya.partyId,
        toPartyId: org.partyId,
        type: "director_of",
        validFrom: "2020-04-01",
      },
      ACTOR,
    );

    // Read from the person's end: outgoing, and the counterparty is the company.
    const hers = await service.partyProfile(TENANT, priya.partyId);
    expect(hers.relationships[0]?.counterparty.displayName).toBe("Meridian");
    expect(hers.relationships[0]?.direction).toBe("outgoing");

    // The same row read from the company's end is the other way round. Both
    // sentences are true and a screen has to know which one it is writing.
    const theirs = await service.partyProfile(TENANT, org.partyId);
    expect(theirs.relationships[0]?.counterparty.displayName).toBe("Priya Menon");
    expect(theirs.relationships[0]?.direction).toBe("incoming");
  });

  it("carries the subtype detail and the legal entities the create form captured", async () => {
    // Both were write-only until a screen had to render them: the legal name,
    // trade name and industry were reachable nowhere, and registerLegalEntity
    // had no counterpart at all. A write with no read is not a stored fact.
    const { service } = svc();
    const org = await service.createOrganization(
      { tenantId: TENANT, legalName: "Meridian Textiles Private Limited", tradeName: "Meridian", industry: "textiles" },
      ACTOR,
    );
    await service.registerLegalEntity(
      {
        tenantId: TENANT,
        organizationPartyId: org.partyId,
        jurisdiction: "IN",
        entityType: "private_limited",
      },
      ACTOR,
    );

    const profile = await service.partyProfile(TENANT, org.partyId);
    expect(profile.organization?.legalName).toBe("Meridian Textiles Private Limited");
    expect(profile.organization?.industry).toBe("textiles");
    expect(profile.legalEntities).toHaveLength(1);
    expect(profile.legalEntities[0]?.jurisdiction).toBe("IN");
    // A person's slot is empty on an organization, and vice versa — exactly one
    // is set, by kind.
    expect(profile.person).toBeNull();

    const priya = await service.createPerson(
      { tenantId: TENANT, fullName: "Priya Menon", nationality: "IN" },
      ACTOR,
    );
    const hers = await service.partyProfile(TENANT, priya.partyId);
    expect(hers.person?.nationality).toBe("IN");
    expect(hers.organization).toBeNull();
    expect(hers.legalEntities).toEqual([]);
  });

  it("throws for a missing party", async () => {
    const { service } = svc();
    await expect(
      service.partyProfile(TENANT, "44444444-4444-4444-4444-444444444444"),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });
});


/**
 * Archiving — and the fact that there is no delete to test.
 *
 * `core` has no `deleted_at` and `bib_app` holds no DELETE grant on any core
 * table, so "remove this party" is not a thing this service can be asked to do.
 * `archived_at` means only "keep this out of the pickers", and the two rules
 * below are the whole of what the SERVICE owns:
 *
 *   · the state machine — the party exists, and is not already in the state
 *     being asked for;
 *   · the event, written after the change and never before it.
 *
 * THE REFUSAL ITSELF IS THE DATABASE'S (migration 0035's trigger). What is
 * asserted here is that the service surfaces it and records nothing when it
 * fires; that it actually holds is proved against real Postgres, with raw SQL
 * that never touches this code, in tests/party/archive.integration.test.ts.
 */
describe("archiving a party", () => {
  it("hides it from the list, and still resolves it by id", async () => {
    // The asymmetry is the entire design. A list is a picker; a document
    // pointing at this id has to render its counterparty either way.
    const { service } = svc();
    const org = await service.createOrganization(
      { tenantId: TENANT, legalName: "Dormant Holdings Private Limited" },
      ACTOR,
    );
    const live = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);

    const archived = await service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);
    expect(archived.archivedAt).not.toBeNull();

    const list = await service.listParties(TENANT, false);
    expect(list.map((p) => p.id)).toEqual([live.partyId]);

    // Still there, still readable, still carrying its whole profile.
    const profile = await service.partyProfile(TENANT, org.partyId);
    expect(profile.party.id).toBe(org.partyId);
    expect(profile.party.archivedAt).toBe(archived.archivedAt);
    expect(profile.organization?.legalName).toBe("Dormant Holdings Private Limited");
  });

  it("includes archived parties when the caller asks for them", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);
    await service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);

    expect(await service.listParties(TENANT, false)).toHaveLength(0);
    expect(await service.listParties(TENANT, true)).toHaveLength(1);
  });

  it("brings one back, and the list has it again", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);
    await service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);
    const restored = await service.unarchiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);

    expect(restored.archivedAt).toBeNull();
    expect(await service.listParties(TENANT, false)).toHaveLength(1);
  });

  it("refuses to archive twice, and to restore what is not archived", async () => {
    // Both are "the party is not in the state this call assumed" — a 409, not a
    // quiet success that leaves the caller believing something else happened.
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);

    await expect(
      service.unarchiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR),
    ).rejects.toBeInstanceOf(PartyNotArchived);

    await service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);
    await expect(
      service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR),
    ).rejects.toBeInstanceOf(PartyAlreadyArchived);
  });

  it("refuses both actions for a party that does not exist", async () => {
    const { service } = svc();
    const missing = "44444444-4444-4444-4444-444444444444";
    await expect(
      service.archiveParty({ tenantId: TENANT, partyId: missing }, ACTOR),
    ).rejects.toBeInstanceOf(PartyNotFound);
    await expect(
      service.unarchiveParty({ tenantId: TENANT, partyId: missing }, ACTOR),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });

  it("surfaces the database's refusal, naming what refers to the party", async () => {
    const { service, fakes } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);
    const parties = fakes.parties as FakePartyRepo;
    parties.referrers.set(org.partyId, ["a lead", "an engagement letter"]);

    const err = await service
      .archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartyHasReferences);
    expect((err as PartyHasReferences).referrers).toEqual(["a lead", "an engagement letter"]);
    // Refused means unchanged: it is still in the picker.
    expect(await service.listParties(TENANT, false)).toHaveLength(1);
  });

  it("records archive and unarchive with the actor, and nothing when refused", async () => {
    const { service, events, fakes } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" }, ACTOR);
    const archived = await service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);
    await service.unarchiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR);

    expect(events.verbs()).toEqual(["party.created", "party.archived", "party.unarchived"]);
    const [, archivedEvent, restoredEvent] = events.recorded;
    expect(archivedEvent?.objectType).toBe("party");
    expect(archivedEvent?.objectId).toBe(org.partyId);
    expect(archivedEvent?.actorId).toBe(ACTOR.id);
    // Ids and machine facts only — never the display name, which for a person
    // party IS their name, in a log that can never be erased.
    expect(archivedEvent?.payload).toEqual({ kind: "organization" });
    // Unarchiving closes the interval the archive opened, without a join.
    expect(restoredEvent?.payload).toEqual({
      kind: "organization",
      archivedAt: archived.archivedAt,
    });

    // A refused archive records nothing at all.
    const parties = fakes.parties as FakePartyRepo;
    parties.referrers.set(org.partyId, ["a proposal"]);
    await expect(
      service.archiveParty({ tenantId: TENANT, partyId: org.partyId }, ACTOR),
    ).rejects.toBeInstanceOf(PartyHasReferences);
    expect(events.verbs()).toEqual(["party.created", "party.archived", "party.unarchived"]);
  });

  it("keeps a person's name out of the archive events", async () => {
    const { service, events } = svc();
    const priya = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    await service.archiveParty({ tenantId: TENANT, partyId: priya.partyId }, ACTOR);
    await service.unarchiveParty({ tenantId: TENANT, partyId: priya.partyId }, ACTOR);
    expect(JSON.stringify(events.recorded)).not.toContain("Priya Menon");
  });
});

describe("the audit trail", () => {
  it("records one event per write, naming the actor", async () => {
    const { service, events } = svc();
    const org = await service.createOrganization(
      { tenantId: TENANT, legalName: "Harbour Point Advisory Private Limited" },
      ACTOR,
    );
    await service.registerLegalEntity(
      { tenantId: TENANT, organizationPartyId: org.partyId, jurisdiction: "IN", entityType: "private_limited" },
      ACTOR,
    );
    await service.addIdentifier(
      { tenantId: TENANT, partyId: org.partyId, type: "pan", value: "ABCDE1234F", validFrom: "2020-01-01" },
      ACTOR,
    );
    const director = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    await service.addRelationship(
      {
        tenantId: TENANT,
        fromPartyId: director.partyId,
        toPartyId: org.partyId,
        type: "director_of",
        validFrom: "2020-04-01",
      },
      ACTOR,
    );

    expect(events.verbs()).toEqual([
      "party.created",
      "legal_entity.registered",
      "party_identifier.added",
      "party.created",
      "party_relationship.recorded",
    ]);
    for (const event of events.recorded) {
      expect(event.actorType).toBe("human");
      expect(event.actorId).toBe(ACTOR.id);
      expect(event.tenantId).toBe(TENANT);
    }
  });

  it("names the object the event is about", async () => {
    const { service, events } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" }, ACTOR);
    const [created] = events.recorded;
    expect(created?.objectId).toBe(org.partyId);
    expect(created?.objectType).toBe("party");
  });

  it("keeps personal data out of the payload", async () => {
    const { service, events } = svc();
    // A person's name and an identifier's value are both personal data, and the
    // ledger cannot be erased — so the events carry the KIND and the row id.
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" }, ACTOR);
    await service.addIdentifier(
      { tenantId: TENANT, partyId: person.partyId, type: "pan", value: "ABCDE1234F", validFrom: "2020-01-01" },
      ACTOR,
    );

    const serialised = JSON.stringify(events.recorded);
    expect(serialised).not.toContain("Priya Menon");
    expect(serialised).not.toContain("ABCDE1234F");
    expect(events.recorded[1]?.payload).toEqual({
      partyId: person.partyId,
      identifierType: "pan",
    });
  });

  it("records nothing when the write is refused", async () => {
    const { service, events } = svc();
    await expect(
      service.createPerson({ tenantId: TENANT, fullName: "Priya" }, ACTOR).then(() =>
        service.addRelationship(
          {
            tenantId: TENANT,
            fromPartyId: "00000000-0000-4000-8000-000000000001",
            toPartyId: "00000000-0000-4000-8000-000000000001",
            type: "director_of",
            validFrom: "2020-04-01",
          },
          ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(SelfRelationship);
    // The person was created and recorded; the refused relationship was not.
    expect(events.verbs()).toEqual(["party.created"]);
  });
});
