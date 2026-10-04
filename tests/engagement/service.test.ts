// The rules that decide whether a firm becomes contractually bound, against
// in-memory ports.
//
// What is proven HERE: the pin, the jurisdiction check, the completeness of the
// terms, the fan-out, and the fee gate. What is NOT proven here is the FREEZE —
// that is a trigger in migration 0017, and a fake asserting its own behaviour
// would prove nothing. See letter.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import type { QuotedLine, QuotedProposal } from "../../src/usecase/engagement/ports";
import {
  AdvanceAmountRequired,
  InvalidLineAdvance,
  OneKindOfAdvance,
  AlreadySuperseded,
  ClauseNotPublished,
  ClauseLawNotIssuers,
  ClauseWrongJurisdiction,
  IssuerJurisdictionUnknown,
  EmptyLetter,
  InvalidDate,
  InvalidJurisdiction,
  InvalidLetterTransition,
  LetterNotEditable,
  LetterNotFound,
  LetterNotSupersedable,
  NoClauses,
  LetterHasNoBody,
  NotAClause,
  QuoteHasNoLines,
  QuoteJurisdictionUnclear,
  QuoteNamesNoEntity,
  QuoteNotAccepted,
  QuoteNotFound,
  ServiceNotQuotable,
  InvalidLineBillingFrequency,
  InvalidLetterBillingTiming,
  InvalidOutOfPocketEstimate,
  UnpricedLineHasDiscount,
  ServiceHasNoListPrice,
  LetterPartyArchived,
  LetterClientIsOwnCompany,
  LetterNotCallersToday,
} from "../../src/domain/engagement/errors";
import { NoIssuingEntity } from "../../src/domain/document/errors";
import {
  AddresseeNotAPerson,
  AddresseeNotLinked,
  EntityOutsideClient,
  IssuerNotAFirmEntity,
  QuoteOfAnotherClient,
  FeeGroupEmpty,
  FeeGroupNotEmpty,
  FeeGroupNotFound,
  FeeGroupTitleRequired,
  GroupedLinePriced,
  InvalidAmount,
  LineNotPriced,
} from "../../src/domain/engagement/errors";
import type { BillingFrequency } from "../../src/domain/document/model";
import {
  CURRENT_LETTER_LAYOUT,
  canonicalContent,
  engagementState,
  isDay,
  resolveEffectiveFrom,
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
/** G1.8. The firm's US and Indian entities, and the law-bearing clauses whose
 *  terms they are compared against. */
const US_ENTITY = "00000000-0000-0000-0000-0000000000f3";
const IN_ENTITY = "00000000-0000-0000-0000-0000000000f4";
const LAW_IN = "00000000-0000-0000-0000-0000000000e4";
const LAW_US = "00000000-0000-0000-0000-0000000000e5";
const FORUM_SG = "00000000-0000-0000-0000-0000000000e6";

function setup(): ReturnType<typeof makeEngagementFakes> & { service: EngagementService } {
  const fakes = makeEngagementFakes();
  // THE CLIENT'S STRUCTURE (F-10-1): both companies are the client's and the
  // contact holds a role there, so a letter may cover the one and be
  // addressed to the other. The refusals have their own describe block.
  fakes.structure.record(PARTY, { entities: [ENTITY_A, ENTITY_B], people: [CONTACT] });
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
  // G1.8's fixtures. Note what LAW_IN is: applicable EVERYWHERE and naming
  // Indian law — which is exactly the clause that went out on the firm's real
  // US letter, and exactly the shape `jurisdictions` cannot catch, because
  // every word of it is true.
  fakes.library.publishClause(LAW_IN, "governing-law-in", {
    title: "Governing law and jurisdiction",
    text: "This engagement is governed by the laws of the Republic of India.",
    jurisdictions: [],
    governingLaw: { jurisdiction: "IN", text: "the laws of the Republic of India" },
    courts: { jurisdiction: "IN", text: "the courts at New Delhi" },
  });
  fakes.library.publishClause(LAW_US, "governing-law-us", {
    title: "Governing law and jurisdiction",
    text: "This engagement is governed by the laws of the State of Delaware.",
    jurisdictions: [],
    governingLaw: { jurisdiction: "US", text: "the laws of the State of Delaware" },
    courts: { jurisdiction: "US", text: "the state and federal courts of Delaware" },
  });
  // The right law and the WRONG forum. Half the bug the firm caught was the
  // courts, so a check that only compared the law would pass this.
  fakes.library.publishClause(FORUM_SG, "forum-sg", {
    title: "Dispute resolution",
    text: "Disputes are resolved by arbitration seated in Singapore.",
    jurisdictions: [],
    governingLaw: { jurisdiction: "US", text: "the laws of the State of Delaware" },
    courts: { jurisdiction: "SG", text: "arbitration seated in Singapore" },
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
  await writeOpening(s.prose, TENANT, id);
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

  it.each([["India"], ["ind"], [""], ["I1"], ["DD"], ["UK"]])("refuses %j as a jurisdiction", async (j) => {
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

describe("a line with no price, and the wording that goes with it", () => {
  const SCOPED = "00000000-0000-0000-0000-0000000000d5";

  function withScopedService(): ReturnType<typeof setup> {
    const s = setup();
    s.library.publishService(SCOPED, "bookkeeping", {
      name: "Monthly bookkeeping",
      billingBasis: "retainer",
      recurrence: "monthly",
      scope: "Books written up monthly.",
      clientObligations: "Records by the 5th.",
      volumeLimits: "Under 1,000 entries.",
      exclusions: "Statutory audit is not included.",
    });
    return s;
  }

  it("agrees a line as mutually agreed, and leaves it out of the totals", async () => {
    // On a LETTER this is a term two parties sign. The old schema could only
    // record it as zero, which is a different agreement.
    const s = setup();
    const id = await draft(s);
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
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_B,
      serviceVersionId: GST,
      description: "Group restructuring advisory",
      quantity: "1",
      pricingNote: "As mutually agreed",
      discountPercent: "0",
    });

    const record = await s.service.describe(TENANT, id);
    expect(record.lines[1]?.line.unitAmount).toBeNull();
    expect(record.lines[1]?.net).toBeNull();
    // The total covers the priced line and SAYS it does not cover the other.
    expect(record.totals.net).toBe("24000.0000");
    expect(record.totals.unpricedLineCount).toBe(1);
  });

  it("refuses a price-less line with no reason, and a discount off one", async () => {
    const s = setup();
    const id = await draft(s);
    const line = {
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "Advisory",
      quantity: "1",
      discountPercent: "0",
    };
    // This service has no list price, so there is nothing to quote it at.
    const err = await s.service.addLine(line).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceHasNoListPrice);
    expect((err as Error).message).toBe(
      "GST monthly filing has no list price in INR in the catalogue. Enter the fee, or say why there is no fixed fee.",
    );
    await expect(
      s.service.addLine({ ...line, pricingNote: "As mutually agreed", discountPercent: "10" }),
    ).rejects.toBeInstanceOf(UnpricedLineHasDiscount);
  });

  it("quotes a line with neither a fee nor a reason at the catalogue's list price (B09)", async () => {
    // A login that cannot see fees reads every list price as null, so the API
    // fills the fee in from the pinned version, as the builder used to.
    const s = setup();
    const PRICED = "00000000-0000-0000-0000-0000000000d9";
    s.library.publishService(PRICED, "bookkeeping", {
      name: "Bookkeeping",
      billingBasis: "fixed",
      listPrice: { amount: "25000.00", currency: "INR" },
    });
    const id = await draft(s);
    const added = await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: PRICED,
      description: "Bookkeeping",
      quantity: "12",
      discountPercent: "0",
    });
    expect(added.unitAmount).toBe("25000.00");
    // Priced, so it carries no reason.
    expect(added.pricingNote).toBeNull();
  });

  it("carries this client's OWN wording, and says which blocks are theirs", async () => {
    // What makes an issued document reproducible: the letter holds the words, so
    // a catalogue revision cannot change what was agreed — and tailoring one
    // client's scope stops meaning "edit the catalogue".
    const s = withScopedService();
    const id = await draft(s);
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: SCOPED,
      description: "Bookkeeping",
      quantity: "12",
      unitAmount: "18000",
      discountPercent: "0",
      exclusionsOverride: "Statutory audit and the transfer-pricing study are not included.",
    });
    const line = (await s.service.describe(TENANT, id)).lines[0];
    expect(line?.terms.exclusions).toEqual({
      text: "Statutory audit and the transfer-pricing study are not included.",
      tailored: true,
    });
    // Untouched blocks still come from the pinned catalogue version…
    expect(line?.terms.scope).toEqual({ text: "Books written up monthly.", tailored: false });
    // …and the catalogue's own exclusions are still readable beside the
    // tailored ones, which is what an editor needs to show the difference.
    expect(line?.service?.exclusions).toBe("Statutory audit is not included.");
  });

  it("defaults billing frequency from the pin, and lets the deal differ", async () => {
    const s = withScopedService();
    const id = await draft(s);
    const defaulted = await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: SCOPED,
      description: "Bookkeeping",
      quantity: "12",
      unitAmount: "18000",
      discountPercent: "0",
    });
    expect(defaulted.billingFrequency).toBe("monthly");

    const quarterly = await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_B,
      serviceVersionId: SCOPED,
      description: "Bookkeeping — second entity",
      quantity: "12",
      unitAmount: "18000",
      discountPercent: "0",
      billingFrequency: "quarterly",
    });
    expect(quarterly.billingFrequency).toBe("quarterly");
  });

  it("keeps the out-of-pocket range out of the letter's money", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "US filings",
      quantity: "1",
      unitAmount: "50000",
      discountPercent: "0",
      oopEstimate: { min: "5000", max: "6000", currency: "USD" },
    });
    const record = await s.service.describe(TENANT, id);
    expect(record.lines[0]?.line.oopEstimate).toEqual({
      min: "5000",
      max: "6000",
      currency: "USD",
    });
    // The letter is in INR and its total is the fee alone. There is no rate on
    // this document for a third currency, so there is no honest conversion —
    // which is right, because an out-of-pocket estimate was never a fee.
    expect(record.totals.net).toBe("50000.0000");
    expect(record.totals.currency).toBe("INR");
  });

  it("refuses a malformed range and an unknown billing frequency", async () => {
    const s = setup();
    const id = await draft(s);
    const line = {
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "x",
      quantity: "1",
      unitAmount: "1",
      discountPercent: "0",
    };
    await expect(
      s.service.addLine({ ...line, oopEstimate: { min: "6000", max: "5000", currency: "USD" } }),
    ).rejects.toBeInstanceOf(InvalidOutOfPocketEstimate);
    await expect(
      s.service.addLine({ ...line, billingFrequency: "fortnightly" }),
    ).rejects.toBeInstanceOf(InvalidLineBillingFrequency);
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

  it("refuses a letter whose cover page says nothing, and names where the words go (CA#2)", async () => {
    // A new firm's first letter went out as "Dear Anil Deshpande, / Yours
    // sincerely," with nothing between: the firm had no standard opening and
    // nothing said so.
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
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    const refused = s.service.send(TENANT, id, ACTOR);
    await expect(refused).rejects.toBeInstanceOf(LetterHasNoBody);
    await expect(refused).rejects.toThrow(/no opening text.*Cover letter.*Standard wording/s);
    // A heading alone is not an opening either.
    await s.prose.addBlock({
      tenantId: TENANT,
      owner: { kind: "engagement_letter", id },
      kind: "cover",
      body: "Engagement letter",
      isHeading: true,
      sortOrder: 1,
    });
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(LetterHasNoBody);
    expect(s.events.recorded.some((e) => e.verb === "engagement_letter.sent")).toBe(false);

    await writeOpening(s.prose, TENANT, id);
    const sent = await s.service.send(TENANT, id, ACTOR);
    expect(sent.status).toBe("sent");
  });

  it("records a migrated paper letter with no opening text: nobody is sent its cover (CA#2 vs T6.12)", async () => {
    // The book import records a letter the client signed on paper by sending
    // it `migrated`. A new firm has no standard opening yet, so the CA#2 guard
    // refused every row of its first import ("marking it sent: This letter has
    // no opening text…") and left a draft behind each one.
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
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    const sent = await s.service.send(TENANT, id, ACTOR, { migrated: true });
    expect(sent.status).toBe("sent");
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
    await writeOpening(s.prose, TENANT, forB);
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
    await writeOpening(s.prose, TENANT, b);
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

describe("the advance no longer holds the work (0322)", () => {
  it("starts every engagement at signature, even when the letter asks for an advance", async () => {
    // Ashish (2026-10-02): "work can be started and parallelly the system should
    // keep on notifying". The advance is drafted and chased, not waited for.
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(engagements.every((e) => e.engagement.status === "active")).toBe(true);
    expect(engagements.every((e) => e.engagement.activatedAt !== null)).toBe(true);
    expect(s.events.recorded.filter((e) => e.verb === "contract.activated")).toHaveLength(engagements.length);
  });

  it("starts work signed before 0322 that still waits on its advance, once", async () => {
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    // What the 0320 gate left behind: the engagement still pending_advance.
    for (const e of engagements) {
      const at = s.letters.engagements.findIndex((x) => x.id === e.engagement.id);
      const row = s.letters.engagements[at];
      if (row !== undefined) s.letters.engagements[at] = { ...row, status: "pending_advance", activatedAt: null };
    }
    const before = s.events.recorded.length;
    expect(await s.service.startWaitingWork(TENANT, id, ACTOR)).toEqual({ started: engagements.length });
    const after = s.events.recorded.slice(before).map((e) => e.verb);
    expect(after[0]).toBe("engagement_letter.work_started_before_advance");
    expect(after.filter((v) => v === "contract.activated")).toHaveLength(engagements.length);
    expect(s.letters.engagements.every((e) => e.status === "active")).toBe(true);
    // Twice is nothing: none waits any more.
    expect(await s.service.startWaitingWork(TENANT, id, ACTOR)).toEqual({ started: 0 });
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
      feeGroups: [],
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

// ── Whose day a letter is dated and its work starts on (2026-09-28) ─────────

describe("the day on a letter is the caller's, or the firm's, never Greenwich's", () => {
  /** 01:00 on 29 September in Delhi, which is still the 28th in UTC. */
  function inDelhiAtOne() {
    const s = setup();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set("2026-09-28T19:30:00.000Z");
    return s;
  }

  it("dates an undated letter on the firm's day when it is sent at 01:00 IST", async () => {
    const s = inDelhiAtOne();
    const id = await draft(s);
    await completeTerms(s, id);
    expect((await s.service.send(TENANT, id, ACTOR)).issuedOn).toBe("2026-09-29");
  });

  it("takes the browser's day, and refuses one that is not today anywhere", async () => {
    const s = inDelhiAtOne();
    const id = await draft(s);
    await completeTerms(s, id);
    await expect(
      s.service.send(TENANT, id, ACTOR, { asOf: "2026-09-25" }),
    ).rejects.toBeInstanceOf(LetterNotCallersToday);
    // Refused before anything was written: still a draft, still undated.
    expect((await s.letters.findLetter(TENANT, id))?.status).toBe("draft");
    expect((await s.service.send(TENANT, id, ACTOR, { asOf: "2026-09-29" })).issuedOn).toBe(
      "2026-09-29",
    );
  });

  it("still prints the day the drafter chose", async () => {
    const s = inDelhiAtOne();
    const id = await draft(s, { issuedOn: "2026-09-15" });
    await completeTerms(s, id);
    expect((await s.service.send(TENANT, id, ACTOR, { asOf: "2026-09-29" })).issuedOn).toBe(
      "2026-09-15",
    );
  });

  it("starts the work on the firm's day, and reads it as started", async () => {
    // On Greenwich's day the engagement started on the 28th, and the read that
    // followed called work signed that morning "not started" until 05:30.
    const s = inDelhiAtOne();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon" },
      ACTOR,
    );
    expect(engagements[0]?.engagement.effectiveFrom).toBe("2026-09-29");
    expect(engagements[0]?.state).toBe("active");
    const [listed] = await s.service.listEngagements(TENANT, id);
    expect(listed?.state).toBe("active");
  });

  it("starts the work on the browser's day when it records the signature", async () => {
    const s = inDelhiAtOne();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR, { asOf: "2026-09-29" });
    await expect(
      s.service.sign(
        { tenantId: TENANT, letterId: id, signedByName: "Priya Menon", asOf: "2026-10-05" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LetterNotCallersToday);
    expect((await s.letters.findLetter(TENANT, id))?.status).toBe("sent");

    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya Menon", asOf: "2026-09-29" },
      ACTOR,
    );
    expect(engagements[0]?.engagement.effectiveFrom).toBe("2026-09-29");
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
    // Since 0322 the advance holds nothing: the work's state follows only the
    // calendar, whatever the letter asks of the client.
    const s = setup();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya" },
      ACTOR,
    );
    expect(engagements[0]?.engagement.status).toBe("active");
    expect(s.events.verbs()).toContain("contract.activated");
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
    // A day that does not exist (B43): it used to pass, and reach Postgres.
    expect(isDay("2026-02-31")).toBe(false);
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
      unitAmount: "2000" as string | null,
      discountPercent: "0",
      effectiveFrom: null as string | null,
      jurisdiction: "IN" as string | null,
      billingFrequency: "monthly" as BillingFrequency | null,
      scopeOverride: "Filing of GSTR-1 and GSTR-3B for the Bengaluru GSTIN." as string | null,
      clientObligationsOverride: null as string | null,
      volumeLimitsOverride: null as string | null,
      exclusionsOverride: null as string | null,
      oopEstimate: null as { min: string; max: string; currency: string } | null,
      pricingNote: null as string | null,
      feeGroupId: null as string | null,
      billingTiming: null as "arrears" | "advance" | "on_date" | null,
      billingOn: null as string | null,
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
      feeGroups: [] as {
        id: string;
        position: number;
        title: string;
        billingFrequency: BillingFrequency;
        amount: string;
        paymentTerms: string | null;
        feeDescription: string | null;
        intro: string | null;
        deliverables: string | null;
        clientObligations: string | null;
        billingTiming: "arrears" | "advance" | "on_date" | null;
        billingOn: string | null;
      }[],
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
      // G1.6. The four OVERRIDES matter most: they are the wording THIS client
      // agreed to, and a hash that did not cover them would verify a document
      // whose scope was whatever the catalogue happened to say — the exact
      // failure the overrides exist to prevent.
      lineScope: {
        ...base,
        lines: [{ ...line, scopeOverride: "Filing for BOTH GSTINs." }],
      },
      lineObligations: {
        ...base,
        lines: [{ ...line, clientObligationsOverride: "Records by the 3rd." }],
      },
      lineLimits: {
        ...base,
        lines: [{ ...line, volumeLimitsOverride: "Up to 2,000 entries." }],
      },
      lineExclusions: {
        ...base,
        lines: [{ ...line, exclusionsOverride: "Appeals are not included." }],
      },
      lineJurisdiction: { ...base, lines: [{ ...line, jurisdiction: "AE" }] },
      lineBilling: { ...base, lines: [{ ...line, billingFrequency: "quarterly" as const }] },
      lineOop: {
        ...base,
        lines: [{ ...line, oopEstimate: { min: "5000", max: "6000", currency: "USD" } }],
      },
      // "As mutually agreed" and "agreed at 2000" are different terms, and the
      // reason has to be inside the hash or a signed letter's only statement
      // about its own price sits outside the signature.
      lineUnpriced: {
        ...base,
        lines: [{ ...line, unitAmount: null, pricingNote: "As mutually agreed" }],
      },
      // When it is invoiced (0319) is a term: advance and a chosen date differ.
      lineBilledInAdvance: { ...base, lines: [{ ...line, billingTiming: "advance" as const }] },
      lineBilledOnADate: {
        ...base,
        lines: [{ ...line, billingTiming: "on_date" as const, billingOn: "2026-11-15" }],
      },
    };

    const rendered = canonicalContent(base);
    for (const [field, variant] of Object.entries(variants)) {
      expect(canonicalContent(variant), `${field} is outside the signature`).not.toBe(rendered);
    }
    // …and it is still deterministic, which is the whole point of it.
    expect(canonicalContent({ ...base })).toBe(rendered);
  });
});

describe("G1.8 — a letter cannot print another country's law", () => {
  // THE ACCEPTANCE, and the sharpest finding of the project this product was
  // designed against. The firm's real engagement letter was issued by its US
  // entity to a US client, and its standard terms named Indian law and Delhi
  // courts. The verdict was flat: "No. This is wrong. For US it's US. For UAE
  // it's DIFC in Dubai."
  //
  // A human review let that letter out. So the refusal is a machine equality
  // test against where the ISSUING ENTITY is registered — not against the
  // letter's own jurisdiction, and not against the clause's `jurisdictions`,
  // which says where a clause may be USED and was satisfied by the real bug.

  /** The firm operating two entities, each registered somewhere, with a rule
   *  routing clients to them. This is the fixture the whole block needs. */
  async function twoEntityFirm(): Promise<ReturnType<typeof setup>> {
    const s = setup();
    s.firmEntities.partyNames.set(US_ENTITY, "10x Global Inc.");
    s.firmEntities.partyNames.set(IN_ENTITY, "10x Global Advisory Private Limited");
    s.firmEntities.partyJurisdictions.set(US_ENTITY, "US");
    s.firmEntities.partyJurisdictions.set(IN_ENTITY, "IN");
    await s.firmEntities.set({
      id: "pref-us",
      tenantId: TENANT,
      clientJurisdiction: "US",
      firmEntityPartyId: US_ENTITY,
      note: null,
    });
    await s.firmEntities.set({
      id: "pref-in",
      tenantId: TENANT,
      clientJurisdiction: "IN",
      firmEntityPartyId: IN_ENTITY,
      note: null,
    });
    return s;
  }

  it("refuses Indian law on a letter issued by the US entity", async () => {
    // The bug, exactly as it happened, now unrepresentable.
    const s = await twoEntityFirm();
    const id = await draft(s, { jurisdiction: "US" });
    const err = await s.service.addClause(TENANT, id, LAW_IN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClauseLawNotIssuers);
    // The message has to name both sides, because the person reading it has to
    // decide which of the two is wrong — the clause, or which entity is issuing.
    expect((err as Error).message).toContain("IN");
    expect((err as Error).message).toContain("US");
    expect(s.letters.clauses).toHaveLength(0);
  });

  it("…and `jurisdictions` could not have caught it", async () => {
    // The reason this check had to exist at all. LAW_IN is scoped to NOWHERE,
    // which means everywhere — so the pre-existing check passes it, and every
    // word of the clause is true. It was the LETTER that was the wrong place.
    const s = await twoEntityFirm();
    const id = await draft(s, { jurisdiction: "US" });
    expect(s.library.pinned(LAW_IN)?.body["jurisdictions"]).toEqual([]);
    const err = await s.service.addClause(TENANT, id, LAW_IN).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ClauseWrongJurisdiction);
    expect(err).toBeInstanceOf(ClauseLawNotIssuers);
  });

  it("accepts the clause whose law IS the issuer's", async () => {
    const s = await twoEntityFirm();
    const us = await draft(s, { jurisdiction: "US" });
    await expect(s.service.addClause(TENANT, us, LAW_US)).resolves.toBeUndefined();
    // And the same firm's Indian entity takes the Indian clause — the rule is
    // the issuer, not a country this product has an opinion about.
    const ind = await draft(s, { jurisdiction: "IN" });
    await expect(s.service.addClause(TENANT, ind, LAW_IN)).resolves.toBeUndefined();
  });

  it("refuses the right law with the wrong forum", async () => {
    // Half the bug the firm caught was the COURTS, so a check comparing only
    // `governingLaw` would let this through: Delaware law, Singapore seat, on a
    // letter from the US entity.
    const s = await twoEntityFirm();
    const id = await draft(s, { jurisdiction: "US" });
    const err = await s.service.addClause(TENANT, id, FORUM_SG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClauseLawNotIssuers);
    expect((err as Error).message).toContain("courts");
    expect((err as Error).message).toContain("SG");
  });

  it("refuses a law-bearing clause when the issuer has no registered jurisdiction", async () => {
    // FAIL-CLOSED, and this is the case that matters most in practice: every
    // firm's seeded default entity is an organization with no legal_entity row,
    // because nothing knows the firm's country at createTenant. That is the
    // exact position the original letter was written from, so passing here
    // would put the check everywhere except where the bug lives.
    const s = setup();
    const id = await draft(s);
    const err = await s.service.addClause(TENANT, id, LAW_IN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuerJurisdictionUnknown);
    // Actionable: it names the entity to go and register, not a uuid.
    expect((err as Error).message).toContain("The Firm Itself");
  });

  it("leaves a clause that names neither term completely alone", async () => {
    // The cost of the rule above, bounded. Most clauses name no law —
    // confidentiality, fees, scope — and an unregistered issuer must not stop a
    // firm drafting with them. Nothing about the check reaches these.
    const s = setup();
    const id = await draft(s);
    await expect(s.service.addClause(TENANT, id, SCOPE_CLAUSE)).resolves.toBeUndefined();
    await expect(s.service.addClause(TENANT, id, LIABILITY_IN)).resolves.toBeUndefined();
  });

  it("hands the structured terms to whatever renders the letter", async () => {
    // The other half of the wiring. LetterClauseRecord used to carry `text` and
    // stop, so the fields G1.8 added could be stored, validated and refused
    // against — and then reached nothing. A renderer asking "whose law does
    // this letter name" had a paragraph to read, which is the position the
    // original letter was written from.
    const s = await twoEntityFirm();
    const id = await draft(s, { jurisdiction: "US" });
    await s.service.addClause(TENANT, id, LAW_US);
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);

    const record = await s.letters.describeLetter(TENANT, id);
    const law = record?.clauses.find((c) => c.title.startsWith("Governing law"));
    expect(law?.governingLaw).toEqual({
      jurisdiction: "US",
      text: "the laws of the State of Delaware",
    });
    expect(law?.courts?.jurisdiction).toBe("US");
    // And null is a real answer beside it, not an absent field.
    const scope = record?.clauses.find((c) => c.title === "Scope of work");
    expect(scope?.governingLaw).toBeNull();
    expect(scope?.courts).toBeNull();
  });

  it("keeps the terms the client agreed to after signature", async () => {
    // Read from the PINNED version, so a clause the firm rewrites tomorrow does
    // not change what a signed letter says its governing law is.
    const s = await twoEntityFirm();
    const id = await draft(s, { jurisdiction: "US" });
    await completeTerms(s, id);
    await s.service.addClause(TENANT, id, LAW_US);
    await writeOpening(s.prose, TENANT, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya Menon" }, ACTOR);

    const record = await s.letters.describeLetter(TENANT, id);
    const law = record?.clauses.find((c) => c.title.startsWith("Governing law"));
    expect(law?.governingLaw?.text).toBe("the laws of the State of Delaware");
  });
});


describe("a client the firm has ARCHIVED (0305)", () => {
  it("refuses a new letter for them", async () => {
    const s = setup();
    s.parties.archive(PARTY, "Acme Industries Private Limited");
    const err = await draft(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LetterPartyArchived);
    expect((err as Error).message).toMatch(/Acme Industries Private Limited is archived/);
    expect(s.letters.letters).toHaveLength(0);
  });

  it("refuses one of the firm's OWN companies as the client, as the invoice's BILLS_THE_FIRM does", async () => {
    const s = setup();
    s.firmEntities.members.add(`${TENANT}:${PARTY}`);
    s.parties.know(PARTY, "10x Global FZE");
    const err = await draft(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LetterClientIsOwnCompany);
    expect((err as LetterClientIsOwnCompany).code).toBe("CLIENT_IS_OWN_COMPANY");
    expect((err as Error).message).toMatch(
      /^10x Global FZE is one of your own companies, so it cannot be the client on an engagement letter\./,
    );
    expect(s.letters.letters).toHaveLength(0);
  });

  it("refuses a line whose company was archived", async () => {
    const s = setup();
    const id = await draft(s);
    s.parties.archive(ENTITY_A, "Acme Foods Private Limited");
    await expect(completeTerms(s, id)).rejects.toThrow(
      /Acme Foods Private Limited is archived, so a letter line cannot be for them/,
    );
  });
});

describe("writing an ACCEPTED quote up as a letter (T3.5b)", () => {
  const QUOTE = "00000000-0000-0000-0000-0000000000q1";

  /** One quote line, with everything a letter line needs already on it. */
  function quoteLine(over: Partial<QuotedLine> = {}): QuotedLine {
    return {
      id: `line-${String(over.description ?? "a")}`,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "GST monthly filing",
      quantity: "12",
      unitAmount: "6000.00",
      discountPercent: "15",
      jurisdiction: "IN",
      billingFrequency: null,
      scopeOverride: null,
      clientObligationsOverride: null,
      volumeLimitsOverride: null,
      exclusionsOverride: null,
      oopEstimate: null,
      pricingNote: null,
      ...over,
    };
  }

  function quoted(
    lines: readonly QuotedLine[],
    over: Partial<QuotedProposal["proposal"]> = {},
  ): QuotedProposal {
    return {
      proposal: {
        id: QUOTE,
        ref: "PR-2026-0007",
        partyId: PARTY,
        issuingEntityPartyId: SEEDED_FIRM_ENTITY,
        title: "Compliance retainer",
        status: "accepted",
        currency: "INR",
        fxRate: "1.0",
        fxRateDate: "2026-07-01",
        deletedAt: null,
        ...over,
      },
      lines,
    };
  }

  function withQuote(quote: QuotedProposal) {
    const h = setup();
    h.quotes.add(quote);
    return h;
  }

  const ask = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    proposalId: QUOTE,
    advanceRequired: false,
    ...over,
  });

  it("REFUSES a quote naming an archived company BEFORE any letter exists (0305)", async () => {
    // Found line by line, the refusal would leave a half-written letter holding
    // a spent reference number.
    const h = withQuote(quoted([quoteLine()]));
    h.parties.archive(ENTITY_A, "Acme Foods Private Limited");
    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(LetterPartyArchived);
    expect(h.letters.letters).toHaveLength(0);
  });

  it("REFUSES a quote made to one of the firm's OWN companies: no letter is written up from it", async () => {
    // A quote from before the proposal refused own companies, or one written
    // straight to the table: the letter's own check still stops it.
    const h = withQuote(quoted([quoteLine()]));
    h.firmEntities.members.add(`${TENANT}:${PARTY}`);
    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(LetterClientIsOwnCompany);
    expect(h.letters.letters).toHaveLength(0);
  });

  it("CARRIES THE PRICE ACROSS — the whole point, and what a walk found missing", async () => {
    // Walked before this existed: the accepted proposal reached nothing, so
    // 1,75,000 was typed by hand a second time and nothing would have caught a
    // fourth digit.
    const h = withQuote(quoted([quoteLine()]));

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.lines).toHaveLength(1);
    expect(out.skipped).toEqual([]);
    expect(out.lines[0]).toMatchObject({
      description: "GST monthly filing",
      quantity: "12",
      unitAmount: "6000.00",
      discountPercent: "15",
      serviceVersionId: GST,
      entityPartyId: ENTITY_A,
    });
  });

  it("takes the quote's CURRENCY and rate, and offers no way to change them", async () => {
    // Changing the currency underneath copied amounts would reinterpret every
    // figure on the document. There is deliberately no parameter for it.
    const h = withQuote(quoted([quoteLine()], { currency: "AED", fxRate: "22.5" }));

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.letter.currency).toBe("AED");
    expect(out.letter.fxRate).toBe("22.5");
    expect(out.lines[0]?.currency).toBe("AED");
  });

  it("links the letter back to the quote, and inherits its issuer and title", async () => {
    const h = withQuote(quoted([quoteLine()]));

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.letter.proposalId).toBe(QUOTE);
    expect(out.letter.title).toBe("Compliance retainer");
    // Contracting through a different company would change the client's
    // counterparty between the offer and the contract.
    expect(out.letter.issuingEntityPartyId).toBe(SEEDED_FIRM_ENTITY);
  });

  it("carries an UNPRICED line with its reason, and does not turn it into zero", async () => {
    const h = withQuote(
      quoted([
        quoteLine({ description: "Advisory", unitAmount: null, discountPercent: "0", pricingNote: "As mutually agreed" }),
      ]),
    );

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.lines[0]?.unitAmount).toBeNull();
    expect(out.lines[0]?.pricingNote).toBe("As mutually agreed");
  });

  it("carries the four scope overrides — the words the client actually read", async () => {
    const h = withQuote(
      quoted([
        quoteLine({
          scopeOverride: "Monthly GSTR-1 and GSTR-3B for two GSTINs.",
          exclusionsOverride: "Annual return is not included.",
        }),
      ]),
    );

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.lines[0]?.scopeOverride).toBe("Monthly GSTR-1 and GSTR-3B for two GSTINs.");
    expect(out.lines[0]?.exclusionsOverride).toBe("Annual return is not included.");
  });

  it("keeps the quote's ORDER — the terms of a contract are not a set", async () => {
    const h = withQuote(
      quoted([
        quoteLine({ description: "First" }),
        quoteLine({ description: "Second" }),
        quoteLine({ description: "Third" }),
      ]),
    );

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.lines.map((l) => l.description)).toEqual(["First", "Second", "Third"]);
    expect(out.lines.map((l) => l.position)).toEqual([...out.lines.map((l) => l.position)].sort((a, b) => a - b));
  });

  it("derives the country when every line agrees, and nobody retypes it", async () => {
    const h = withQuote(quoted([quoteLine(), quoteLine({ description: "TDS" })]));

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.letter.jurisdiction).toBe("IN");
  });

  it("REFUSES when the lines disagree, rather than picking the first", async () => {
    // Governing law is a document-level term, and two countries on one quote is
    // two letters. Picking whichever line came first would settle which courts
    // hear a dispute by array order.
    const h = withQuote(
      quoted([quoteLine(), quoteLine({ description: "UAE VAT", jurisdiction: "AE" })]),
    );

    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(
      QuoteJurisdictionUnclear,
    );
    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toThrow(/IN, AE/);
  });

  it("accepts a stated country when the lines disagree", async () => {
    const h = withQuote(
      quoted([quoteLine(), quoteLine({ description: "UAE VAT", jurisdiction: "AE" })]),
    );

    const out = await h.service.draftFromQuote(ask({ jurisdiction: "AE" }), ACTOR);

    expect(out.letter.jurisdiction).toBe("AE");
  });

  it("SKIPS a line that names no company, and says so instead of guessing one", async () => {
    // A proposal may quote a prospect holding no entity; a letter line must
    // name one, because signing it creates an engagement. On a signed page a
    // guessed party is indistinguishable from one somebody agreed to.
    const h = withQuote(
      quoted([quoteLine(), quoteLine({ description: "Incorporation", entityPartyId: null })]),
    );

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.lines).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ description: "Incorporation" });
    expect(out.skipped[0]?.reason).toMatch(/which company the work is for/);
  });

  it("uses a stated fallback company for those lines when the caller names one", async () => {
    const h = withQuote(
      quoted([quoteLine({ description: "Incorporation", entityPartyId: null })]),
    );

    const out = await h.service.draftFromQuote(ask({ defaultEntityPartyId: ENTITY_B }), ACTOR);

    expect(out.skipped).toEqual([]);
    expect(out.lines[0]?.entityPartyId).toBe(ENTITY_B);
  });

  it("refuses BEFORE drafting when no line can be carried — a spent number for nothing", async () => {
    // `draft` draws a reference from a counter that commits on its own, so a
    // letter that fails after that point burns one. A letter with a spent
    // number, no lines and no way to add any is worse than a refusal.
    const h = withQuote(quoted([quoteLine({ entityPartyId: null })]));

    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(
      QuoteNamesNoEntity,
    );
    expect(await h.service.list(TENANT, {})).toHaveLength(0);
  });

  it("refuses a quote the client has not accepted, naming the state it is in", async () => {
    const h = withQuote(quoted([quoteLine()], { status: "sent" }));

    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(QuoteNotAccepted);
    await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toThrow(/PR-2026-0007 is sent/);
  });

  it("refuses a rejected or expired quote — a client who comes back is a new quote", async () => {
    for (const status of ["rejected", "expired", "draft"]) {
      const h = withQuote(quoted([quoteLine()], { status }));
      await expect(h.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(
        QuoteNotAccepted,
      );
    }
  });

  it("refuses a quote with no lines, and one that is not there at all", async () => {
    const empty = withQuote(quoted([]));
    await expect(empty.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(
      QuoteHasNoLines,
    );

    const missing = setup();
    await expect(missing.service.draftFromQuote(ask(), ACTOR)).rejects.toBeInstanceOf(
      QuoteNotFound,
    );
  });

  it("records the carry BESIDE the draft, with counts and no client wording", async () => {
    const h = withQuote(
      quoted([quoteLine(), quoteLine({ description: "Incorporation", entityPartyId: null })]),
    );

    await h.service.draftFromQuote(ask(), ACTOR);

    const verbs = h.events.verbs();
    // Both, and in that order: the draft is the same act either way, and the
    // second row is the extra fact that the terms were CARRIED.
    expect(verbs).toContain("engagement_letter.drafted");
    expect(verbs).toContain("engagement_letter.drafted_from_proposal");
    const carried = h.events.recorded.find(
      (e) => e.verb === "engagement_letter.drafted_from_proposal",
    );
    expect(carried?.payload).toMatchObject({
      proposalId: QUOTE,
      linesCopied: 1,
      linesSkipped: 1,
      jurisdictionStated: false,
      defaultEntityUsed: false,
    });
    // Counts only. What would say WHICH lines were dropped is the client's own
    // wording, and this log cannot be erased.
    expect(JSON.stringify(carried?.payload)).not.toMatch(/Incorporation/);
  });

  it("does NOT carry the advance — a proposal has none, so it is the firm's call", async () => {
    const h = withQuote(quoted([quoteLine()]));

    const out = await h.service.draftFromQuote(
      ask({ advanceRequired: true, advanceAmount: "50000.00" }),
      ACTOR,
    );

    expect(out.letter.advanceRequired).toBe(true);
    expect(out.letter.advanceAmount).toBe("50000.00");
  });

  it("leaves the letter a DRAFT with no clauses — terms are chosen against ITS country", async () => {
    const h = withQuote(quoted([quoteLine()]));

    const out = await h.service.draftFromQuote(ask(), ACTOR);

    expect(out.letter.status).toBe("draft");
    // And it therefore cannot be sent yet, which is correct: a letter with no
    // clauses has no terms at all.
    await expect(h.service.send(TENANT, out.letter.id, ACTOR)).rejects.toBeInstanceOf(NoClauses);
  });
});

describe("a letter signed before the firm used this product", () => {
  // The book import records letters the client signed on paper years ago. The
  // configured provider may be DocuSign, which demands an envelope that never
  // existed; `migrated` routes the signature to the attested signer instead,
  // and the configured provider is not asked at all.
  it("goes to the migration signer, and the configured provider is never asked", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    s.esign.failNext = true; // would blow up if it were asked

    const { letter, engagements } = await s.service.sign(
      { tenantId: TENANT, letterId: id, signedByName: "Priya", reference: "Migrated on 2026-09-23", migrated: true },
      ACTOR,
    );
    expect(letter.status).toBe("signed");
    expect(engagements.length).toBeGreaterThan(0);
    expect(s.migrationSigner.signed.map((x) => x.letterId)).toEqual([id]);
    expect(s.esign.signed).toHaveLength(0);
    expect(s.esign.failNext).toBe(true);
    expect(letter.signatureMethod).toBe(s.migrationSigner.method);
  });

  it("is not the default: an ordinary signature still goes to the configured provider", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(s.esign.signed.map((x) => x.letterId)).toEqual([id]);
    expect(s.migrationSigner.signed).toHaveLength(0);
  });
});

describe("who a letter names beside the client (F-10-1)", () => {
  // Every one of these was checked for the FIRM only: any party of the firm
  // could be written onto a letter, another client's included. Each refusal
  // comes before the reference number is drawn, so a refused draft spends none.
  const OTHER_CLIENT = "00000000-0000-0000-0000-0000000000b9";
  const OTHER_COMPANY = "00000000-0000-0000-0000-0000000000ba";
  const STRANGER = "00000000-0000-0000-0000-0000000000bd";
  const QUOTE = "00000000-0000-0000-0000-0000000000q2";

  function named() {
    const s = setup();
    s.parties
      .know(PARTY, "Acme Holdings Private Limited")
      .know(OTHER_CLIENT, "Lakeview Foods Private Limited")
      .know(OTHER_COMPANY, "Lakeview Logistics Private Limited")
      .know(STRANGER, "R Iyer", "person")
      .know(CONTACT, "R Sharma", "person");
    return s;
  }

  /** The number the NEXT letter gets — how a test sees none was spent. */
  async function nextRef(s: ReturnType<typeof setup>): Promise<string | undefined> {
    const id = await draft(s);
    return (await s.letters.findLetter(TENANT, id))?.ref;
  }

  it("refuses a client's company as the issuer, by name, and spends no number", async () => {
    const s = named();
    const refused = s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        jurisdiction: "IN",
        title: "x",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
        issuingEntityPartyId: OTHER_CLIENT,
      },
      ACTOR,
    );
    await expect(refused).rejects.toBeInstanceOf(IssuerNotAFirmEntity);
    await expect(refused).rejects.toThrow(
      /Lakeview Foods Private Limited is not one of the firm's own companies/,
    );
    expect(await nextRef(s)).toBe("EL-2026-0001");
  });

  it("refuses a quote made to another client, and a quote that is not there", async () => {
    const s = named();
    s.quotes.add({
      proposal: {
        id: QUOTE,
        ref: "PR-2026-0009",
        partyId: OTHER_CLIENT,
        issuingEntityPartyId: SEEDED_FIRM_ENTITY,
        title: "Lakeview retainer",
        status: "accepted",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        deletedAt: null,
      },
      lines: [],
    });
    const ask = (proposalId: string) =>
      s.service.draft(
        {
          tenantId: TENANT,
          partyId: PARTY,
          proposalId,
          jurisdiction: "IN",
          title: "x",
          currency: "INR",
          fxRate: "1",
          fxRateDate: "2026-07-01",
          advanceRequired: false,
        },
        ACTOR,
      );
    await expect(ask(QUOTE)).rejects.toBeInstanceOf(QuoteOfAnotherClient);
    await expect(ask(QUOTE)).rejects.toThrow(
      "PR-2026-0009 is a quote to Lakeview Foods Private Limited, and this letter is for Acme Holdings Private Limited.",
    );
    await expect(ask("00000000-0000-0000-0000-0000000000q3")).rejects.toBeInstanceOf(QuoteNotFound);
    expect(s.letters.letters).toHaveLength(0);
  });

  it("addresses a letter to a PERSON, never a company", async () => {
    const s = named();
    await expect(draft(s, { addressedToPartyId: OTHER_COMPANY })).rejects.toBeInstanceOf(
      AddresseeNotAPerson,
    );
    expect(s.letters.letters).toHaveLength(0);
  });

  it("refuses a person with no role at the client, and says how to fix it", async () => {
    // R Iyer may be real and may even be Acme's accountant; until the firm
    // records that, the letter cannot say it is addressed to them.
    const s = named();
    const refused = draft(s, { addressedToPartyId: STRANGER });
    await expect(refused).rejects.toBeInstanceOf(AddresseeNotLinked);
    await expect(refused).rejects.toThrow(
      /R Iyer has no recorded role at Acme Holdings Private Limited or any of its companies/,
    );
    expect(s.letters.letters).toHaveLength(0);

    // Recorded, the same letter goes through.
    s.structure.record(PARTY, { entities: [ENTITY_A, ENTITY_B], people: [CONTACT, STRANGER] });
    await expect(draft(s, { addressedToPartyId: STRANGER })).resolves.toBeTypeOf("string");
  });

  it("refuses a line for another client's company, by name", async () => {
    const s = named();
    const id = await draft(s);
    const refused = s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: OTHER_COMPANY,
      serviceVersionId: GST,
      description: "GST filing",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "0",
    });
    await expect(refused).rejects.toBeInstanceOf(EntityOutsideClient);
    await expect(refused).rejects.toThrow(
      /Lakeview Logistics Private Limited is not Acme Holdings Private Limited and is not recorded as one of its companies/,
    );
    expect(await s.letters.listLines(TENANT, id)).toHaveLength(0);
  });

  it("always lets a line be for the client itself", async () => {
    // A single-company client records no structure at all, and is the
    // ordinary case: nothing here may ask it to.
    const s = named();
    const id = await draft(s);
    await expect(
      s.service.addLine({
        tenantId: TENANT,
        letterId: id,
        entityPartyId: PARTY,
        serviceVersionId: GST,
        description: "GST filing",
        quantity: "12",
        unitAmount: "2000",
        discountPercent: "0",
      }),
    ).resolves.toMatchObject({ entityPartyId: PARTY });
  });

  it("refuses a quote naming another client's company BEFORE any letter exists", async () => {
    const s = named();
    s.quotes.add({
      proposal: {
        id: QUOTE,
        ref: "PR-2026-0010",
        partyId: PARTY,
        issuingEntityPartyId: SEEDED_FIRM_ENTITY,
        title: "Group retainer",
        status: "accepted",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        deletedAt: null,
      },
      lines: [
        {
          id: "line-1",
          entityPartyId: OTHER_COMPANY,
          serviceVersionId: GST,
          description: "GST monthly filing",
          quantity: "12",
          unitAmount: "6000.00",
          discountPercent: "0",
          jurisdiction: "IN",
          billingFrequency: null,
          scopeOverride: null,
          clientObligationsOverride: null,
          volumeLimitsOverride: null,
          exclusionsOverride: null,
          oopEstimate: null,
          pricingNote: null,
        },
      ],
    });
    await expect(
      s.service.draftFromQuote(
        { tenantId: TENANT, proposalId: QUOTE, advanceRequired: false },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(EntityOutsideClient);
    expect(s.letters.letters).toHaveLength(0);
    expect(await nextRef(s)).toBe("EL-2026-0001");
  });

  it("reads the structure on the FIRM's day, not the server's", async () => {
    // 20:00 UTC on 1 July is 01:30 on 2 July in Delhi. A directorship that
    // starts on 2 July must already count.
    const s = named();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set(new Date("2026-07-01T20:00:00Z"));
    await s.service.structureFor(TENANT, PARTY);
    expect(s.structure.days).toEqual(["2026-07-02"]);
  });
});

// ── Fee groups — one fee for several services (0083) ──────────────────────

describe("fee groups (0083)", () => {
  async function withGroup(
    s: ReturnType<typeof setup>,
  ): Promise<{ id: string; groupId: string }> {
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, {
      title: "Ongoing recurring services",
      billingFrequency: "monthly",
      amount: "5000",
    });
    return { id, groupId: group.id };
  }

  function groupedLine(id: string, groupId: string, entity = ENTITY_A): Parameters<EngagementService["addLine"]>[0] {
    return {
      tenantId: TENANT,
      letterId: id,
      entityPartyId: entity,
      serviceVersionId: GST,
      description: "GST filing",
      quantity: "1",
      discountPercent: "0",
      feeGroupId: groupId,
    };
  }

  it("drafts every new letter in the firm's Annexure layout", async () => {
    // "Switch everyone" (2026-09-26): the layout is stated on the row by the
    // service rather than left to the column's default.
    const s = setup();
    const id = await draft(s);
    expect(CURRENT_LETTER_LAYOUT).toBe("annexure");
    expect((await s.letters.findLetter(TENANT, id))?.layout).toBe("annexure");
  });

  it("prices a grouped service by the group, and needs no pricing note for it", async () => {
    const s = setup();
    const { id, groupId } = await withGroup(s);
    const line = await s.service.addLine(groupedLine(id, groupId));
    expect([line.feeGroupId, line.unitAmount, line.pricingNote]).toEqual([groupId, null, null]);
  });

  it("refuses a grouped service with a price or a discount of its own — it would be charged twice", async () => {
    const s = setup();
    const { id, groupId } = await withGroup(s);
    await expect(
      s.service.addLine({ ...groupedLine(id, groupId), unitAmount: "100" }),
    ).rejects.toBeInstanceOf(GroupedLinePriced);
    await expect(
      s.service.addLine({ ...groupedLine(id, groupId), discountPercent: "10" }),
    ).rejects.toBeInstanceOf(GroupedLinePriced);
  });

  it("refuses a group that is not on this letter", async () => {
    const s = setup();
    const other = await withGroup(s);
    const id = await draft(s);
    await expect(s.service.addLine(groupedLine(id, other.groupId))).rejects.toBeInstanceOf(
      FeeGroupNotFound,
    );
  });

  it("needs a title, a fee and a period it is billed on", async () => {
    const s = setup();
    const id = await draft(s);
    const base = { title: "Retainer", billingFrequency: "monthly", amount: "5000" };
    await expect(s.service.addFeeGroup(TENANT, id, { ...base, title: "  " })).rejects.toBeInstanceOf(
      FeeGroupTitleRequired,
    );
    await expect(s.service.addFeeGroup(TENANT, id, { ...base, amount: "5,000" })).rejects.toBeInstanceOf(
      InvalidAmount,
    );
    await expect(
      s.service.addFeeGroup(TENANT, id, { ...base, billingFrequency: "fortnightly" }),
    ).rejects.toBeInstanceOf(InvalidLineBillingFrequency);
  });

  it("holds a group to the letter's currency and numbers the sections from A", async () => {
    const s = setup();
    const id = await draft(s);
    const a = await s.service.addFeeGroup(TENANT, id, {
      title: "One-time initial activities",
      billingFrequency: "one_time",
      amount: "40000",
    });
    const b = await s.service.addFeeGroup(TENANT, id, {
      title: "Ongoing recurring services",
      billingFrequency: "monthly",
      amount: "5000",
    });
    expect(a.currency).toBe("INR");
    const view = await s.service.describe(TENANT, id);
    expect(view.feeGroups.map((g) => [g.code, g.group.id])).toEqual([
      ["A", a.id],
      ["B", b.id],
    ]);
  });

  it("edits a group's terms, and a blank clears a piece of its prose", async () => {
    const s = setup();
    const id = await draft(s);
    const group = await s.service.addFeeGroup(TENANT, id, {
      title: "Retainer",
      billingFrequency: "monthly",
      amount: "5000",
      paymentTerms: "Monthly in advance",
      intro: "Applies across the group.",
    });
    const edited = await s.service.editFeeGroup(TENANT, id, group.id, {
      amount: "6000",
      paymentTerms: "",
    });
    expect([edited.amount, edited.paymentTerms, edited.intro, edited.title]).toEqual([
      "6000",
      null,
      "Applies across the group.",
      "Retainer",
    ]);
  });

  it("will not strike out a group that still prices a service", async () => {
    const s = setup();
    const { id, groupId } = await withGroup(s);
    await s.service.addLine(groupedLine(id, groupId));
    await expect(s.service.removeFeeGroup(TENANT, id, groupId)).rejects.toBeInstanceOf(
      FeeGroupNotEmpty,
    );
    const empty = await s.service.addFeeGroup(TENANT, id, {
      title: "Spare",
      billingFrequency: "custom",
      amount: "1",
    });
    await s.service.removeFeeGroup(TENANT, id, empty.id);
    expect((await s.service.describe(TENANT, id)).feeGroups).toHaveLength(1);
  });

  it("moves a service into a group, giving up its price, and out again, needing one", async () => {
    const s = setup();
    const { id, groupId } = await withGroup(s);
    await completeTerms(s, id);
    const line = (await s.letters.listLines(TENANT, id))[0];
    if (line === undefined) throw new Error("no line");

    const grouped = await s.service.setLinePricing({
      tenantId: TENANT,
      letterId: id,
      lineId: line.id,
      feeGroupId: groupId,
    });
    expect([grouped.feeGroupId, grouped.unitAmount, grouped.discountPercent]).toEqual([
      groupId,
      null,
      "0",
    ]);

    await expect(
      s.service.setLinePricing({ tenantId: TENANT, letterId: id, lineId: line.id, feeGroupId: null }),
    ).rejects.toBeInstanceOf(LineNotPriced);
    const alone = await s.service.setLinePricing({
      tenantId: TENANT,
      letterId: id,
      lineId: line.id,
      feeGroupId: null,
      pricingNote: "As mutually agreed",
    });
    expect([alone.feeGroupId, alone.unitAmount, alone.pricingNote]).toEqual([
      null,
      null,
      "As mutually agreed",
    ]);
  });

  it("refuses to send a letter with a group that covers nothing", async () => {
    const s = setup();
    const { id } = await withGroup(s);
    await completeTerms(s, id);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(FeeGroupEmpty);
  });

  it("counts the group's fee once in the letter's totals, and its services are not unpriced", async () => {
    const s = setup();
    const { id, groupId } = await withGroup(s);
    await s.service.addLine(groupedLine(id, groupId, ENTITY_A));
    await s.service.addLine(groupedLine(id, groupId, ENTITY_B));
    await completeTerms(s, id);
    const view = await s.service.describe(TENANT, id);
    // 5,000 for the group + 12 × 2,000 for the line priced on its own.
    expect(view.totals.net).toBe("29000.0000");
    expect(view.totals.unpricedLineCount).toBe(0);
    expect(view.feeGroups[0]?.lineIds).toHaveLength(2);
  });

  it("changes nothing on a letter that has gone out", async () => {
    const s = setup();
    const id = await signedLetter(s);
    await expect(
      s.service.addFeeGroup(TENANT, id, { title: "Late", billingFrequency: "monthly", amount: "1" }),
    ).rejects.toBeInstanceOf(LetterNotEditable);
  });

  it("signs the groups with the rest of the terms", async () => {
    // Two letters identical but for how a group prices them must hash apart:
    // the retainer IS a term.
    const hashOf = async (amount: string): Promise<string | null> => {
      const s = setup();
      const { id, groupId } = await withGroup(s);
      await s.service.editFeeGroup(TENANT, id, groupId, { amount });
      await s.service.addLine(groupedLine(id, groupId));
      await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
      await writeOpening(s.prose, TENANT, id);
      await s.service.send(TENANT, id, ACTOR);
      const signed = await s.service.sign(
        { tenantId: TENANT, letterId: id, signedByName: "Priya Menon" },
        ACTOR,
      );
      return signed.letter.signedContentHash;
    };
    expect(await hashOf("5000")).not.toBe(await hashOf("5500"));
  });
});

describe("what the signature commits to, for a fee group (0083)", () => {
  const letter = {
    ref: "EL-2026-0001",
    issuingEntityPartyId: SEEDED_FIRM_ENTITY,
    jurisdiction: "US",
    title: "MyDojo",
    currency: "USD",
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
  };
  const line = (position: number, feeGroupId: string | null): Parameters<typeof canonicalContent>[0]["lines"][number] => ({
    position,
    entityPartyId: ENTITY_A,
    serviceVersionId: GST,
    description: "Accounting",
    quantity: "1",
    unitAmount: feeGroupId === null ? "100" : null,
    discountPercent: "0",
    effectiveFrom: null,
    jurisdiction: null,
    billingFrequency: "monthly",
    scopeOverride: null,
    clientObligationsOverride: null,
    volumeLimitsOverride: null,
    exclusionsOverride: null,
    oopEstimate: null,
    pricingNote: null,
    feeGroupId,
    billingTiming: null,
    billingOn: null,
  });
  const group = (id: string, position: number, amount = "5000"): Parameters<typeof canonicalContent>[0]["feeGroups"][number] => ({
    id,
    position,
    title: "Ongoing recurring services",
    billingFrequency: "monthly",
    billingTiming: null,
    billingOn: null,
    amount,
    paymentTerms: null,
    feeDescription: null,
    intro: null,
    deliverables: null,
    clientObligations: null,
  });

  it("renders a letter with no groups exactly as it did before 0083", () => {
    // DocuSign verifies a completed envelope against this string, so a letter
    // sent before the deploy and signed after it must render the same at both
    // moments: one head row, one row per line, one per clause, and nothing new.
    const rendered = canonicalContent({ letter, lines: [line(1, null)], feeGroups: [], clauses: [] });
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).not.toContain("feegroup");
    // The seventeen fields G1.6 left a line row with — 0083 added none to it.
    expect(rendered.split("\n")[1]?.split("\t")).toHaveLength(17);
  });

  it("commits to the fee, and to which services each fee covers", () => {
    const base = {
      letter,
      lines: [line(1, "g1"), line(2, "g1"), line(3, "g2")],
      feeGroups: [group("g1", 1), group("g2", 2, "900")],
      clauses: [],
    };
    const rendered = canonicalContent(base);
    const moved = { ...base, lines: [line(1, "g1"), line(2, "g2"), line(3, "g2")] };
    const repriced = { ...base, feeGroups: [group("g1", 1, "5500"), group("g2", 2, "900")] };
    expect(canonicalContent(moved)).not.toBe(rendered);
    expect(canonicalContent(repriced)).not.toBe(rendered);
    expect(canonicalContent({ ...base })).toBe(rendered);
  });
});

// ── Phase 1b (0319): billing starts when the work does ───────────────────────

describe("asking the billing desk to schedule the work that went live", () => {
  function withBilling(fail = false) {
    const s = setup();
    const asked: { engagementIds: readonly string[]; liveOn: string }[] = [];
    const service = new EngagementService({
      ...s,
      goLiveBilling: {
        scheduleActivated: (input) => {
          asked.push({ engagementIds: input.engagementIds, liveOn: input.liveOn });
          return fail ? Promise.reject(new Error("billing is down")) : Promise.resolve({ scheduled: [] });
        },
      },
    });
    return { ...s, service, asked };
  }

  it("on signature, for the engagements it made active, from the signature's day", async () => {
    const s = withBilling();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(s.asked).toEqual([
      { engagementIds: engagements.map((e) => e.engagement.id), liveOn: engagements[0]?.engagement.effectiveFrom },
    ]);
  });

  it("at signature even when the letter asks for an advance (0322)", async () => {
    const s = withBilling();
    const id = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(s.asked.map((a) => a.engagementIds)).toEqual([engagements.map((e) => e.engagement.id)]);
  });

  it("never turns a signature into a failure when billing cannot be scheduled", async () => {
    const s = withBilling(true);
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { letter } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(letter.status).toBe("signed");
    expect(s.asked).toHaveLength(1);
  });
});

describe("filling the compliance calendar when work goes live (audit 2026-10-03, CA#24)", () => {
  function withCalendar(fail = false) {
    const s = setup();
    const filled: string[] = [];
    const service = new EngagementService({
      ...s,
      calendar: {
        fillCalendar: (tenantId) => {
          filled.push(tenantId);
          return fail ? Promise.reject(new Error("calendar is down")) : Promise.resolve(3);
        },
      },
    });
    return { ...s, service, filled };
  }

  it("asks for the firm's calendar to be filled on signature, once", async () => {
    const s = withCalendar();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(s.filled).toEqual([TENANT]);
  });

  it("never turns a signature into a failure when the calendar cannot be filled", async () => {
    // Tonight's sweep fills it either way; the client has already signed.
    const s = withCalendar(true);
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    const { letter } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(letter.status).toBe("signed");
    expect(s.filled).toEqual([TENANT]);
  });
});

describe("when a recurring fee is invoiced, as the letter says it (0319)", () => {
  const line = (s: ReturnType<typeof setup>, id: string, over: Record<string, string>) =>
    s.service.addLine({
      tenantId: TENANT,
      letterId: id,
      entityPartyId: ENTITY_A,
      serviceVersionId: GST,
      description: "GST filing",
      quantity: "1",
      unitAmount: "2000",
      discountPercent: "0",
      ...over,
    });

  it("keeps the timing a monthly fee was written with, and a date with on_date", async () => {
    const s = setup();
    const id = await draft(s);
    const advance = await line(s, id, { billingFrequency: "monthly", billingTiming: "advance" });
    expect(advance).toMatchObject({ billingTiming: "advance", billingOn: null });
    const dated = await line(s, id, { billingFrequency: "annually", billingTiming: "on_date", billingOn: "2026-11-15" });
    expect(dated).toMatchObject({ billingTiming: "on_date", billingOn: "2026-11-15" });
    expect((await line(s, id, { billingFrequency: "monthly" })).billingTiming).toBeNull();
  });

  it("refuses a date without on_date, on_date without a date, and a timing on a one-off fee", async () => {
    const s = setup();
    const id = await draft(s);
    for (const over of [
      { billingFrequency: "monthly", billingTiming: "on_date" },
      { billingFrequency: "monthly", billingTiming: "advance", billingOn: "2026-11-15" },
      { billingFrequency: "monthly", billingOn: "2026-11-15" },
      { billingFrequency: "one_time", billingTiming: "advance" },
      { billingFrequency: "monthly", billingTiming: "weekly" },
    ]) {
      await expect(line(s, id, over), JSON.stringify(over)).rejects.toBeInstanceOf(InvalidLetterBillingTiming);
    }
  });

  it("clears a timing nobody touched when the fee stops being billed per period", async () => {
    const s = setup();
    const id = await draft(s);
    const l = await line(s, id, { billingFrequency: "monthly", billingTiming: "advance" });
    const oneOff = await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: l.id, billingFrequency: "one_time" });
    expect(oneOff).toMatchObject({ billingFrequency: "one_time", billingTiming: null, billingOn: null });
  });
});

// ── Phase 2 (0320): a service's own advance, and the advance bill ───────────

describe("a service's own advance (0320)", () => {
  async function twoLines(s: ReturnType<typeof setup>, id: string) {
    const gst = await s.service.addLine({
      tenantId: TENANT, letterId: id, entityPartyId: ENTITY_A, serviceVersionId: GST,
      description: "GST filing", quantity: "1", unitAmount: "2000", discountPercent: "0",
    });
    const audit = await s.service.addLine({
      tenantId: TENANT, letterId: id, entityPartyId: ENTITY_B, serviceVersionId: GST,
      description: "Statutory audit", quantity: "1", unitAmount: "100000", discountPercent: "0",
    });
    return { gst, audit };
  }

  it("is set on a draft line and cleared with null", async () => {
    const s = setup();
    const id = await draft(s);
    const { audit } = await twoLines(s, id);
    const set = await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: "50000" });
    expect(set.advanceAmount).toBe("50000");
    const cleared = await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: null });
    expect(cleared.advanceAmount).toBeNull();
  });

  it("must be an amount above zero", async () => {
    const s = setup();
    const id = await draft(s);
    const { audit } = await twoLines(s, id);
    for (const bad of ["0", "-5", "abc"]) {
      await expect(
        s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: bad }),
      ).rejects.toBeInstanceOf(InvalidLineAdvance);
    }
  });

  it("is refused beside the letter's own advance, both ways round", async () => {
    const s = setup();
    const withLetterAdvance = await draft(s, { advanceRequired: true, advanceAmount: "10000" });
    const { audit } = await twoLines(s, withLetterAdvance);
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: withLetterAdvance, lineId: audit.id, advanceAmount: "500" }),
    ).rejects.toBeInstanceOf(OneKindOfAdvance);

    const withLineAdvance = await draft(s);
    const lines = await twoLines(s, withLineAdvance);
    await s.service.updateLine({ tenantId: TENANT, letterId: withLineAdvance, lineId: lines.audit.id, advanceAmount: "500" });
    await expect(
      s.service.revise({ tenantId: TENANT, letterId: withLineAdvance, advanceRequired: true, advanceAmount: "1000" }, ACTOR),
    ).rejects.toBeInstanceOf(OneKindOfAdvance);
  });

  it("is refused on a grouped line, and given up when a line joins a group", async () => {
    const s = setup();
    const id = await draft(s);
    const { gst, audit } = await twoLines(s, id);
    await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: gst.id, advanceAmount: "500" });
    const group = await s.service.addFeeGroup(TENANT, id, { title: "Retainer", billingFrequency: "monthly", amount: "5000" });
    const moved = await s.service.setLinePricing({ tenantId: TENANT, letterId: id, lineId: gst.id, feeGroupId: group.id });
    expect(moved.advanceAmount).toBeNull();
    await s.service.setLinePricing({ tenantId: TENANT, letterId: id, lineId: audit.id, feeGroupId: group.id });
    await expect(
      s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: "500" }),
    ).rejects.toBeInstanceOf(InvalidLineAdvance);
  });

  it("holds no work since 0322: every service starts at signing, its own advance or not", async () => {
    const s = setup();
    const id = await draft(s);
    const { audit } = await twoLines(s, id);
    await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: "50000" });
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    await writeOpening(s.prose, TENANT, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    const byLine = new Map(engagements.map((e) => [e.engagement.engagementLetterLineId, e.engagement.status]));
    expect(byLine.get(audit.id)).toBe("active");
    expect([...byLine.values()].filter((st) => st === "active")).toHaveLength(2);
    expect(s.events.recorded.filter((e) => e.verb === "contract.activated")).toHaveLength(2);
  });

  it("is a term: in the content hash when set, and absent when not", async () => {
    const s = setup();
    const id = await draft(s);
    const { audit } = await twoLines(s, id);
    const lines = await s.letters.listLines(TENANT, id);
    const letter = await s.letters.findLetter(TENANT, id);
    if (letter === null) throw new Error("no letter");
    const base = { letter, lines, feeGroups: [], clauses: [] };
    const without = canonicalContent(base);
    // A line read before 0320 had no advance field at all: it hashes the same.
    const before = lines.map(({ advanceAmount: _dropped, ...l }) => l);
    expect(canonicalContent({ ...base, lines: before })).toBe(without);
    await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: "50000" });
    expect(canonicalContent({ ...base, lines: await s.letters.listLines(TENANT, id) })).not.toBe(without);
  });
});

describe("the advance bill and its release (0320)", () => {
  function withAdvanceBilling(fail = false) {
    const s = setup();
    const asked: string[] = [];
    const service = new EngagementService({
      ...s,
      advanceBilling: {
        billAdvances: (input) => {
          asked.push(input.letterId);
          return fail ? Promise.reject(new Error("billing is down")) : Promise.resolve({ created: 1 });
        },
      },
    });
    return { ...s, service, asked };
  }

  it("asks billing for the advance bill when a letter that asks for one is signed", async () => {
    const s = withAdvanceBilling();
    const id = await signedLetter(s, { advanceRequired: true, advanceAmount: "10000" });
    expect(s.asked).toEqual([id]);
  });

  it("asks nothing when the letter asks for no advance", async () => {
    const s = withAdvanceBilling();
    await signedLetter(s);
    expect(s.asked).toEqual([]);
  });

  it("never turns a signature into a failure when the advance bill cannot be written", async () => {
    const s = withAdvanceBilling(true);
    const id = await signedLetter(s, { advanceRequired: true, advanceAmount: "10000" });
    expect((await s.letters.findLetter(TENANT, id))?.status).toBe("signed");
  });

  it("starts a service with its own advance at signature, and asks for its advance bill (0322)", async () => {
    const s = withAdvanceBilling();
    const id = await draft(s);
    const audit = await s.service.addLine({
      tenantId: TENANT, letterId: id, entityPartyId: ENTITY_B, serviceVersionId: GST,
      description: "Statutory audit", quantity: "1", unitAmount: "100000", discountPercent: "0",
    });
    await s.service.updateLine({ tenantId: TENANT, letterId: id, lineId: audit.id, advanceAmount: "50000" });
    await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
    await writeOpening(s.prose, TENANT, id);
    await s.service.send(TENANT, id, ACTOR);
    const { engagements } = await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya" }, ACTOR);
    expect(engagements.map((e) => e.engagement.status)).toEqual(["active"]);
    expect(s.asked).toEqual([id]);
  });
});
