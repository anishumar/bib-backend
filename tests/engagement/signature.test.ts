// Sending a letter for signature through a provider that SENDS (0080), and
// learning how it ended.
//
// The properties worth proving, in the order they would hurt:
//
//   a letter is never recorded as signed because an envelope merely went out;
//   the hash stamped on the envelope is the hash `sign()` will compute, so a
//     completed envelope actually verifies;
//   a DocuSign fault never undoes a send, and a retry never mails the client a
//     second contract;
//   a withdrawn letter's envelope is voided, and a letter the client has just
//     signed cannot be withdrawn out from under them.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import {
  FakeDispatch,
  FakeLetterPdf,
  FakeSignatureTenants,
  FakeSignedCopyFiler,
  makeEngagementFakes,
} from "../../src/testfakes/engagement";
import {
  EnvelopeAlreadySigned,
  SignatureIncomplete,
  SignatureRequestNotPending,
} from "../../src/domain/engagement/errors";
import { mapError } from "../../src/api/domainerr";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ab";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const USER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: USER };
const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE = "00000000-0000-0000-0000-0000000000e1";
const SIGNER = { name: "Priya Menon", email: "Priya@Meridian.example" };

function setup(options: { sends?: boolean } = {}) {
  const fakes = makeEngagementFakes();
  // The line's company is the client's (F-10-1).
  fakes.structure.record(PARTY, { entities: [ENTITY] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", billingBasis: "fixed" });
  fakes.library.publishClause(SCOPE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  const dispatch = new FakeDispatch();
  const letterPdf = new FakeLetterPdf();
  const filer = new FakeSignedCopyFiler();
  const sends = options.sends ?? true;
  const service = new EngagementService({
    ...fakes,
    dispatch: sends ? dispatch : null,
    letterPdf: sends ? letterPdf : null,
    signedCopies: filer,
    tenants: new FakeSignatureTenants([TENANT, OTHER_TENANT]),
  });
  return { ...fakes, dispatch, letterPdf, filer, service };
}

type Setup = ReturnType<typeof setup>;

async function readyToSend(s: Setup): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Meridian — FY27 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: false,
    },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    letterId: letter.id,
    entityPartyId: ENTITY,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await s.service.addClause(TENANT, letter.id, SCOPE);
  return letter.id;
}

async function outForSignature(s: Setup): Promise<{ letterId: string; envelopeId: string }> {
  const letterId = await readyToSend(s);
  await s.service.send(TENANT, letterId, ACTOR, { signer: SIGNER });
  const view = await s.service.describe(TENANT, letterId);
  const envelopeId = view.signing.request?.envelopeId;
  if (envelopeId === undefined || envelopeId === null) throw new Error("no envelope was raised");
  return { letterId, envelopeId };
}

describe("sending through a provider that sends", () => {
  it("refuses to send without somebody to ask, and leaves the letter a draft", async () => {
    const s = setup();
    const letterId = await readyToSend(s);

    await expect(s.service.send(TENANT, letterId, ACTOR)).rejects.toBeInstanceOf(SignatureIncomplete);
    await expect(
      s.service.send(TENANT, letterId, ACTOR, { signer: { name: "Priya", email: "priya at meridian" } }),
    ).rejects.toThrow(/not one/);

    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("draft");
    expect(s.dispatch.raised).toHaveLength(0);
    expect(s.signatures.rows.size).toBe(0);
  });

  it("sends, raises one envelope at once, and leaves the letter SENT — not signed", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);

    const view = await s.service.describe(TENANT, letterId);
    expect(view.letter.status).toBe("sent");
    expect(view.letter.signedAt).toBeNull();
    expect(view.signing).toMatchObject({ provider: "fake", sends: true });
    expect(view.signing.request).toMatchObject({
      envelopeId,
      // Stored as the provider will compare it.
      signer: { name: "Priya Menon", email: "priya@meridian.example" },
      lastFailure: null,
      outcome: null,
    });
    expect(s.dispatch.raised).toHaveLength(1);
    expect(s.letterPdf.rendered).toEqual([letterId]);
    expect(view.engagements).toHaveLength(0);
  });

  it("records the envelope on the ledger by provider and id, and nobody's name or address", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);

    const requested = s.events.recorded.filter((e) => e.verb === "engagement_letter.signature_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.objectId).toBe(letterId);
    expect(requested[0]?.payload).toEqual({ provider: "fake", envelopeId });
    const sent = s.events.recorded.find((e) => e.verb === "engagement_letter.sent");
    expect(sent?.payload).toMatchObject({ signatureProvider: "fake" });
    expect(JSON.stringify(s.events.recorded)).not.toMatch(/Priya|meridian\.example/i);
  });

  it("stamps the envelope with the SAME hash the signature will be checked against", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");

    await s.service.settleSignatures();

    const signedWith = s.esign.signed.find((x) => x.letterId === letterId);
    expect(signedWith?.contentHash).toBe(s.dispatch.raised[0]?.contentHash);
  });

  it("keeps a provider fault on the request and does NOT undo the send", async () => {
    const s = setup();
    const letterId = await readyToSend(s);
    s.dispatch.failRaise = "DocuSign refused to create the envelope: HTTP 400 INVALID_EMAIL";

    const sent = await s.service.send(TENANT, letterId, ACTOR, { signer: SIGNER });

    expect(sent.status).toBe("sent");
    const request = (await s.service.describe(TENANT, letterId)).signing.request;
    expect(request).toMatchObject({ envelopeId: null, attempts: 1 });
    expect(request?.lastFailure).toMatch(/INVALID_EMAIL/);
  });

  it("raises it on retry, clears the fault, and refuses a retry once it is out", async () => {
    const s = setup();
    const letterId = await readyToSend(s);
    s.dispatch.failRaise = "down";
    await s.service.send(TENANT, letterId, ACTOR, { signer: SIGNER });

    s.dispatch.failRaise = "still down";
    await expect(s.service.retrySignatureRequest(TENANT, letterId, ACTOR)).rejects.toThrow(/still down/);

    s.dispatch.failRaise = null;
    const raised = await s.service.retrySignatureRequest(TENANT, letterId, ACTOR);
    expect(raised).toMatchObject({ lastFailure: null, attempts: 3 });
    expect(raised.envelopeId).not.toBeNull();

    const again = s.service.retrySignatureRequest(TENANT, letterId, ACTOR);
    await expect(again).rejects.toBeInstanceOf(SignatureRequestNotPending);
    await expect(again.catch((e: unknown) => mapError(e).status)).resolves.toBe(409);
    expect(s.dispatch.raised).toHaveLength(1);
  });

  it("reuses an envelope DocuSign already holds for the letter — a lost reply never means a second contract", async () => {
    const s = setup();
    const letterId = await readyToSend(s);
    s.dispatch.failRaise = "socket hang up";
    await s.service.send(TENANT, letterId, ACTOR, { signer: SIGNER });
    // DocuSign acted on the first create and the reply was lost.
    s.dispatch.existing.set(letterId, "env-from-the-lost-reply");
    s.dispatch.failRaise = null;

    const raised = await s.service.retrySignatureRequest(TENANT, letterId, ACTOR);

    expect(raised.envelopeId).toBe("env-from-the-lost-reply");
    expect(s.dispatch.raised).toHaveLength(0);
  });

  it("lets one of two simultaneous retries raise, not both", async () => {
    const s = setup();
    const letterId = await readyToSend(s);
    s.dispatch.failRaise = "down";
    await s.service.send(TENANT, letterId, ACTOR, { signer: SIGNER });
    s.dispatch.failRaise = null;

    await Promise.allSettled([
      s.service.retrySignatureRequest(TENANT, letterId, ACTOR),
      s.service.retrySignatureRequest(TENANT, letterId, ACTOR),
    ]);

    expect(s.dispatch.raised).toHaveLength(1);
  });

  it("never raises an envelope for a MIGRATED letter — the client signed on paper", async () => {
    const s = setup();
    const letterId = await readyToSend(s);

    await s.service.send(TENANT, letterId, ACTOR, { migrated: true });

    expect(s.dispatch.raised).toHaveLength(0);
    expect((await s.service.describe(TENANT, letterId)).signing.request).toBeNull();
  });
});

describe("a provider that sends nothing (attested)", () => {
  it("sends without a signer, raises nothing, and says so on the view", async () => {
    const s = setup({ sends: false });
    const letterId = await readyToSend(s);

    await s.service.send(TENANT, letterId, ACTOR);

    const view = await s.service.describe(TENANT, letterId);
    expect(view.letter.status).toBe("sent");
    expect(view.signing).toEqual({ provider: "fake", sends: false, request: null });
    expect(await s.service.settleSignatures()).toEqual([]);
  });
});

describe("the signature sweep", () => {
  it("signs a completed envelope through sign(): the signer's name, the envelope as reference, the system as actor", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");

    const [report] = await s.service.settleSignatures();

    expect(report).toMatchObject({ tenantId: TENANT, signed: 1, withdrawn: 0, stillOut: 0, failed: [] });
    const view = await s.service.describe(TENANT, letterId);
    expect(view.letter).toMatchObject({
      status: "signed",
      signedByName: "Priya Menon",
      signatureMethod: "fake",
      signatureReference: envelopeId,
    });
    expect(view.engagements).toHaveLength(1);
    expect(view.signing.request).toMatchObject({ outcome: "completed" });
    const signed = s.events.recorded.find((e) => e.verb === "engagement_letter.signed");
    expect(signed).toMatchObject({ actorType: "system", actorId: null });
  });

  it("withdraws a declined envelope's letter and says why on the event", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "declined");

    const [report] = await s.service.settleSignatures();

    expect(report).toMatchObject({ signed: 0, withdrawn: 1 });
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("withdrawn");
    const withdrawn = s.events.recorded.find((e) => e.verb === "engagement_letter.withdrawn");
    expect(withdrawn?.payload).toMatchObject({ wasStatus: "sent", signatureOutcome: "declined" });
  });

  it("leaves an envelope still out alone, and asks again next time", async () => {
    const s = setup();
    const { letterId } = await outForSignature(s);

    const [first] = await s.service.settleSignatures();
    const [second] = await s.service.settleSignatures();

    expect(first).toMatchObject({ signed: 0, withdrawn: 0, stillOut: 1 });
    expect(second).toMatchObject({ stillOut: 1 });
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
  });

  it("does not ask twice about an envelope it has settled", async () => {
    const s = setup();
    const { envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");
    await s.service.settleSignatures();

    const [again] = await s.service.settleSignatures();

    expect(again).toMatchObject({ signed: 0, withdrawn: 0, stillOut: 0 });
  });

  it("reports an envelope the provider does not hold and moves NOTHING — a wrong account is not a mass withdrawal", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "missing");

    const [report] = await s.service.settleSignatures();

    expect(report).toMatchObject({ signed: 0, withdrawn: 0 });
    expect(report?.failed[0]?.reason).toMatch(/left as it is/);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
    expect((await s.service.describe(TENANT, letterId)).signing.request?.outcome).toBeNull();
  });

  it("still lets a person withdraw a letter whose envelope is missing", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "missing");

    await s.service.withdraw(TENANT, letterId, ACTOR);

    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("withdrawn");
    expect(s.dispatch.voided).toHaveLength(0);
  });

  it("reports a provider fault per letter and goes on with the rest", async () => {
    const s = setup();
    const { letterId } = await outForSignature(s);
    s.dispatch.failProgress = "DocuSign refused to read envelope: HTTP 503";

    const [report] = await s.service.settleSignatures();

    expect(report?.failed).toEqual([{ letterId, reason: "DocuSign refused to read envelope: HTTP 503" }]);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
  });
});

describe("the signed copies (bib keeps its own)", () => {
  it("files the signed letter for the client and the certificate for the firm, against the letter, once", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");

    const [report] = await s.service.settleSignatures();
    const [again] = await s.service.settleSignatures();

    expect(report).toMatchObject({ signed: 1, copiesFiled: 1, failed: [] });
    expect(again).toMatchObject({ copiesFiled: 0 });
    expect(s.filer.filed.map((f) => f.which)).toEqual(["signed", "certificate"]);
    expect(s.filer.filed.every((f) => f.letterId === letterId && f.partyId === PARTY)).toBe(true);
    expect(s.filer.filed[0]?.title).toMatch(/signed by Priya Menon/);
    expect((await s.service.describe(TENANT, letterId)).signing.request?.copiesFiledAt).not.toBeNull();
  });

  it("never lets a copy that will not download undo or block the signature, and retries it next pass", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");
    s.dispatch.failCopies = "DocuSign would not hand over the signed letter: HTTP 503";

    const [first] = await s.service.settleSignatures();

    expect(first).toMatchObject({ signed: 1, copiesFiled: 0 });
    expect(first?.failed[0]?.reason).toMatch(/signed, but the signed copy is not filed yet/);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("signed");
    expect(s.filer.filed).toHaveLength(0);

    s.dispatch.failCopies = null;
    const [second] = await s.service.settleSignatures();
    expect(second).toMatchObject({ copiesFiled: 1, failed: [] });
    expect(s.filer.filed).toHaveLength(2);
  });

  it("files nothing for a declined envelope — there is no signed copy", async () => {
    const s = setup();
    const { envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "declined");

    await s.service.settleSignatures();

    expect(s.filer.filed).toHaveLength(0);
  });
});

describe("withdrawing a letter whose envelope is out", () => {
  it("voids the envelope first, so the client cannot sign a letter the firm pulled", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);

    const withdrawn = await s.service.withdraw(TENANT, letterId, ACTOR);

    expect(withdrawn.status).toBe("withdrawn");
    expect(s.dispatch.voided).toHaveLength(1);
    expect(s.dispatch.voided[0]?.envelopeId).toBe(envelopeId);
    expect(s.dispatch.voided[0]?.reason).toMatch(/withdrawn by the firm/);
    expect((await s.service.describe(TENANT, letterId)).signing.request).toMatchObject({ outcome: "voided" });
  });

  it("refuses when the client has already finished signing, and leaves it for the sweep to record", async () => {
    const s = setup();
    const { letterId, envelopeId } = await outForSignature(s);
    s.dispatch.states.set(envelopeId, "completed");

    const attempt = s.service.withdraw(TENANT, letterId, ACTOR);

    await expect(attempt).rejects.toBeInstanceOf(EnvelopeAlreadySigned);
    await expect(attempt.catch((e: unknown) => mapError(e).status)).resolves.toBe(409);
    expect(s.dispatch.voided).toHaveLength(0);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");

    await s.service.settleSignatures();
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("signed");
  });

  it("withdraws nothing when the void fails — the provider's fault is the answer", async () => {
    const s = setup();
    const { letterId } = await outForSignature(s);
    s.dispatch.void = () => Promise.reject(new Error("DocuSign refused to void"));

    await expect(s.service.withdraw(TENANT, letterId, ACTOR)).rejects.toThrow(/refused to void/);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
  });
});
