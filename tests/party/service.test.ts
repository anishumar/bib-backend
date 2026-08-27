import { describe, expect, it } from "vitest";
import { PartyService } from "../../src/usecase/party/service";
import { makePartyFakes } from "../../src/testfakes/party";
import {
  DuplicateIdentifier,
  InvalidDateRange,
  InvalidIdentifier,
  InvalidRelationshipType,
  NotAnOrganization,
  PartyNotFound,
  SelfRelationship,
} from "../../src/domain/party/errors";

const TENANT = "11111111-1111-1111-1111-111111111111";

function svc() {
  const fakes = makePartyFakes();
  return { service: new PartyService(fakes), fakes };
}

describe("createOrganization", () => {
  it("creates an organization party; display name prefers the trade name", async () => {
    const { service } = svc();
    const org = await service.createOrganization({
      tenantId: TENANT,
      legalName: "Harbour Point Advisory Private Limited",
      tradeName: "Harbour Point",
    });
    expect(org.legalName).toBe("Harbour Point Advisory Private Limited");
    const parties = await service.listParties(TENANT);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.displayName).toBe("Harbour Point");
    expect(parties[0]?.kind).toBe("organization");
  });

  it("falls back to the legal name when there is no trade name", async () => {
    const { service } = svc();
    await service.createOrganization({ tenantId: TENANT, legalName: "Acme LLP" });
    const [party] = await service.listParties(TENANT);
    expect(party?.displayName).toBe("Acme LLP");
  });
});

describe("registerLegalEntity", () => {
  it("registers against an organization and upper-cases the jurisdiction", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme Pte Ltd" });
    const entity = await service.registerLegalEntity({
      tenantId: TENANT,
      organizationPartyId: org.partyId,
      jurisdiction: "sg",
      entityType: "pte_ltd",
    });
    expect(entity.jurisdiction).toBe("SG");
    expect(entity.status).toBe("active");
  });

  it("refuses to register against a person", async () => {
    const { service } = svc();
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" });
    await expect(
      service.registerLegalEntity({
        tenantId: TENANT,
        organizationPartyId: person.partyId,
        jurisdiction: "IN",
        entityType: "private_limited",
      }),
    ).rejects.toBeInstanceOf(NotAnOrganization);
  });
});

describe("addIdentifier", () => {
  async function withOrg() {
    const { service, fakes } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" });
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
    });
    expect(id.value).toBe("ABCDE1234F");
  });

  it("rejects a malformed PAN", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "NOTAPAN", validFrom: "2020-04-01" }),
    ).rejects.toBeInstanceOf(InvalidIdentifier);
  });

  it("rejects a 14-char GSTIN but accepts a 15-char one", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "gstin", value: "27ABCDE1234F1Z", validFrom: "2020-04-01" }),
    ).rejects.toBeInstanceOf(InvalidIdentifier);
    const ok = await service.addIdentifier({
      tenantId: TENANT, partyId, type: "gstin", value: "27ABCDE1234F1Z5", validFrom: "2020-04-01",
    });
    expect(ok.value).toBe("27ABCDE1234F1Z5");
  });

  it("rejects a duplicate identifier within the tenant", async () => {
    const { service, partyId } = await withOrg();
    await service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "ABCDE1234F", validFrom: "2020-04-01" });
    await expect(
      service.addIdentifier({ tenantId: TENANT, partyId, type: "pan", value: "abcde1234f", validFrom: "2021-04-01" }),
    ).rejects.toBeInstanceOf(DuplicateIdentifier);
  });

  it("rejects an inverted date range", async () => {
    const { service, partyId } = await withOrg();
    await expect(
      service.addIdentifier({
        tenantId: TENANT, partyId, type: "pan", value: "ABCDE1234F",
        validFrom: "2021-04-01", validTo: "2020-04-01",
      }),
    ).rejects.toBeInstanceOf(InvalidDateRange);
  });

  it("rejects an identifier on a party that does not exist", async () => {
    const { service } = svc();
    await expect(
      service.addIdentifier({
        tenantId: TENANT, partyId: "22222222-2222-2222-2222-222222222222",
        type: "pan", value: "ABCDE1234F", validFrom: "2020-04-01",
      }),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });

  it("findByIdentifier matches on the normalised value (the dedup key)", async () => {
    const { service, partyId } = await withOrg();
    await service.addIdentifier({ tenantId: TENANT, partyId, type: "email", value: "Info@Acme.COM", validFrom: "2020-04-01" });
    const hit = await service.findByIdentifier(TENANT, "email", "info@acme.com");
    expect(hit?.partyId).toBe(partyId);
  });
});

describe("addRelationship", () => {
  async function twoParties() {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" });
    const person = await service.createPerson({ tenantId: TENANT, fullName: "Priya Menon" });
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
    });
    expect(rel.type).toBe("director_of");
    expect(rel.attributes.din).toBe("01234567");
  });

  it("rejects a self-relationship", async () => {
    const { service, orgId } = await twoParties();
    await expect(
      service.addRelationship({ tenantId: TENANT, fromPartyId: orgId, toPartyId: orgId, type: "parent_of", validFrom: "2021-04-01" }),
    ).rejects.toBeInstanceOf(SelfRelationship);
  });

  it("rejects an unknown relationship type", async () => {
    const { service, orgId, personId } = await twoParties();
    await expect(
      service.addRelationship({ tenantId: TENANT, fromPartyId: personId, toPartyId: orgId, type: "wizard_of", validFrom: "2021-04-01" }),
    ).rejects.toBeInstanceOf(InvalidRelationshipType);
  });

  it("rejects a relationship whose party is missing", async () => {
    const { service, orgId } = await twoParties();
    await expect(
      service.addRelationship({
        tenantId: TENANT, fromPartyId: "33333333-3333-3333-3333-333333333333",
        toPartyId: orgId, type: "director_of", validFrom: "2021-04-01",
      }),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });
});

describe("partyProfile (the compliance as-of question)", () => {
  it("filters relationships to those in force on the as-of date", async () => {
    const { service } = svc();
    const org = await service.createOrganization({ tenantId: TENANT, legalName: "Acme" });
    const a = await service.createPerson({ tenantId: TENANT, fullName: "Director A" });
    const b = await service.createPerson({ tenantId: TENANT, fullName: "Director B" });
    // A served 2020-04-01 .. 2022-03-31; B is open-ended from 2022-04-01.
    await service.addRelationship({ tenantId: TENANT, fromPartyId: a.partyId, toPartyId: org.partyId, type: "director_of", validFrom: "2020-04-01", validTo: "2022-04-01" });
    await service.addRelationship({ tenantId: TENANT, fromPartyId: b.partyId, toPartyId: org.partyId, type: "director_of", validFrom: "2022-04-01" });

    const on2021 = await service.partyProfile(TENANT, org.partyId, "2021-03-31");
    expect(on2021.relationships.map((r) => r.fromPartyId)).toEqual([a.partyId]);

    const on2023 = await service.partyProfile(TENANT, org.partyId, "2023-03-31");
    expect(on2023.relationships.map((r) => r.fromPartyId)).toEqual([b.partyId]);

    const all = await service.partyProfile(TENANT, org.partyId);
    expect(all.relationships).toHaveLength(2);
  });

  it("throws for a missing party", async () => {
    const { service } = svc();
    await expect(
      service.partyProfile(TENANT, "44444444-4444-4444-4444-444444444444"),
    ).rejects.toBeInstanceOf(PartyNotFound);
  });
});
