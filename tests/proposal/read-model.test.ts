// T6.18 · what the builder and the preview READ, against in-memory ports.
//
// The screens draw the whole document from one GET: the issuer and where it is
// registered, each line's Dept by name, the money per billing frequency, and
// the PDF's own section plan. The SQL half of each (the GROUP BY, the joins,
// the plan matching the render) runs in document.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const BOOKS = "00000000-0000-0000-0000-0000000000d1";
const GST = "00000000-0000-0000-0000-0000000000d2";
const ADVISORY = "00000000-0000-0000-0000-0000000000d3";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(BOOKS, "books", {
    name: "Monthly bookkeeping",
    ref: "H1",
    module: "FRC",
    group: "FINCOMPLIANCE",
    jurisdictions: ["IN"],
    recurrence: "monthly",
    billingBasis: "fixed",
  });
  fakes.catalogue.publishService(GST, "gst", {
    name: "GST returns",
    ref: "C2",
    module: "TRC",
    recurrence: "monthly",
    billingBasis: "fixed",
  });
  fakes.catalogue.publishService(ADVISORY, "advisory", {
    name: "Board advisory",
    recurrence: "one_time",
    billingBasis: "fixed",
  });
  fakes.proposals.axes.push(
    { axis: "dept", code: "TRC", name: "Transactions & Regulatory Compliance", sortOrder: 2 },
    { axis: "dept", code: "FRC", name: "Financial Reporting & Compliance", sortOrder: 1 },
    { axis: "team", code: "FINCOMPLIANCE", name: "Finance & Compliance", sortOrder: 1 },
  );
  return { ...fakes, service: new ProposalService(fakes) };
}

async function proposalWithThreeLines(s: ReturnType<typeof setup>): Promise<string> {
  const p = await s.service.draft(
    { tenantId: TENANT, partyId: PARTY, title: "FY27", currency: "INR", fxRate: "1", fxRateDate: "2026-06-01" },
    ACTOR,
  );
  const add = (serviceVersionId: string, description: string, unitAmount?: string) =>
    s.service.addLine(
      {
        tenantId: TENANT,
        proposalId: p.id,
        serviceVersionId,
        description,
        quantity: "1",
        discountPercent: "0",
        ...(unitAmount === undefined ? { pricingNote: "As mutually agreed" } : { unitAmount }),
      },
      ACTOR,
    );
  await add(GST, "GST returns", "10000");
  await add(BOOKS, "Monthly bookkeeping", "50000");
  await add(ADVISORY, "Board advisory");
  return p.id;
}

describe("the proposal read, for the builder and the preview (T6.18)", () => {
  it("letters the sections as the PDF does: the firm's Dept order, codes, the no-Dept section last", async () => {
    const s = setup();
    const id = await proposalWithThreeLines(s);
    const view = await s.service.describe(TENANT, id);
    expect(
      view.document.sections.map((section) => ({
        code: section.code,
        title: section.title,
        items: section.items.map((i) => i.code),
      })),
    ).toEqual([
      { code: "A", title: "Financial Reporting & Compliance", items: ["H1"] },
      { code: "B", title: "Transactions & Regulatory Compliance", items: ["C2"] },
      { code: "C", title: "Other services", items: ["C1"] },
    ]);
  });

  it("names each line's Dept and delivery team, and where the service is offered", async () => {
    const s = setup();
    const id = await proposalWithThreeLines(s);
    const lines = (await s.service.describe(TENANT, id)).lines;
    const books = lines.find((l) => l.service?.ref === "H1");
    expect(books?.dept).toEqual({ code: "FRC", name: "Financial Reporting & Compliance" });
    expect(books?.team).toEqual({ code: "FINCOMPLIANCE", name: "Finance & Compliance" });
    expect(books?.service?.jurisdictions).toEqual(["IN"]);
    const advisory = lines.find((l) => l.line.description === "Board advisory");
    expect(advisory?.dept).toBeNull();
    expect(advisory?.service?.jurisdictions).toEqual([]);
  });

  it("gives the money per billing frequency, never only one mixed net", async () => {
    const s = setup();
    const id = await proposalWithThreeLines(s);
    const view = await s.service.describe(TENANT, id);
    expect(view.totalsByFrequency).toEqual([
      { currency: "INR", frequency: "monthly", net: "60000.0000", lineCount: 2, unpricedLineCount: 0 },
      { currency: "INR", frequency: "one_time", net: "0.0000", lineCount: 1, unpricedLineCount: 1 },
    ]);
    // What the client is worth a year (CA#42): the recurring fees over twelve
    // months, never a one-off added in.
    expect(view.annualValue).toEqual([{ amount: "720000.0000", currency: "INR" }]);
  });

  it("names the issuer and where it is registered, null when the firm recorded nowhere", async () => {
    const s = setup();
    const id = await proposalWithThreeLines(s);
    const view = await s.service.describe(TENANT, id);
    expect(view.issuer.partyId).toBe(view.proposal.issuingEntityPartyId);
    expect(view.issuer.jurisdiction).toBeNull();
    s.proposals.partyJurisdictions.set(view.proposal.issuingEntityPartyId, "AE");
    expect((await s.service.describe(TENANT, id)).issuer.jurisdiction).toBe("AE");
  });
});
