// What a DocuSign signature is allowed to mean.
//
// Every case here is one way of arriving at the same wrong answer — a letter
// recorded as signed when nobody signed it, or when somebody signed something
// else — and `signed` is terminal in the domain and frozen by a trigger in
// migration 0019, so each of these is a mistake that cannot afterwards be
// corrected. That is why the refusals outnumber the acceptances so heavily.
//
// The last two cases run the REAL `EngagementService` over this adapter,
// because the rules above are only worth anything if the caller behaves the way
// `ports.ts` says it does: nothing is written when the provider throws.
import { describe, expect, it } from "vitest";
import { DocusignSigner } from "../../src/infrastructure/esign/docusign-signer";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import type { ContentHasher } from "../../src/usecase/engagement/ports";
import {
  ENVELOPE,
  FakeDocusignTransport,
  HASH,
  LETTER,
  RecordingLogger,
  TENANT,
  anEnvelope,
  refusal,
} from "./fakes";

function signer(): { docusign: DocusignSigner; docs: FakeDocusignTransport; log: RecordingLogger } {
  const docs = new FakeDocusignTransport();
  const log = new RecordingLogger();
  return { docusign: new DocusignSigner(docs, log), docs, log };
}

function request(overrides: { reference?: string | undefined; contentHash?: string } = {}): {
  tenantId: string;
  letterId: string;
  signedByName: string;
  contentHash: string;
  reference?: string | undefined;
} {
  return {
    tenantId: TENANT,
    letterId: LETTER,
    signedByName: "Priya Menon",
    contentHash: overrides.contentHash ?? HASH,
    reference: "reference" in overrides ? overrides.reference : ENVELOPE,
  };
}

describe("the DocuSign signer, on an envelope that is finished and bound", () => {
  it("hands back the envelope id, which is the thread to the evidence", async () => {
    const s = signer();
    s.docs.put(anEnvelope());

    await expect(s.docusign.sign(request())).resolves.toEqual({ reference: ENVELOPE });
    expect(s.docs.asked).toEqual([ENVELOPE]);
  });

  it("calls itself docusign, so a reader can tell it from an attestation", () => {
    expect(signer().docusign.method).toBe("docusign");
  });

  it("stores DocuSign's spelling of the id and not the one somebody typed", async () => {
    // What gets written to the letter has to be what the vendor will answer to
    // when this is looked up years later, and a GUID a person pasted may carry
    // any casing at all.
    const s = signer();
    s.docs.put(anEnvelope());

    const result = await s.docusign.sign(request({ reference: ENVELOPE.toUpperCase() }));
    expect(result.reference).toBe(ENVELOPE);
  });

  it("accepts a hash DocuSign handed back upper-cased", async () => {
    // A hex digest is the same digest in either case, and it makes a round trip
    // through a vendor's storage. Refusing it would be a false alarm about the
    // most alarming failure this adapter has.
    const s = signer();
    s.docs.put(anEnvelope({ contentHash: HASH.toUpperCase() }));

    await expect(s.docusign.sign(request())).resolves.toEqual({ reference: ENVELOPE });
  });

  it("records the envelope in the log and never the signatory's name", async () => {
    // The letter is where a signatory is recorded, and that row can be erased.
    // A log line cannot, which is the same reason `EngagementService.sign`
    // keeps the name out of the event it writes.
    const s = signer();
    s.docs.put(anEnvelope());
    await s.docusign.sign(request());

    expect(s.log.text()).toContain(ENVELOPE);
    expect(s.log.text()).not.toContain("Priya Menon");
  });
});

describe("the DocuSign signer refuses what it cannot stand behind", () => {
  it("refuses a reference that is not there at all", async () => {
    const s = signer();
    await expect(s.docusign.sign(request({ reference: undefined }))).rejects.toThrow(
      /envelope id/i,
    );
    expect(s.docs.asked).toHaveLength(0);
  });

  it("refuses the firm's old paper reference, and says what the field means now", async () => {
    // The signature screen still offers "paper-001" as its example. Until
    // somebody relabels it this is the refusal a partner will actually meet, so
    // it has to teach rather than merely reject.
    const s = signer();
    const err = await refusal(s.docusign.sign(request({ reference: "paper-001" })));

    expect(err).toContain("paper-001");
    expect(err).toContain("BIB_ESIGN_PROVIDER=docusign");
    expect(err).toMatch(/36-character/);
    expect(s.docs.asked).toHaveLength(0);
  });

  it("refuses an envelope this deployment cannot see, and names the account variable", async () => {
    const s = signer();
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain(ENVELOPE);
    expect(err).toContain("BIB_DOCUSIGN_ACCOUNT_ID");
  });

  // The whole lifecycle, refused by name. `sent` and `delivered` are the
  // dangerous pair: the envelope is real, the id is real, and the only thing
  // missing is the signature.
  const unfinished: readonly [string, RegExp][] = [
    ["created", /never sent/],
    ["sent", /has not opened it/],
    ["delivered", /has not finished signing/],
    ["signed", /finished routing/],
    ["declined", /REFUSED to sign/],
    ["voided", /cancelled/],
    ["deleted", /no evidence/],
  ];
  for (const [status, because] of unfinished) {
    it(`refuses an envelope that is ${status}`, async () => {
      const s = signer();
      s.docs.put(anEnvelope({ status }));
      const err = await refusal(s.docusign.sign(request()));

      expect(err).toContain(`"${status}"`);
      expect(err).toMatch(because);
      expect(err).toContain("Valid: completed");
    });
  }

  it("refuses a status it has never heard of rather than guessing", async () => {
    const s = signer();
    s.docs.put(anEnvelope({ status: "correcting" }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain("correcting");
    expect(err).toContain("Valid: completed");
  });

  it("refuses an envelope carrying no content hash — it proves somebody signed something", async () => {
    const s = signer();
    s.docs.put(anEnvelope({ contentHash: null }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain("bib_content_hash");
  });

  it("refuses an envelope raised over DIFFERENT terms, and quotes both hashes", async () => {
    // The failure worth the most: a letter amended after the envelope went out.
    // Everybody involved believes a contract exists and it is over the wrong
    // words.
    const other = "0".repeat(64);
    const s = signer();
    s.docs.put(anEnvelope({ contentHash: other }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain(other);
    expect(err).toContain(HASH);
    expect(err).toMatch(/different document/);
  });

  it("refuses an envelope that names no letter", async () => {
    const s = signer();
    s.docs.put(anEnvelope({ letterId: null }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain("bib_letter_id");
  });

  it("refuses another letter's envelope, and names both letters", async () => {
    const elsewhere = "00000000-0000-0000-0000-0000000000e2";
    const s = signer();
    s.docs.put(anEnvelope({ letterId: elsewhere }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toContain(elsewhere);
    expect(err).toContain(LETTER);
  });

  it("refuses a completed envelope nobody was asked to sign", async () => {
    // An envelope whose recipients were all set to receive a copy completes on
    // its own, with a status indistinguishable from a signed one.
    const s = signer();
    s.docs.put(anEnvelope({ recipientStatuses: [] }));
    const err = await refusal(s.docusign.sign(request()));

    expect(err).toMatch(/at least one recipient who signed/);
  });

  it("refuses when the only recipient has not signed yet", async () => {
    const s = signer();
    s.docs.put(anEnvelope({ recipientStatuses: ["sent"] }));
    await expect(s.docusign.sign(request())).rejects.toThrow(/recipient/);
  });
});

// ── Through the real use case ────────────────────────────────────────────────
//
// `ports.ts` promises that a provider which throws leaves the letter alone.
// That promise is what makes every refusal above safe, and it is worth proving
// against the real service rather than assuming it.

const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

/** A letter that has been sent and is waiting to be signed, over the real
 *  service with this adapter wired in as its e-sign port. */
async function sentLetter(docs: FakeDocusignTransport): Promise<{
  service: EngagementService;
  fakes: ReturnType<typeof makeEngagementFakes>;
  letterId: string;
  hashes: string[];
}> {
  const fakes = makeEngagementFakes();
  // The line's company is the client's (F-10-1).
  fakes.structure.record(PARTY, { entities: [ENTITY] });
  fakes.library.publishService(GST, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
  });
  fakes.library.publishClause(SCOPE_CLAUSE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });

  // The hash the service computes is not knowable in advance — it is a digest
  // of the canonical terms — and the envelope has to carry it. Watching the
  // hasher is how the fixture learns what to stamp, and it is honest: the
  // adapter still compares against what the service handed it.
  const hashes: string[] = [];
  const watched: ContentHasher = {
    hash: (content: string) => {
      const digest = fakes.hasher.hash(content);
      hashes.push(digest);
      return digest;
    },
  };

  const service = new EngagementService({
    ...fakes,
    hasher: watched,
    esign: new DocusignSigner(docs, new RecordingLogger()),
  });

  const letter = await service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: false,
    },
    ACTOR,
  );
  await service.addLine({
    tenantId: TENANT,
    letterId: letter.id,
    entityPartyId: ENTITY,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await service.addClause(TENANT, letter.id, SCOPE_CLAUSE);
  await writeOpening(fakes.prose, TENANT, letter.id);
  await service.send(TENANT, letter.id, ACTOR);

  return { service, fakes, letterId: letter.id, hashes };
}

describe("EngagementService over the DocuSign signer", () => {
  it("writes nothing when the envelope is merely out for signature", async () => {
    // THE CASE THIS ADAPTER EXISTS TO PREVENT. An adapter that created and sent
    // an envelope would reach exactly this state and report success, and the
    // letter would be signed, fanned out and frozen with nobody's signature on
    // it.
    const docs = new FakeDocusignTransport();
    const s = await sentLetter(docs);
    docs.answer = (id) =>
      anEnvelope({ id, status: "sent", letterId: s.letterId, contentHash: s.hashes[0] ?? "" });

    await expect(
      s.service.sign(
        { tenantId: TENANT, letterId: s.letterId, signedByName: "Priya", reference: ENVELOPE },
        ACTOR,
      ),
    ).rejects.toThrow(/completed/i);

    const after = await s.fakes.letters.findLetter(TENANT, s.letterId);
    expect(after?.status).toBe("sent");
    expect(s.fakes.letters.engagements).toHaveLength(0);
    expect(s.fakes.events.verbs()).not.toContain("engagement_letter.signed");
  });

  it("records the envelope id and the method when DocuSign says it is completed", async () => {
    const docs = new FakeDocusignTransport();
    const s = await sentLetter(docs);
    docs.answer = (id) =>
      anEnvelope({ id, letterId: s.letterId, contentHash: s.hashes[0] ?? "" });

    const { letter, engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: s.letterId, signedByName: "Priya", reference: ENVELOPE },
      ACTOR,
    );

    expect(letter.status).toBe("signed");
    expect(letter.signatureMethod).toBe("docusign");
    expect(letter.signatureReference).toBe(ENVELOPE);
    expect(letter.signedContentHash).toBe(s.hashes[0]);
    expect(engagements).toHaveLength(1);
  });
});
