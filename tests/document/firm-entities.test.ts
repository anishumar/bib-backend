// T6.18 · the firm's own companies, against in-memory ports.
//
// What is proven here: the one default-currency table, the address shape, and
// the service's refusals — a country another company issues for, a company
// that would move country, a party that is not one of ours. The single
// transaction (party + organization + legal entity + preference) runs against
// Postgres in firm-entities.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  defaultCurrencyFor,
  readRegisteredAddress,
  registeredAddressProblem,
} from "../../src/domain/document/model";
import { makeFirmEntityFakes, SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";
import {
  CountryAlreadyServed,
  FirmEntityNotFound,
  InvalidFirmEntity,
  JurisdictionFixed,
  NotAFirmEntity,
  NothingToChangeOnEntity,
  InvalidCompanyTimeZone,
  InvalidCompanyYearStart,
  CompanyNotRegistered,
} from "../../src/domain/document/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const CLIENT = "00000000-0000-0000-0000-0000000000bb";

describe("defaultCurrencyFor — the one copy of D1's table", () => {
  it("maps the four countries the firm is registered in", () => {
    expect(defaultCurrencyFor("IN", "INR")).toBe("INR");
    expect(defaultCurrencyFor("AE", "INR")).toBe("AED");
    expect(defaultCurrencyFor("SG", "INR")).toBe("SGD");
    expect(defaultCurrencyFor("US", "INR")).toBe("USD");
  });
  it("falls back to the firm's reporting currency for any other country, or none", () => {
    expect(defaultCurrencyFor("GB", "INR")).toBe("INR");
    expect(defaultCurrencyFor(null, "AED")).toBe("AED");
  });
});

describe("the registered address, { lines: string[] }", () => {
  it("reads the shape back and nothing else", () => {
    expect(readRegisteredAddress({ lines: ["605 Geddes Street", "Wilmington"] })).toEqual({
      lines: ["605 Geddes Street", "Wilmington"],
    });
    expect(readRegisteredAddress({ street: "605 Geddes Street" })).toBeNull();
    expect(readRegisteredAddress({ lines: [1, 2] })).toBeNull();
    expect(readRegisteredAddress(null)).toBeNull();
  });
  it("holds it to eight lines of two hundred characters", () => {
    expect(registeredAddressProblem({ lines: ["a"] })).toBeNull();
    expect(registeredAddressProblem({ lines: [] })).toMatch(/at least one line/);
    expect(registeredAddressProblem({ lines: Array(9).fill("a") })).toMatch(/at most 8 lines/);
    expect(registeredAddressProblem({ lines: ["a".repeat(201)] })).toMatch(/200 characters/);
  });
});

describe("the firm's own companies (T6.18)", () => {
  it("lists them with the reporting currency and each one's default currency", async () => {
    const f = makeFirmEntityFakes();
    f.firmEntities.reportingCurrencyCode = "AED";
    const { reportingCurrency, entities } = await f.service.list(TENANT);
    expect(reportingCurrency).toBe("AED");
    // The firm itself, registered nowhere: the reporting currency.
    expect(entities[0]).toMatchObject({ partyId: SEEDED_FIRM_ENTITY, isFirmSelf: true, defaultCurrency: "AED" });
  });

  it("creates one for its own country, with the three events the three writes record", async () => {
    const f = makeFirmEntityFakes();
    const created = await f.service.create(
      {
        tenantId: TENANT,
        name: "  EPB USA Inc  ",
        jurisdiction: "us",
        entityType: "Inc.",
        registeredAddress: { lines: ["605 Geddes Street", "  ", "Wilmington, Delaware 19805", "USA"] },
      },
      ACTOR,
    );
    expect(created).toMatchObject({
      name: "EPB USA Inc",
      jurisdiction: "US",
      entityType: "Inc.",
      registeredAddress: { lines: ["605 Geddes Street", "Wilmington, Delaware 19805", "USA"] },
      routedCountries: ["US"],
      isFallback: false,
      defaultCurrency: "USD",
    });
    expect(f.events.verbs()).toEqual([
      "party.created",
      "legal_entity.registered",
      "firm_entity_preference.set",
    ]);
    expect(f.events.recorded[2]?.payload).toEqual({
      clientJurisdiction: "US",
      firmEntityPartyId: created.partyId,
      isFallback: false,
    });
  });

  it("refuses a country another of the firm's companies already issues for", async () => {
    const f = makeFirmEntityFakes();
    await f.service.create({ tenantId: TENANT, name: "EPB Gulf FZE", jurisdiction: "AE", entityType: "FZE" }, ACTOR);
    const err = await f.service
      .create({ tenantId: TENANT, name: "Second Gulf LLC", jurisdiction: "AE", entityType: "LLC" }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CountryAlreadyServed);
    expect((err as Error).message).toMatch(/^EPB Gulf FZE already issues .* clients in AE/);
  });

  it("answers a race for the country the same way, having written nothing", async () => {
    const f = makeFirmEntityFakes();
    f.firmEntities.loseNextRace = true;
    await expect(
      f.service.create({ tenantId: TENANT, name: "EPB Asia", jurisdiction: "SG", entityType: "Pte. Ltd." }, ACTOR),
    ).rejects.toBeInstanceOf(CountryAlreadyServed);
    expect(f.events.recorded).toHaveLength(0);
  });

  it("refuses the fallback as a country, a blank name and a blank type", async () => {
    const f = makeFirmEntityFakes();
    const create = (over: Record<string, string>) =>
      f.service.create({ tenantId: TENANT, name: "X", jurisdiction: "IN", entityType: "Pvt Ltd", ...over }, ACTOR);
    await expect(create({ jurisdiction: "*" })).rejects.toBeInstanceOf(InvalidFirmEntity);
    await expect(create({ jurisdiction: "IND" })).rejects.toBeInstanceOf(InvalidFirmEntity);
    await expect(create({ name: "   " })).rejects.toBeInstanceOf(InvalidFirmEntity);
    await expect(create({ entityType: " " })).rejects.toBeInstanceOf(InvalidFirmEntity);
  });

  it("edits a name, type and address, and records which fields changed — never their values", async () => {
    const f = makeFirmEntityFakes();
    const us = await f.service.create({ tenantId: TENANT, name: "EPB USA", jurisdiction: "US", entityType: "Inc." }, ACTOR);
    const saved = await f.service.edit(
      {
        tenantId: TENANT,
        partyId: us.partyId,
        name: "EPB USA Inc",
        entityType: "Corporation",
        registeredAddress: { lines: ["Wilmington"] },
      },
      ACTOR,
    );
    expect(saved).toMatchObject({ name: "EPB USA Inc", entityType: "Corporation" });
    const edited = f.events.recorded.find((e) => e.verb === "firm_entity.edited");
    expect(edited?.payload).toEqual({ fields: ["name", "entityType", "registeredAddress"] });
    const cleared = await f.service.edit({ tenantId: TENANT, partyId: us.partyId, registeredAddress: null }, ACTOR);
    expect(cleared.registeredAddress).toBeNull();
  });

  it("records where the seeded company is registered, once, and never moves it after", async () => {
    const f = makeFirmEntityFakes();
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, jurisdiction: "IN" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidFirmEntity);
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, entityType: "Pvt Ltd" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidFirmEntity);
    const registered = await f.service.edit(
      { tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, jurisdiction: "in", entityType: "Private Limited" },
      ACTOR,
    );
    expect(registered).toMatchObject({ jurisdiction: "IN", entityType: "Private Limited", defaultCurrency: "INR" });
    expect(f.events.verbs()).toContain("legal_entity.registered");
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, jurisdiction: "AE" }, ACTOR),
    ).rejects.toBeInstanceOf(JurisdictionFixed);
    // The same country again is not a move, and with nothing else it is nothing.
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, jurisdiction: "IN" }, ACTOR),
    ).rejects.toBeInstanceOf(NothingToChangeOnEntity);
  });

  it("answers a client as not one of ours, and an unknown id as not found", async () => {
    const f = makeFirmEntityFakes();
    f.firmEntities.otherParties.set(CLIENT, "Meridian Foods");
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: CLIENT, name: "Ours now" }, ACTOR),
    ).rejects.toBeInstanceOf(NotAFirmEntity);
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: "00000000-0000-0000-0000-00000000dead", name: "X" }, ACTOR),
    ).rejects.toBeInstanceOf(FirmEntityNotFound);
  });
});

describe("a company's identity on paper (audit 2026-10-03: B12 / CA#1, CA#18)", () => {
  async function indian(f: ReturnType<typeof makeFirmEntityFakes>) {
    return f.service.create(
      { tenantId: TENANT, name: "Sharma Mehta & Co", jurisdiction: "IN", entityType: "Partnership firm" },
      ACTOR,
    );
  }

  it("holds the address's state and postal code, and the tax number, PAN, phone and email", async () => {
    const f = makeFirmEntityFakes();
    const firm = await indian(f);
    f.events.store.rows.length = 0;
    const saved = await f.service.edit(
      {
        tenantId: TENANT,
        partyId: firm.partyId,
        registeredAddress: { lines: ["12 MG Road, Camp, Pune"], region: " Maharashtra ", postalCode: "411001" },
        taxRegistration: "27abcde1234f1z5",
        pan: "abcde1234f",
        phone: "98200 12345",
        email: "Office@SharmaMehta.in",
      },
      ACTOR,
    );
    expect(saved).toMatchObject({
      registeredAddress: { lines: ["12 MG Road, Camp, Pune"], region: "Maharashtra", postalCode: "411001" },
      // An Indian company's tax registration is its GSTIN, held to its shape.
      taxRegistration: { type: "gstin", value: "27ABCDE1234F1Z5" },
      pan: "ABCDE1234F",
      // Completed with the company's country code, as every phone is stored.
      phone: "+919820012345",
      email: "office@sharmamehta.in",
    });
    // Which kinds changed, never their values.
    const added = f.events.recorded.filter((e) => e.verb === "party_identifier.added");
    expect(added.map((e) => e.payload)).toEqual([
      { partyId: firm.partyId, identifierType: "gstin" },
      { partyId: firm.partyId, identifierType: "pan" },
      { partyId: firm.partyId, identifierType: "phone" },
      { partyId: firm.partyId, identifierType: "email" },
    ]);
    expect(JSON.stringify(f.events.recorded)).not.toMatch(/27ABCDE|ABCDE1234F|9820012345|sharmamehta|Maharashtra/i);
    expect(f.events.recorded.find((e) => e.verb === "firm_entity.edited")?.payload).toEqual({
      fields: ["registeredAddress"],
    });
  });

  it("refuses a GSTIN or a PAN that is not one, saying what one looks like", async () => {
    const f = makeFirmEntityFakes();
    const firm = await indian(f);
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: firm.partyId, taxRegistration: "27ABCDE1234" }, ACTOR),
    ).rejects.toThrow(/GSTIN.*15 characters.*27ABCDE1234F1Z5/);
    await expect(f.service.edit({ tenantId: TENANT, partyId: firm.partyId, pan: "ABC" }, ACTOR)).rejects.toThrow(
      /PAN.*ABCDE1234F/,
    );
  });

  it("calls a company's tax number by its own country's kind", async () => {
    const f = makeFirmEntityFakes();
    const gulf = await f.service.create(
      { tenantId: TENANT, name: "EPB Gulf FZE", jurisdiction: "AE", entityType: "FZE", taxRegistration: "100123456700003" },
      ACTOR,
    );
    expect(gulf.taxRegistration).toEqual({ type: "trn", value: "100123456700003" });
    // A PAN is India's: refused for a company registered anywhere else.
    await expect(f.service.edit({ tenantId: TENANT, partyId: gulf.partyId, pan: "ABCDE1234F" }, ACTOR)).rejects.toThrow(
      /PAN.*India/,
    );
  });

  it("replaces a number by voiding the old one, and clears it with null", async () => {
    const f = makeFirmEntityFakes();
    const firm = await indian(f);
    await f.service.edit({ tenantId: TENANT, partyId: firm.partyId, taxRegistration: "27ABCDE1234F1Z5" }, ACTOR);
    f.events.store.rows.length = 0;
    const moved = await f.service.edit({ tenantId: TENANT, partyId: firm.partyId, taxRegistration: "29ABCDE1234F1Z7" }, ACTOR);
    expect(moved.taxRegistration?.value).toBe("29ABCDE1234F1Z7");
    expect(f.events.verbs()).toEqual(["party_identifier.voided", "party_identifier.added"]);
    const cleared = await f.service.edit({ tenantId: TENANT, partyId: firm.partyId, taxRegistration: null }, ACTOR);
    expect(cleared.taxRegistration).toBeNull();
  });

  it("refuses a number another party already holds at this firm", async () => {
    const f = makeFirmEntityFakes();
    const firm = await indian(f);
    f.firmEntities.heldElsewhere.add("pan ABCDE1234F");
    await expect(f.service.edit({ tenantId: TENANT, partyId: firm.partyId, pan: "ABCDE1234F" }, ACTOR)).rejects.toThrow(
      /already recorded for another/,
    );
  });
});

describe("a company's own financial year and time zone (0337)", () => {
  async function gulf() {
    const f = makeFirmEntityFakes();
    const created = await f.service.create(
      { tenantId: TENANT, name: "EPB Gulf FZE", jurisdiction: "AE", entityType: "FZE" },
      ACTOR,
    );
    return { f, id: created.partyId };
  }

  it("starts on the firm's: neither is set on a new company that sends neither", async () => {
    const { f, id } = await gulf();
    const found = await f.firmEntities.find(TENANT, id);
    expect(found).toMatchObject({ timeZone: null, fiscalYearStartMonth: null });
  });

  it("is set at creation when sent", async () => {
    const f = makeFirmEntityFakes();
    const created = await f.service.create(
      {
        tenantId: TENANT,
        name: "EPB Gulf FZE",
        jurisdiction: "AE",
        entityType: "FZE",
        timeZone: "Asia/Dubai",
        fiscalYearStartMonth: 1,
      },
      ACTOR,
    );
    expect(created).toMatchObject({ timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
  });

  it("is changed by an edit, and the event names the fields but never the values", async () => {
    const { f, id } = await gulf();
    const after = await f.service.edit(
      { tenantId: TENANT, partyId: id, timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 },
      ACTOR,
    );
    expect(after).toMatchObject({ timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
    const edited = f.events.recorded.filter((e) => e.verb === "firm_entity.edited").at(-1);
    expect(edited?.payload).toEqual({ fields: ["timeZone", "fiscalYearStart"] });
    expect(JSON.stringify(edited?.payload)).not.toContain("Dubai");
  });

  it("goes back to the firm's when cleared", async () => {
    const { f, id } = await gulf();
    await f.service.edit({ tenantId: TENANT, partyId: id, timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 }, ACTOR);
    const after = await f.service.edit(
      { tenantId: TENANT, partyId: id, timeZone: null, fiscalYearStartMonth: null },
      ACTOR,
    );
    expect(after).toMatchObject({ timeZone: null, fiscalYearStartMonth: null });
  });

  it("refuses an offset or an invented zone, in the firm card's words", async () => {
    const { f, id } = await gulf();
    for (const bad of ["+04:00", "Mars/Olympus", ""]) {
      await expect(f.service.edit({ tenantId: TENANT, partyId: id, timeZone: bad }, ACTOR)).rejects.toBeInstanceOf(
        InvalidCompanyTimeZone,
      );
    }
  });

  it("refuses a month that is not one", async () => {
    const { f, id } = await gulf();
    for (const bad of [0, 13, 4.5]) {
      await expect(
        f.service.edit({ tenantId: TENANT, partyId: id, fiscalYearStartMonth: bad }, ACTOR),
      ).rejects.toBeInstanceOf(InvalidCompanyYearStart);
    }
  });

  it("needs the company registered first: the firm's own seeded one has no country yet", async () => {
    const f = makeFirmEntityFakes();
    await expect(
      f.service.edit({ tenantId: TENANT, partyId: SEEDED_FIRM_ENTITY, timeZone: "Asia/Kolkata" }, ACTOR),
    ).rejects.toBeInstanceOf(CompanyNotRegistered);
  });

  it("may be set in the same edit that records where it is registered", async () => {
    const f = makeFirmEntityFakes();
    const after = await f.service.edit(
      {
        tenantId: TENANT,
        partyId: SEEDED_FIRM_ENTITY,
        jurisdiction: "IN",
        entityType: "Private Limited",
        timeZone: "Asia/Kolkata",
        fiscalYearStartMonth: 4,
      },
      ACTOR,
    );
    expect(after).toMatchObject({ jurisdiction: "IN", timeZone: "Asia/Kolkata", fiscalYearStartMonth: 4 });
  });
});
