// A proposal the client accepted OUTSIDE the link, recorded by a colleague
// holding `acceptance:record` (0317). The acceptance: how, when, who and a
// note are required, a file is optional, only a sent proposal within its date
// can be accepted this way, and the ledger says how and never who.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { InvalidTransition, ProposalExpired } from "../../src/domain/proposal/errors";
import { AcceptanceInvalid, AcceptThroughRecord, EvidenceNotFiledHere } from "../../src/domain/acceptance/errors";
import { mapError } from "../../src/api/domainerr";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";
const EMAIL_FILE = "00000000-0000-0000-0000-00000000f11e";

function setup() {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.clock.set("2026-06-15T09:00:00Z");
  return { ...fakes, service: new ProposalService(fakes) };
}
type Setup = ReturnType<typeof setup>;

async function sent(s: Setup, validUntil?: string): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Rocket — FY27 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      ...(validUntil === undefined ? {} : { validUntil }),
    },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    proposalId: p.id,
    serviceVersionId: GST_VERSION,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
    billingFrequency: "monthly",
  });
  await s.service.send(TENANT, p.id, ACTOR);
  return p.id;
}

const statement = (over: Record<string, string | undefined> = {}) => ({
  channel: "call",
  acceptedOn: "2026-06-15",
  acceptedByName: "Ravi Kumar",
  note: "Ravi called Siddharth and said go ahead with the quote as sent.",
  ...over,
});

describe("recording a proposal the client accepted outside the link", () => {
  it("accepts it with how, when, who and a note — no file needed", async () => {
    const s = setup();
    const id = await sent(s);

    const accepted = await s.service.recordAcceptance(TENANT, id, statement(), PARTNER, ACTOR);

    expect(accepted.status).toBe("accepted");
    const record = await s.service.describe(TENANT, id);
    expect(record.recordedAcceptance).toMatchObject({
      channel: "call",
      acceptedOn: "2026-06-15",
      acceptedByName: "Ravi Kumar",
      evidenceDocumentId: null,
      recordedBy: { userId: PARTNER },
    });
    expect(record.clientDecision).toBeNull();
  });

  it("says how on the ledger, and never the client's name or the note", async () => {
    const s = setup();
    const id = await sent(s);
    await s.service.recordAcceptance(TENANT, id, statement(), PARTNER, ACTOR);

    const event = s.events.recorded.find((e) => e.verb === "proposal.accepted");
    expect(event?.payload).toMatchObject({ via: "recorded", channel: "call", evidenceFiled: false });
    expect(JSON.stringify(event?.payload)).not.toMatch(/Ravi|go ahead/);
    expect(event).toMatchObject({ actorType: "human", actorId: PARTNER });
  });

  it("keeps a file only when it is attached to THIS proposal", async () => {
    const s = setup();
    const id = await sent(s);
    await expect(
      s.service.recordAcceptance(TENANT, id, statement({ evidenceDocumentId: EMAIL_FILE }), PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EvidenceNotFiledHere);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("sent");

    s.proposals.evidenceLinks.add(`${id}:${EMAIL_FILE}`);
    await s.service.recordAcceptance(TENANT, id, statement({ evidenceDocumentId: EMAIL_FILE }), PARTNER, ACTOR);
    expect((await s.service.describe(TENANT, id)).recordedAcceptance?.evidenceDocumentId).toBe(EMAIL_FILE);
  });

  it("refuses a lapsed proposal and marks it expired: it is copied, never accepted late", async () => {
    const s = setup();
    const id = await sent(s, "2026-06-20");
    s.clock.set("2026-06-25T09:00:00Z");

    await expect(
      s.service.recordAcceptance(TENANT, id, statement({ acceptedOn: "2026-06-19" }), PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(ProposalExpired);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("expired");
  });

  it("refuses one already answered, a day before it went out, and a day not yet come", async () => {
    const s = setup();
    const id = await sent(s);
    for (const bad of [{ acceptedOn: "2026-06-14" }, { acceptedOn: "2026-06-16" }, { acceptedByName: " " }]) {
      await expect(s.service.recordAcceptance(TENANT, id, statement(bad), PARTNER, ACTOR)).rejects.toBeInstanceOf(
        AcceptanceInvalid,
      );
    }
    await s.service.decide(TENANT, id, "rejected", ACTOR, "Too dear");
    await expect(s.service.recordAcceptance(TENANT, id, statement(), PARTNER, ACTOR)).rejects.toBeInstanceOf(
      InvalidTransition,
    );
  });

  it("maps the refusal /decision now gives an acceptance to a 409 naming the way", () => {
    expect(mapError(new AcceptThroughRecord())).toMatchObject({
      status: 409,
      reason: "ACCEPT_THROUGH_RECORD",
    });
  });
});
