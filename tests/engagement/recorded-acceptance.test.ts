// A letter the client accepted OUTSIDE bib, recorded by a colleague (0317).
//
// The properties, in the order they would hurt:
//   the client's email must be filed against THIS letter before anything moves,
//     and a wrong file voids no envelope;
//   an envelope still out is voided, so the client cannot also sign it, and one
//     DocuSign reports signed is refused and left for the sweep;
//   the letter is then signed exactly as a signature signs it — frozen, one
//     engagement per line — under its own method, with the evidence beside it;
//   the ledger says HOW, never who at the client or what they said.
import { describe, expect, it } from "vitest";
import { EngagementService, RECORDED_ACCEPTANCE_METHOD } from "../../src/usecase/engagement/service";
import {
  FakeDispatch,
  FakeLetterPdf,
  FakeSignatureTenants,
  FakeSignedCopyFiler,
  makeEngagementFakes,
} from "../../src/testfakes/engagement";
import { EnvelopeAlreadySigned, InvalidLetterTransition } from "../../src/domain/engagement/errors";
import {
  AcceptanceInvalid,
  AcceptanceNeedsEvidence,
  EvidenceNotFiledHere,
} from "../../src/domain/acceptance/errors";
import { mapError } from "../../src/api/domainerr";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const USER = "00000000-0000-0000-0000-0000000000cc";
const PARTNER = "00000000-0000-0000-0000-0000000000c9";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE = "00000000-0000-0000-0000-0000000000e1";
const EMAIL_FILE = "00000000-0000-0000-0000-00000000f11e";
const SIGNER = { name: "Priya Menon", email: "priya@meridian.example" };
// The fakes' clock is 2026-07-01 09:00 UTC and the firm's zone is UTC.
const TODAY = "2026-07-01";

function setup(options: { sends?: boolean } = {}) {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [ENTITY] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", billingBasis: "fixed" });
  fakes.library.publishClause(SCOPE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  const dispatch = new FakeDispatch();
  const sends = options.sends ?? true;
  const service = new EngagementService({
    ...fakes,
    dispatch: sends ? dispatch : null,
    letterPdf: sends ? new FakeLetterPdf() : null,
    signedCopies: new FakeSignedCopyFiler(),
    tenants: new FakeSignatureTenants([TENANT]),
  });
  return { ...fakes, dispatch, service };
}

type Setup = ReturnType<typeof setup>;

async function sent(s: Setup, withEnvelope: boolean): Promise<string> {
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
    { type: "human", id: USER },
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
  await s.service.send(TENANT, letter.id, { type: "human", id: USER }, withEnvelope ? { signer: SIGNER } : undefined);
  return letter.id;
}

const statement = (over: Record<string, string | undefined> = {}) => ({
  channel: "email",
  acceptedOn: TODAY,
  acceptedByName: "Priya Menon",
  acceptedByTitle: "Director",
  note: "Replied 'go ahead' to the letter email, thread in the shared inbox.",
  evidenceDocumentId: EMAIL_FILE,
  ...over,
});

describe("recording a letter the client accepted outside bib", () => {
  it("signs it under its own method, fans out, and keeps the evidence beside it", async () => {
    const s = setup({ sends: false });
    const letterId = await sent(s, false);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);

    const result = await s.service.recordAcceptance(
      { tenantId: TENANT, letterId, statement: statement() },
      PARTNER,
      ACTOR,
    );

    expect(result.letter).toMatchObject({
      status: "signed",
      signedByName: "Priya Menon",
      signedByTitle: "Director",
      signatureMethod: RECORDED_ACCEPTANCE_METHOD,
      signatureReference: `Accepted by email on ${TODAY}; recorded by the firm`,
    });
    expect(result.engagements).toHaveLength(1);
    const view = await s.service.describe(TENANT, letterId);
    expect(view.recordedAcceptance).toMatchObject({
      channel: "email",
      acceptedOn: TODAY,
      acceptedByName: "Priya Menon",
      evidenceDocumentId: EMAIL_FILE,
      recordedBy: { userId: PARTNER },
    });
  });

  it("says HOW on the ledger and never the client's name or the note", async () => {
    const s = setup({ sends: false });
    const letterId = await sent(s, false);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);

    const signed = s.events.recorded.find((e) => e.verb === "engagement_letter.signed");
    expect(signed?.payload).toMatchObject({
      signatureMethod: RECORDED_ACCEPTANCE_METHOD,
      via: "recorded",
      channel: "email",
    });
    expect(JSON.stringify(signed?.payload)).not.toMatch(/Priya|go ahead/);
    expect(signed).toMatchObject({ actorType: "human", actorId: PARTNER });
  });

  it("refuses without the client's email, and with one filed against another document", async () => {
    const s = setup({ sends: false });
    const letterId = await sent(s, false);

    await expect(
      s.service.recordAcceptance(
        { tenantId: TENANT, letterId, statement: statement({ evidenceDocumentId: undefined }) },
        PARTNER,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(AcceptanceNeedsEvidence);
    await expect(
      s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EvidenceNotFiledHere);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
    expect(mapError(new AcceptanceNeedsEvidence())).toMatchObject({ status: 400 });
    expect(mapError(new EvidenceNotFiledHere(EMAIL_FILE))).toMatchObject({ status: 409 });
  });

  it("refuses a day before it was sent, a day not yet come, and a blank note", async () => {
    const s = setup({ sends: false });
    const letterId = await sent(s, false);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    for (const bad of [{ acceptedOn: "2026-06-30" }, { acceptedOn: "2026-07-02" }, { note: "  " }, { channel: "fax" }]) {
      await expect(
        s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement(bad) }, PARTNER, ACTOR),
      ).rejects.toBeInstanceOf(AcceptanceInvalid);
    }
  });

  it("refuses a letter that is not out for signature", async () => {
    const s = setup({ sends: false });
    const letterId = await sent(s, false);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);
    await expect(
      s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(InvalidLetterTransition);
  });
});

describe("a letter still out with DocuSign", () => {
  it("voids the envelope first, settles the request, then signs", async () => {
    const s = setup();
    const letterId = await sent(s, true);
    const envelopeId = (await s.service.describe(TENANT, letterId)).signing.request?.envelopeId ?? "";
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);

    await s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);

    expect(s.dispatch.voided).toEqual([{ envelopeId, reason: expect.stringMatching(/accepted it outside/) as string }]);
    const view = await s.service.describe(TENANT, letterId);
    expect(view.letter.status).toBe("signed");
    expect(view.signing.request).toMatchObject({ outcome: "voided" });
    // The sweep leaves it alone afterwards: nothing is awaiting.
    const [report] = await s.service.settleSignatures();
    expect(report).toMatchObject({ signed: 0, withdrawn: 0, stillOut: 0 });
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("signed");
  });

  it("refuses when the client has already signed in DocuSign, and voids nothing", async () => {
    const s = setup();
    const letterId = await sent(s, true);
    const envelopeId = (await s.service.describe(TENANT, letterId)).signing.request?.envelopeId ?? "";
    s.dispatch.states.set(envelopeId, "completed");
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);

    await expect(
      s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EnvelopeAlreadySigned);
    expect(s.dispatch.voided).toHaveLength(0);
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("sent");
  });

  it("voids nothing when the evidence is not filed against the letter", async () => {
    const s = setup();
    const letterId = await sent(s, true);
    await expect(
      s.service.recordAcceptance({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EvidenceNotFiledHere);
    expect(s.dispatch.voided).toHaveLength(0);
    expect((await s.service.describe(TENANT, letterId)).signing.request).toMatchObject({ outcome: null });
  });
});
