// Copying a closed proposal into a new draft (0316), at the use-case level. The
// acceptance: a quote the client turned down, or one that lapsed, starts the
// next draft with every line, price, discount and word exactly as it was, and
// the old quote stays exactly what the client was shown.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import {
  ProposalDeleted,
  ProposalNotCopyable,
} from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ENTITY = "00000000-0000-0000-0000-0000000000dd";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";
const BOOKS_VERSION = "00000000-0000-0000-0000-0000000000d2";

async function setup() {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.catalogue.publishService(BOOKS_VERSION, "bookkeeping", {
    name: "Monthly bookkeeping",
    billingBasis: "retainer",
    listPrice: { amount: "50000.00", currency: "INR" },
  });
  fakes.clock.set("2026-06-15T09:00:00Z");
  fakes.policies.maxPercent = "15";
  await fakes.prose.addStandardBlock(
    { tenantId: TENANT, kind: "exclusion", body: "Anything not in the scope is excluded.", sortOrder: 1, jurisdiction: null },
    ACTOR,
  );
  return { ...fakes, service: new ProposalService(fakes) };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A quote with two lines, one tailored, and its prose edited for the client. */
async function quote(s: Setup, validUntil?: string): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Rocket — FY27 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      background: "Rocket is moving its books to one firm.",
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
    discountPercent: "10",
    billingFrequency: "monthly",
  });
  await s.service.addLine({
    tenantId: TENANT,
    proposalId: p.id,
    entityPartyId: ENTITY,
    serviceVersionId: BOOKS_VERSION,
    description: "Accounting",
    quantity: "1",
    unitAmount: "45000",
    discountPercent: "0",
    volumeLimitsOverride: "≤1,000 entries; ≤8 bank accounts",
    scopeOverride: "Recording and review of monthly transactions.",
    pricingNote: "Plus statutory fees at actuals.",
  });
  const [standard] = (await s.service.describe(TENANT, p.id)).blocks;
  await s.prose.editBlock(TENANT, standard?.id ?? "", { body: "Payroll is excluded for Rocket." });
  await s.prose.addBlock({
    tenantId: TENANT,
    owner: { kind: "proposal", id: p.id },
    kind: "commercial",
    body: "Fees are billed quarterly in advance.",
    sortOrder: 1,
  });
  return p.id;
}

async function rejected(s: Setup): Promise<string> {
  const id = await quote(s);
  await s.service.send(TENANT, id, ACTOR);
  await s.service.decide(TENANT, id, "rejected", ACTOR, "Fees too high");
  return id;
}

describe("copying a rejected proposal into a new draft", () => {
  it("makes a new draft with its own reference, every line exactly as it was", async () => {
    const s = await setup();
    const sourceId = await rejected(s);

    const made = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(made.proposal.status).toBe("draft");
    expect(made.proposal.id).not.toBe(sourceId);
    expect(made.proposal.ref).not.toBe((await s.proposals.findById(TENANT, sourceId))?.ref);
    expect(made.proposal.copiedFromId).toBe(sourceId);
    expect(made.linesCopied).toBe(2);
    expect(made.skipped).toEqual([]);

    const strip = (l: { description: string; quantity: string; unitAmount: string | null; discountPercent: string; billingFrequency: string | null; entityPartyId: string | null; serviceVersionId: string; volumeLimitsOverride: string | null; scopeOverride: string | null; pricingNote: string | null; position: number }) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      discountPercent: l.discountPercent,
      billingFrequency: l.billingFrequency,
      entityPartyId: l.entityPartyId,
      serviceVersionId: l.serviceVersionId,
      volumeLimitsOverride: l.volumeLimitsOverride,
      scopeOverride: l.scopeOverride,
      pricingNote: l.pricingNote,
      position: l.position,
    });
    const before = (await s.proposals.listLines(TENANT, sourceId)).map(strip);
    const after = (await s.proposals.listLines(TENANT, made.proposal.id)).map(strip);
    expect(after).toEqual(before);
  });

  it("carries the head: client, issuer, currency and rate, title, Background", async () => {
    const s = await setup();
    const sourceId = await rejected(s);
    const source = await s.proposals.findById(TENANT, sourceId);

    const { proposal } = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(proposal).toMatchObject({
      partyId: source?.partyId,
      issuingEntityPartyId: source?.issuingEntityPartyId,
      currency: source?.currency,
      fxRate: source?.fxRate,
      fxRateDate: source?.fxRateDate,
      title: source?.title,
      background: source?.background,
      preparedByUserId: PARTNER,
      sentAt: null,
      decidedAt: null,
      declinedReason: null,
    });
  });

  it("copies the prose as it stood — the edited line and the hand-written one — and nothing twice", async () => {
    const s = await setup();
    const sourceId = await rejected(s);

    const { proposal } = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    const text = (id: string) =>
      s.service.describe(TENANT, id).then((r) => r.blocks.map((b) => `${b.kind}:${b.body}`).sort());
    expect(await text(proposal.id)).toEqual(await text(sourceId));
    expect(await text(proposal.id)).toEqual([
      "commercial:Fees are billed quarterly in advance.",
      "exclusion:Payroll is excluded for Rocket.",
    ]);
  });

  it("leaves the rejected quote exactly as the client turned it down", async () => {
    const s = await setup();
    const sourceId = await rejected(s);
    const before = await s.proposals.findById(TENANT, sourceId);
    const linesBefore = await s.proposals.listLines(TENANT, sourceId);

    await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(await s.proposals.findById(TENANT, sourceId)).toEqual(before);
    expect(await s.proposals.listLines(TENANT, sourceId)).toEqual(linesBefore);
  });

  it("links both ways on the page, and records the copy against the OLD quote", async () => {
    const s = await setup();
    const sourceId = await rejected(s);

    const { proposal } = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    const copyView = await s.service.describe(TENANT, proposal.id);
    const sourceView = await s.service.describe(TENANT, sourceId);
    expect(copyView.copiedFrom).toEqual({ id: sourceId, ref: sourceView.proposal.ref, status: "rejected" });
    expect(sourceView.copies).toEqual([{ id: proposal.id, ref: proposal.ref, status: "draft" }]);

    const copied = s.events.recorded.filter((e) => e.verb === "proposal.copied");
    expect(copied).toHaveLength(1);
    expect(copied[0]?.objectId).toBe(sourceId);
    expect(copied[0]?.payload).toMatchObject({ copyId: proposal.id, linesCopied: 2, linesSkipped: 0 });
    const drafted = s.events.recorded.filter(
      (e) => e.verb === "proposal.drafted" && e.objectId === proposal.id,
    );
    expect(drafted[0]?.payload).toMatchObject({ copiedFromId: sourceId });
  });

  it("asks for the discount approval again: the old one was for the old document", async () => {
    const s = await setup();
    s.policies.maxPercent = "5";
    const id = await quote(s);
    await s.service.approveDiscount(TENANT, id, PARTNER, ACTOR);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.decide(TENANT, id, "rejected", ACTOR, "Fees too high");

    const { proposal } = await s.service.copyAsDraft(TENANT, id, ACTOR);

    expect(proposal.discountApprovedBy).toBeNull();
    await expect(s.service.send(TENANT, proposal.id, ACTOR)).rejects.toThrow(/approv/i);
  });

  it("skips a line whose company was archived since, and says why, keeping the rest", async () => {
    const s = await setup();
    const sourceId = await rejected(s);
    s.parties.archive(ENTITY, "Rocket Labs Pvt Ltd");

    const made = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(made.linesCopied).toBe(1);
    expect(made.skipped).toHaveLength(1);
    expect(made.skipped[0]?.description).toBe("Accounting");
    expect(made.skipped[0]?.reason).toMatch(/Rocket Labs Pvt Ltd/);
  });
});

describe("which proposals can be copied", () => {
  it("an expired one — and a sent one past its date is expired first", async () => {
    const s = await setup();
    const id = await quote(s, "2026-06-01"); // the clock is 15 June
    await s.service.send(TENANT, id, ACTOR);
    expect((await s.service.describe(TENANT, id)).copyRefusal).toBeNull();

    const made = await s.service.copyAsDraft(TENANT, id, ACTOR);

    expect((await s.proposals.findById(TENANT, id))?.status).toBe("expired");
    // The date is the reason it expired; the copy does not inherit it.
    expect(made.proposal.validUntil).toBeNull();
  });

  it("keeps a validity date that is still ahead", async () => {
    const s = await setup();
    const id = await quote(s, "2026-07-31");
    await s.service.send(TENANT, id, ACTOR);
    await s.service.decide(TENANT, id, "rejected", ACTOR, "Timing");

    const made = await s.service.copyAsDraft(TENANT, id, ACTOR);

    expect(made.proposal.validUntil).toBe("2026-07-31");
  });

  it("refuses a draft, a sent quote still open, and an accepted one — each saying what to do", async () => {
    const s = await setup();
    const draftId = await quote(s);
    const sentId = await quote(s);
    await s.service.send(TENANT, sentId, ACTOR);
    const acceptedId = await quote(s);
    await s.service.send(TENANT, acceptedId, ACTOR);
    await s.service.decide(TENANT, acceptedId, "accepted", ACTOR);

    for (const [id, words] of [
      [draftId, /still a draft/],
      [sentId, /still has this one/],
      [acceptedId, /engagement letter instead/],
    ] as const) {
      await expect(s.service.copyAsDraft(TENANT, id, ACTOR)).rejects.toThrow(words);
      await expect(s.service.copyAsDraft(TENANT, id, ACTOR)).rejects.toBeInstanceOf(ProposalNotCopyable);
      // The page is told the same sentence before anybody presses.
      expect((await s.service.describe(TENANT, id)).copyRefusal?.message).toMatch(words);
    }
    // Nothing was drafted by any of the refusals.
    expect(s.events.recorded.filter((e) => e.verb === "proposal.copied")).toEqual([]);
  });

  it("refuses a deleted draft as deleted", async () => {
    const s = await setup();
    const id = await quote(s);
    await s.service.delete(TENANT, id, ACTOR);
    await expect(s.service.copyAsDraft(TENANT, id, ACTOR)).rejects.toBeInstanceOf(ProposalDeleted);
  });

  it("a copy of a copy is allowed once the client turns that one down too", async () => {
    const s = await setup();
    const first = await rejected(s);
    const second = (await s.service.copyAsDraft(TENANT, first, ACTOR)).proposal.id;
    await s.service.send(TENANT, second, ACTOR);
    await s.service.decide(TENANT, second, "rejected", ACTOR, "Still too high");

    const third = await s.service.copyAsDraft(TENANT, second, ACTOR);

    expect(third.proposal.copiedFromId).toBe(second);
    expect((await s.service.describe(TENANT, first)).copies.map((c) => c.id)).toEqual([second]);
  });
});
