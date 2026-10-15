// The short letter: a DRAFT the client already agreed to by email, recorded as
// signed without being sent (2026-10-15). What must hold:
//   nothing goes to the client: no envelope, no `engagement_letter.sent`, and
//     no cover page needed;
//   it signs and fans out exactly as an accepted letter does, with the
//     firm's standard terms put on when the draft has none;
//   every refusal leaves a draft.
import { describe, expect, it } from "vitest";
import { EngagementService, RECORDED_ACCEPTANCE_METHOD } from "../../src/usecase/engagement/service";
import {
  FakeDispatch,
  FakeLetterPdf,
  FakeSignatureTenants,
  FakeSignedCopyFiler,
  makeEngagementFakes,
} from "../../src/testfakes/engagement";
import { EmptyLetter, LetterNotEditable, NoClauses } from "../../src/domain/engagement/errors";
import { AcceptanceInvalid, EvidenceNotFiledHere } from "../../src/domain/acceptance/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const PARTNER = "00000000-0000-0000-0000-0000000000c9";
const ACTOR = { type: "human" as const, id: PARTNER };
const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE = "00000000-0000-0000-0000-0000000000e1";
const EMAIL_FILE = "00000000-0000-0000-0000-00000000f11e";
// The fakes' clock is 2026-07-01 09:00 UTC and the firm's zone is UTC.
const TODAY = "2026-07-01";

function setup(options: { clauses?: boolean } = {}) {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [ENTITY] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", billingBasis: "fixed" });
  if (options.clauses ?? true) {
    fakes.library.publishClause(SCOPE, "scope", {
      title: "Scope of work",
      text: "The firm will perform the services listed above.",
      jurisdictions: [],
    });
  }
  // DocuSign is configured: the short letter must still raise nothing.
  const dispatch = new FakeDispatch();
  const service = new EngagementService({
    ...fakes,
    dispatch,
    letterPdf: new FakeLetterPdf(),
    signedCopies: new FakeSignedCopyFiler(),
    tenants: new FakeSignatureTenants([TENANT]),
  });
  return { ...fakes, dispatch, service };
}

type Setup = ReturnType<typeof setup>;

/** A draft with one service, no terms and no cover page: what the short form writes. */
async function draft(s: Setup, withLine = true): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Meridian: GST",
      currency: "INR",
      fxRate: "1",
      fxRateDate: TODAY,
      advanceRequired: false,
    },
    ACTOR,
  );
  if (withLine) {
    await s.service.addLine({
      tenantId: TENANT,
      letterId: letter.id,
      entityPartyId: ENTITY,
      serviceVersionId: GST,
      description: "GST monthly filing",
      quantity: "1",
      unitAmount: "2000",
      discountPercent: "0",
      billingFrequency: "monthly",
    });
  }
  return letter.id;
}

const statement = (over: Record<string, string | undefined> = {}) => ({
  channel: "email",
  acceptedOn: "2026-06-28",
  acceptedByName: "Priya Menon",
  acceptedByTitle: "Director",
  note: "Replied 'go ahead' to our fee email of 27 June.",
  evidenceDocumentId: EMAIL_FILE,
  ...over,
});

describe("recording a draft the client agreed to by email", () => {
  it("signs it with the standard terms, starts the work, and sends nothing", async () => {
    const s = setup();
    const letterId = await draft(s);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);

    const result = await s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);

    expect(result.letter).toMatchObject({
      status: "signed",
      signedByName: "Priya Menon",
      signatureMethod: RECORDED_ACCEPTANCE_METHOD,
      signatureReference: "Agreed by email on 2026-06-28; not sent to the client, recorded by the firm",
      issuedOn: TODAY,
    });
    expect(result.engagements).toHaveLength(1);
    const view = await s.service.describe(TENANT, letterId);
    expect(view.clauses).toHaveLength(1);
    expect(view.recordedAcceptance).toMatchObject({ acceptedOn: "2026-06-28", evidenceDocumentId: EMAIL_FILE });
    expect(s.dispatch.raised).toHaveLength(0);
    expect(view.signing.request).toBeNull();
  });

  it("tells the ledger it was never sent, and never who at the client", async () => {
    const s = setup();
    const letterId = await draft(s);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);

    expect(s.events.recorded.some((e) => e.verb === "engagement_letter.sent")).toBe(false);
    const signed = s.events.recorded.find((e) => e.verb === "engagement_letter.signed");
    expect(signed?.payload).toMatchObject({ via: "recorded", channel: "email", sentToClient: false });
    expect(JSON.stringify(signed?.payload)).not.toMatch(/Priya|go ahead/);
    expect(s.events.recorded.filter((e) => e.verb === "contract.activated")).toHaveLength(1);
  });

  it("keeps terms the drafter already chose", async () => {
    const s = setup();
    const letterId = await draft(s);
    await s.service.addClause(TENANT, letterId, SCOPE);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);
    expect((await s.service.describe(TENANT, letterId)).clauses).toHaveLength(1);
  });
});

describe("a refusal leaves a draft", () => {
  it("when the client's email is not filed against this letter, before any terms go on", async () => {
    const s = setup();
    const letterId = await draft(s);
    await expect(
      s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EvidenceNotFiledHere);
    const view = await s.service.describe(TENANT, letterId);
    expect(view.letter.status).toBe("draft");
    expect(view.clauses).toHaveLength(0);
  });

  it("when the day has not come, or the note is blank", async () => {
    const s = setup();
    const letterId = await draft(s);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    for (const bad of [{ acceptedOn: "2026-07-02" }, { note: " " }]) {
      await expect(
        s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement(bad) }, PARTNER, ACTOR),
      ).rejects.toBeInstanceOf(AcceptanceInvalid);
    }
    expect((await s.service.describe(TENANT, letterId)).letter.status).toBe("draft");
  });

  it("when it has no services, and when the firm has no terms to put on", async () => {
    const s = setup();
    const empty = await draft(s, false);
    s.letters.evidenceLinks.add(`${empty}:${EMAIL_FILE}`);
    await expect(
      s.service.recordAgreed({ tenantId: TENANT, letterId: empty, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(EmptyLetter);
    expect((await s.service.describe(TENANT, empty)).clauses).toHaveLength(0);

    const bare = setup({ clauses: false });
    const letterId = await draft(bare);
    bare.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await expect(
      bare.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(NoClauses);
    expect((await bare.service.describe(TENANT, letterId)).letter.status).toBe("draft");
  });

  it("and a letter already sent is refused: that one takes Record acceptance", async () => {
    const s = setup();
    const letterId = await draft(s);
    s.letters.evidenceLinks.add(`${letterId}:${EMAIL_FILE}`);
    await s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR);
    await expect(
      s.service.recordAgreed({ tenantId: TENANT, letterId, statement: statement() }, PARTNER, ACTOR),
    ).rejects.toBeInstanceOf(LetterNotEditable);
  });
});
