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
async function sent(s: ReturnType<typeof setup>, newYork: boolean, validUntil = "2026-10-31"): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Rocket — FY27 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-10-01",
      validUntil,
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

// FINAL REVIEW #4: a recorded acceptance's date is the RECORDER's statement of
// a day. Their screen sends its own today (asOf), held to the company's day or
// one either side, so a partner in Delhi at 09:00 on 1 November can record a
// New York company's quote as accepted "today" while New York is still on
// 31 October.
describe("a recorded acceptance takes the recorder's day, held to the company's (0337)", () => {
  // 03:30 UTC on 1 November: 09:00 on 1 November in India, 23:30 on 31 October in New York.
  const AT = "2026-11-01T03:30:00Z";
  const today = { ...statement, acceptedOn: "2026-11-01" };

  it("records India's 1 November for a New York company when the recorder says it is today", async () => {
    const s = setup();
    const id = await sent(s, true, "2026-11-30");
    s.clock.set(AT);
    await s.service.recordAcceptance(TENANT, id, today, PARTNER, ACTOR, "2026-11-01");
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("accepted");
  });

  it("refuses a recorder's day two days off the company's", async () => {
    const s = setup();
    const id = await sent(s, true, "2026-11-30");
    s.clock.set(AT);
    await expect(
      s.service.recordAcceptance(TENANT, id, { ...statement, acceptedOn: "2026-11-02" }, PARTNER, ACTOR, "2026-11-02"),
    ).rejects.toThrow(/cannot be today where you are/);
  });
});
