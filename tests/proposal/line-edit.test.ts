// T6.18 · changing a line already on a draft, against in-memory ports.
//
// Until this there was no edit: a line could be pulled and quoted again, which
// lost its place and its pin. What is proven here is that an edit is judged by
// the rules for ADDING a line, on the line as it will be — the change merged
// over what the line says now — that `null` is each field's own "undo", and
// that a discount raised past the firm's limit after a sign-off lapses the
// sign-off. The UPDATE itself runs against Postgres in
// line-edit.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { discountApprovalLapses } from "../../src/domain/proposal/model";
import {
  DiscountNeedsApproval,
  InvalidDiscount,
  InvalidLineBillingFrequency,
  InvalidLineDescription,
  InvalidLineJurisdiction,
  InvalidQuantity,
  InvalidUnitAmount,
  LineNotFound,
  NotADraft,
  NothingToChangeOnLine,
  ProposalDeleted,
  UnpricedLineHasDiscount,
  UnpricedLineNeedsReason,
} from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    ref: "H1",
    billingBasis: "fixed",
    recurrence: "monthly",
    listPrice: { amount: "25000.00", currency: "INR" },
    scope: "Monthly GSTR-1 and GSTR-3B.",
    exclusions: "Annual return.",
  });
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draftWithLine(
  s: ReturnType<typeof setup>,
  discountPercent = "0",
): Promise<{ proposalId: string; lineId: string }> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Acme FY27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
    },
    ACTOR,
  );
  const line = await s.service.addLine(
    {
      tenantId: TENANT,
      proposalId: p.id,
      serviceVersionId: GST_VERSION,
      description: "GST monthly filing",
      quantity: "12",
      unitAmount: "2000",
      discountPercent,
    },
    ACTOR,
  );
  return { proposalId: p.id, lineId: line.id };
}

describe("discountApprovalLapses — the pure rule", () => {
  it("never lapses what was never given", () => {
    expect(discountApprovalLapses(false, "0", "90", "15")).toBe(false);
  });
  it("lapses on a raise past the limit", () => {
    expect(discountApprovalLapses(true, "20", "30", "15")).toBe(true);
  });
  it("does not lapse on a raise that stays within the limit", () => {
    expect(discountApprovalLapses(true, "5", "10", "15")).toBe(false);
  });
  it("does not lapse on a cut, even one still past the limit", () => {
    expect(discountApprovalLapses(true, "40", "30", "15")).toBe(false);
  });
  it("does not lapse when the discount is unchanged", () => {
    expect(discountApprovalLapses(true, "40", "40", "15")).toBe(false);
  });
  it("reads no published policy as a limit of zero", () => {
    expect(discountApprovalLapses(true, "0", "1", null)).toBe(true);
  });
});

describe("changing a line on a draft (T6.18)", () => {
  it("changes only what it names, and keeps the line's place and pin", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    const before = (await s.proposals.listLines(TENANT, proposalId))[0];
    const line = await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, unitAmount: "2500", quantity: "6" },
      ACTOR,
    );
    expect(line.unitAmount).toBe("2500");
    expect(line.quantity).toBe("6");
    expect(line.id).toBe(lineId);
    expect(line.position).toBe(before?.position);
    expect(line.serviceVersionId).toBe(GST_VERSION);
    expect(line.description).toBe("GST monthly filing");
    expect(line.billingFrequency).toBe("monthly");
    expect(line.currency).toBe("INR");
  });

  it("refuses a change that names nothing", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    await expect(
      s.service.updateLine({ tenantId: TENANT, proposalId, lineId }, ACTOR),
    ).rejects.toBeInstanceOf(NothingToChangeOnLine);
  });

  it("refuses a line that is not on the proposal, or was pulled", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    await expect(
      s.service.updateLine(
        { tenantId: TENANT, proposalId, lineId: "00000000-0000-0000-0000-00000000dead", quantity: "2" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LineNotFound);
    await s.service.removeLine(TENANT, proposalId, lineId);
    await expect(
      s.service.updateLine({ tenantId: TENANT, proposalId, lineId, quantity: "2" }, ACTOR),
    ).rejects.toBeInstanceOf(LineNotFound);
  });

  it("refuses once the proposal is sent, and once it is deleted", async () => {
    const s = setup();
    const sent = await draftWithLine(s);
    await s.service.send(TENANT, sent.proposalId, ACTOR);
    await expect(
      s.service.updateLine({ tenantId: TENANT, ...sent, quantity: "2" }, ACTOR),
    ).rejects.toBeInstanceOf(NotADraft);

    const deleted = await draftWithLine(s);
    await s.service.delete(TENANT, deleted.proposalId, ACTOR);
    await expect(
      s.service.updateLine({ tenantId: TENANT, ...deleted, quantity: "2" }, ACTOR),
    ).rejects.toBeInstanceOf(ProposalDeleted);
  });

  it("judges the line as it WILL be: no price needs a reason", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    await expect(
      s.service.updateLine({ tenantId: TENANT, proposalId, lineId, unitAmount: null }, ACTOR),
    ).rejects.toBeInstanceOf(UnpricedLineNeedsReason);
    const unpriced = await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, unitAmount: null, pricingNote: "As mutually agreed" },
      ACTOR,
    );
    expect(unpriced.unitAmount).toBeNull();
    expect(unpriced.pricingNote).toBe("As mutually agreed");
    // And the reason cannot then be cleared on its own.
    await expect(
      s.service.updateLine({ tenantId: TENANT, proposalId, lineId, pricingNote: null }, ACTOR),
    ).rejects.toBeInstanceOf(UnpricedLineNeedsReason);
  });

  it("refuses a discount on a line that has no price, whichever half arrives second", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s, "10");
    await expect(
      s.service.updateLine(
        { tenantId: TENANT, proposalId, lineId, unitAmount: null, pricingNote: "Agreed" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(UnpricedLineHasDiscount);
  });

  it("holds every field to the rule it had on adding", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    const edit = (change: Record<string, unknown>): Promise<unknown> =>
      s.service.updateLine({ tenantId: TENANT, proposalId, lineId, ...change }, ACTOR);
    await expect(edit({ quantity: "0" })).rejects.toBeInstanceOf(InvalidQuantity);
    await expect(edit({ unitAmount: "12,000" })).rejects.toBeInstanceOf(InvalidUnitAmount);
    await expect(edit({ discountPercent: "101" })).rejects.toBeInstanceOf(InvalidDiscount);
    await expect(edit({ jurisdiction: "INR" })).rejects.toBeInstanceOf(InvalidLineJurisdiction);
    await expect(edit({ billingFrequency: "weekly" })).rejects.toBeInstanceOf(
      InvalidLineBillingFrequency,
    );
    await expect(edit({ description: "   " })).rejects.toBeInstanceOf(InvalidLineDescription);
  });

  it("null puts the catalogue's words back, and blank means the same", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    await s.service.updateLine(
      {
        tenantId: TENANT,
        proposalId,
        lineId,
        scopeOverride: "Quarterly GSTR-1 only.",
        exclusionsOverride: "Nothing excluded.",
      },
      ACTOR,
    );
    let view = await s.service.describe(TENANT, proposalId);
    expect(view.lines[0]?.terms.scope).toEqual({ text: "Quarterly GSTR-1 only.", tailored: true });
    expect(view.lines[0]?.terms.exclusions.tailored).toBe(true);

    await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, scopeOverride: null, exclusionsOverride: "  " },
      ACTOR,
    );
    view = await s.service.describe(TENANT, proposalId);
    expect(view.lines[0]?.terms.scope).toEqual({
      text: "Monthly GSTR-1 and GSTR-3B.",
      tailored: false,
    });
    expect(view.lines[0]?.terms.exclusions).toEqual({ text: "Annual return.", tailored: false });
  });

  it("null frequency goes back to the PINNED service's recurrence", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    const quarterly = await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, billingFrequency: "quarterly" },
      ACTOR,
    );
    expect(quarterly.billingFrequency).toBe("quarterly");
    const back = await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, billingFrequency: null },
      ACTOR,
    );
    expect(back.billingFrequency).toBe("monthly");
  });

  it("sets and clears the country and the out-of-pocket range", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    const set = await s.service.updateLine(
      {
        tenantId: TENANT,
        proposalId,
        lineId,
        jurisdiction: "in",
        oopEstimate: { min: "500", max: "900", currency: "usd" },
      },
      ACTOR,
    );
    expect(set.jurisdiction).toBe("IN");
    expect(set.oopEstimate).toEqual({ min: "500", max: "900", currency: "USD" });
    const cleared = await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, jurisdiction: null, oopEstimate: null },
      ACTOR,
    );
    expect(cleared.jurisdiction).toBeNull();
    expect(cleared.oopEstimate).toBeNull();
  });

  it("the totals follow the edit — the database adds, the fake agrees", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, unitAmount: "3000", discountPercent: "10" },
      ACTOR,
    );
    const view = await s.service.describe(TENANT, proposalId);
    // 12 × 3000 = 36000, less 10% = 32400.
    expect(view.totals.net).toBe("32400.0000");
  });

  it("records no event for the edit itself — a draft being written is not a transition", async () => {
    const s = setup();
    const { proposalId, lineId } = await draftWithLine(s);
    const before = s.events.recorded.length;
    await s.service.updateLine({ tenantId: TENANT, proposalId, lineId, quantity: "3" }, ACTOR);
    expect(s.events.recorded.length).toBe(before);
  });
});

describe("the discount sign-off, when a line changes after it (T6.18)", () => {
  it("LAPSES when a discount is raised past the limit, and the draft needs signing off again", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const { proposalId, lineId } = await draftWithLine(s, "20");
    await s.service.approveDiscount(TENANT, proposalId, PARTNER, ACTOR);

    await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, discountPercent: "35" },
      ACTOR,
    );
    const after = await s.proposals.findById(TENANT, proposalId);
    expect(after?.discountApprovedAt).toBeNull();
    expect(after?.discountApprovedBy).toBeNull();
    await expect(s.service.send(TENANT, proposalId, ACTOR)).rejects.toBeInstanceOf(
      DiscountNeedsApproval,
    );
    const lapsed = s.events.recorded.find((e) => e.verb === "proposal.discount_approval_lapsed");
    expect(lapsed?.payload).toMatchObject({
      previouslyApprovedByUserId: PARTNER,
      lineId,
      discountPercent: "35",
      limitPercent: "15",
    });
    expect(lapsed?.actorId).toBe(PARTNER);
  });

  it("stands when the discount is cut", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const { proposalId, lineId } = await draftWithLine(s, "40");
    await s.service.approveDiscount(TENANT, proposalId, PARTNER, ACTOR);
    await s.service.updateLine(
      { tenantId: TENANT, proposalId, lineId, discountPercent: "30" },
      ACTOR,
    );
    expect((await s.proposals.findById(TENANT, proposalId))?.discountApprovedBy).toBe(PARTNER);
    const { proposal } = await s.service.send(TENANT, proposalId, ACTOR);
    expect(proposal.status).toBe("sent");
  });

  it("stands when a price changes and the discount does not", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const { proposalId, lineId } = await draftWithLine(s, "40");
    await s.service.approveDiscount(TENANT, proposalId, PARTNER, ACTOR);
    await s.service.updateLine({ tenantId: TENANT, proposalId, lineId, unitAmount: "1800" }, ACTOR);
    expect((await s.proposals.findById(TENANT, proposalId))?.discountApprovedBy).toBe(PARTNER);
  });

  it("LAPSES when a line is ADDED past the limit after the sign-off", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const { proposalId } = await draftWithLine(s, "20");
    await s.service.approveDiscount(TENANT, proposalId, PARTNER, ACTOR);
    await s.service.addLine(
      {
        tenantId: TENANT,
        proposalId,
        serviceVersionId: GST_VERSION,
        description: "GST annual return",
        quantity: "1",
        unitAmount: "10000",
        discountPercent: "50",
      },
      ACTOR,
    );
    expect((await s.proposals.findById(TENANT, proposalId))?.discountApprovedAt).toBeNull();
    expect(s.events.verbs()).toContain("proposal.discount_approval_lapsed");
  });

  it("stands when a line added after it is within the limit", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const { proposalId } = await draftWithLine(s, "20");
    await s.service.approveDiscount(TENANT, proposalId, PARTNER, ACTOR);
    await s.service.addLine(
      {
        tenantId: TENANT,
        proposalId,
        serviceVersionId: GST_VERSION,
        description: "GST annual return",
        quantity: "1",
        unitAmount: "10000",
        discountPercent: "5",
      },
      ACTOR,
    );
    expect((await s.proposals.findById(TENANT, proposalId))?.discountApprovedBy).toBe(PARTNER);
    expect(s.events.verbs()).not.toContain("proposal.discount_approval_lapsed");
  });
});
