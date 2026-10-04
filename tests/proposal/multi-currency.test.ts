// Q006 · a proposal priced in more than one currency (0344): the main currency
// with the proposal's own rate, a rate row for each other currency a line is
// in, and totals per currency that are never added together. Against in-memory
// ports; the SQL is proven in multi-currency.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import {
  CurrencyLockedByLines,
  CurrencyNeedsARate,
  RateInUse,
  RateIsMainCurrency,
} from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const BOOKS = "00000000-0000-0000-0000-0000000000d1";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(BOOKS, "books", {
    name: "Monthly bookkeeping",
    recurrence: "monthly",
    billingBasis: "fixed",
  });
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draft(s: ReturnType<typeof setup>): Promise<string> {
  const p = await s.service.draft(
    { tenantId: TENANT, partyId: PARTY, title: "FY27", currency: "USD", fxRate: "84.1", fxRateDate: "2026-10-01" },
    ACTOR,
  );
  return p.id;
}

const add = (s: ReturnType<typeof setup>, proposalId: string, unitAmount: string, currency?: string) =>
  s.service.addLine(
    {
      tenantId: TENANT,
      proposalId,
      serviceVersionId: BOOKS,
      description: "Monthly bookkeeping",
      quantity: "1",
      unitAmount,
      discountPercent: "0",
      ...(currency === undefined ? {} : { currency }),
    },
    ACTOR,
  );

const rate = (s: ReturnType<typeof setup>, proposalId: string, currency = "AED", fxRate = "22.75") =>
  s.service.setRate({ tenantId: TENANT, proposalId, currency, fxRate, fxRateDate: "2026-10-01" }, ACTOR);

describe("a proposal in two currencies", () => {
  it("needs a rate before a line goes on in another currency", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(add(s, id, "4000", "AED")).rejects.toBeInstanceOf(CurrencyNeedsARate);
    await rate(s, id);
    expect((await add(s, id, "4000", "aed")).currency).toBe("AED");
    expect(s.events.verbs()).toContain("proposal.rate_set");
  });

  it("totals and values each currency on its own, the main one first", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    await add(s, id, "4000", "AED");
    await add(s, id, "5000");

    const view = await s.service.describe(TENANT, id);
    expect(view.totals.map((t) => [t.currency, t.net])).toEqual([
      ["USD", "5000.0000"],
      ["AED", "4000.0000"],
    ]);
    expect(view.totalsByFrequency.map((t) => [t.currency, t.frequency])).toEqual([
      ["USD", "monthly"],
      ["AED", "monthly"],
    ]);
    // A year of each, never one figure that adds dirhams to dollars.
    expect(view.annualValue).toEqual([
      { amount: "60000.0000", currency: "USD" },
      { amount: "48000.0000", currency: "AED" },
    ]);
    expect(view.proposal.rates.map((r) => r.currency)).toEqual(["AED"]);
  });

  it("keeps a rate while a line uses it, and has none for the main currency", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(rate(s, id, "USD", "84")).rejects.toBeInstanceOf(RateIsMainCurrency);
    await rate(s, id);
    const line = await add(s, id, "4000", "AED");
    await expect(s.service.removeRate(TENANT, id, "AED", ACTOR)).rejects.toBeInstanceOf(RateInUse);
    await s.service.removeLine(TENANT, id, line.id);
    await s.service.removeRate(TENANT, id, "AED", ACTOR);
    expect((await s.service.describe(TENANT, id)).proposal.rates).toEqual([]);
  });

  it("moves the main currency only once nothing is priced in the old one", async () => {
    const s = setup();
    const id = await draft(s);
    await rate(s, id);
    const usd = await add(s, id, "5000");
    await add(s, id, "4000", "AED");
    await expect(
      s.service.revise({ tenantId: TENANT, proposalId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-10-01" }, ACTOR),
    ).rejects.toBeInstanceOf(CurrencyLockedByLines);
    await s.service.removeLine(TENANT, id, usd.id);
    const moved = await s.service.revise(
      { tenantId: TENANT, proposalId: id, currency: "AED", fxRate: "22.8", fxRateDate: "2026-10-02" },
      ACTOR,
    );
    expect([moved.currency, moved.fxRate, moved.rates]).toEqual(["AED", "22.8", []]);
  });
});
