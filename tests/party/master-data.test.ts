// Correcting a client's master data (V2.5): the name, the company facts, and
// an identifier typed wrong, against the in-memory fakes. The SQL half (the
// duplicate check reading only OPEN identifiers, the voided row's freeze) is
// `master-data.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { PartyService } from "../../src/usecase/party/service";
import { makePartyFakes } from "../../src/testfakes/party";
import type { RecordingEventSink } from "../../src/testfakes/ledger";
import type { Actor } from "../../src/domain/ledger/model";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PARTNER: Actor = { type: "human", id: "22222222-2222-2222-2222-222222222222" };

async function world() {
  const deps = makePartyFakes();
  const service = new PartyService(deps);
  const events = deps.events as RecordingEventSink;
  const org = await service.createOrganization(
    { tenantId: TENANT, legalName: "Kaveri Fods Private Limited", tradeName: "Kaveri Fods" },
    PARTNER,
  );
  return { service, events, org };
}

describe("correcting a client's name and company facts (V2.5)", () => {
  it("renames it, names the fields that changed, and never their values", async () => {
    const w = await world();
    const updated = await w.service.updateParty(
      { tenantId: TENANT, partyId: w.org.partyId, displayName: " Kaveri Foods ", tradeName: "Kaveri Foods", industry: "Food" },
      PARTNER,
    );
    expect(updated.displayName).toBe("Kaveri Foods");
    const event = w.events.recorded.at(-1);
    expect(event?.verb).toBe("party.updated");
    expect(event?.payload).toEqual({ fields: ["displayName", "tradeName", "industry"] });
    expect(JSON.stringify(event)).not.toContain("Kaveri");
  });

  it("refuses a blank name, and a correction that changes nothing", async () => {
    const w = await world();
    await expect(
      w.service.updateParty({ tenantId: TENANT, partyId: w.org.partyId, displayName: "   " }, PARTNER),
    ).rejects.toMatchObject({ code: "INVALID_PARTY_DETAILS" });
    await expect(
      w.service.updateParty({ tenantId: TENANT, partyId: w.org.partyId, displayName: "Kaveri Fods" }, PARTNER),
    ).rejects.toMatchObject({ code: "NOTHING_TO_CHANGE" });
  });

  it("corrects a registered company's country and kind", async () => {
    const w = await world();
    await w.service.registerLegalEntity(
      { tenantId: TENANT, organizationPartyId: w.org.partyId, jurisdiction: "AE", entityType: "fzco", financialYearEnd: "12-31" },
      PARTNER,
    );
    const fixed = await w.service.correctLegalEntity(
      { tenantId: TENANT, partyId: w.org.partyId, jurisdiction: "in", entityType: "private_limited" },
      PARTNER,
    );
    // Moved into India: the year end becomes India's fixed 31 March (Q076).
    expect(fixed).toMatchObject({ jurisdiction: "IN", entityType: "private_limited", financialYearEnd: "03-31" });
    expect(w.events.recorded.at(-1)?.payload).toMatchObject({ fields: ["jurisdiction", "entityType", "financialYearEnd"] });
    await expect(
      w.service.correctLegalEntity({ tenantId: TENANT, partyId: w.org.partyId, jurisdiction: "India" }, PARTNER),
    ).rejects.toMatchObject({ code: "INVALID_PARTY_DETAILS" });
  });

  it("asks for a year end when a company moves out of India, and records one on its own (Q076)", async () => {
    const w = await world();
    await w.service.registerLegalEntity(
      { tenantId: TENANT, organizationPartyId: w.org.partyId, jurisdiction: "IN", entityType: "private_limited" },
      PARTNER,
    );
    await expect(
      w.service.correctLegalEntity({ tenantId: TENANT, partyId: w.org.partyId, jurisdiction: "AE" }, PARTNER),
    ).rejects.toMatchObject({ code: "INVALID_PARTY_DETAILS" });
    const moved = await w.service.correctLegalEntity(
      { tenantId: TENANT, partyId: w.org.partyId, jurisdiction: "AE", financialYearEnd: "12-31" },
      PARTNER,
    );
    expect(moved).toMatchObject({ jurisdiction: "AE", financialYearEnd: "12-31" });
    const yearOnly = await w.service.correctLegalEntity(
      { tenantId: TENANT, partyId: w.org.partyId, financialYearEnd: "06-30" },
      PARTNER,
    );
    expect(yearOnly.financialYearEnd).toBe("06-30");
    expect(w.events.recorded.at(-1)?.payload).toMatchObject({ fields: ["financialYearEnd"], financialYearEnd: "06-30" });
  });
});

describe("an identifier typed wrong (V2.5)", () => {
  it("a mistyped PAN is voided, and the right one can then be added with no duplicate refusal", async () => {
    const w = await world();
    const other = await w.service.createOrganization({ tenantId: TENANT, legalName: "Lotus Retail" }, PARTNER);
    // The PAN went on the wrong client.
    const wrong = await w.service.addIdentifier(
      { tenantId: TENANT, partyId: other.partyId, type: "pan", value: "AAACK1234F", validFrom: "2026-04-01" },
      PARTNER,
    );
    await expect(
      w.service.addIdentifier(
        { tenantId: TENANT, partyId: w.org.partyId, type: "pan", value: "AAACK1234F", validFrom: "2026-04-01" },
        PARTNER,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_IDENTIFIER" });

    const voided = await w.service.voidIdentifier(
      { tenantId: TENANT, partyId: other.partyId, identifierId: wrong.id },
      PARTNER,
    );
    expect(voided.voidedAt).not.toBeNull();
    const event = w.events.recorded.at(-1);
    expect(event).toMatchObject({ verb: "party_identifier.voided" });
    expect(event?.payload).toEqual({ partyId: other.partyId, identifierType: "pan" });

    const right = await w.service.addIdentifier(
      { tenantId: TENANT, partyId: w.org.partyId, type: "pan", value: "AAACK1234F", validFrom: "2026-04-01" },
      PARTNER,
    );
    expect(right.partyId).toBe(w.org.partyId);
    // Voided is final.
    await expect(
      w.service.voidIdentifier({ tenantId: TENANT, partyId: other.partyId, identifierId: wrong.id }, PARTNER),
    ).rejects.toMatchObject({ code: "IDENTIFIER_CLOSED" });
  });

  it("an ended GSTIN frees its value too, and cannot end twice or end before it began", async () => {
    const w = await world();
    const gstin = await w.service.addIdentifier(
      { tenantId: TENANT, partyId: w.org.partyId, type: "gstin", value: "27AAACK1234F1Z5", validFrom: "2026-04-01" },
      PARTNER,
    );
    await expect(
      w.service.endIdentifier(
        { tenantId: TENANT, partyId: w.org.partyId, identifierId: gstin.id, validTo: "2026-03-01" },
        PARTNER,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
    const ended = await w.service.endIdentifier(
      { tenantId: TENANT, partyId: w.org.partyId, identifierId: gstin.id, validTo: "2026-09-30" },
      PARTNER,
    );
    expect(ended.validTo).toBe("2026-09-30");
    expect(w.events.recorded.at(-1)?.payload).toEqual({
      partyId: w.org.partyId,
      identifierType: "gstin",
      validTo: "2026-09-30",
    });
    await expect(
      w.service.endIdentifier(
        { tenantId: TENANT, partyId: w.org.partyId, identifierId: gstin.id, validTo: "2026-10-31" },
        PARTNER,
      ),
    ).rejects.toMatchObject({ code: "IDENTIFIER_CLOSED" });
    // Not this client's identifier: not found, whatever its id.
    await expect(
      w.service.voidIdentifier({ tenantId: TENANT, partyId: TENANT, identifierId: gstin.id }, PARTNER),
    ).rejects.toMatchObject({ code: "IDENTIFIER_NOT_FOUND" });
  });
});

describe("a client's billing address (audit 2026-10-03, CA#22)", () => {
  // Clients had no address anywhere, so an invoice's "Billed to" said a name
  // and nothing else. One shape with the firm's own registered address: the
  // printed lines, then the state, the postal code and the country.
  it("records it, tidied, for a company or a person, and names the field, never the address", async () => {
    const w = await world();
    const updated = await w.service.updateParty(
      {
        tenantId: TENANT,
        partyId: w.org.partyId,
        billingAddress: { lines: [" Plot 4, MIDC Bhosari ", "  "], region: "Maharashtra", postalCode: "411026", country: "in" },
      },
      PARTNER,
    );
    expect(updated.billingAddress).toEqual({
      lines: ["Plot 4, MIDC Bhosari"],
      region: "Maharashtra",
      postalCode: "411026",
      country: "IN",
    });
    const event = w.events.recorded.at(-1);
    expect(event?.payload).toEqual({ fields: ["billingAddress"] });
    expect(JSON.stringify(event)).not.toMatch(/MIDC|Maharashtra|411026/);
  });

  it("clears it with null, and refuses one with no line or a country that is not one", async () => {
    const w = await world();
    await w.service.updateParty(
      { tenantId: TENANT, partyId: w.org.partyId, billingAddress: { lines: ["Plot 4"], country: "IN" } },
      PARTNER,
    );
    const cleared = await w.service.updateParty(
      { tenantId: TENANT, partyId: w.org.partyId, billingAddress: null },
      PARTNER,
    );
    expect(cleared.billingAddress).toBeNull();
    await expect(
      w.service.updateParty(
        { tenantId: TENANT, partyId: w.org.partyId, billingAddress: { lines: [], region: "Maharashtra" } },
        PARTNER,
      ),
    ).rejects.toThrow(/at least one line/);
    await expect(
      w.service.updateParty(
        { tenantId: TENANT, partyId: w.org.partyId, billingAddress: { lines: ["Plot 4"], country: "India" } },
        PARTNER,
      ),
    ).rejects.toThrow(/country from the list/);
  });
});
