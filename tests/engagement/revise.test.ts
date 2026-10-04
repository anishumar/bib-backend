// T6.18 S6 · a DRAFT letter changes in place: its head (the builder's step 1,
// the cover edited in the preview) and its lines (the preview's pencils), and
// the read carries what the preview draws — the Annexure plan and the money
// per frequency. Against in-memory ports; the SQL is proven in
// revise.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import {
  AdvanceAmountRequired,
  EntityOutsideClient,
  GroupedLinePriced,
  InvalidLetterLineDescription,
  IssuerNotAFirmEntity,
  LetterCurrencyLocked,
  LetterInvalidCurrencyChange,
  LetterNotEditable,
  LetterProseEdited,
  NothingToChangeOnLetterLine,
  NothingToRevise,
  TermsOnLetter,
  UnpricedLineNeedsReason,
} from "../../src/domain/engagement/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY_B = "00000000-0000-0000-0000-0000000000b2";
const OUTSIDER = "00000000-0000-0000-0000-0000000000b9";
const CONTACT = "00000000-0000-0000-0000-0000000000bc";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const UAE_ENTITY = "00000000-0000-0000-0000-0000000000f2";
const GST = "00000000-0000-0000-0000-0000000000d1";
const AUDIT = "00000000-0000-0000-0000-0000000000d2";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";

function setup(): ReturnType<typeof makeEngagementFakes> & { service: EngagementService } {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [PARTY, ENTITY_B], people: [CONTACT] });
  fakes.library.publishService(GST, "gst-filing", {
    name: "GST monthly filing",
    recurrence: "monthly",
    scope: "Monthly GST returns.",
  });
  fakes.library.publishService(AUDIT, "audit", { name: "Statutory audit", recurrence: "annually" });
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
      fxRateDate: "2026-07-01",
      advanceRequired: false,
    },
    ACTOR,
  );
  return letter.id;
}

async function line(s: ReturnType<typeof setup>, letterId: string, unitAmount = "5000") {
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

describe("revising a draft letter's head", () => {
  it("changes what it names and leaves the rest", async () => {
    const s = setup();
    const id = await draft(s);
    const revised = await s.service.revise(
      {
        tenantId: TENANT,
        letterId: id,
        title: "  Engagement Letter for Acme Pvt Ltd  ",
        background: "Acme is a growing manufacturer.",
        addressedToPartyId: CONTACT,
        effectiveFrom: "2026-10-01",
        advanceRequired: true,
        advanceAmount: "25000",
      },
      ACTOR,
    );
    expect(revised).toMatchObject({
      title: "Engagement Letter for Acme Pvt Ltd",
      background: "Acme is a growing manufacturer.",
      addressedToPartyId: CONTACT,
      effectiveFrom: "2026-10-01",
      advanceRequired: true,
      advanceAmount: "25000",
      jurisdiction: "IN",
      currency: "INR",
    });
  });

  it("clears with null, and turning the advance off clears its amount", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.revise(
      { tenantId: TENANT, letterId: id, background: "x", advanceRequired: true, advanceAmount: "10" },
      ACTOR,
    );
    const cleared = await s.service.revise(
      { tenantId: TENANT, letterId: id, background: null, advanceRequired: false },
      ACTOR,
    );
    expect(cleared).toMatchObject({ background: null, advanceRequired: false, advanceAmount: null });
  });

  it("refuses an advance with no amount, a body naming nothing, and a sent letter", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, advanceRequired: true }, ACTOR),
    ).rejects.toBeInstanceOf(AdvanceAmountRequired);
    await expect(s.service.revise({ tenantId: TENANT, letterId: id }, ACTOR)).rejects.toBeInstanceOf(
      NothingToRevise,
    );
    await line(s, id);
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    await writeOpening(s.prose, TENANT, id);
    await s.service.send(TENANT, id, ACTOR);
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, title: "Too late" }, ACTOR),
    ).rejects.toBeInstanceOf(LetterNotEditable);
  });

  it("changes the main currency only while no LIVE fee is in it — a pulled line no longer counts (0344)", async () => {
    const s = setup();
    const id = await draft(s);
    const moved = await s.service.revise(
      { tenantId: TENANT, letterId: id, currency: "aed", fxRate: "22.75", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    expect(moved).toMatchObject({ currency: "AED", fxRate: "22.75" });
    expect(s.events.verbs()).toContain("engagement_letter.currency_changed");

    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, currency: "INR" }, ACTOR),
    ).rejects.toBeInstanceOf(LetterInvalidCurrencyChange);

    // A pulled line's key no longer carries the letter's currency, so it
    // holds nothing back; a live one in the main currency does.
    const pulled = await line(s, id);
    await s.service.removeLine(TENANT, id, pulled.id);
    await s.service.revise(
      { tenantId: TENANT, letterId: id, currency: "INR", fxRate: "1", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    await line(s, id);
    await expect(
      s.service.revise(
        { tenantId: TENANT, letterId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LetterCurrencyLocked);
    await s.service.revise(
      { tenantId: TENANT, letterId: id, currency: "INR", fxRate: "1", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    // The same currency at a corrected rate is not a new currency.
    const corrected = await s.service.revise(
      { tenantId: TENANT, letterId: id, currency: "INR", fxRate: "1.0", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    expect(corrected.fxRate).toBe("1.0");
  });

  it("moves the issuer and the country, and records who contracts under whose law", async () => {
    const s = setup();
    await s.firmEntities.set({
      id: "pref-ae",
      tenantId: TENANT,
      clientJurisdiction: "AE",
      firmEntityPartyId: UAE_ENTITY,
      note: null,
    });
    const id = await draft(s);
    const moved = await s.service.revise(
      { tenantId: TENANT, letterId: id, issuingEntityPartyId: UAE_ENTITY, jurisdiction: "ae" },
      ACTOR,
    );
    expect(moved).toMatchObject({ issuingEntityPartyId: UAE_ENTITY, jurisdiction: "AE" });
    const event = s.events.recorded.find((e) => e.verb === "engagement_letter.issuer_changed");
    expect(event?.payload).toMatchObject({
      toIssuingEntityPartyId: UAE_ENTITY,
      fromJurisdiction: "IN",
      toJurisdiction: "AE",
      proseReplaced: true,
      editedLinesReplaced: 0,
    });
  });

  it("asks before replacing wording written for this client", async () => {
    const s = setup();
    await s.firmEntities.set({
      id: "pref-ae",
      tenantId: TENANT,
      clientJurisdiction: "AE",
      firmEntityPartyId: UAE_ENTITY,
      note: null,
    });
    const id = await draft(s);
    await s.prose.addBlock({
      tenantId: TENANT,
      owner: { kind: "engagement_letter", id },
      kind: "exclusion",
      body: "Audit of the Dubai branch is not included.",
      sortOrder: 9,
    });
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, issuingEntityPartyId: UAE_ENTITY }, ACTOR),
    ).rejects.toMatchObject({ code: "PROSE_EDITED", editedCount: 1 });
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, jurisdiction: "AE" }, ACTOR),
    ).rejects.toBeInstanceOf(LetterProseEdited);
    const moved = await s.service.revise(
      { tenantId: TENANT, letterId: id, issuingEntityPartyId: UAE_ENTITY, replaceEditedProse: true },
      ACTOR,
    );
    expect(moved.issuingEntityPartyId).toBe(UAE_ENTITY);
  });

  it("refuses a new issuer or country once terms are on the letter, and a company not the firm's", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, issuingEntityPartyId: OUTSIDER }, ACTOR),
    ).rejects.toBeInstanceOf(IssuerNotAFirmEntity);
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: id, jurisdiction: "SG" }, ACTOR),
    ).rejects.toBeInstanceOf(TermsOnLetter);
    // Anything else still changes.
    const titled = await s.service.revise({ tenantId: TENANT, letterId: id, title: "New" }, ACTOR);
    expect(titled.title).toBe("New");
  });
});

describe("changing a line on a draft letter", () => {
  it("changes its wording, fee, frequency and scope, and null goes back to the pin", async () => {
    const s = setup();
    const id = await draft(s);
    const added = await line(s, id);
    const changed = await s.service.updateLine({
      tenantId: TENANT,
      letterId: id,
      lineId: added.id,
      description: "GST returns, monthly",
      unitAmount: "6000",
      billingFrequency: "quarterly",
      scopeOverride: "Monthly GST returns, and the annual return.",
      effectiveFrom: "2026-11-01",
      entityPartyId: ENTITY_B,
    });
    expect(changed).toMatchObject({
      description: "GST returns, monthly",
      unitAmount: "6000",
      billingFrequency: "quarterly",
      scopeOverride: "Monthly GST returns, and the annual return.",
      effectiveFrom: "2026-11-01",
      entityPartyId: ENTITY_B,
    });
    const back = await s.service.updateLine({
      tenantId: TENANT,
      letterId: id,
      lineId: added.id,
      billingFrequency: null,
      scopeOverride: null,
      effectiveFrom: null,
    });
    expect(back).toMatchObject({ billingFrequency: "monthly", scopeOverride: null, effectiveFrom: null });
    const view = await s.service.describe(TENANT, id);
    expect(view.lines[0]?.terms.scope).toEqual({ text: "Monthly GST returns.", tailored: false });
  });

  it("judges the price on the line as it will be", async () => {
    const s = setup();
    const id = await draft(s);
    const added = await line(s, id);
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: added.id, unitAmount: null }),
    ).rejects.toBeInstanceOf(UnpricedLineNeedsReason);
    const agreed = await s.service.updateLine({
      tenantId: TENANT,
      letterId: id,
      lineId: added.id,
      unitAmount: null,
      pricingNote: "As mutually agreed",
    });
    expect(agreed).toMatchObject({ unitAmount: null, pricingNote: "As mutually agreed" });
  });

  it("refuses a price on a line a section pays for, a blank name, a company not the client's, and nothing", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, {
      title: "Ongoing services",
      billingFrequency: "monthly",
      amount: "50000",
    });
    const grouped = await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: PARTY,
      serviceVersionId: AUDIT,
      description: "Statutory audit",
      quantity: "1",
      discountPercent: "0",
      feeGroupId: group.id,
    });
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: grouped.id, unitAmount: "100" }),
    ).rejects.toBeInstanceOf(GroupedLinePriced);
    // Its wording still changes.
    const named = await s.service.updateLine({
      tenantId: TENANT,
      letterId: id,
      lineId: grouped.id,
      description: "Statutory audit, FY 2026-27",
    });
    expect(named.description).toBe("Statutory audit, FY 2026-27");
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: grouped.id, description: "  " }),
    ).rejects.toBeInstanceOf(InvalidLetterLineDescription);
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: grouped.id, entityPartyId: OUTSIDER }),
    ).rejects.toBeInstanceOf(EntityOutsideClient);
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: grouped.id }),
    ).rejects.toBeInstanceOf(NothingToChangeOnLetterLine);
  });
});

describe("what the read carries for the preview", () => {
  it("plans Annexure 1 as the PDF does, and adds the money per frequency with a section once", async () => {
    const s = setup();
    const id = await draft(s);
    await line(s, id, "5000");
    const group = await s.service.addFeeGroup(TENANT, id, {
      title: "Annual work",
      billingFrequency: "annually",
      amount: "120000",
    });
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: PARTY,
      serviceVersionId: AUDIT,
      description: "Statutory audit",
      quantity: "1",
      discountPercent: "0",
      feeGroupId: group.id,
    });
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: PARTY,
      serviceVersionId: GST,
      description: "GST advisory",
      quantity: "1",
      discountPercent: "0",
      pricingNote: "As mutually agreed",
    });
    const view = await s.service.describe(TENANT, id);
    expect(view.document.sections.map((sec) => [sec.code, sec.title])).toEqual([
      ["A", "Annual work"],
      ["B", "Other services"],
    ]);
    expect(view.document.sections[1]?.items.map((i) => i.code)).toEqual(["B1", "B2"]);
    expect(view.document.fees.map((f) => [f.code, f.amount])).toEqual([
      ["A", "120000"],
      ["B1", "5000.0000"],
      ["B2", null],
    ]);
    expect(view.totalsByFrequency).toEqual([
      { currency: "INR", frequency: "monthly", net: "5000.0000", lineCount: 2, unpricedLineCount: 1 },
      { currency: "INR", frequency: "annually", net: "120000.0000", lineCount: 1, unpricedLineCount: 0 },
    ]);
  });
});
