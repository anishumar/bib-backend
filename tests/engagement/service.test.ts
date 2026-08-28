// The rules that decide whether a firm becomes contractually bound, against
// in-memory ports.
//
// What is proven HERE: the pin, the jurisdiction check, the completeness of the
// terms, the fan-out, and the fee gate. What is NOT proven here is the FREEZE —
// that is a trigger in migration 0017, and a fake asserting its own behaviour
// would prove nothing. See letter.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes } from "../../src/testfakes/engagement";
import {
  AdvanceAlreadyRecorded,
  AdvanceAmountRequired,
  AdvanceNotRequired,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidJurisdiction,
  InvalidLetterTransition,
  LetterNotEditable,
  NoClauses,
  NotAClause,
  ServiceNotQuotable,
} from "../../src/domain/engagement/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
// The client's own companies. An engagement is `service × one legal entity`, so
// a letter covering both fans out into engagements that differ in exactly this.
const ENTITY_A = "00000000-0000-0000-0000-0000000000b1";
const ENTITY_B = "00000000-0000-0000-0000-0000000000b2";
const USER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: USER };

const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";
const LIABILITY_IN = "00000000-0000-0000-0000-0000000000e2";
const LIABILITY_AE = "00000000-0000-0000-0000-0000000000e3";

function setup(): ReturnType<typeof makeEngagementFakes> & { service: EngagementService } {
  const fakes = makeEngagementFakes();
  fakes.library.publishService(GST, "gst-filing", {
    name: "GST monthly filing",
    billingBasis: "fixed",
  });
  // Unscoped — applies everywhere, the same reading the catalogue gives the
  // same field.
  fakes.library.publishClause(SCOPE_CLAUSE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  fakes.library.publishClause(LIABILITY_IN, "liability", {
    title: "Limitation of liability",
    text: "Liability is limited to fees paid.",
    jurisdictions: ["IN"],
  });
  fakes.library.publishClause(LIABILITY_AE, "liability-ae", {
    title: "Limitation of liability (UAE)",
    text: "Liability is limited as permitted by UAE law.",
    jurisdictions: ["AE"],
  });
  return { ...fakes, service: new EngagementService(fakes) };
}

async function draft(
  s: ReturnType<typeof setup>,
  overrides: { advanceRequired?: boolean; advanceAmount?: string; jurisdiction?: string } = {},
): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: overrides.jurisdiction ?? "IN",
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: overrides.advanceRequired ?? false,
      ...(overrides.advanceAmount === undefined ? {} : { advanceAmount: overrides.advanceAmount }),
    },
    ACTOR,
  );
  return letter.id;
}

async function completeTerms(s: ReturnType<typeof setup>, id: string): Promise<void> {
  await s.service.addLine({
    tenantId: TENANT,
    letterId: id,
    entityPartyId: ENTITY_A,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
}

describe("drafting", () => {
  it.each([["India"], ["ind"], [""], ["I1"]])("refuses %j as a jurisdiction", async (j) => {
    const s = setup();
    await expect(draft(s, { jurisdiction: j })).rejects.toBeInstanceOf(InvalidJurisdiction);
  });

  it("refuses an advance requirement with no amount", async () => {
    // A gate with no figure is a gate nobody can pass.
    const s = setup();
    await expect(draft(s, { advanceRequired: true })).rejects.toBeInstanceOf(
      AdvanceAmountRequired,
    );
  });

  it("keeps the title out of the ledger", async () => {
    const s = setup();
    const id = await draft(s);
    const drafted = s.events.recorded.find((e) => e.verb === "engagement_letter.drafted");
    expect(drafted?.objectId).toBe(id);
    expect(drafted?.payload).toMatchObject({ partyId: PARTY, jurisdiction: "IN" });
    expect(JSON.stringify(s.events.recorded)).not.toContain("Acme");
  });
});

describe("the terms", () => {
  it("refuses a clause written for another jurisdiction", async () => {
    // A term drafted for the UAE may be unenforceable in India, or simply
    // wrong. Including it quietly is worse than leaving a gap.
    const s = setup();
    const id = await draft(s, { jurisdiction: "IN" });
    const err = await s.service.addClause(TENANT, id, LIABILITY_AE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClauseWrongJurisdiction);
    expect((err as Error).message).toContain("AE");
    expect((err as Error).message).toContain("IN");
  });

  it("accepts a clause scoped to this jurisdiction, and one scoped to none", async () => {
    const s = setup();
    const id = await draft(s, { jurisdiction: "IN" });
    await expect(s.service.addClause(TENANT, id, LIABILITY_IN)).resolves.toBeUndefined();
    await expect(s.service.addClause(TENANT, id, SCOPE_CLAUSE)).resolves.toBeUndefined();
  });

  it("refuses a DRAFT clause — it was never in force", async () => {
    // Putting one in a contract binds the client to wording the firm never
    // adopted.
    const s = setup();
    const id = await draft(s);
    s.library.add("00000000-0000-0000-0000-0000000000e9", {
      kind: "clause",
      status: "draft",
      key: "untested",
      version: 1,
      body: { title: "Untested", text: "…", jurisdictions: [] },
    });
    await expect(
      s.service.addClause(TENANT, id, "00000000-0000-0000-0000-0000000000e9"),
    ).rejects.toBeInstanceOf(ClauseNotPublished);
  });

  it("refuses a service version where a clause belongs", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(s.service.addClause(TENANT, id, GST)).rejects.toBeInstanceOf(NotAClause);
  });

  it("refuses a draft service on a line", async () => {
    const s = setup();
    const id = await draft(s);
    s.library.add("00000000-0000-0000-0000-0000000000d9", {
      kind: "service",
      status: "draft",
      key: "unpublished",
      version: 1,
      body: { name: "Unpublished", billingBasis: "fixed" },
    });
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        letterId: id,
        entityPartyId: ENTITY_A,
        serviceVersionId: "00000000-0000-0000-0000-0000000000d9",
        description: "x",
        quantity: "1",
        unitAmount: "1",
        discountPercent: "0",
      }),
    ).rejects.toBeInstanceOf(ServiceNotQuotable);
  });
});

describe("sending", () => {
  it("refuses a letter that commits nobody to anything", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(EmptyLetter);
  });

  it("refuses a letter with no terms at all", async () => {
    // The dangerous one: a signed contract with no clauses is enforceable as
    // whatever a court reads into it, and the failure is silent at exactly the
    // moment it is expensive.
    const s = setup();
    const id = await draft(s);
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "GST filing",
      quantity: "1",
      unitAmount: "2000",
      discountPercent: "0",
    });
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(NoClauses);
  });

  it("refuses to change a letter once it has gone out", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await expect(s.service.addClause(TENANT, id, LIABILITY_IN)).rejects.toBeInstanceOf(
      LetterNotEditable,
    );
  });
});

describe("signature and fan-out", () => {
  it("creates one engagement per line, active when no advance is required", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    // A SECOND COMPANY of the same client, deliberately. The firm's own rule is
    // "Per Company": vCFO for a group of four is four engagements, and the field
    // that tells them apart is this one.
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_B,
      serviceVersionId: GST,
      description: "Annual return",
      quantity: "1",
      unitAmount: "18000",
      discountPercent: "0",
    });
    await s.service.send(TENANT, id, ACTOR);

    const { letter, engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon" },
      ACTOR,
    );
    expect(letter.status).toBe("signed");
    expect(engagements).toHaveLength(2);
    expect(engagements.every((e) => e.status === "active")).toBe(true);
    // One spawn trigger per engagement — this is what T2.4's scheduler consumes.
    expect(s.events.recorded.filter((e) => e.verb === "contract.activated")).toHaveLength(2);
  });

  it("takes the entity from the LINE and the client from the letter", async () => {
    // G0.1. Before this, every engagement was spawned with `letter.partyId` and
    // the entity dimension did not exist anywhere in the commercial chain — so
    // T3.2's calendar, which keys on an entity because an entity owes GSTR-3B
    // and a client does not, had no join to generate against.
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id); // ENTITY_A
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_B,
      serviceVersionId: GST,
      description: "Annual return",
      quantity: "1",
      unitAmount: "18000",
      discountPercent: "0",
    });
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon" },
      ACTOR,
    );

    expect(new Set(engagements.map((e) => e.entityPartyId))).toEqual(
      new Set([ENTITY_A, ENTITY_B]),
    );
    // BOTH are kept: invoicing needs who is billed, the calendar needs who the
    // work is delivered to.
    expect(engagements.every((e) => e.partyId === PARTY)).toBe(true);
  });

  it("the signature commits to the entity — it is a term, not metadata", async () => {
    // Same services, same money, same clauses, different company. If the entity
    // were outside the canonical rendering, the hash would say these two
    // agreements are identical, and the one dimension the delivery lane
    // schedules against would sit outside what the signature proves.
    const s = setup();
    const forA = await draft(s);
    await completeTerms(s, forA); // ENTITY_A
    await s.service.send(TENANT, forA, ACTOR);
    const signedA = await s.service.sign(
      { tenantId: TENANT, letterId: forA, signedByName: "Priya" },
      ACTOR,
    );

    const forB = await draft(s);
    await s.service.addLine({
      tenantId: TENANT,
      letterId: forB,
      entityPartyId: ENTITY_B, // the only difference
      serviceVersionId: GST,
      description: "GST filing, 12 months",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "0",
    });
    await s.service.addClause(TENANT, forB, SCOPE_CLAUSE);
    await s.service.send(TENANT, forB, ACTOR);
    const signedB = await s.service.sign(
      { tenantId: TENANT, letterId: forB, signedByName: "Priya" },
      ACTOR,
    );

    expect(signedA.letter.signedContentHash).not.toBe(signedB.letter.signedContentHash);
  });

  it("records the method and the hash, and never the signatory's name", async () => {
    // The name is personal data and this log cannot be erased. The hash is what
    // makes the entry useful years later: it says WHICH document was signed,
    // verifiably, without containing it.
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { letter } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon" },
      ACTOR,
    );

    const signed = s.events.recorded.find((e) => e.verb === "engagement_letter.signed");
    expect(signed?.payload).toMatchObject({ signatureMethod: "fake", engagementCount: 1 });
    expect(signed?.payload["contentHash"]).toBe(letter.signedContentHash);
    expect(JSON.stringify(s.events.recorded)).not.toContain("Priya Menon");
  });

  it("writes nothing when the provider fails", async () => {
    // A letter recorded as signed because a vendor call failed quietly is the
    // worst outcome available here.
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    s.esign.failNext = true;

    await expect(
      s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR),
    ).rejects.toThrow();
    const after = await s.letters.findLetter(TENANT, id);
    expect(after?.status).toBe("sent");
    expect(s.letters.engagements).toHaveLength(0);
    expect(s.events.verbs()).not.toContain("engagement_letter.signed");
  });

  it("hashes the TERMS, so a different letter gets a different fingerprint", async () => {
    const s = setup();
    const a = await draft(s);
    await completeTerms(s, a);
    await s.service.send(TENANT, a, ACTOR);
    const signedA = await s.service.sign(
      { tenantId: TENANT, letterId: a, signedByName: "Priya" },
      ACTOR,
    );

    const b = await draft(s);
    await s.service.addLine({
      tenantId: TENANT,
      letterId: b,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "GST filing, 12 months",
      quantity: "12",
      unitAmount: "2500", // the only difference
      discountPercent: "0",
    });
    await s.service.addClause(TENANT, b, SCOPE_CLAUSE);
    await s.service.send(TENANT, b, ACTOR);
    const signedB = await s.service.sign(
      { tenantId: TENANT, letterId: b, signedByName: "Priya" },
      ACTOR,
    );

    expect(signedA.letter.signedContentHash).not.toBe(signedB.letter.signedContentHash);
  });

  it("is one-way: a signed letter cannot be withdrawn", async () => {
    // A signed letter is superseded by a new one, never pulled — the old one
    // stays readable as what was actually agreed.
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    await expect(s.service.withdraw(TENANT, id, ACTOR)).rejects.toBeInstanceOf(
      InvalidLetterTransition,
    );
  });
});

describe("the advance-fee gate", () => {
  it("holds every engagement until the advance is recorded", async () => {
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);

    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya" },
      ACTOR,
    );
    expect(engagements.every((e) => e.status === "pending_advance")).toBe(true);
    // The gate is real, not advisory: no advance, no spawn trigger, no jobs.
    expect(s.events.verbs()).not.toContain("contract.activated");

    const { released } = await s.service.recordAdvance(TENANT, id, USER, ACTOR);
    expect(released).toHaveLength(1);
    expect(released[0]?.status).toBe("active");
    expect(s.events.recorded.filter((e) => e.verb === "contract.activated")).toHaveLength(1);
  });

  it("refuses an advance nobody asked for", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(s.service.recordAdvance(TENANT, id, USER, ACTOR)).rejects.toBeInstanceOf(
      AdvanceNotRequired,
    );
  });

  it("refuses to record the same advance twice", async () => {
    // Two receipts in an uncorrectable log for one payment.
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    await s.service.recordAdvance(TENANT, id, USER, ACTOR);
    await expect(s.service.recordAdvance(TENANT, id, USER, ACTOR)).rejects.toBeInstanceOf(
      AdvanceAlreadyRecorded,
    );
  });

  it("names who recorded it, because it is an attestation and not a receipt", async () => {
    // Until payments (T3.5) exist, a person asserts the money arrived. WHO said
    // so is the whole value of the record.
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    await s.service.recordAdvance(TENANT, id, USER, ACTOR);

    const recorded = s.events.recorded.find(
      (e) => e.verb === "engagement_letter.advance_recorded",
    );
    expect(recorded?.payload).toMatchObject({
      recordedByUserId: USER,
      amount: "10000",
      currency: "INR",
    });
  });
});
