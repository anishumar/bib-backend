// One fee for several services on a proposal (0394): the section's fee pays
// for its services, totals count it once, and the PDF prints the firm's
// "Included in A1".
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { planProposal } from "../../src/domain/proposal/document";
import {
  ProposalFeeGroupEmpty,
  ProposalFeeGroupNotEmpty,
  ProposalFeeGroupTitleRequired,
  ProposalGroupedLinePriced,
  ProposalLineNotPriced,
} from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const BOOKS = "00000000-0000-0000-0000-0000000000d1";
const TDS = "00000000-0000-0000-0000-0000000000d2";
const GST = "00000000-0000-0000-0000-0000000000d3";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  for (const [id, key, name, price] of [
    [BOOKS, "books", "Accounting", "30000.00"],
    [TDS, "tds", "Monthly TDS", "8000.00"],
    [GST, "gst", "GST returns", "15000.00"],
  ] as const) {
    fakes.catalogue.publishService(id, key, {
      name,
      billingBasis: "retainer",
      recurrence: "monthly",
      listPrice: { amount: price, currency: "INR" },
    });
  }
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draft(s: ReturnType<typeof setup>): Promise<string> {
  const p = await s.service.draft(
    { tenantId: TENANT, partyId: PARTY, title: "EduHubSpot", currency: "INR", fxRate: "1", fxRateDate: "2026-10-01" },
    ACTOR,
  );
  return p.id;
}

const line = (proposalId: string, serviceVersionId: string, description: string) => ({
  tenantId: TENANT,
  proposalId,
  serviceVersionId,
  description,
  quantity: "1",
  discountPercent: "0",
});

const section = { title: "Accounting, Tax & GST", billingFrequency: "monthly", amount: "70000" };

describe("a proposal section: one fee for several services (0394)", () => {
  it("prices its services by its one fee, and the totals count that fee once", async () => {
    const s = setup();
    const id = await draft(s);
    const books = await s.service.addLine(line(id, BOOKS, "Accounting"), ACTOR);
    const tds = await s.service.addLine(line(id, TDS, "Monthly TDS"), ACTOR);
    await s.service.addLine(line(id, GST, "GST returns"), ACTOR);
    const group = await s.service.addFeeGroup(TENANT, id, section);
    expect(group).toMatchObject({ title: "Accounting, Tax & GST", amount: "70000", currency: "INR", position: 1 });

    const moved = await s.service.setLinePricing({ tenantId: TENANT, proposalId: id, lineId: books.id, feeGroupId: group.id });
    expect(moved).toMatchObject({ feeGroupId: group.id, unitAmount: null, discountPercent: "0", pricingNote: null });
    await s.service.setLinePricing({ tenantId: TENANT, proposalId: id, lineId: tds.id, feeGroupId: group.id });

    const view = await s.service.describe(TENANT, id);
    expect(view.feeGroups).toEqual([
      expect.objectContaining({ code: "A", lineIds: [books.id, tds.id] }),
    ]);
    // 70,000 for the section + 15,000 for GST on its own; nothing "as agreed".
    expect(Number(view.totals[0]?.net)).toBe(85000);
    expect(view.totals[0]?.unpricedLineCount).toBe(0);
    expect(view.totalsByFrequency).toHaveLength(1);
    expect(view.totalsByFrequency[0]).toMatchObject({ currency: "INR", frequency: "monthly", unpricedLineCount: 0 });
    expect(Number(view.totalsByFrequency[0]?.net)).toBe(85000);
  });

  it("takes a service straight into a section, and refuses one sent with a price of its own", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, section);
    const added = await s.service.addLine({ ...line(id, TDS, "Monthly TDS"), feeGroupId: group.id }, ACTOR);
    expect(added).toMatchObject({ feeGroupId: group.id, unitAmount: null, pricingNote: null, currency: "INR" });
    await expect(
      s.service.addLine({ ...line(id, GST, "GST"), feeGroupId: group.id, unitAmount: "100" }, ACTOR),
    ).rejects.toThrow(ProposalGroupedLinePriced);
    await expect(
      s.service.updateLine({ tenantId: TENANT, proposalId: id, lineId: added.id, unitAmount: "5000" }, ACTOR),
    ).rejects.toThrow(ProposalGroupedLinePriced);
    // Its words still change.
    const renamed = await s.service.updateLine(
      { tenantId: TENANT, proposalId: id, lineId: added.id, description: "TDS, monthly" },
      ACTOR,
    );
    expect(renamed).toMatchObject({ description: "TDS, monthly", unitAmount: null, feeGroupId: group.id });
  });

  it("asks a service leaving a section for a price or a reason", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, section);
    const added = await s.service.addLine({ ...line(id, TDS, "Monthly TDS"), feeGroupId: group.id }, ACTOR);
    const out = { tenantId: TENANT, proposalId: id, lineId: added.id, feeGroupId: null };
    await expect(s.service.setLinePricing(out)).rejects.toThrow(ProposalLineNotPriced);
    const priced = await s.service.setLinePricing({ ...out, unitAmount: "8000" });
    expect(priced).toMatchObject({ feeGroupId: null, unitAmount: "8000" });
  });

  it("keeps a section that still pays for a service, and strikes off an empty one", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, section);
    const added = await s.service.addLine({ ...line(id, TDS, "Monthly TDS"), feeGroupId: group.id }, ACTOR);
    await expect(s.service.removeFeeGroup(TENANT, id, group.id)).rejects.toThrow(ProposalFeeGroupNotEmpty);
    await s.service.setLinePricing({ tenantId: TENANT, proposalId: id, lineId: added.id, feeGroupId: null, pricingNote: "As mutually agreed" });
    await s.service.removeFeeGroup(TENANT, id, group.id);
    expect((await s.service.describe(TENANT, id)).feeGroups).toEqual([]);
  });

  it("refuses a section with no title, and sending one that covers nothing", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(s.service.addFeeGroup(TENANT, id, { ...section, title: "  " })).rejects.toThrow(
      ProposalFeeGroupTitleRequired,
    );
    await s.service.addLine(line(id, GST, "GST returns"), ACTOR);
    await s.service.addFeeGroup(TENANT, id, section);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toThrow(ProposalFeeGroupEmpty);
  });

  it("changes the section's fee and currency, its services moving with it", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.setRate({ tenantId: TENANT, proposalId: id, currency: "USD", fxRate: "84", fxRateDate: "2026-10-01" }, ACTOR);
    const group = await s.service.addFeeGroup(TENANT, id, section);
    const added = await s.service.addLine({ ...line(id, TDS, "US books"), feeGroupId: group.id }, ACTOR);
    const edited = await s.service.editFeeGroup(TENANT, id, group.id, { amount: "750", currency: "USD" });
    expect(edited).toMatchObject({ amount: "750", currency: "USD", title: "Accounting, Tax & GST" });
    const lines = await s.proposals.listLines(TENANT, id);
    expect(lines.find((l) => l.id === added.id)?.currency).toBe("USD");
  });

  it("is copied with its services when a closed proposal is copied", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, { ...section, billingTiming: "advance" });
    await s.service.addLine({ ...line(id, TDS, "Monthly TDS"), feeGroupId: group.id }, ACTOR);
    await s.service.addLine(line(id, GST, "GST returns"), ACTOR);
    await s.proposals.setStatus(TENANT, id, "rejected", "2026-10-02T00:00:00.000Z", "Too dear");
    const copy = await s.service.copyAsDraft(TENANT, id, ACTOR);
    const view = await s.service.describe(TENANT, copy.proposal.id);
    expect(view.feeGroups).toHaveLength(1);
    expect(view.feeGroups[0]?.group).toMatchObject({ title: section.title, amount: "70000", billingTiming: "advance" });
    expect(view.feeGroups[0]?.lineIds).toHaveLength(1);
    expect(copy.skipped).toEqual([]);
  });
});

describe("how a section prints on the proposal (rule 4)", () => {
  const terms = {
    scope: { text: "", tailored: false },
    clientObligations: { text: "", tailored: false },
    volumeLimits: { text: "", tailored: false },
    exclusions: { text: "", tailored: false },
  };
  const planLine = (id: string, position: number, ref: string, dept: string, feeGroupId: string | null) => ({
    id,
    position,
    ref,
    deptCode: dept,
    description: ref,
    subject: null,
    terms,
    billingFrequency: "monthly" as const,
    net: feeGroupId === null ? "15000" : null,
    currency: "INR",
    pricingNote: null,
    oopEstimate: null,
    feeGroupId,
  });

  it("puts the fee on the section's first service in print order, the others included in it", () => {
    const plan = planProposal({
      depts: [
        { code: "FRC", name: "Financial Reporting", sortOrder: 1 },
        { code: "TRC", name: "Tax & Regulatory", sortOrder: 2 },
      ],
      feeGroups: [
        { id: "g1", title: "Accounting, Tax & GST", amount: "70000", currency: "INR", billingFrequency: "monthly", paymentTerms: null },
      ],
      lines: [
        planLine("l-tds", 1, "C1", "TRC", "g1"),
        planLine("l-books", 2, "A1", "FRC", "g1"),
        planLine("l-vcfo", 3, "E1", "FRC", null),
      ],
    });
    const items = plan.sections.flatMap((x) => x.items);
    const fee = (code: string) => items.find((i) => i.code === code)?.fee;
    // FRC prints first, so A1 carries the fee although C1 was quoted first.
    expect(fee("A1")).toMatchObject({ kind: "section", isAnchor: true, amount: "70000", anchorCode: "A1" });
    expect(fee("C1")).toMatchObject({ kind: "section", isAnchor: false, anchorCode: "A1" });
    expect(fee("E1")).toEqual({ kind: "own" });
  });
});
