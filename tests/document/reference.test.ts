// What a document is called, and who issues it — the two rules, against
// in-memory ports. No database, no HTTP.
//
// What is proven HERE is the DECISIONS: how a reference is spelled, and the
// precedence between a country's own row and the fallback. What is NOT proven
// here is that a number is never handed out twice, or that a burnt number stays
// burnt — those are properties of a unique index and a transaction boundary,
// and they are checked against real Postgres in reference.integration.test.ts.
import { describe, expect, it } from "vitest";
import { DocumentService } from "../../src/usecase/document/service";
import { makeDocumentFakes, SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";
import {
  ANY_JURISDICTION,
  countryOfRef,
  formatCountryRef,
  formatDocumentRef,
  fyEndYear,
  isDocumentRef,
  refYear,
  resolveIssuingEntity,
} from "../../src/domain/document/model";
import type { FirmEntityPreference } from "../../src/domain/document/model";
import {
  FirmEntityNotFound,
  InvalidFirstNumber,
  InvalidJurisdictionKey,
  NoIssuingEntity,
} from "../../src/domain/document/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const UAE_ENTITY = "00000000-0000-0000-0000-0000000000e1";
const US_ENTITY = "00000000-0000-0000-0000-0000000000e2";

function setup(): ReturnType<typeof makeDocumentFakes> & { service: DocumentService } {
  const fakes = makeDocumentFakes();
  fakes.preferences.partyNames.set(UAE_ENTITY, "The Firm (DMCC)");
  fakes.preferences.partyNames.set(US_ENTITY, "The Firm US LLC");
  return { ...fakes, service: new DocumentService(fakes) };
}

function preference(
  clientJurisdiction: string,
  firmEntityPartyId: string,
): FirmEntityPreference {
  return {
    id: `pref-${clientJurisdiction}`,
    tenantId: TENANT,
    clientJurisdiction,
    firmEntityPartyId,
    note: null,
  };
}

describe("the reference a client quotes back", () => {
  it("is the type, the year and a padded number", () => {
    expect(formatDocumentRef({ type: "engagement_letter", year: 2026, number: 7 })).toBe(
      "EL-2026-0007",
    );
    expect(formatDocumentRef({ type: "proposal", year: 2026, number: 7 })).toBe("PR-2026-0007");
  });

  it("grows a fifth digit rather than colliding", () => {
    // A firm that issues ten thousand documents in a year gets a longer number.
    // Truncating to four would reissue a reference somebody is already holding,
    // which is the one thing a document number may never do.
    expect(formatDocumentRef({ type: "proposal", year: 2026, number: 10_000 })).toBe(
      "PR-2026-10000",
    );
    expect(isDocumentRef("PR-2026-10000")).toBe(true);
  });

  it("refuses a number or a year that could not be one", () => {
    expect(() => formatDocumentRef({ type: "proposal", year: 2026, number: 0 })).toThrow(
      RangeError,
    );
    expect(() => formatDocumentRef({ type: "proposal", year: 26, number: 1 })).toThrow(RangeError);
  });

  it.each([["EL-2026-0007"], ["PR-2026-0001"], ["EL-2026-123456"]])("accepts %s", (ref) => {
    expect(isDocumentRef(ref)).toBe(true);
  });

  it.each([["EL-26-0007"], ["XX-2026-0007"], ["EL-2026-7"], ["el-2026-0007"], [""]])(
    "rejects %j",
    (ref) => {
      expect(isDocumentRef(ref)).toBe(false);
    },
  );

  it("takes its year from UTC, not from the machine's zone", () => {
    // Two pods in two regions must not hand out numbers from two different
    // years for documents drafted a second apart.
    expect(refYear(new Date("2026-12-31T23:30:00Z"))).toBe(2026);
    expect(refYear(new Date("2027-01-01T00:30:00Z"))).toBe(2027);
  });

  it("gives an issuer with no country the firm-wide run, per type and year", async () => {
    const s = setup();
    const when = new Date("2026-06-01T09:00:00Z");
    expect(await s.service.nextRef(TENANT, "proposal", SEEDED_FIRM_ENTITY, when)).toBe("PR-2026-0001");
    expect(await s.service.nextRef(TENANT, "proposal", SEEDED_FIRM_ENTITY, when)).toBe("PR-2026-0002");
    expect(await s.service.nextRef(TENANT, "engagement_letter", SEEDED_FIRM_ENTITY, when)).toBe("EL-2026-0001");
    expect(
      await s.service.nextRef(TENANT, "proposal", SEEDED_FIRM_ENTITY, new Date("2027-01-02T09:00:00Z")),
    ).toBe("PR-2027-0001");
  });
});

describe("the country reference (0392)", () => {
  function registered(): ReturnType<typeof setup> {
    const s = setup();
    s.preferences.partyJurisdictions.set(UAE_ENTITY, "AE");
    s.preferences.partyJurisdictions.set(US_ENTITY, "US");
    return s;
  }
  const OCT_2026 = new Date("2026-10-13T09:00:00Z");

  it("spells the year it ends, the issuer's country and the number", () => {
    expect(formatCountryRef({ type: "engagement_letter", fyEndYear: 2027, country: "IN", number: 501 })).toBe("27IN501");
    expect(formatCountryRef({ type: "proposal", fyEndYear: 2027, country: "IN", number: 501 })).toBe("PL27IN501");
    expect(formatCountryRef({ type: "proposal", fyEndYear: 2027, country: "AE", number: 7 })).toBe("PL27AE007");
    expect(formatCountryRef({ type: "proposal", fyEndYear: 2027, country: "AE", number: 1234 })).toBe("PL27AE1234");
    expect(() => formatCountryRef({ type: "proposal", fyEndYear: 2027, country: "XX", number: 1 })).toThrow(RangeError);
    expect(countryOfRef("PL27AE007")).toBe("AE");
    expect(countryOfRef("27IN501")).toBe("IN");
    expect(countryOfRef("PR-2026-0001")).toBeNull();
  });

  it.each([["27IN501"], ["PL27IN501"], ["PL27AE1234"]])("accepts %s", (ref) => {
    expect(isDocumentRef(ref)).toBe(true);
  });

  it("names a year by its end: April 2026 to March 2027 is 27, a calendar year is itself", () => {
    expect(fyEndYear(2026, 4)).toBe(2027);
    expect(fyEndYear(2026, 1)).toBe(2026);
  });

  it("starts each country's run at the firm's first number and keeps the runs apart", async () => {
    const s = registered();
    await s.service.setFirstNumber(TENANT, 501, ACTOR);
    expect(await s.service.nextRef(TENANT, "engagement_letter", UAE_ENTITY, OCT_2026)).toBe("27AE501");
    expect(await s.service.nextRef(TENANT, "engagement_letter", UAE_ENTITY, OCT_2026)).toBe("27AE502");
    expect(await s.service.nextRef(TENANT, "engagement_letter", US_ENTITY, OCT_2026)).toBe("27US501");
    expect(await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, OCT_2026)).toBe("PL27AE501");
    // A new financial year (1 April 2027) starts the run again.
    expect(
      await s.service.nextRef(TENANT, "engagement_letter", UAE_ENTITY, new Date("2027-04-01T09:00:00Z")),
    ).toBe("28AE501");
    expect(s.events.store.rows.some((e) => e.verb === "tenant.document_numbering_set")).toBe(true);
  });

  it("reads the issuing company's own year and zone", async () => {
    const s = registered();
    // The US company keeps a calendar year: October 2026 is in its year 2026.
    s.calendars.calendars = new Map([
      [US_ENTITY, { timeZone: "America/Los_Angeles", fiscalYearStartMonth: 1 }],
      [UAE_ENTITY, { timeZone: "Asia/Dubai", fiscalYearStartMonth: null }],
    ]);
    expect(await s.service.nextRef(TENANT, "proposal", US_ENTITY, OCT_2026)).toBe("PL26US001");
    // 31 March 23:30 in Dubai is still March there, though it is April in India.
    expect(await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, new Date("2027-03-31T19:30:00Z"))).toBe("PL27AE001");
  });

  it("moves a run already started up to a raised first number, never down", async () => {
    const s = registered();
    expect(await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, OCT_2026)).toBe("PL27AE001");
    await s.service.setFirstNumber(TENANT, 501, ACTOR);
    expect(await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, OCT_2026)).toBe("PL27AE501");
    await s.service.setFirstNumber(TENANT, 100, ACTOR);
    expect(await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, OCT_2026)).toBe("PL27AE502");
  });

  it("refuses a first number that is not a whole number from 1", async () => {
    const s = registered();
    await expect(s.service.setFirstNumber(TENANT, 0, ACTOR)).rejects.toThrow(InvalidFirstNumber);
    await expect(s.service.setFirstNumber(TENANT, 1.5, ACTOR)).rejects.toThrow(InvalidFirstNumber);
  });

  it("renumbers a draft whose new issuer is in another country, and only then", async () => {
    const s = registered();
    const ref = await s.service.nextRef(TENANT, "proposal", UAE_ENTITY, OCT_2026);
    expect(await s.service.refAfterIssuerChange(TENANT, "proposal", ref, UAE_ENTITY, OCT_2026)).toBe(ref);
    expect(await s.service.refAfterIssuerChange(TENANT, "proposal", ref, US_ENTITY, OCT_2026)).toBe("PL27US001");
    // A number from before 0392 names no country and is kept.
    expect(await s.service.refAfterIssuerChange(TENANT, "proposal", "PR-2026-0004", US_ENTITY, OCT_2026)).toBe(
      "PR-2026-0004",
    );
  });
});

describe("which of the firm's own entities is contracting", () => {
  it("prefers the client's own country over the fallback", () => {
    // "jahan ka client hota hai, wahan ki entity" — a US client is served by
    // the US entity even though the firm has a fallback for everywhere else.
    const rows = [preference(ANY_JURISDICTION, UAE_ENTITY), preference("US", US_ENTITY)];
    expect(resolveIssuingEntity(rows, "US")?.firmEntityPartyId).toBe(US_ENTITY);
  });

  it("falls back for a country the firm has no entity in", () => {
    // The acceptance: this resolves through a ROW somebody chose, not through
    // an `if` in a service. "But mostly UAE."
    const rows = [preference(ANY_JURISDICTION, UAE_ENTITY), preference("US", US_ENTITY)];
    expect(resolveIssuingEntity(rows, "GB")?.firmEntityPartyId).toBe(UAE_ENTITY);
  });

  it("falls back when the client's country is not known at all", () => {
    // A proposal need not say where the prospect is. "We do not know where they
    // are" and "we are not there" are the same answer from the firm's side.
    const rows = [preference(ANY_JURISDICTION, UAE_ENTITY)];
    expect(resolveIssuingEntity(rows, null)?.firmEntityPartyId).toBe(UAE_ENTITY);
  });

  it("normalises the country before matching it", () => {
    const rows = [preference("AE", UAE_ENTITY)];
    expect(resolveIssuingEntity(rows, " ae ")?.firmEntityPartyId).toBe(UAE_ENTITY);
  });

  it("answers nothing when the firm has published no fallback", () => {
    // Not "pick the first row": a firm with a US rule and no fallback has said
    // nothing about a UAE client, and guessing on its behalf is how a document
    // ends up naming the wrong counterparty.
    expect(resolveIssuingEntity([preference("US", US_ENTITY)], "AE")).toBeNull();
  });
});

describe("the service that reads that rule", () => {
  it("resolves through the fallback every firm is seeded with", async () => {
    const s = setup();
    expect(await s.service.issuerFor(TENANT, "GB")).toBe(SEEDED_FIRM_ENTITY);
  });

  it("refuses, loudly, when a firm has named no entity at all", async () => {
    const s = setup();
    // The firm that somehow has no rows. A document that cannot say who is
    // contracting is not a document, so this is refused rather than defaulted.
    s.preferences.seededFallbackPartyId = null;
    await expect(s.service.issuerFor(TENANT, "GB")).rejects.toThrow(NoIssuingEntity);
  });

  it("names the call that fixes it", async () => {
    const s = setup();
    s.preferences.seededFallbackPartyId = null;
    await expect(s.service.issuerFor(TENANT, null)).rejects.toThrow(
      /firm-entities\/preferences/,
    );
  });

  it("records who decided which entity serves a country", async () => {
    const s = setup();
    const saved = await s.service.setPreference(
      { tenantId: TENANT, clientJurisdiction: "us", firmEntityPartyId: US_ENTITY, note: "treaty" },
      ACTOR,
    );
    expect(saved.preference.clientJurisdiction).toBe("US");
    // The write answers with the entity by NAME, so the screen that just
    // changed the row can render it without a second read.
    expect(saved.entity.displayName).toBe("The Firm US LLC");
    expect(await s.service.issuerFor(TENANT, "US")).toBe(US_ENTITY);

    const [event] = s.events.recorded;
    expect(event?.verb).toBe("firm_entity_preference.set");
    expect(event?.objectType).toBe("firm_entity_preference");
    expect(event?.actorId).toBe(PARTNER);
    expect(event?.payload).toMatchObject({
      clientJurisdiction: "US",
      firmEntityPartyId: US_ENTITY,
      isFallback: false,
    });
    // The NOTE is free text a person wrote and this log cannot be erased, so it
    // stays on the row where it can be.
    expect(JSON.stringify(event?.payload)).not.toContain("treaty");
  });

  it("marks a change of the fallback as what it is", async () => {
    const s = setup();
    await s.service.setPreference(
      { tenantId: TENANT, clientJurisdiction: "*", firmEntityPartyId: UAE_ENTITY },
      ACTOR,
    );
    expect(s.events.recorded[0]?.payload).toMatchObject({ isFallback: true });
    expect(await s.service.issuerFor(TENANT, "GB")).toBe(UAE_ENTITY);
  });

  it("refuses a key that is not a country or the wildcard", async () => {
    const s = setup();
    await expect(
      s.service.setPreference(
        { tenantId: TENANT, clientJurisdiction: "UAE", firmEntityPartyId: UAE_ENTITY },
        ACTOR,
      ),
    ).rejects.toThrow(InvalidJurisdictionKey);
  });

  it("refuses an entity that is not this firm's", async () => {
    const s = setup();
    await expect(
      s.service.setPreference(
        {
          tenantId: TENANT,
          clientJurisdiction: "US",
          firmEntityPartyId: "00000000-0000-0000-0000-00000000dead",
        },
        ACTOR,
      ),
    ).rejects.toThrow(FirmEntityNotFound);
    expect(s.events.recorded).toHaveLength(0);
  });

  it("lists the rule with the entity by name, fallback last", async () => {
    const s = setup();
    await s.service.setPreference(
      { tenantId: TENANT, clientJurisdiction: "US", firmEntityPartyId: US_ENTITY },
      ACTOR,
    );
    const rows = await s.service.listPreferences(TENANT);
    // A screen renders a name, never a uuid.
    expect(rows.map((r) => r.entity.displayName)).toContain("The Firm US LLC");
    expect(rows).toHaveLength(2);
  });
});
