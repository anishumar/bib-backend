// A proposal lapses at the end of its last day on its COMPANY's calendar
// (0337): a New York company's quote valid until 31 October is still open at
// 22:00 on 31 October in New York, though it is already 1 November in India.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { ProposalExpired } from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";

function setup() {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.timeZones.set("Asia/Kolkata");
  fakes.clock.set("2026-10-01T09:00:00Z");
  return { ...fakes, service: new ProposalService(fakes) };
}

/** Sent, valid until 31 October; its company on New York's clock when asked. */
async function sent(s: ReturnType<typeof setup>, newYork: boolean): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Rocket — FY27 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-10-01",
      validUntil: "2026-10-31",
    },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    proposalId: p.id,
    serviceVersionId: GST_VERSION,
    description: "GST filing",
    quantity: "1",
    unitAmount: "2000",
    discountPercent: "0",
    billingFrequency: "monthly",
  });
  await s.service.send(TENANT, p.id, ACTOR);
  if (newYork) {
    const issuer = (await s.proposals.findById(TENANT, p.id))?.issuingEntityPartyId ?? "";
    s.timeZones.setCompany(issuer, { timeZone: "America/New_York" });
  }
  return p.id;
}

const statement = {
  channel: "call",
  acceptedOn: "2026-10-31",
  acceptedByName: "Ravi Kumar",
  note: "Ravi called and said go ahead with the quote as sent.",
};

describe("a proposal lapses on its company's calendar (0337)", () => {
  // 02:00 UTC on 1 November: 22:00 on 31 October in New York.
  const AT = "2026-11-01T02:00:00Z";

  it("is still open on New York's 31 October for a New York company", async () => {
    const s = setup();
    const id = await sent(s, true);
    s.clock.set(AT);
    await s.service.recordAcceptance(TENANT, id, statement, PARTNER, ACTOR);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("accepted");
  });

  it("has lapsed on India's 1 November for a company on the firm's clock", async () => {
    const s = setup();
    const id = await sent(s, false);
    s.clock.set(AT);
    await expect(s.service.recordAcceptance(TENANT, id, statement, PARTNER, ACTOR)).rejects.toBeInstanceOf(
      ProposalExpired,
    );
  });
});
