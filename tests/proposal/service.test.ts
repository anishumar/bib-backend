// Quoting's rules, against in-memory ports. No database, no HTTP.
//
// What is proven HERE is everything that decides whether a quote may exist and
// may go out: the pin, the draft-only rule, and the discount gate. What is NOT
// proven here is the arithmetic — the totals come from `numeric` in migration
// 0013 and are checked against real Postgres in pricing.integration.test.ts,
// because a second implementation of the formula is exactly the thing that ends
// up disagreeing.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { parseShareToken } from "../../src/domain/proposal/model";
import {
  AlreadyApproved,
  ApprovalNotNeeded,
  DiscountNeedsApproval,
  EmptyProposal,
  InvalidDecision,
  InvalidFxRate,
  InvalidQuoteCurrency,
  InvalidTransition,
  InvalidUnitAmount,
  NotADraft,
  NotAService,
  ProposalExpired,
  ProposalNotFound,
  ServiceNotFound,
  ShareLinkUnknown,
  ServiceNotPublished,
} from "../../src/domain/proposal/errors";
import { NoIssuingEntity } from "../../src/domain/document/errors";
import { SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";
/** One of the FIRM's own entities, beside the fallback it is seeded with. */
const US_ENTITY = "00000000-0000-0000-0000-0000000000e2";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draftWith(
  s: ReturnType<typeof setup>,
  overrides: { validUntil?: string } = {},
): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      ...overrides,
    },
    ACTOR,
  );
  return p.id;
}

describe("drafting", () => {
  it("gives the document a number a client can quote back", async () => {
    // G1.1's acceptance. The id is the system's name for this document; the ref
    // is the firm's, and it is what somebody reads down the phone.
    const s = setup();
    const p = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        title: "Acme — FY26",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      ACTOR,
    );
    // The clock the fakes carry is fixed at 2026-06-01.
    expect(p.ref).toBe("PR-2026-0001");
    const second = await draftWith(s);
    expect((await s.proposals.findById(TENANT, second))?.ref).toBe("PR-2026-0002");
  });

  it("names which of the firm's own entities is offering", async () => {
    // G1.2's acceptance, on the proposal side. Resolved through the firm's
    // fallback ROW — the one every tenant is seeded with — and then STORED,
    // because the rule may change and an issued document must always say who
    // actually issued it.
    const s = setup();
    const p = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        title: "Acme — FY26",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      ACTOR,
    );
    expect(p.issuingEntityPartyId).toBe(SEEDED_FIRM_ENTITY);
    expect(s.events.recorded[0]?.payload).toMatchObject({
      ref: "PR-2026-0001",
      issuingEntityPartyId: SEEDED_FIRM_ENTITY,
    });
  });

  it("lets a partner name the entity for this document only", async () => {
    // "with flexibility to choose" — the override, which does not touch the
    // firm's standing rule.
    const s = setup();
    await s.firmEntities.set({
      id: "pref-us",
      tenantId: TENANT,
      clientJurisdiction: "US",
      firmEntityPartyId: US_ENTITY,
      note: null,
    });
    const chosen = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        issuingEntityPartyId: US_ENTITY,
        title: "Acme — FY26",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      ACTOR,
    );
    expect(chosen.issuingEntityPartyId).toBe(US_ENTITY);
    // And the client's country picks the same entity when nobody says.
    const byRule = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        clientJurisdiction: "US",
        title: "Acme — FY26 (2)",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      ACTOR,
    );
    expect(byRule.issuingEntityPartyId).toBe(US_ENTITY);
  });

  it("refuses to draft at all for a firm that has named no entity", async () => {
    // A document that cannot say who is contracting is not a document, so this
    // fails closed and the message names the row that is missing.
    const s = setup();
    s.firmEntities.seededFallbackPartyId = null;
    await expect(draftWith(s)).rejects.toBeInstanceOf(NoIssuingEntity);
    expect(s.proposals.rows).toHaveLength(0);
  });

  it("fixes the currency and the rate at the top of the document", async () => {
    const s = setup();
    const p = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        title: "Gulf Advisory — VAT",
        currency: " aed ",
        fxRate: "23.4500",
        fxRateDate: "2026-06-01",
      },
      ACTOR,
    );
    expect(p.currency).toBe("AED");
    expect(p.status).toBe("draft");
    expect(p.sentAt).toBeNull();
  });

  it.each([["Rs"], ["rupees"], [""], ["IN1"]])("refuses %j as a quote currency", async (c) => {
    const s = setup();
    await expect(
      s.service.draft(
        {
          tenantId: TENANT,
          partyId: PARTY,
          title: "x",
          currency: c,
          fxRate: "1",
          fxRateDate: "2026-06-01",
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidQuoteCurrency);
  });

  it.each([["0"], ["-1"], ["one"], ["1.000000001"]])(
    "refuses %j as an exchange rate",
    async (rate) => {
      // Zero in particular: it would make every converted total zero, and
      // nothing would look wrong until somebody ran a report.
      const s = setup();
      await expect(
        s.service.draft(
          {
            tenantId: TENANT,
            partyId: PARTY,
            title: "x",
            currency: "AED",
            fxRate: rate,
            fxRateDate: "2026-06-01",
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(InvalidFxRate);
    },
  );

  it("records the drafting, and keeps the title out of the ledger", async () => {
    // A proposal is routinely titled "Acme Ltd — FY26 audit". The log cannot be
    // erased; the row it points at can.
    const s = setup();
    const id = await draftWith(s);
    const drafted = s.events.recorded.find((e) => e.verb === "proposal.drafted");
    expect(drafted?.objectId).toBe(id);
    expect(drafted?.payload).toMatchObject({ partyId: PARTY, currency: "INR", fxRate: "1" });
    expect(JSON.stringify(s.events.recorded)).not.toContain("Acme");
  });
});

describe("quoting a line", () => {
  it("pins the catalogue version and inherits the proposal's currency", async () => {
    const s = setup();
    const id = await draftWith(s);
    const line = await s.service.addLine({
      tenantId: TENANT,
      proposalId: id,
      serviceVersionId: GST_VERSION,
      description: "GST filing, 12 months",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "0",
    });
    expect(line.serviceVersionId).toBe(GST_VERSION);
    // Never the caller's to state: the composite key in 0011 would refuse a
    // different one anyway, and a rule explained beats a foreign-key 500.
    expect(line.currency).toBe("INR");
    expect(line.position).toBe(1);
  });

  it("refuses a version this firm does not have", async () => {
    const s = setup();
    const id = await draftWith(s);
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: "00000000-0000-0000-0000-00000000dead",
        description: "x",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(ServiceNotFound);
  });

  it("refuses a DRAFT catalogue version, and accepts an ARCHIVED one", async () => {
    // The asymmetry is the whole point of pinning. A draft was never in force,
    // so a price the firm never agreed to must not reach a client's document.
    // An archived version is exactly what a pin resolves to once the catalogue
    // moves on, and refusing it would break every proposal older than the last
    // catalogue edit.
    const s = setup();
    const id = await draftWith(s);
    s.catalogue.add("00000000-0000-0000-0000-0000000000d2", {
      kind: "service",
      status: "draft",
      key: "advisory",
      version: 1,
      body: { name: "Advisory", billingBasis: "hourly" },
    });
    s.catalogue.add("00000000-0000-0000-0000-0000000000d3", {
      kind: "service",
      status: "archived",
      key: "gst-filing",
      version: 1,
      body: { name: "GST monthly filing (2025)", billingBasis: "fixed" },
    });

    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: "00000000-0000-0000-0000-0000000000d2",
        description: "x",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(ServiceNotPublished);

    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: "00000000-0000-0000-0000-0000000000d3",
        description: "last year's scope",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a version that is a role, not a service", async () => {
    const s = setup();
    const id = await draftWith(s);
    s.catalogue.add("00000000-0000-0000-0000-0000000000d4", {
      kind: "role",
      status: "published",
      key: "partner",
      version: 1,
      body: { label: "Partner", permissions: [] },
    });
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: "00000000-0000-0000-0000-0000000000d4",
        description: "x",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(NotAService);
  });

  it("refuses an amount given as anything but a decimal string", async () => {
    const s = setup();
    const id = await draftWith(s);
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: GST_VERSION,
        description: "x",
        quantity: "1",
        unitAmount: "1,499.50",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(InvalidUnitAmount);
  });

  it("refuses to change a proposal that has been sent", async () => {
    const s = setup();
    const id = await draftWith(s);
    await addGst(s, id, "0");
    await s.service.send(TENANT, id, ACTOR);
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        proposalId: id,
        serviceVersionId: GST_VERSION,
        description: "one more thing",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(NotADraft);
  });
});

describe("the discount gate", () => {
  it("blocks a send when no policy is published — silence is not permission", async () => {
    // A firm that has never set a limit has not decided that anything goes.
    // Fail-open on that silence is the reading nobody can audit.
    const s = setup();
    const id = await draftWith(s);
    await addGst(s, id, "5");
    const err = await s.service.send(TENANT, id, ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscountNeedsApproval);
    expect((err as Error).message).toContain("no discount policy");
    expect((err as Error).message).toContain("maxDiscountPercent");
  });

  it("lets a discount within the firm's limit go straight out", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "10");
    const { proposal: sent } = await s.service.send(TENANT, id, ACTOR);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
  });

  it("blocks a discount past the limit until somebody signs it off", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "40");

    const err = await s.service.send(TENANT, id, ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscountNeedsApproval);
    expect((err as Error).message).toContain("40");
    expect((err as Error).message).toContain("15");

    const approved = await s.service.approveDiscount(TENANT, id, PARTNER, ACTOR);
    expect(approved.discountApprovedBy).toBe(PARTNER);

    const { proposal: sent } = await s.service.send(TENANT, id, ACTOR);
    expect(sent.status).toBe("sent");
  });

  it("judges the LARGEST line discount, not the average", async () => {
    // Averaging would let 40% off one line through beside a full-price line —
    // exactly the trade somebody would make to avoid asking.
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "0");
    await addGst(s, id, "40");
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(DiscountNeedsApproval);
  });

  it("refuses an approval nobody needed", async () => {
    // Recording one would put a signature in an append-only log for a decision
    // that was never asked for, and that log cannot be corrected afterwards.
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "10");
    await expect(
      s.service.approveDiscount(TENANT, id, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(ApprovalNotNeeded);
  });

  it("refuses a second sign-off for one decision", async () => {
    // The log cannot be corrected, so two approval events for one decision
    // would show two people-shaped acts where there was one.
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "40");
    await s.service.approveDiscount(TENANT, id, PARTNER, ACTOR);
    await expect(
      s.service.approveDiscount(TENANT, id, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(AlreadyApproved);
    expect(s.events.recorded.filter((e) => e.verb === "proposal.discount_approved")).toHaveLength(
      1,
    );
  });

  it("records who approved it and the limit as it was", async () => {
    // The limit is recorded rather than re-derived: the policy may have changed
    // by the time somebody queries the margin a year later.
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "40");
    await s.service.approveDiscount(TENANT, id, PARTNER, ACTOR);
    const approved = s.events.recorded.find((e) => e.verb === "proposal.discount_approved");
    expect(approved?.payload).toMatchObject({
      approvedByUserId: PARTNER,
      largestDiscountPercent: "40",
      limitPercent: "15",
    });
  });
});

describe("sending and deciding", () => {
  it("refuses to send a proposal that offers nothing", async () => {
    const s = setup();
    const id = await draftWith(s);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(EmptyProposal);
  });

  it("is one-way: a sent proposal cannot be un-sent or re-sent", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "0");
    await s.service.send(TENANT, id, ACTOR);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(NotADraft);
  });

  it("records the client's decision, and refuses a second one", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "0");
    await s.service.send(TENANT, id, ACTOR);

    const accepted = await s.service.decide(TENANT, id, "accepted", ACTOR);
    expect(accepted.status).toBe("accepted");
    expect(accepted.decidedAt).not.toBeNull();
    expect(s.events.verbs()).toContain("proposal.accepted");

    await expect(s.service.decide(TENANT, id, "rejected", ACTOR)).rejects.toBeInstanceOf(
      InvalidTransition,
    );
  });

  it("refuses a decision that is not one a recipient can give", async () => {
    const s = setup();
    const id = await draftWith(s);
    await expect(s.service.decide(TENANT, id, "expired", ACTOR)).rejects.toBeInstanceOf(
      InvalidDecision,
    );
  });

  it("expires a lapsed proposal at the moment somebody tries to accept it", async () => {
    // Nothing in this system runs on a timer. A proposal past its date would
    // otherwise sit in `sent` forever, or be pretended-expired by a read that
    // leaves the row saying something else.
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s, { validUntil: "2026-05-01" }); // the fake clock is June
    await addGst(s, id, "0");
    await s.service.send(TENANT, id, ACTOR);

    await expect(s.service.decide(TENANT, id, "accepted", ACTOR)).rejects.toBeInstanceOf(
      ProposalExpired,
    );
    const after = await s.proposals.findById(TENANT, id);
    expect(after?.status).toBe("expired");
    expect(s.events.verbs()).toContain("proposal.expired");
  });

  it("is still valid ON its last day, not until midnight UTC", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    // The fake clock is 2026-06-01T09:00:00Z.
    const id = await draftWith(s, { validUntil: "2026-06-01" });
    await addGst(s, id, "0");
    await s.service.send(TENANT, id, ACTOR);
    await expect(s.service.decide(TENANT, id, "accepted", ACTOR)).resolves.toBeDefined();
  });

  it("answers a proposal that is not this firm's with not-found", async () => {
    const s = setup();
    await expect(
      s.service.describe(TENANT, "00000000-0000-0000-0000-00000000beef"),
    ).rejects.toBeInstanceOf(ProposalNotFound);
  });
});

describe("the share link", () => {
  async function sent(s: ReturnType<typeof setup>): Promise<{ id: string; token: string }> {
    s.policies.maxPercent = "15";
    const id = await draftWith(s);
    await addGst(s, id, "0");
    const result = await s.service.send(TENANT, id, ACTOR);
    return { id, token: result.shareToken };
  }

  it("is issued at SEND, and carries the tenant it belongs to", async () => {
    // The tenant travels in the token so that opening it is still an ordinary
    // tenant-scoped read. Looking a digest up across every firm would need a
    // query RLS does not scope, on a table that holds money.
    const s = setup();
    const { token } = await sent(s);
    expect(parseShareToken(token)?.tenantId).toBe(TENANT);
    expect(parseShareToken(token)?.secret).not.toBe("");
  });

  it("stores only the digest, never the token", async () => {
    const s = setup();
    const { token } = await sent(s);
    // The fake keeps what the adapter keeps: digests, keyed to proposals.
    expect([...s.proposals.shareDigests.keys()]).toEqual([s.shareTokens.hash(token)]);
    expect(JSON.stringify([...s.proposals.rows])).not.toContain(token);
  });

  it("shows the recipient the document, and nothing about the firm's insides", async () => {
    const s = setup();
    const { token } = await sent(s);
    const shared = await s.service.viewShared(token, { type: "system", id: null });
    expect(shared.firmName).not.toBe("");
    expect(shared.lines).toHaveLength(1);
    // Its own read model, not the staff one with fields nulled — so these are
    // absent rather than null, and a field added for colleagues cannot arrive
    // here by default.
    const keys = Object.keys(shared);
    for (const internal of ["partyId", "leadId", "fxRate", "discountApprovedBy"]) {
      expect(keys).not.toContain(internal);
    }
    expect(JSON.stringify(shared)).not.toContain(GST_VERSION);
  });

  it("counts every open and records only the first", async () => {
    // The count is commercial signal; the event is a state transition. A client
    // refreshing a page is not fifty facts about the business.
    const s = setup();
    const { id, token } = await sent(s);
    const anon = { type: "system" as const, id: null };
    await s.service.viewShared(token, anon);
    await s.service.viewShared(token, anon);
    await s.service.viewShared(token, anon);

    const after = await s.proposals.findById(TENANT, id);
    expect(after?.viewCount).toBe(3);
    expect(after?.firstViewedAt).not.toBeNull();
    expect(s.events.recorded.filter((e) => e.verb === "proposal.viewed")).toHaveLength(1);
  });

  it.each([["not-a-token"], [""], ["...."], ["00000000-0000-0000-0000-000000000001.nope"]])(
    "answers %j the same way it answers an unknown link",
    async (token) => {
      // One answer for malformed, unknown and withdrawn. Telling them apart
      // lets somebody probing learn which firms exist and which links used to,
      // and a real recipient cannot act on the difference anyway.
      const s = setup();
      await expect(
        s.service.viewShared(token, { type: "system", id: null }),
      ).rejects.toBeInstanceOf(ShareLinkUnknown);
    },
  );

  it("expires a lapsed proposal when the recipient opens it", async () => {
    const s = setup();
    s.policies.maxPercent = "15";
    const id = await draftWith(s, { validUntil: "2026-05-01" }); // the fake clock is June
    await addGst(s, id, "0");
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);

    await expect(
      s.service.viewShared(shareToken, { type: "system", id: null }),
    ).rejects.toBeInstanceOf(ProposalExpired);
    const after = await s.proposals.findById(TENANT, id);
    expect(after?.status).toBe("expired");
    // Not counted: they never saw it.
    expect(after?.viewCount).toBe(0);
  });

  it("keeps working after the client's decision is recorded", async () => {
    // A client who accepted still needs to be able to re-read what they agreed
    // to. Only expiry closes the link.
    const s = setup();
    const { id, token } = await sent(s);
    await s.service.decide(TENANT, id, "accepted", ACTOR);

    const shared = await s.service.viewShared(token, { type: "system", id: null });
    expect(shared.id).toBe(id);
    expect(shared.status).toBe("accepted");
  });
});

async function addGst(
  s: ReturnType<typeof setup>,
  proposalId: string,
  discountPercent: string,
): Promise<void> {
  await s.service.addLine({
    tenantId: TENANT,
    proposalId,
    serviceVersionId: GST_VERSION,
    description: "GST monthly filing",
    quantity: "1",
    unitAmount: "25000.00",
    discountPercent,
  });
}
