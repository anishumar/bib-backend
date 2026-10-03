// Copying a withdrawn engagement letter into a new draft (0316), at the
// use-case level. The acceptance: a letter the firm pulled, or the client
// declined, starts the next draft with its fee sections, lines, prose, cover
// letter and terms, and the withdrawn letter stays on record as it was.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import { LetterDeleted, LetterNotCopyable } from "../../src/domain/engagement/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ENTITY = "00000000-0000-0000-0000-0000000000b2";
const USER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: USER };
const GST = "00000000-0000-0000-0000-0000000000d1";
const BOOKS = "00000000-0000-0000-0000-0000000000d2";
const SCOPE_V1 = "00000000-0000-0000-0000-0000000000e1";
const SCOPE_V2 = "00000000-0000-0000-0000-0000000000e2";
const FEES_CLAUSE = "00000000-0000-0000-0000-0000000000e3";

function setup() {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [ENTITY, OTHER_ENTITY], people: [] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", billingBasis: "fixed" });
  fakes.library.publishService(BOOKS, "bookkeeping", { name: "Monthly bookkeeping", billingBasis: "retainer" });
  fakes.library.publishClause(SCOPE_V1, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  fakes.library.publishClause(FEES_CLAUSE, "fees", {
    title: "Fees",
    text: "Fees are payable within 15 days.",
    jurisdictions: [],
  });
  return { ...fakes, service: new EngagementService(fakes) };
}
type Setup = ReturnType<typeof setup>;

/** A letter with a fee section covering one line, a line priced alone, two
 *  terms, and prose edited for the client — sent, then withdrawn. */
async function withdrawn(s: Setup, effectiveFrom?: string): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Rocket — FY27 engagement",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: true,
      advanceAmount: "25000",
      background: "Rocket is moving its books to one firm.",
      ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    },
    ACTOR,
  );
  const group = await s.service.addFeeGroup(TENANT, letter.id, {
    title: "Ongoing services",
    billingFrequency: "monthly",
    amount: "50000",
    paymentTerms: "Monthly in advance",
    intro: "One fee for the monthly work.",
  });
  await s.service.addLine({
    tenantId: TENANT,
    letterId: letter.id,
    entityPartyId: ENTITY,
    serviceVersionId: BOOKS,
    description: "Accounting",
    quantity: "1",
    discountPercent: "0",
    volumeLimitsOverride: "≤1,000 entries",
    feeGroupId: group.id,
  });
  await s.service.addLine({
    tenantId: TENANT,
    letterId: letter.id,
    entityPartyId: OTHER_ENTITY,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "5",
  });
  await s.service.addClause(TENANT, letter.id, SCOPE_V1);
  await s.service.addClause(TENANT, letter.id, FEES_CLAUSE);
  await s.prose.addBlock({
    tenantId: TENANT,
    owner: { kind: "engagement_letter", id: letter.id },
    kind: "cover",
    body: "We are pleased to set out the terms of our engagement.",
    sortOrder: 1,
  });
  await s.prose.addBlock({
    tenantId: TENANT,
    owner: { kind: "engagement_letter", id: letter.id },
    kind: "exclusion",
    body: "Payroll is excluded for Rocket.",
    sortOrder: 1,
  });
  await s.service.send(TENANT, letter.id, ACTOR);
  await s.service.withdraw(TENANT, letter.id, ACTOR);
  return letter.id;
}

describe("copying a withdrawn letter into a new draft", () => {
  it("makes a new draft with the head, fee section, lines, terms and prose", async () => {
    const s = setup();
    const sourceId = await withdrawn(s);

    const made = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(made.letter).toMatchObject({
      status: "draft",
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Rocket — FY27 engagement",
      currency: "INR",
      advanceRequired: true,
      advanceAmount: "25000",
      background: "Rocket is moving its books to one firm.",
      copiedFromId: sourceId,
      issuedOn: null,
      sentAt: null,
      withdrawnAt: null,
    });
    expect(made).toMatchObject({ linesCopied: 2, feeGroupsCopied: 1, clausesCopied: 2 });
    expect(made.skippedLines).toEqual([]);
    expect(made.skippedClauses).toEqual([]);

    const view = await s.service.describe(TENANT, made.letter.id);
    expect(view.feeGroups.map((g) => ({ title: g.group.title, amount: g.group.amount, intro: g.group.intro })))
      .toEqual([{ title: "Ongoing services", amount: "50000", intro: "One fee for the monthly work." }]);
    // The grouped line sits in the NEW section, not the old letter's.
    const grouped = view.lines.find((l) => l.line.description === "Accounting");
    expect(grouped?.line.feeGroupId).toBe(view.feeGroups[0]?.group.id);
    expect(grouped?.line.volumeLimitsOverride).toBe("≤1,000 entries");
    const alone = view.lines.find((l) => l.line.description === "GST filing, 12 months");
    expect(alone?.line).toMatchObject({ unitAmount: "2000", discountPercent: "5", entityPartyId: OTHER_ENTITY });

    const prose = view.blocks.map((b) => `${b.kind}:${b.body}`);
    expect(prose).toContain("cover:We are pleased to set out the terms of our engagement.");
    expect(prose).toContain("exclusion:Payroll is excluded for Rocket.");
    expect(prose).toHaveLength((await s.service.describe(TENANT, sourceId)).blocks.length);
  });

  it("takes each term at the library's CURRENT wording", async () => {
    const s = setup();
    const sourceId = await withdrawn(s);
    // The firm rewrote its scope clause after the letter was withdrawn.
    s.library.add(SCOPE_V1, {
      kind: "clause",
      status: "archived",
      key: "scope",
      version: 1,
      body: { title: "Scope of work", text: "Old wording.", jurisdictions: [] },
    });
    s.library.add(SCOPE_V2, {
      kind: "clause",
      status: "published",
      key: "scope",
      version: 2,
      body: { title: "Scope of work", text: "New wording.", jurisdictions: [] },
    });

    const { letter } = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    const pinned = (await s.letters.listClauses(TENANT, letter.id)).map((c) => c.clauseVersionId);
    expect(pinned).toContain(SCOPE_V2);
    expect(pinned).not.toContain(SCOPE_V1);
  });

  it("skips a term retired from the library, and says so", async () => {
    const s = setup();
    const sourceId = await withdrawn(s);
    s.library.add(FEES_CLAUSE, {
      kind: "clause",
      status: "archived",
      key: "fees",
      version: 1,
      body: { title: "Fees", text: "Fees are payable within 15 days.", jurisdictions: [] },
    });

    const made = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(made.clausesCopied).toBe(1);
    expect(made.skippedClauses).toEqual([
      { id: FEES_CLAUSE, description: "Fees", reason: "This term is no longer in the firm's clause library." },
    ]);
  });

  it("leaves the withdrawn letter as it was, and links both ways", async () => {
    const s = setup();
    const sourceId = await withdrawn(s);
    const before = await s.letters.findLetter(TENANT, sourceId);

    const { letter } = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(await s.letters.findLetter(TENANT, sourceId)).toEqual(before);
    const sourceView = await s.service.describe(TENANT, sourceId);
    expect(sourceView.copies).toEqual([{ id: letter.id, ref: letter.ref, status: "draft" }]);
    expect((await s.service.describe(TENANT, letter.id)).copiedFrom).toEqual({
      id: sourceId,
      ref: sourceView.letter.ref,
      status: "withdrawn",
    });
    const copied = s.events.recorded.filter((e) => e.verb === "engagement_letter.copied");
    expect(copied).toHaveLength(1);
    expect(copied[0]?.objectId).toBe(sourceId);
    expect(copied[0]?.payload).toMatchObject({ copyId: letter.id, linesCopied: 2, feeGroupsCopied: 1 });
  });

  it("drops a start date already past, and keeps one still ahead", async () => {
    const s = setup(); // the fake clock is 1 July 2026
    const past = await withdrawn(s, "2026-06-01");
    const ahead = await withdrawn(s, "2026-08-01");

    expect((await s.service.copyAsDraft(TENANT, past, ACTOR)).letter.effectiveFrom).toBeNull();
    expect((await s.service.copyAsDraft(TENANT, ahead, ACTOR)).letter.effectiveFrom).toBe("2026-08-01");
  });

  it("skips a line whose company was archived since, and keeps the rest", async () => {
    const s = setup();
    const sourceId = await withdrawn(s);
    s.parties.archive(OTHER_ENTITY, "Rocket Labs Pvt Ltd");

    const made = await s.service.copyAsDraft(TENANT, sourceId, ACTOR);

    expect(made.linesCopied).toBe(1);
    expect(made.skippedLines.map((l) => l.description)).toEqual(["GST filing, 12 months"]);
  });
});

describe("which letters can be copied", () => {
  it("refuses a draft, a sent letter and a deleted one, and the page is told first", async () => {
    const s = setup();
    const draft = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        jurisdiction: "IN",
        title: "Draft",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        advanceRequired: false,
      },
      ACTOR,
    );
    await expect(s.service.copyAsDraft(TENANT, draft.id, ACTOR)).rejects.toThrow(/still a draft/);
    expect((await s.service.describe(TENANT, draft.id)).copyRefusal?.code).toBe("LETTER_NOT_COPYABLE");

    const sentId = await withdrawn(s);
    // A withdrawn one IS copyable, and the page says so.
    expect((await s.service.describe(TENANT, sentId)).copyRefusal).toBeNull();

    await s.service.delete(TENANT, draft.id, ACTOR);
    await expect(s.service.copyAsDraft(TENANT, draft.id, ACTOR)).rejects.toBeInstanceOf(LetterDeleted);
  });

  it("refuses a letter still out with the client", async () => {
    const s = setup();
    const letter = await s.service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        jurisdiction: "IN",
        title: "Out",
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
      description: "GST",
      quantity: "1",
      unitAmount: "1000",
      discountPercent: "0",
    });
    await s.service.addClause(TENANT, letter.id, SCOPE_V1);
    await writeOpening(s.prose, TENANT, letter.id);
    await s.service.send(TENANT, letter.id, ACTOR);

    const err = await s.service.copyAsDraft(TENANT, letter.id, ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LetterNotCopyable);
    expect((err as Error).message).toMatch(/withdraw it first/);
  });
});
