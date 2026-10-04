// Q006 · a letter priced in more than one currency (0344): a main currency
// with the letter's own rate, and a rate row for each other currency a service
// or section is priced in. Two currencies are never added together, and a
// letter in ONE currency reads, totals and hashes exactly as it did. Against
// in-memory ports; the SQL is proven in multi-currency.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import { canonicalContent } from "../../src/domain/engagement/model";
import {
  CurrencyNeedsARate,
  LetterCurrencyLocked,
  LineCurrencyFollowsSection,
  RateInUse,
  RateIsMainCurrency,
} from "../../src/domain/engagement/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const GST = "00000000-0000-0000-0000-0000000000d1";
const VAT = "00000000-0000-0000-0000-0000000000d3";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";

function setup(): ReturnType<typeof makeEngagementFakes> & { service: EngagementService } {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [PARTY], people: [] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", recurrence: "monthly" });
  fakes.library.publishService(VAT, "uae-vat", {
    name: "UAE VAT return",
    recurrence: "quarterly",
    listPrice: { amount: "3000", currency: "AED" },
  });
  fakes.library.publishClause(SCOPE_CLAUSE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  return { ...fakes, service: new EngagementService(fakes) };
}

async function draft(s: ReturnType<typeof setup>): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Engagement Letter for Acme",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-10-01",
      advanceRequired: false,
    },
    ACTOR,
  );
  return letter.id;
}

function gst(s: ReturnType<typeof setup>, letterId: string, unitAmount = "5000") {
  return s.service.addLine({
    tenantId: TENANT,
    letterId,
    entityPartyId: PARTY,
    serviceVersionId: GST,
    description: "GST monthly filing",
    quantity: "1",
    unitAmount,
    discountPercent: "0",
  });
}

function aed(s: ReturnType<typeof setup>, letterId: string, unitAmount = "4000") {
  return s.service.addLine({
    tenantId: TENANT,
    letterId,
    entityPartyId: PARTY,
    serviceVersionId: VAT,
    description: "UAE VAT return",
    quantity: "1",
    unitAmount,
    currency: "aed",
    discountPercent: "0",
    billingFrequency: "monthly",
  });
}

const rate = (s: ReturnType<typeof setup>, letterId: string, currency = "AED", fxRate = "22.75") =>
  s.service.setRate({ tenantId: TENANT, letterId, currency, fxRate, fxRateDate: "2026-10-01" }, ACTOR);

describe("a letter in two currencies", () => {
  it("refuses a fee in a currency it holds no rate for, and takes one once the rate is set", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(aed(s, id)).rejects.toBeInstanceOf(CurrencyNeedsARate);

    const set = await rate(s, id);
    expect(set).toEqual({ currency: "AED", fxRate: "22.75", fxRateDate: "2026-10-01", source: "typed" });
    expect(s.events.recorded.find((e) => e.verb === "engagement_letter.rate_set")?.payload).toEqual({
      currency: "AED",
      fxRate: "22.75",
      fxRateDate: "2026-10-01",
      source: "typed",
    });

    const line = await aed(s, id);
    expect(line.currency).toBe("AED");
    expect((await gst(s, id)).currency).toBe("INR");
  });

  it("totals each currency on its own, the main one first, and never adds them", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    await aed(s, id, "4000");
    await gst(s, id, "5000");

    const view = await s.service.describe(TENANT, id);
    expect(view.totals.map((t) => [t.currency, t.net])).toEqual([
      ["INR", "5000.0000"],
      ["AED", "4000.0000"],
    ]);
    expect(view.totalsByFrequency.map((t) => [t.currency, t.frequency, t.net])).toEqual([
      ["INR", "monthly", "5000.0000"],
      ["AED", "monthly", "4000.0000"],
    ]);
    expect(view.letter.rates.map((r) => r.currency)).toEqual(["AED"]);
    // The in-app preview's Summary of Fees prints each row in its own currency.
    expect(view.document.fees.map((f) => f.currency)).toEqual(["AED", "INR"]);
    const list = await s.service.list(TENANT, {});
    expect(list[0]?.totals.map((t) => t.currency)).toEqual(["INR", "AED"]);
  });

  it("quotes the list price in its own currency when the letter holds that rate", async () => {
    const s = setup();
    const id = await draft(s);
    const add = () =>
      s.service.addLine({
        tenantId: TENANT,
        letterId: id,
        entityPartyId: PARTY,
        serviceVersionId: VAT,
        description: "UAE VAT return",
        quantity: "1",
        discountPercent: "0",
      });
    // No AED rate: the list price is in AED, so there is nothing in INR to quote.
    await expect(add()).rejects.toThrow(/list price/i);
    await rate(s, id);
    const line = await add();
    expect([line.currency, line.unitAmount]).toEqual(["AED", "3000"]);
  });

  it("keeps a rate while anything is priced in it, and has none for the main currency", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(rate(s, id, "INR", "1")).rejects.toBeInstanceOf(RateIsMainCurrency);
    await rate(s, id);
    const line = await aed(s, id);
    await expect(s.service.removeRate(TENANT, id, "AED", ACTOR)).rejects.toBeInstanceOf(RateInUse);
    await s.service.removeLine(TENANT, id, line.id);
    await s.service.removeRate(TENANT, id, "aed", ACTOR);
    expect((await s.service.describe(TENANT, id)).letter.rates).toEqual([]);
    expect(s.events.verbs()).toContain("engagement_letter.rate_removed");
  });

  it("moves a line to another rated currency, and refuses one with no rate", async () => {
    const s = setup();
    const id = await draft(s);
    const line = await gst(s, id);
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: line.id, currency: "USD" }),
    ).rejects.toBeInstanceOf(CurrencyNeedsARate);
    await rate(s, id);
    const moved = await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: line.id, currency: "AED" });
    expect(moved.currency).toBe("AED");
  });

  it("changes the main currency while nothing is priced in the old one, and the new one's rate becomes the head's", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    const inr = await gst(s, id);
    await aed(s, id);
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-10-01" }, ACTOR),
    ).rejects.toBeInstanceOf(LetterCurrencyLocked);

    await s.service.removeLine(TENANT, id, inr.id);
    const moved = await s.service.revise(
      { tenantId: TENANT, letterId: id, currency: "AED", fxRate: "22.8", fxRateDate: "2026-10-02" },
      ACTOR,
    );
    expect([moved.currency, moved.fxRate, moved.rates]).toEqual(["AED", "22.8", []]);
  });
});

describe("a section in another currency", () => {
  it("prices its services in its own currency and takes them with it when it moves", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(
      s.service.addFeeGroup(TENANT, id, { title: "UAE compliance", billingFrequency: "monthly", amount: "9000", currency: "AED" }),
    ).rejects.toBeInstanceOf(CurrencyNeedsARate);
    await rate(s, id);
    await rate(s, id, "USD", "84.1");
    const group = await s.service.addFeeGroup(TENANT, id, {
      title: "UAE compliance",
      billingFrequency: "monthly",
      amount: "9000",
      currency: "AED",
    });
    expect(group.currency).toBe("AED");

    // Into the section: the section's currency, whatever the line had.
    const line = await gst(s, id);
    const grouped = await s.service.setLinePricing({ tenantId: TENANT, letterId: id, lineId: line.id, feeGroupId: group.id });
    expect(grouped.currency).toBe("AED");
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: line.id, currency: "INR" }),
    ).rejects.toBeInstanceOf(LineCurrencyFollowsSection);
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        letterId: id,
        entityPartyId: PARTY,
        serviceVersionId: GST,
        description: "GST",
        quantity: "1",
        discountPercent: "0",
        feeGroupId: group.id,
        currency: "INR",
      }),
    ).rejects.toBeInstanceOf(LineCurrencyFollowsSection);

    await s.service.editFeeGroup(TENANT, id, group.id, { currency: "USD" });
    const lines = await s.letters.listLines(TENANT, id);
    expect(lines.map((l) => l.currency)).toEqual(["USD"]);
    expect((await s.letters.listFeeGroups(TENANT, id)).map((g) => g.currency)).toEqual(["USD"]);
    // And out of it again, the line keeps the currency it had.
    const alone = await s.service.setLinePricing({
      tenantId: TENANT,
      letterId: id,
      lineId: line.id,
      feeGroupId: null,
      unitAmount: "100",
    });
    expect(alone.currency).toBe("USD");
  });
});

describe("what the client signs (canonicalContent)", () => {
  it("hashes a letter in one currency byte for byte as before 0344", async () => {
    const s = setup();
    const id = await draft(s);
    await gst(s, id);
    const letter = (await s.letters.findLetter(TENANT, id))!;
    const lines = await s.letters.listLines(TENANT, id);
    const feeGroups = await s.letters.listFeeGroups(TENANT, id);
    const clauses = await s.letters.listClauses(TENANT, id);
    const now = canonicalContent({ letter, lines, feeGroups, clauses });
    // The rendering before 0344 knew no currency on a line and no rates.
    const { rates: _rates, ...before } = letter;
    const old = canonicalContent({
      letter: before,
      lines: lines.map(({ currency: _c, ...rest }) => rest),
      feeGroups: feeGroups.map(({ currency: _c, ...rest }) => rest),
      clauses,
    });
    expect(now).toBe(old);
    expect(now).not.toMatch(/currency:|\nrate\t/);
  });

  it("commits to a line's other currency and to every other currency's rate", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    await aed(s, id);
    const letter = (await s.letters.findLetter(TENANT, id))!;
    const lines = await s.letters.listLines(TENANT, id);
    const content = canonicalContent({ letter, lines, feeGroups: [], clauses: [] });
    expect(content).toContain("\tcurrency:AED");
    expect(content).toContain("\nrate\tAED\t22.75");
    // A different rate is a different agreement.
    const other = canonicalContent({
      letter: { ...letter, rates: [{ ...letter.rates[0]!, fxRate: "22.8" }] },
      lines,
      feeGroups: [],
      clauses: [],
    });
    expect(other).not.toBe(content);
  });
});

describe("copying and quoting carry every currency", () => {
  it("copies a withdrawn letter's rates and each line's currency", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    await aed(s, id);
    await gst(s, id);
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    await writeOpening(s.prose, TENANT, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.withdraw(TENANT, id, ACTOR);

    const copy = await s.service.copyAsDraft(TENANT, id, ACTOR);
    const view = await s.service.describe(TENANT, copy.letter.id);
    expect(view.letter.rates.map((r) => [r.currency, r.fxRate])).toEqual([["AED", "22.75"]]);
    expect(view.lines.map((l) => l.line.currency)).toEqual(["AED", "INR"]);
  });
});
