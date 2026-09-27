// T6.18 · changing a draft's issuer and currency, against in-memory ports.
//
// D9: a new issuer replaces the draft's prose with that company's standard set,
// and prose edited for this client is not thrown away without being asked. D1:
// one currency per document, so the currency moves only while nothing is
// quoted. The single transaction (issuer + prose) runs against Postgres in
// issuer-change.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";
import {
  CurrencyLockedByLines,
  InvalidCurrencyChange,
  InvalidFxRate,
  InvalidQuoteCurrency,
  NotADraft,
  ProposalIssuerNotAFirmEntity,
  ProseEdited,
} from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const GST = "00000000-0000-0000-0000-0000000000d1";
const UAE = "00000000-0000-0000-0000-0000000000e3";
const STRANGER = "00000000-0000-0000-0000-0000000000e9";

async function setup(): Promise<ReturnType<typeof makeProposalFakes> & { service: ProposalService }> {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST, "gst", { name: "GST returns", billingBasis: "fixed" });
  // The firm's UAE company, registered in AE and named for AE clients.
  fakes.firmEntities.partyNames.set(UAE, "Gulf Co FZE");
  fakes.firmEntities.partyJurisdictions.set(UAE, "AE");
  await fakes.firmEntities.set({
    id: "pref-ae",
    tenantId: TENANT,
    clientJurisdiction: "AE",
    firmEntityPartyId: UAE,
    note: null,
  });
  // The firm's standard prose: one line everywhere, one India-only, one UAE-only.
  for (const [body, jurisdiction, sortOrder] of [
    ["Anything not in the scope is excluded.", null, 1],
    ["All fees are exclusive of GST as applicable.", "IN", 2],
    ["All fees are exclusive of VAT as applicable.", "AE", 3],
  ] as const) {
    await fakes.prose.addStandardBlock(
      { tenantId: TENANT, kind: "commercial", body, sortOrder, jurisdiction },
      ACTOR,
    );
  }
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draftIndian(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      clientJurisdiction: "IN",
      title: "FY27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
    },
    ACTOR,
  );
  return p.id;
}

const bodies = async (s: Awaited<ReturnType<typeof setup>>, id: string): Promise<string[]> =>
  (await s.service.describe(TENANT, id)).blocks.map((b) => b.body);

describe("changing a draft's issuer (T6.18, D9)", () => {
  it("moves it to the new company and replaces the prose with that company's standard set", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    expect(await bodies(s, id)).toEqual([
      "Anything not in the scope is excluded.",
      "All fees are exclusive of GST as applicable.",
    ]);

    const revised = await s.service.revise(
      { tenantId: TENANT, proposalId: id, issuingEntityPartyId: UAE },
      ACTOR,
    );
    expect(revised.issuingEntityPartyId).toBe(UAE);
    // No client country sent: the new issuer's own country picks the lines.
    expect(await bodies(s, id)).toEqual([
      "Anything not in the scope is excluded.",
      "All fees are exclusive of VAT as applicable.",
    ]);
    const event = s.events.recorded.find((e) => e.verb === "proposal.issuer_changed");
    expect(event?.payload).toMatchObject({
      fromIssuingEntityPartyId: SEEDED_FIRM_ENTITY,
      toIssuingEntityPartyId: UAE,
      proseReplaced: true,
      editedLinesReplaced: 0,
    });
  });

  it("takes the CLIENT's country for the prose when it is sent", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    await s.service.revise(
      { tenantId: TENANT, proposalId: id, issuingEntityPartyId: UAE, clientJurisdiction: "in" },
      ACTOR,
    );
    expect(await bodies(s, id)).toContain("All fees are exclusive of GST as applicable.");
  });

  it("asks first when prose was edited for this client — PROSE_EDITED names the count", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    const [first] = (await s.service.describe(TENANT, id)).blocks;
    await s.prose.editBlock(TENANT, first?.id ?? "", { body: "Nothing is excluded for you." });

    const err = await s.service
      .revise({ tenantId: TENANT, proposalId: id, issuingEntityPartyId: UAE }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProseEdited);
    expect((err as ProseEdited).editedCount).toBe(1);
    expect((err as Error).message).toMatch(/^1 line of this proposal's .* Gulf Co FZE's standard set/);
    // Nothing moved.
    expect((await s.proposals.findById(TENANT, id))?.issuingEntityPartyId).toBe(SEEDED_FIRM_ENTITY);
    expect(await bodies(s, id)).toContain("Nothing is excluded for you.");

    await s.service.revise(
      { tenantId: TENANT, proposalId: id, issuingEntityPartyId: UAE, replaceEditedProse: true },
      ACTOR,
    );
    expect(await bodies(s, id)).not.toContain("Nothing is excluded for you.");
    const event = s.events.recorded.find((e) => e.verb === "proposal.issuer_changed");
    expect(event?.payload).toMatchObject({ editedLinesReplaced: 1 });
  });

  it("refuses a company that is not one of the firm's own", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    await expect(
      s.service.revise({ tenantId: TENANT, proposalId: id, issuingEntityPartyId: STRANGER }, ACTOR),
    ).rejects.toBeInstanceOf(ProposalIssuerNotAFirmEntity);
  });

  it("leaves the prose alone when the issuer named is the one it already has", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    const before = (await s.service.describe(TENANT, id)).blocks.map((b) => b.id);
    await s.service.revise(
      { tenantId: TENANT, proposalId: id, issuingEntityPartyId: SEEDED_FIRM_ENTITY, title: "Renamed" },
      ACTOR,
    );
    expect((await s.service.describe(TENANT, id)).blocks.map((b) => b.id)).toEqual(before);
    expect(s.events.verbs()).not.toContain("proposal.issuer_changed");
  });

  it("refuses once the proposal has been sent", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    await s.service.addLine(
      { tenantId: TENANT, proposalId: id, serviceVersionId: GST, description: "GST", quantity: "1", unitAmount: "100", discountPercent: "0" },
      ACTOR,
    );
    await s.service.send(TENANT, id, ACTOR);
    await expect(
      s.service.revise({ tenantId: TENANT, proposalId: id, issuingEntityPartyId: UAE }, ACTOR),
    ).rejects.toBeInstanceOf(NotADraft);
  });
});

describe("changing a draft's currency (T6.18, D1)", () => {
  it("changes currency, rate and day together while nothing is quoted", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    const revised = await s.service.revise(
      { tenantId: TENANT, proposalId: id, currency: "aed", fxRate: "22.75", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    expect(revised).toMatchObject({ currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" });
    expect(s.events.recorded.find((e) => e.verb === "proposal.currency_changed")?.payload).toEqual({
      fromCurrency: "INR",
      toCurrency: "AED",
      fromFxRate: "1",
      toFxRate: "22.75",
      fxRateDate: "2026-09-28",
    });
  });

  it("refuses a new currency under a live line, and says how many", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    await s.service.addLine(
      { tenantId: TENANT, proposalId: id, serviceVersionId: GST, description: "GST", quantity: "1", unitAmount: "100", discountPercent: "0" },
      ACTOR,
    );
    const err = await s.service
      .revise({ tenantId: TENANT, proposalId: id, currency: "USD", fxRate: "83", fxRateDate: "2026-09-28" }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CurrencyLockedByLines);
    expect((err as Error).message).toMatch(/already quotes 1 service in INR/);
  });

  it("allows a new currency once the only line was pulled", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    const line = await s.service.addLine(
      { tenantId: TENANT, proposalId: id, serviceVersionId: GST, description: "GST", quantity: "1", unitAmount: "100", discountPercent: "0" },
      ACTOR,
    );
    await s.service.removeLine(TENANT, id, line.id);
    const revised = await s.service.revise(
      { tenantId: TENANT, proposalId: id, currency: "USD", fxRate: "83", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    expect(revised.currency).toBe("USD");
  });

  it("allows correcting the rate of the same currency under live lines", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    await s.service.addLine(
      { tenantId: TENANT, proposalId: id, serviceVersionId: GST, description: "GST", quantity: "1", unitAmount: "100", discountPercent: "0" },
      ACTOR,
    );
    const revised = await s.service.revise(
      { tenantId: TENANT, proposalId: id, currency: "INR", fxRate: "1", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    expect(revised.fxRateDate).toBe("2026-09-28");
  });

  it("refuses half a change, a code that is not one, and a rate that is not positive", async () => {
    const s = await setup();
    const id = await draftIndian(s);
    const revise = (change: Record<string, string>) =>
      s.service.revise({ tenantId: TENANT, proposalId: id, ...change }, ACTOR);
    await expect(revise({ currency: "USD" })).rejects.toBeInstanceOf(InvalidCurrencyChange);
    await expect(revise({ fxRate: "83", fxRateDate: "2026-09-28" })).rejects.toBeInstanceOf(
      InvalidCurrencyChange,
    );
    await expect(revise({ currency: "US", fxRate: "83", fxRateDate: "2026-09-28" })).rejects.toBeInstanceOf(
      InvalidQuoteCurrency,
    );
    await expect(revise({ currency: "USD", fxRate: "0", fxRateDate: "2026-09-28" })).rejects.toBeInstanceOf(
      InvalidFxRate,
    );
  });
});
