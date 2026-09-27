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
