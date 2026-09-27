// Deleting a draft proposal made by mistake (0086), at the use-case level. The
// acceptance: a draft nobody was ever sent comes off the list of quotes, stays
// readable by id, and never changes again — while a proposal that went out,
// and one a live letter cites, stay exactly where they are.
//
// The database half — the guard trigger, and a deleted draft being final even
// to a psql session — is proven in tests/deletion/deletion.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import {
  NotOutForAnswer,
  ProposalCitedByLetter,
  ProposalDeleted,
  ProposalLeadDeleted,
  ProposalNotDeletable,
  ProposalNotFound,
} from "../../src/domain/proposal/errors";
import { proposalDeletionBlock } from "../../src/domain/proposal/model";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";
const LEAD = "00000000-0000-0000-0000-0000000000f1";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.proposals.accounts.set(PARTNER, { displayName: "Anish", email: "anish@firm.example" });
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draft(s: ReturnType<typeof setup>, leadId?: string): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      ...(leadId === undefined ? {} : { leadId }),
    },
    ACTOR,
  );
  return p.id;
}

async function addLine(s: ReturnType<typeof setup>, proposalId: string): Promise<void> {
  await s.service.addLine({
    tenantId: TENANT,
    proposalId,
    serviceVersionId: GST_VERSION,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
}

describe("deleting a draft made by mistake", () => {
  it("takes it off the list, under every filter, and says who deleted it", async () => {
    const s = setup();
    const id = await draft(s);

    const deleted = await s.service.delete(TENANT, id, ACTOR);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedByUserId).toBe(PARTNER);
    // Still a draft: a deletion is not a status, and nothing about the row but
    // the two columns moved.
    expect(deleted.status).toBe("draft");
    expect(await s.service.list(TENANT, {})).toEqual([]);
    expect(await s.service.list(TENANT, { status: "draft" })).toEqual([]);
    expect(await s.service.list(TENANT, { partyId: PARTY })).toEqual([]);
  });

  it("still opens by id, marked, naming who deleted it", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);

    const view = await s.service.describe(TENANT, id);
    expect(view.proposal.deletedAt).not.toBeNull();
    expect(view.deletedBy?.displayName).toBe("Anish");
    expect(view.deleteRefusal?.code).toBe("PROPOSAL_DELETED");
  });

  it("records one proposal.deleted with the reference, never the title", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);

    const recorded = s.events.recorded.filter((e) => e.verb === "proposal.deleted");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({ ref: "PR-2026-0001", partyId: PARTY });
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain("Acme");
  });

  it("is final: nothing about a deleted draft changes again", async () => {
    const s = setup();
    const id = await draft(s);
    await addLine(s, id);
    await s.service.delete(TENANT, id, ACTOR);

    await expect(s.service.delete(TENANT, id, ACTOR)).rejects.toBeInstanceOf(ProposalDeleted);
    await expect(addLine(s, id)).rejects.toBeInstanceOf(ProposalDeleted);
    await expect(s.service.revise({ tenantId: TENANT, proposalId: id, title: "x" })).rejects.toBeInstanceOf(
      ProposalDeleted,
    );
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(ProposalDeleted);
    await expect(s.service.decide(TENANT, id, "accepted", ACTOR)).rejects.toBeInstanceOf(
      ProposalDeleted,
    );
    // Its lines were never struck one by one: the document went, whole.
    const lines = s.proposals.lines.filter((l) => l.proposalId === id);
    expect(lines.every((l) => !l.removed)).toBe(true);
  });

  it("does not reuse the reference: the next draft takes the next number", async () => {
    const s = setup();
    const first = await draft(s);
    await s.service.delete(TENANT, first, ACTOR);
    const second = await draft(s);
    expect((await s.service.describe(TENANT, second)).proposal.ref).toBe("PR-2026-0002");
  });

  it("answers for a proposal that does not exist as not found", async () => {
    await expect(
      setup().service.delete(TENANT, "00000000-0000-0000-0000-00000000ffff", ACTOR),
    ).rejects.toBeInstanceOf(ProposalNotFound);
  });
});

describe("what a proposal that is not a mistake keeps", () => {
  it("refuses one that was sent — the client holds it", async () => {
    const s = setup();
    const id = await draft(s);
    await addLine(s, id);
    await s.service.send(TENANT, id, ACTOR);

    const refused = s.service.delete(TENANT, id, ACTOR);
    await expect(refused).rejects.toBeInstanceOf(ProposalNotDeletable);
    await expect(refused).rejects.toThrow(/PR-2026-0001 is sent, and only a draft/);
    expect((await s.service.describe(TENANT, id)).deleteRefusal?.code).toBe(
      "PROPOSAL_NOT_DELETABLE",
    );
  });

  it("refuses while a live letter cites it, and names the letter", async () => {
    const s = setup();
    const id = await draft(s);
    s.proposals.citeFrom(id, "EL-2026-0003");

    const refused = s.service.delete(TENANT, id, ACTOR);
    await expect(refused).rejects.toBeInstanceOf(ProposalCitedByLetter);
    await expect(refused).rejects.toThrow(/Engagement letter EL-2026-0003 cites this proposal/);
    expect(s.events.verbs()).not.toContain("proposal.deleted");
  });

  it("offers Delete on a live draft, and only there", async () => {
    const s = setup();
    const id = await draft(s);
    expect((await s.service.describe(TENANT, id)).deleteRefusal).toBeNull();
  });
});

describe("a deleted lead gains no proposal", () => {
  it("refuses drafting from it, before a reference number is spent", async () => {
    const s = setup();
    s.leads.delete(LEAD);
    await expect(draft(s, LEAD)).rejects.toBeInstanceOf(ProposalLeadDeleted);
    expect(s.proposals.rows).toHaveLength(0);
    expect(s.events.recorded).toHaveLength(0);
  });

  it("drafts from a live lead as it always did", async () => {
    const s = setup();
    s.leads.capture(LEAD);
    const id = await draft(s, LEAD);
    expect((await s.service.describe(TENANT, id)).proposal.leadId).toBe(LEAD);
  });
});

describe("a deleted draft has no link to reissue", () => {
  it("is not out for an answer", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);
    await expect(s.service.reissue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(NotOutForAnswer);
  });
});

describe("proposalDeletionBlock — the rule, alone", () => {
  it("names the deletion first, then the status, then what cites it", () => {
    expect(
      proposalDeletionBlock({ status: "draft", deletedAt: "2026-06-01T09:30:00.000Z" }, ["EL-1"]),
    ).toEqual({ kind: "deleted" });
    expect(proposalDeletionBlock({ status: "accepted", deletedAt: null }, ["EL-1"])).toEqual({
      kind: "not_draft",
      status: "accepted",
    });
    expect(proposalDeletionBlock({ status: "draft", deletedAt: null }, ["EL-1"])).toEqual({
      kind: "letters",
      refs: ["EL-1"],
    });
    expect(proposalDeletionBlock({ status: "draft", deletedAt: null }, [])).toBeNull();
  });
});
