// The proposal by email, and the client's own answer (0085) — against in-memory
// ports. No database, no mail server, no renderer.
//
// What is proven HERE is every rule a person meets: the address is checked
// before anything moves; a mail server or a render that fails leaves a SENT
// proposal and says so beside the link; the link's page answers once, with a
// name, and an acceptance only with the statement ticked; the evidence is kept
// and none of it reaches the ledger; the colleague who prepared it is told.
// What the database adds — the one-answer WHERE, the foreign keys, the
// CHECKs — is proven in email.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { acceptanceStatement } from "../../src/domain/proposal/model";
import {
  AcceptanceNotConfirmed,
  AlreadyAnswered,
  EmailUnavailable,
  InvalidRecipient,
  NotOutForAnswer,
  ProposalExpired,
  ShareLinkUnknown,
  SignerNameRequired,
} from "../../src/domain/proposal/errors";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { SharedAnswerInput } from "../../src/usecase/proposal/service";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const PARTNER = "00000000-0000-0000-0000-0000000000cc";
const PRIYA = "00000000-0000-0000-0000-0000000000f1";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST_VERSION = "00000000-0000-0000-0000-0000000000d1";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(GST_VERSION, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.parties.know(PRIYA, "Priya Sharma", "person").know(PARTY, "Nexus Fintech");
  fakes.structure.record(PARTY, { people: [PRIYA], entities: [] });
  fakes.proposals.partyNames.set(PARTY, "Nexus Fintech");
  fakes.proposals.partyNames.set(PRIYA, "Priya Sharma");
  fakes.proposals.partyEmails.set(PRIYA, "priya@nexus.example");
  fakes.proposals.accounts.set(PARTNER, { displayName: "Sahil Kohli", email: "sahil@firm.example" });
  return { ...fakes, service: new ProposalService(fakes) };
}

/** A draft with one priced line, prepared for Priya, ready to send. */
async function ready(
  s: ReturnType<typeof setup>,
  overrides: { validUntil?: string } = {},
): Promise<string> {
  const p = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      title: "Proposal for Services",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      addressedToPartyId: PRIYA,
      ...overrides,
    },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    proposalId: p.id,
    serviceVersionId: GST_VERSION,
    description: "GST monthly filing",
    quantity: "1",
    unitAmount: "25000.00",
    discountPercent: "0",
  });
  return p.id;
}

function answer(token: string, overrides: Partial<SharedAnswerInput> = {}): SharedAnswerInput {
  return {
    token,
    decision: "accepted",
    signerName: "Priya Sharma",
    confirmed: true,
    ipAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 (test)",
    ...overrides,
  };
}

describe("sending by email", () => {
  it("emails the client the PDF of record, with buttons that open the link", async () => {
    const s = setup();
    const id = await ready(s);
    const result = await s.service.send(TENANT, id, ACTOR, {
      to: "priya@nexus.example",
      note: "As discussed on Tuesday.",
    });

    expect(result.proposal.status).toBe("sent");
    expect(result.email).toMatchObject({ status: "sent", to: "priya@nexus.example" });
    const [letter] = s.mailer.letters;
    expect(letter).toMatchObject({
      to: "priya@nexus.example",
      // A reply reaches the colleague who prepared it, not a no-reply box.
      replyTo: "sahil@firm.example",
      preparedBy: "Sahil Kohli",
      greetingName: "Priya Sharma",
      clientName: "Nexus Fintech",
      ref: "PR-2026-0001",
      note: "As discussed on Tuesday.",
    });
    // The buttons OPEN the page with an answer ready; they do not answer.
    const view = `https://app.example.test/p/${result.shareToken}`;
    expect(letter?.viewUrl).toBe(view);
    expect(letter?.acceptUrl).toBe(`${view}?answer=accept`);
    expect(letter?.declineUrl).toBe(`${view}?answer=decline`);
    expect(letter?.pdf.filename).toBe("PR-2026-0001.pdf");
    expect(letter?.pdf.bytes.byteLength).toBeGreaterThan(0);
  });

  it("pins the PDF it attached, and records the email — never the address in the ledger", async () => {
    const s = setup();
    const id = await ready(s);
    const result = await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });

    const [pdf] = s.pdfs.filed;
    expect(result.proposal.sentPdfVersionId).toBe(pdf?.versionId);
    expect(s.proposals.emails).toEqual([
      expect.objectContaining({
        toEmail: "priya@nexus.example",
        note: null,
        pdfVersionId: pdf?.versionId,
        linkDigest: s.shareTokens.hash(result.shareToken),
        sentBy: PARTNER,
      }),
    ]);
    const emailed = s.events.recorded.find((e) => e.verb === "proposal.emailed");
    expect(emailed?.payload).toMatchObject({ pdfContentHash: pdf?.contentHash });
    expect(JSON.stringify(s.events.recorded)).not.toContain("priya@nexus.example");
  });

  it("refuses an address that is not one BEFORE anything moves", async () => {
    const s = setup();
    const id = await ready(s);
    await expect(s.service.send(TENANT, id, ACTOR, { to: "priya at nexus" })).rejects.toBeInstanceOf(
      InvalidRecipient,
    );
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("draft");
    expect(s.events.recorded.map((e) => e.verb)).not.toContain("proposal.sent");
  });

  it("keeps the proposal SENT and says why when the mail server refuses", async () => {
    // The link is readable once — throwing here would lose it. So the failure
    // comes back beside it, and nothing claims an email went.
    const s = setup();
    const id = await ready(s);
    s.mailer.failWith = new Error("535 Username and Password not accepted");
    const result = await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });

    expect(result.proposal.status).toBe("sent");
    expect(result.shareToken).not.toBe("");
    expect(result.email).toEqual({
      status: "failed",
      to: "priya@nexus.example",
      reason: "535 Username and Password not accepted",
    });
    expect(s.proposals.emails).toHaveLength(0);
    expect(s.events.recorded.map((e) => e.verb)).not.toContain("proposal.emailed");
  });

  it("says so the same way when the PDF cannot be rendered", async () => {
    const s = setup();
    const id = await ready(s);
    s.pdfs.failWith = new Error("the cover artwork is not a PNG or JPEG");
    const result = await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });
    expect(result.proposal.status).toBe("sent");
    expect(result.email).toMatchObject({ status: "failed", reason: /cover artwork/ });
    expect(s.mailer.letters).toHaveLength(0);
  });

  it("refuses an email in a process with no mailer, before anything moves", async () => {
    // The worker composes this service to read quotes and holds no SMTP
    // password; an email asked of it must not become a sent proposal.
    const fakes = setup();
    const s = { ...fakes, service: new ProposalService({ ...fakes, mailer: null }) };
    const id = await ready(s);
    await expect(
      s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" }),
    ).rejects.toBeInstanceOf(EmailUnavailable);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("draft");
  });

  it("sends without an email — the link, no letter, and the PDF of record filed at once", async () => {
    // 2026-09-28: a proposal sent as a bare link (WhatsApp, copied) used to
    // have no PDF of record until the client downloaded one, so the staff page
    // had no file to show. It is filed and pinned the moment it goes out.
    const s = setup();
    const id = await ready(s);
    const result = await s.service.send(TENANT, id, ACTOR);
    expect(result.email).toBeNull();
    expect(s.mailer.letters).toHaveLength(0);
    expect(s.pdfs.filed).toHaveLength(1);
    expect(result.proposal.sentPdfVersionId).toBe(s.pdfs.filed[0]?.versionId);
  });

  it("still sends when the PDF cannot be rendered — the file is filed later", async () => {
    const s = setup();
    const id = await ready(s);
    s.pdfs.failWith = new Error("render failed");
    const result = await s.service.send(TENANT, id, ACTOR);
    expect(result.proposal.status).toBe("sent");
    expect(result.proposal.sentPdfVersionId).toBeNull();
  });
});

describe("a new link (reissue)", () => {
  it("replaces the link — the old one stops opening anything", async () => {
    const s = setup();
    const id = await ready(s);
    const first = await s.service.send(TENANT, id, ACTOR);
    const second = await s.service.reissue(TENANT, id, ACTOR);

    expect(second.shareToken).not.toBe(first.shareToken);
    await expect(s.service.viewShared(first.shareToken, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      ShareLinkUnknown,
    );
    expect((await s.service.viewShared(second.shareToken, SYSTEM_ACTOR)).id).toBe(id);
    expect(s.events.recorded.map((e) => e.verb)).toContain("proposal.link_reissued");
  });

  it("emails the NEW link, with the same PDF of record", async () => {
    const s = setup();
    const id = await ready(s);
    await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });
    const again = await s.service.reissue(TENANT, id, ACTOR, { to: "cfo@nexus.example" });

    expect(again.email).toMatchObject({ status: "sent", to: "cfo@nexus.example" });
    expect(s.mailer.letters[1]?.viewUrl).toContain(again.shareToken);
    // Pinned once: the second email attaches the file the first one did.
    expect(s.pdfs.filed).toHaveLength(1);
    expect(s.proposals.emails.map((e) => e.pdfVersionId)).toEqual([
      s.pdfs.filed[0]?.versionId,
      s.pdfs.filed[0]?.versionId,
    ]);
  });

  it("refuses a proposal that is not out for an answer", async () => {
    const s = setup();
    const id = await ready(s);
    await expect(s.service.reissue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(NotOutForAnswer);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    await expect(s.service.reissue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(NotOutForAnswer);
  });

  it("expires a lapsed proposal rather than giving it a new link", async () => {
    const s = setup();
    const id = await ready(s, { validUntil: "2026-06-10" });
    await s.service.send(TENANT, id, ACTOR);
    s.clock.set(new Date("2026-06-11T09:00:00Z"));
    await expect(s.service.reissue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(ProposalExpired);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("expired");
  });
});

describe("the client answers on the link", () => {
  it("shows the page the sentence an acceptance ticks, word for word", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    const shared = await s.service.viewShared(shareToken, SYSTEM_ACTOR);
    expect(shared.acceptanceStatement).toBe(
      "I accept proposal PR-2026-0001 on behalf of Nexus Fintech.",
    );
    expect(shared.answer).toBeNull();
  });

  it("accepts with a name and the statement ticked, and keeps the evidence", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });
    const shared = await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);

    expect(shared.status).toBe("accepted");
    expect(shared.answer).toMatchObject({ decision: "accepted", signerName: "Priya Sharma" });
    const [kept] = s.proposals.answers;
    expect(kept).toMatchObject({
      decision: "accepted",
      signerName: "Priya Sharma",
      statement: acceptanceStatement("PR-2026-0001", "Nexus Fintech"),
      emailId: s.proposals.emails[0]?.id,
      pdfVersionId: s.pdfs.filed[0]?.versionId,
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (test)",
      declinedReason: null,
    });
    // The staff read model carries it, with the address the link was sent to.
    const record = await s.service.describe(TENANT, id);
    expect(record.clientDecision).toMatchObject({
      signerName: "Priya Sharma",
      emailedTo: "priya@nexus.example",
    });
  });

  it("records the answer in the ledger as the LINK's, with none of the personal data", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR, { to: "priya@nexus.example" });
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);

    const accepted = s.events.recorded.find((e) => e.verb === "proposal.accepted");
    expect(accepted?.objectId).toBe(id);
    expect(accepted?.payload).toMatchObject({ via: "share_link", decision: "accepted" });
    const log = JSON.stringify(s.events.recorded);
    for (const personal of ["Priya Sharma", "203.0.113.9", "Mozilla", "priya@nexus.example"]) {
      expect(log).not.toContain(personal);
    }
  });

  it("tells the colleague who prepared it", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    expect(s.mailer.notices).toEqual([
      expect.objectContaining({
        to: "sahil@firm.example",
        decision: "accepted",
        signerName: "Priya Sharma",
        clientName: "Nexus Fintech",
        proposalUrl: `https://app.example.test/proposals/${id}`,
      }),
    ]);
  });

  it("stands even when the notice to the colleague cannot be sent", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    s.mailer.failWith = new Error("relay down");
    const shared = await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    expect(shared.status).toBe("accepted");
  });

  it("refuses an acceptance with no name, or with the statement unticked", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await expect(
      s.service.answerShared(answer(shareToken, { signerName: "   " }), SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(SignerNameRequired);
    await expect(
      s.service.answerShared(answer(shareToken, { confirmed: false }), SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(AcceptanceNotConfirmed);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("sent");
  });

  it("declines with a name and a reason — and no statement", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    const shared = await s.service.answerShared(
      answer(shareToken, {
        decision: "rejected",
        confirmed: false,
        declinedReason: "Staying with our current auditor.",
      }),
      SYSTEM_ACTOR,
    );
    expect(shared.status).toBe("rejected");
    expect((await s.proposals.findById(TENANT, id))?.declinedReason).toBe(
      "Staying with our current auditor.",
    );
    expect(s.proposals.answers[0]?.statement).toBeNull();
    expect(s.mailer.notices[0]).toMatchObject({
      decision: "rejected",
      declinedReason: "Staying with our current auditor.",
    });
  });

  it("answers ONCE — a second answer is refused and the first stands", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    await expect(
      s.service.answerShared(answer(shareToken, { decision: "rejected" }), SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(AlreadyAnswered);
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("accepted");
    expect(s.proposals.answers).toHaveLength(1);
  });

  it("expires a lapsed proposal rather than accepting it late", async () => {
    const s = setup();
    const id = await ready(s, { validUntil: "2026-06-10" });
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    s.clock.set(new Date("2026-06-11T09:00:00Z"));
    await expect(s.service.answerShared(answer(shareToken), SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      ProposalExpired,
    );
    expect((await s.proposals.findById(TENANT, id))?.status).toBe("expired");
    expect(s.proposals.answers).toHaveLength(0);
  });

  it("answers the same way for a link it does not know", async () => {
    const s = setup();
    await expect(
      s.service.answerShared(answer(`${TENANT}.nothing`), SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(ShareLinkUnknown);
    await expect(s.service.answerShared(answer("garbage"), SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      ShareLinkUnknown,
    );
  });

  it("names no email when the link reached the client some other way", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    expect(s.proposals.answers[0]?.emailId).toBeNull();
    // Nothing had asked for the PDF yet, so answering files it — the record
    // of what they answered is the file, not a re-render months later.
    expect(s.proposals.answers[0]?.pdfVersionId).toBe(s.pdfs.filed[0]?.versionId);
    expect((await s.service.describe(TENANT, id)).clientDecision?.emailedTo).toBeNull();
  });

  it("does not refuse an answer because the PDF cannot be rendered", async () => {
    const s = setup();
    const id = await ready(s);
    // Failing from before Send, so nothing was pinned when it went out.
    s.pdfs.failWith = new Error("render failed");
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    const shared = await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    expect(shared.status).toBe("accepted");
    expect(s.proposals.answers[0]?.pdfVersionId).toBeNull();
  });
});

describe("the PDF from the link", () => {
  it("serves the PDF of record, and renders it only once", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    const first = await s.service.sharedPdf(shareToken, SYSTEM_ACTOR);
    const second = await s.service.sharedPdf(shareToken, SYSTEM_ACTOR);
    expect(first.filename).toBe("PR-2026-0001.pdf");
    expect(second.bytes).toEqual(first.bytes);
    expect(s.pdfs.filed).toHaveLength(1);
    expect((await s.proposals.findById(TENANT, id))?.sentPdfVersionId).toBe(
      s.pdfs.filed[0]?.versionId,
    );
  });

  it("still downloads once answered — it is the client's copy", async () => {
    const s = setup();
    const id = await ready(s);
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    await s.service.answerShared(answer(shareToken), SYSTEM_ACTOR);
    await expect(s.service.sharedPdf(shareToken, SYSTEM_ACTOR)).resolves.toMatchObject({
      filename: "PR-2026-0001.pdf",
    });
  });

  it("refuses an expired proposal, as its page does", async () => {
    const s = setup();
    const id = await ready(s, { validUntil: "2026-06-10" });
    const { shareToken } = await s.service.send(TENANT, id, ACTOR);
    s.clock.set(new Date("2026-06-11T09:00:00Z"));
    await expect(s.service.sharedPdf(shareToken, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      ProposalExpired,
    );
  });
});
