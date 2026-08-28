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
  AlreadySuperseded,
  ClauseNotPublished,
  ClauseWrongJurisdiction,
  EmptyLetter,
  InvalidDate,
  InvalidJurisdiction,
  InvalidLetterTransition,
  LetterNotEditable,
  LetterNotFound,
  LetterNotSupersedable,
  NoClauses,
  NotAClause,
  ServiceNotQuotable,
} from "../../src/domain/engagement/errors";
import { NoIssuingEntity } from "../../src/domain/document/errors";
import {
  canonicalContent,
  engagementState,
  isDay,
  resolveEffectiveFrom,
  utcDay,
} from "../../src/domain/engagement/model";
import { SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
// The client's own companies. An engagement is `service × one legal entity`, so
// a letter covering both fans out into engagements that differ in exactly this.
const ENTITY_A = "00000000-0000-0000-0000-0000000000b1";
const ENTITY_B = "00000000-0000-0000-0000-0000000000b2";
const USER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: USER };
/** The named individual a letter is addressed to, care-of the client. */
const CONTACT = "00000000-0000-0000-0000-0000000000bc";
/** Who binds the firm, and who takes over from them. Deliberately NOT `USER`:
 *  the person who operates the system and the person with authority to bind are
 *  two different people at any real firm, and G1.4 exists to keep them apart. */
const SIGNATORY = "00000000-0000-0000-0000-0000000000c1";
const SUCCESSOR = "00000000-0000-0000-0000-0000000000c2";
/** Another firm, for the tenant wall. */
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ab";

const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";
const LIABILITY_IN = "00000000-0000-0000-0000-0000000000e2";
const LIABILITY_AE = "00000000-0000-0000-0000-0000000000e3";
/** One of the FIRM's own entities, beside the fallback it is seeded with. */
const UAE_ENTITY = "00000000-0000-0000-0000-0000000000f2";

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

interface DraftOverrides {
  advanceRequired?: boolean;
  advanceAmount?: string;
  jurisdiction?: string;
  background?: string;
  addressedToPartyId?: string;
  issuedOn?: string;
  supersedesId?: string;
  effectiveFrom?: string;
}

async function draft(s: ReturnType<typeof setup>, overrides: DraftOverrides = {}): Promise<string> {
  const { advanceRequired, jurisdiction, ...rest } = overrides;
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: jurisdiction ?? "IN",
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: advanceRequired ?? false,
      ...rest,
    },
    ACTOR,
  );
  return letter.id;
}

async function completeTerms(
  s: ReturnType<typeof setup>,
  id: string,
  lineEffectiveFrom?: string,
): Promise<void> {
  await s.service.addLine({
    tenantId: TENANT,
    letterId: id,
    entityPartyId: ENTITY_A,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
    ...(lineEffectiveFrom === undefined ? {} : { effectiveFrom: lineEffectiveFrom }),
  });
  await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
}

/** Draft → terms → send → sign, which is the only path an engagement exists
 *  down. Returns the letter id. */
async function signedLetter(
  s: ReturnType<typeof setup>,
  overrides: DraftOverrides = {},
  lineEffectiveFrom?: string,
): Promise<string> {
  const id = await draft(s, overrides);
  await completeTerms(s, id, lineEffectiveFrom);
  await s.service.send(TENANT, id, ACTOR);
  await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya Menon" }, ACTOR);
  return id;
}

describe("drafting", () => {
  it("gives the letter a number a client can quote back", async () => {
    // G1.1's acceptance on the letter, which is where it matters most: this is
    // the string that appears in the client's own records and in a filing.
    const s = setup();
    const id = await draft(s);
    expect((await s.letters.findLetter(TENANT, id))?.ref).toBe("EL-2026-0001");
    const second = await draft(s);
    expect((await s.letters.findLetter(TENANT, second))?.ref).toBe("EL-2026-0002");
  });

  it("names which of the firm's own entities is contracting", async () => {
    // G1.2's acceptance. The letter says WHERE the work is; this says WHO on
    // our side is bound, and the two are different questions.
    const s = setup();
    const id = await draft(s);
    const letter = await s.letters.findLetter(TENANT, id);
    expect(letter?.issuingEntityPartyId).toBe(SEEDED_FIRM_ENTITY);
    expect(s.events.recorded[0]?.payload).toMatchObject({
      ref: "EL-2026-0001",
      issuingEntityPartyId: SEEDED_FIRM_ENTITY,
    });
  });

  it("looks the rule up on the letter's own jurisdiction", async () => {
    // "jahan ka client hota hai, wahan ki entity". The letter already states
    // where the client is, so that is the key — no second field to keep in step
    // with the first.
    const s = setup();
    await s.firmEntities.set({
      id: "pref-ae",
      tenantId: TENANT,
      clientJurisdiction: "AE",
      firmEntityPartyId: UAE_ENTITY,
      note: null,
    });
    const uae = await draft(s, { jurisdiction: "AE" });
    expect((await s.letters.findLetter(TENANT, uae))?.issuingEntityPartyId).toBe(UAE_ENTITY);
    // A country the firm has no entity in resolves through the FALLBACK ROW.
    const indian = await draft(s, { jurisdiction: "IN" });
    expect((await s.letters.findLetter(TENANT, indian))?.issuingEntityPartyId).toBe(
      SEEDED_FIRM_ENTITY,
    );
  });

  it("refuses to draft at all for a firm that has named no entity", async () => {
    const s = setup();
    s.firmEntities.seededFallbackPartyId = null;
    await expect(draft(s)).rejects.toBeInstanceOf(NoIssuingEntity);
    expect(s.letters.letters).toHaveLength(0);
  });

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
    expect(engagements.every((e) => e.engagement.status === "active")).toBe(true);
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

    expect(new Set(engagements.map((e) => e.engagement.entityPartyId))).toEqual(
      new Set([ENTITY_A, ENTITY_B]),
    );
    // BOTH are kept: invoicing needs who is billed, the calendar needs who the
    // work is delivered to.
    expect(engagements.every((e) => e.engagement.partyId === PARTY)).toBe(true);
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
    expect(engagements.every((e) => e.engagement.status === "pending_advance")).toBe(true);
    // The gate is real, not advisory: no advance, no spawn trigger, no jobs.
    expect(s.events.verbs()).not.toContain("contract.activated");

    const { released } = await s.service.recordAdvance(TENANT, id, USER, ACTOR);
    expect(released).toHaveLength(1);
    expect(released[0]?.engagement.status).toBe("active");
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

describe("what the signature commits to", () => {
  it("covers the reference and the entity that is contracting", () => {
    // The most basic term there is — who the client contracted with — and the
    // one the letter that started this review got wrong. A hash that did not
    // cover it would verify a document without verifying its counterparty.
    const base = {
      letter: {
        ref: "EL-2026-0001",
        issuingEntityPartyId: SEEDED_FIRM_ENTITY,
        jurisdiction: "IN",
        title: "Acme — FY26",
        currency: "INR",
        fxRate: "1",
        advanceRequired: false,
        advanceAmount: null,
        background: null,
        addressedToPartyId: null,
        issuedOn: null,
        supersedesId: null,
        effectiveFrom: null,
        firmSignatoryUserId: null,
        firmSignatoryTitle: null,
      },
      lines: [],
      clauses: [],
    };
    const elsewhere = {
      ...base,
      letter: { ...base.letter, issuingEntityPartyId: UAE_ENTITY },
    };
    const renumbered = { ...base, letter: { ...base.letter, ref: "EL-2026-0002" } };

    expect(canonicalContent(base)).not.toBe(canonicalContent(elsewhere));
    expect(canonicalContent(base)).not.toBe(canonicalContent(renumbered));
    // And it is deterministic, which is the whole point of it.
    expect(canonicalContent(base)).toBe(canonicalContent({ ...base }));
  });
});

// ── G1.3 · the prose a letter opens and closes with ─────────────────────────

describe("what the letter actually says", () => {
  it("opens with a background and is addressed to a named person", async () => {
    // G1.3's acceptance. Before this the document had no opening paragraph and
    // no addressee at all — `addressedTo` was a COMPUTED STRING (the party's
    // display name), so a letter could be addressed to a company and never to
    // the person at it.
    const s = setup();
    s.letters.partyNames.set(CONTACT, "R Sharma");
    s.letters.partyNames.set(PARTY, "Acme Ltd");
    const id = await draft(s, {
      background: "Acme is separating its logistics arm and needs GST filings for both.",
      addressedToPartyId: CONTACT,
      issuedOn: "2026-09-01",
    });

    const record = await s.service.describe(TENANT, id);
    expect(record.letter.background).toContain("separating its logistics arm");
    expect(record.letter.issuedOn).toBe("2026-09-01");
    // The NAME, not the id — the letter prints "R Sharma, c/o Acme Ltd", and
    // the c/o is the client the letter already names.
    expect(record.addressedTo).toEqual({ id: CONTACT, displayName: "R Sharma" });
    expect(record.party.displayName).toBe("Acme Ltd");
  });

  it("keeps the addressee optional — a letter to no individual is ordinary", async () => {
    const s = setup();
    const id = await draft(s);
    const record = await s.service.describe(TENANT, id);
    expect(record.addressedTo).toBeNull();
    expect(record.letter.background).toBeNull();
  });

  it("refuses a date that is not one", async () => {
    const s = setup();
    await expect(draft(s, { issuedOn: "01/09/2026" })).rejects.toBeInstanceOf(InvalidDate);
    await expect(draft(s, { effectiveFrom: "next October" })).rejects.toBeInstanceOf(InvalidDate);
  });

  it("stores blank prose as nothing at all", async () => {
    // "   " is somebody clearing a field, not an empty paragraph — and the
    // column refuses blank prose outright, so the service must not send it one.
    const s = setup();
    const id = await draft(s, { background: "   " });
    expect((await s.letters.findLetter(TENANT, id))?.background).toBeNull();
  });
});

describe("superseding a letter", () => {
  it("records which agreement the new letter replaces, in both directions", async () => {
    // The instruction the model has been giving since T2.3 — "supersede it with
    // a new letter instead" — finally has somewhere to be recorded. And it is
    // readable BOTH ways: a screen showing the old letter has to be able to say
    // "no longer in force, see EL-2026-0002", which is the question anybody
    // opening a signed letter actually has.
    const s = setup();
    const original = await signedLetter(s);
    const replacement = await draft(s, { supersedesId: original });

    const successor = await s.service.describe(TENANT, replacement);
    expect(successor.letter.supersedesId).toBe(original);
    expect(successor.supersedes).toEqual({ id: original, ref: "EL-2026-0001" });

    const superseded = await s.service.describe(TENANT, original);
    expect(superseded.supersededBy).toEqual({ id: replacement, ref: "EL-2026-0002" });
    // …and the lineage is on the successor's first ledger row, so "why does
    // this client have two letters for one year" is answered without comparing
    // dates.
    const drafted = s.events.recorded.filter((e) => e.verb === "engagement_letter.drafted");
    expect(drafted[1]?.payload).toMatchObject({ supersedesId: original });
  });

  it("refuses to supersede a letter nobody signed", async () => {
    // A draft is EDITED; a letter that went out and was never signed is
    // WITHDRAWN. Superseding exists for the one thing that can never be edited.
    const s = setup();
    const stillADraft = await draft(s);
    await expect(draft(s, { supersedesId: stillADraft })).rejects.toBeInstanceOf(
      LetterNotSupersedable,
    );

    await completeTerms(s, stillADraft);
    await s.service.send(TENANT, stillADraft, ACTOR);
    await expect(draft(s, { supersedesId: stillADraft })).rejects.toBeInstanceOf(
      LetterNotSupersedable,
    );
  });

  it("refuses a second live replacement for the same agreement", async () => {
    // Two live letters replacing one agreement leaves nobody able to say which
    // is in force.
    const s = setup();
    const original = await signedLetter(s);
    await draft(s, { supersedesId: original });
    await expect(draft(s, { supersedesId: original })).rejects.toBeInstanceOf(AlreadySuperseded);
  });

  it("frees the slot when the replacement is withdrawn", async () => {
    // Drafting a replacement, pulling it, and drafting a better one is an
    // ordinary afternoon. Only a LIVE successor holds the slot.
    const s = setup();
    const original = await signedLetter(s);
    const abandoned = await draft(s, { supersedesId: original });
    await s.service.withdraw(TENANT, abandoned, ACTOR);

    const replacement = await draft(s, { supersedesId: original });
    expect((await s.service.describe(TENANT, original)).supersededBy).toEqual({
      id: replacement,
      ref: "EL-2026-0003",
    });
  });

  it("refuses to supersede a letter at another firm", async () => {
    const s = setup();
    const ours = await signedLetter(s);
    await expect(
      s.service.draft(
        {
          tenantId: OTHER_TENANT,
          partyId: PARTY,
          jurisdiction: "IN",
          title: "Someone else's letter",
          currency: "INR",
          fxRate: "1",
          fxRateDate: "2026-07-01",
          advanceRequired: false,
          supersedesId: ours,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LetterNotFound);
  });
});

// ── G1.4 · the firm's own signature block ──────────────────────────────────

describe("the firm's signature block", () => {
  it("prints BOTH signatures — the firm's when it goes out, the client's when it comes back", async () => {
    // G1.4's acceptance. A real letter carries "Yours sincerely, …, Director"
    // AND the client's acceptance; only the client's half was modelled, so the
    // firm's block rendered as a blank line.
    const s = setup();
    s.firm.name(SIGNATORY, "Director");
    const id = await draft(s);
    await completeTerms(s, id);

    const sent = await s.service.send(TENANT, id, ACTOR);
    expect(sent.firmSignatoryUserId).toBe(SIGNATORY);
    expect(sent.firmSignatoryTitle).toBe("Director");
    expect(sent.firmSignedAt).not.toBeNull();

    const { letter } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon", signedByTitle: "Director" },
      ACTOR,
    );
    // Both halves, on one document.
    expect(letter.signedByName).toBe("Priya Menon");
    expect(letter.signedByTitle).toBe("Director");
    expect(letter.firmSignatoryUserId).toBe(SIGNATORY);
  });

  it("records who bound the firm WITHOUT losing who operated the system", async () => {
    // The distinction G1.4 exists for. Authority to bind is an audit question;
    // who pressed send is a different fact, and the ledger has always recorded
    // it as the actor. A single field could not answer both, because at any
    // real firm they are two people.
    const s = setup();
    s.firm.name(SIGNATORY, "Managing Partner");
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);

    const sent = s.events.recorded.find((e) => e.verb === "engagement_letter.sent");
    expect(sent?.actorId).toBe(USER); // the operator, unchanged
    expect(sent?.payload).toMatchObject({
      firmSignatoryUserId: SIGNATORY, // the authority, new
      firmSignatoryTitle: "Managing Partner",
    });
    expect(ACTOR.id).not.toBe(SIGNATORY);
  });

  it("still sends when the firm has named nobody", async () => {
    // A firm that has not configured a signatory is not blocked from operating.
    // Refusing would be defensible and is recorded as an open question; it
    // would also lock every existing firm out of the flow they use today.
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    const sent = await s.service.send(TENANT, id, ACTOR);
    expect(sent.firmSignatoryUserId).toBeNull();
    expect(sent.firmSignatoryTitle).toBeNull();
    expect(sent.firmSignedAt).toBeNull();
  });

  it("resolves the signatory's NAME for the block, and keeps the title as stored", async () => {
    // The name is a join — an erased account stops resolving and the letter
    // survives, the same contract the ledger's actor name keeps. The TITLE is
    // stored on the letter, because a promotion must not restate what the
    // document said.
    const s = setup();
    s.firm.name(SIGNATORY, "Director");
    s.letters.userNames.set(SIGNATORY, "Siddharth Jain");
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);

    const record = await s.service.describe(TENANT, id);
    expect(record.firmSignatory?.displayName).toBe("Siddharth Jain");
    expect(record.firmSignatory?.title).toBe("Director");
  });

  it("takes the block ONCE, when the letter goes out", async () => {
    // A snapshot, like the issuing entity: naming a successor next year must
    // not restate who signed a letter this year.
    const s = setup();
    s.firm.name(SIGNATORY, "Director");
    const id = await draft(s);
    await completeTerms(s, id);
    const sent = await s.service.send(TENANT, id, ACTOR);

    s.firm.name(SUCCESSOR, "Managing Partner");
    const later = await s.letters.findLetter(TENANT, id);
    expect(later?.firmSignatoryUserId).toBe(SIGNATORY);
    expect(later?.firmSignedAt).toBe(sent.firmSignedAt);
  });

  it("dates the document the day it goes out, unless the drafter dated it", async () => {
    const s = setup();
    const dated = await draft(s, { issuedOn: "2026-06-15" });
    await completeTerms(s, dated);
    expect((await s.service.send(TENANT, dated, ACTOR)).issuedOn).toBe("2026-06-15");

    const undated = await draft(s);
    await completeTerms(s, undated);
    // The fake clock is 2026-07-01T09:00:00Z.
    expect((await s.service.send(TENANT, undated, ACTOR)).issuedOn).toBe("2026-07-01");
  });
});

// ── G1.5 · effective dates ─────────────────────────────────────────────────

describe("when the work begins", () => {
  it("opens engagements on the letter's date, not the signature's", async () => {
    // G1.5's acceptance. A letter signed in September can open engagements that
    // begin in October — the case that could not be written down at all, and
    // that had the firm issued August's filings for work it had not taken on.
    const s = setup();
    const id = await signedLetter(s, { effectiveFrom: "2026-10-01" });
    const [engagement] = await s.service.listEngagements(TENANT, id);
    expect(engagement?.engagement.effectiveFrom).toBe("2026-10-01");
    // The COMMERCIAL gates are open — this letter needed no advance — but the
    // work has not started, and every read says so.
    expect(engagement?.engagement.status).toBe("active");
    expect(engagement?.state).toBe("pending_start");
  });

  it("lets ONE line begin on a different date from the rest", async () => {
    // The second half of the acceptance, and the reason the column is on both:
    // per line can express a single shared date and the reverse cannot.
    const s = setup();
    const id = await draft(s, { effectiveFrom: "2026-10-01" });
    await completeTerms(s, id, "2026-12-01"); // this line starts later still
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
      { tenantId: TENANT, letterId: id, signedByName: "Priya" },
      ACTOR,
    );

    const byEntity = new Map(engagements.map((e) => [e.engagement.entityPartyId, e]));
    expect(byEntity.get(ENTITY_A)?.engagement.effectiveFrom).toBe("2026-12-01"); // the line's
    expect(byEntity.get(ENTITY_B)?.engagement.effectiveFrom).toBe("2026-10-01"); // the letter's
  });

  it("falls back to the signature date when nobody said otherwise", async () => {
    const s = setup();
    const id = await signedLetter(s);
    const [engagement] = await s.service.listEngagements(TENANT, id);
    // The fake clock is 2026-07-01T09:00:00Z, and it starts today.
    expect(engagement?.engagement.effectiveFrom).toBe("2026-07-01");
    expect(engagement?.state).toBe("active");
  });

  it("puts the start date on contract.activated, and emits it anyway", async () => {
    // THE CROSS-LANE DECISION, asserted rather than described. The event fires
    // when the COMMERCIAL gates open — not on the effective date — because
    // nothing in this service runs on a timer and an engagement nobody was told
    // about is worse than one scheduled early. What stops August's filings
    // being issued is the DATE travelling with it: the scheduler owns a clock
    // and already plans future periods.
    const s = setup();
    await signedLetter(s, { effectiveFrom: "2026-10-01" });
    const activated = s.events.recorded.filter((e) => e.verb === "contract.activated");
    expect(activated).toHaveLength(1);
    expect(activated[0]?.payload).toMatchObject({ effectiveFrom: "2026-10-01" });
  });

  it("keeps the fee gate ahead of the date gate", async () => {
    // Money first. An engagement waiting on an advance is `pending_advance`
    // whatever the calendar says — telling somebody their October work is
    // "starting soon" when nobody has paid for it is the wrong reassurance —
    // and it becomes `pending_start` only once the advance is in.
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya" },
      ACTOR,
    );
    expect(engagements[0]?.state).toBe("pending_advance");
    expect(s.events.verbs()).not.toContain("contract.activated");

    const { released } = await s.service.recordAdvance(TENANT, id, USER, ACTOR);
    expect(released[0]?.state).toBe("active");
  });

  it("the signature commits to the dates — they are terms", async () => {
    // Same services, same money, same clauses, different start date. If the
    // effective date sat outside the canonical rendering, the hash would call
    // these two agreements identical while one of them commits the firm to
    // three months of work the other does not.
    const s = setup();
    const october = await signedLetter(s, { effectiveFrom: "2026-10-01" });
    const immediately = await signedLetter(s, { effectiveFrom: "2026-07-01" });
    expect((await s.letters.findLetter(TENANT, october))?.signedContentHash).not.toBe(
      (await s.letters.findLetter(TENANT, immediately))?.signedContentHash,
    );
  });
});

// ── The pure rules, without any infrastructure at all ───────────────────────

describe("the effective-date rules themselves", () => {
  it("prefers the line, then the letter, then the signature", () => {
    // The two-level default written once. "Null on the line means the letter,
    // null on the letter means the signature date" is the kind of rule that
    // gets written differently the second time somebody needs it.
    expect(resolveEffectiveFrom("2026-12-01", "2026-10-01", "2026-09-15")).toBe("2026-12-01");
    expect(resolveEffectiveFrom(null, "2026-10-01", "2026-09-15")).toBe("2026-10-01");
    expect(resolveEffectiveFrom(null, null, "2026-09-15")).toBe("2026-09-15");
  });

  it("narrows only `active`, and only while the date is ahead", () => {
    const on = (status: string, effectiveFrom: string): string =>
      engagementState(
        { status: status as "active" | "pending_advance" | "paused", effectiveFrom },
        "2026-09-15",
      );

    expect(on("active", "2026-10-01")).toBe("pending_start");
    expect(on("active", "2026-09-15")).toBe("active"); // today counts as started
    expect(on("active", "2026-08-01")).toBe("active");
    // The money gate outranks the calendar: "starting soon" is the wrong thing
    // to say about work nobody has paid for.
    expect(on("pending_advance", "2026-10-01")).toBe("pending_advance");
    // And a decision outranks both.
    expect(on("paused", "2026-10-01")).toBe("paused");
  });

  it("reads a day as a day, and refuses anything else", () => {
    expect(isDay("2026-10-01")).toBe(true);
    expect(isDay("2026-13-01")).toBe(false); // not a month
    expect(isDay("2026-10-1")).toBe(false);
    expect(isDay("01/10/2026")).toBe(false);
    expect(isDay("2026-10-01T00:00:00Z")).toBe(false); // an instant is not a day
    // UTC, not the machine's zone: two pods in two regions must not disagree
    // about which day a contract started.
    expect(utcDay(new Date("2026-10-01T23:30:00Z"))).toBe("2026-10-01");
    expect(utcDay(new Date("2026-10-01T00:30:00Z"))).toBe("2026-10-01");
  });
});

describe("what the signature commits to", () => {
  it("covers every field G1.3–G1.5 added", () => {
    // The freeze protects the row; the HASH protects the meaning. A field left
    // out of the canonical rendering is one that could be swapped for another
    // without the signature noticing — so each of these is asserted by changing
    // exactly one thing and demanding a different digest.
    const line = {
      position: 1,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "GST filing",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "0",
      effectiveFrom: null as string | null,
    };
    const base = {
      letter: {
        ref: "EL-2026-0001",
        issuingEntityPartyId: SEEDED_FIRM_ENTITY,
        jurisdiction: "IN",
        title: "Acme — FY26",
        currency: "INR",
        fxRate: "1",
        advanceRequired: false,
        advanceAmount: null as string | null,
        background: "Acme is separating its logistics arm." as string | null,
        addressedToPartyId: CONTACT,
        issuedOn: "2026-09-01" as string | null,
        supersedesId: null as string | null,
        effectiveFrom: "2026-10-01" as string | null,
        firmSignatoryUserId: SIGNATORY,
        firmSignatoryTitle: "Director",
      },
      lines: [line],
      clauses: [],
    };

    const variants: Record<string, typeof base> = {
      background: { ...base, letter: { ...base.letter, background: "Something else entirely." } },
      addressee: { ...base, letter: { ...base.letter, addressedToPartyId: PARTY } },
      issuedOn: { ...base, letter: { ...base.letter, issuedOn: "2026-09-02" } },
      supersedes: { ...base, letter: { ...base.letter, supersedesId: ENTITY_B } },
      effectiveFrom: { ...base, letter: { ...base.letter, effectiveFrom: "2026-11-01" } },
      signatory: { ...base, letter: { ...base.letter, firmSignatoryUserId: SUCCESSOR } },
      capacity: { ...base, letter: { ...base.letter, firmSignatoryTitle: "Managing Partner" } },
      lineDate: { ...base, lines: [{ ...line, effectiveFrom: "2026-12-01" }] },
    };

    const rendered = canonicalContent(base);
    for (const [field, variant] of Object.entries(variants)) {
      expect(canonicalContent(variant), `${field} is outside the signature`).not.toBe(rendered);
    }
    // …and it is still deterministic, which is the whole point of it.
    expect(canonicalContent({ ...base })).toBe(rendered);
  });
});
