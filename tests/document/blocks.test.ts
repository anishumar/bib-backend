// G1.7 — the prose a document carries besides its priced lines.
//
// Three lists appear on every proposal and every engagement letter and had no
// home in this schema: the general scope EXCLUSIONS, the COMMERCIAL notes, and
// the TEAM the firm will deploy. They are not clauses — a clause is a term of
// the contract, drawn from a versioned library and pinned — they are the
// document's own prose.
//
// The acceptance has two halves and they pull in opposite directions:
//
//   1. A firm edits its standard exclusions and THE NEXT letter changes, while
//      EVERY ISSUED ONE still says what it said. That is what makes this a COPY
//      and not a reference — a reference would silently rewrite what a signed
//      agreement says the firm excluded.
//   2. A UAE proposal does not print an Indian tax note. "All fees are
//      exclusive of GST as applicable" is wrong outside India, and it is a
//      mistake the firm already caught in its own template.
//
// Both are properties of `blocksFor` and of the copy, so both are tested here
// against fakes; the freeze on a SIGNED letter's blocks is a trigger and is
// proven against real Postgres in tests/engagement/letter.integration.test.ts.
import { describe, expect, it } from "vitest";
import { DocumentService } from "../../src/usecase/document/service";
import { makeDocumentFakes } from "../../src/testfakes/document";
import { blocksFor } from "../../src/domain/document/model";
import type { StandardBlock } from "../../src/domain/document/model";
import {
  BlankBlockBody,
  BlocksAlreadySeeded,
  InvalidBlockKind,
  LetterOnlyBlockKind,
  InvalidSortOrder,
  StandardBlockNotFound,
} from "../../src/domain/document/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000ab";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const PROPOSAL = { kind: "proposal" as const, id: "00000000-0000-0000-0000-0000000000d1" };
const LETTER = {
  kind: "engagement_letter" as const,
  id: "00000000-0000-0000-0000-0000000000d2",
};

function setup(): { service: DocumentService } & ReturnType<typeof makeDocumentFakes> {
  const fakes = makeDocumentFakes();
  return { ...fakes, service: new DocumentService(fakes) };
}

/** The firm's real standard set, near enough: two unscoped exclusions, the GST
 *  note that must not leave India, and a team heading. */
async function standardSet(s: ReturnType<typeof setup>): Promise<void> {
  await s.service.addStandardBlock(
    { tenantId: TENANT, kind: "exclusion", body: "Statutory fees are not included.", sortOrder: 1 },
    ACTOR,
  );
  await s.service.addStandardBlock(
    { tenantId: TENANT, kind: "exclusion", body: "Representation before courts.", sortOrder: 2 },
    ACTOR,
  );
  await s.service.addStandardBlock(
    {
      tenantId: TENANT,
      kind: "commercial",
      body: "All fees are exclusive of GST as applicable.",
      sortOrder: 1,
      jurisdiction: "IN",
    },
    ACTOR,
  );
  await s.service.addStandardBlock(
    {
      tenantId: TENANT,
      kind: "team",
      body: "Engagement Partner",
      sortOrder: 1,
      isHeading: true,
    },
    ACTOR,
  );
}

describe("the firm's standard set", () => {
  it("starts empty, because nothing seeds it", async () => {
    // Not a gap to fill later: no migration writes these, so a firm genuinely
    // has no standard exclusions until somebody writes them. A default set
    // would be this product inventing legal terms on a firm's behalf.
    const s = setup();
    expect(await s.service.listStandardBlocks(TENANT)).toEqual([]);
  });

  it("records the change, and never the words", async () => {
    // The standard set is what every document from here on will say, so "who
    // changed it and when" is an audit question. The BODY stays out of the
    // payload: it is prose a person wrote, and this log cannot be erased.
    const s = setup();
    await standardSet(s);
    const events = s.events.recorded.filter((e) => e.verb === "standard_document_block.set");
    expect(events).toHaveLength(4);
    expect(events[0]?.payload).toMatchObject({ kind: "exclusion", sortOrder: 1 });
    expect(JSON.stringify(events[0]?.payload)).not.toContain("Statutory");
  });

  it("refuses a blank body, a bad kind and a bad order", async () => {
    const s = setup();
    const base = { tenantId: TENANT, kind: "exclusion", body: "x", sortOrder: 1 };
    await expect(
      s.service.addStandardBlock({ ...base, body: "   " }, ACTOR),
    ).rejects.toBeInstanceOf(BlankBlockBody);
    await expect(
      s.service.addStandardBlock({ ...base, kind: "footer" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidBlockKind);
    await expect(
      s.service.addStandardBlock({ ...base, sortOrder: 0 }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidSortOrder);
  });

  it("demands a jurisdiction in the case it will be compared in", async () => {
    // Stored verbatim and compared as an equality test, so "in" is what a
    // comparison would get. Same rule G1.8 applies to a clause's terms.
    const s = setup();
    await expect(
      s.service.addStandardBlock(
        { tenantId: TENANT, kind: "commercial", body: "GST extra.", sortOrder: 1, jurisdiction: "in" },
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it("retires a line rather than deleting it", async () => {
    const s = setup();
    await standardSet(s);
    const [first] = await s.service.listStandardBlocks(TENANT);
    if (first === undefined) throw new Error("no standard block");
    const retired = await s.service.editStandardBlock(TENANT, first.id, { isActive: false }, ACTOR);
    expect(retired.isActive).toBe(false);
    // Still listed. A document issued while it was live copied it, and "where
    // did this line come from" has to resolve years later.
    expect((await s.service.listStandardBlocks(TENANT)).map((b) => b.id)).toContain(first.id);
  });

  it("tells a null jurisdiction apart from an absent one", async () => {
    // The distinction the adapter's CASE expression exists for: `undefined`
    // means "leave it", `null` means "print this everywhere" — a real edit.
    const s = setup();
    const scoped = await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "commercial", body: "GST extra.", sortOrder: 1, jurisdiction: "IN" },
      ACTOR,
    );
    const untouched = await s.service.editStandardBlock(TENANT, scoped.id, { body: "GST." }, ACTOR);
    expect(untouched.jurisdiction).toBe("IN");
    const widened = await s.service.editStandardBlock(
      TENANT,
      scoped.id,
      { jurisdiction: null },
      ACTOR,
    );
    expect(widened.jurisdiction).toBeNull();
  });

  it("does not find another firm's block", async () => {
    const s = setup();
    await standardSet(s);
    const [first] = await s.service.listStandardBlocks(TENANT);
    if (first === undefined) throw new Error("no standard block");
    await expect(
      s.service.editStandardBlock(OTHER, first.id, { body: "theirs now" }, ACTOR),
    ).rejects.toBeInstanceOf(StandardBlockNotFound);
  });
});

describe("blocksFor — which lines a document written for a country gets", () => {
  const line = (over: Partial<StandardBlock>): StandardBlock => ({
    id: "b1",
    tenantId: TENANT,
    kind: "exclusion",
    body: "x",
    isHeading: false,
    sortOrder: 1,
    jurisdiction: null,
    issuingEntityPartyId: null,
    isActive: true,
    ...over,
  });

  it("copies an unscoped line to every country", () => {
    expect(blocksFor([line({})], "AE", "proposal")).toHaveLength(1);
  });

  it("copies a scoped line only to its own", () => {
    const gst = line({ id: "gst", jurisdiction: "IN" });
    expect(blocksFor([gst], "IN", "proposal")).toHaveLength(1);
    expect(blocksFor([gst], "AE", "proposal")).toHaveLength(0);
  });

  it("never copies a retired line", () => {
    expect(blocksFor([line({ isActive: false })], "IN", "proposal")).toHaveLength(0);
  });

  it("orders by kind, then order, then id — total, so ties are stable", () => {
    // `sort_order` is deliberately not unique: making it unique would turn
    // "insert a line between two others" into a renumbering of the list. So
    // ties are ordinary, and the tiebreak is not a detail.
    const rows = [
      line({ id: "b", kind: "team", sortOrder: 1 }),
      line({ id: "a", kind: "exclusion", sortOrder: 2 }),
      line({ id: "z", kind: "exclusion", sortOrder: 2 }),
      line({ id: "c", kind: "commercial", sortOrder: 1 }),
    ];
    expect(blocksFor(rows, "IN", "proposal").map((b) => b.id)).toEqual(["a", "z", "c", "b"]);
    // The same input shuffled gives the same answer.
    expect(blocksFor(rows.slice().reverse(), "IN", "proposal").map((b) => b.id)).toEqual(["a", "z", "c", "b"]);
  });
});

describe("the copy onto a document", () => {
  it("gives an Indian proposal the GST note and a UAE one nothing of the kind", async () => {
    // THE ACCEPTANCE, second half. "All fees are exclusive of GST as
    // applicable" is wrong on a UAE document in exactly the way the firm
    // already caught in its own template.
    const s = setup();
    await standardSet(s);

    const indian = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(indian.map((b) => b.body)).toContain("All fees are exclusive of GST as applicable.");

    const uae = await s.service.seedBlocks(TENANT, LETTER, "AE");
    expect(uae.map((b) => b.body)).not.toContain("All fees are exclusive of GST as applicable.");
    // …while the exclusions that are true everywhere still come.
    expect(uae.map((b) => b.body)).toContain("Statutory fees are not included.");
  });

  it("renumbers from 1 within each kind", async () => {
    // The standard list is not contiguous — a firm inserts between two lines
    // and retires others — and a document printing exclusions 1, 4, 5 has a
    // reader wondering what 2 and 3 said.
    const s = setup();
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "exclusion", body: "first", sortOrder: 10 },
      ACTOR,
    );
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "exclusion", body: "second", sortOrder: 40 },
      ACTOR,
    );
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "team", body: "Partner", sortOrder: 7 },
      ACTOR,
    );
    const copied = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(copied.map((b) => [b.kind, b.sortOrder, b.body])).toEqual([
      ["exclusion", 1, "first"],
      ["exclusion", 2, "second"],
      ["team", 1, "Partner"],
    ]);
  });

  it("keeps a breadcrumb to the standard line it came from", async () => {
    const s = setup();
    await standardSet(s);
    const standard = await s.service.listStandardBlocks(TENANT);
    const copied = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(copied.every((b) => b.sourceId !== null)).toBe(true);
    expect(new Set(copied.map((b) => b.sourceId))).toEqual(
      new Set(standard.filter((b) => b.jurisdiction === null || b.jurisdiction === "IN").map((b) => b.id)),
    );
  });

  it("refuses to seed twice", async () => {
    // Repeating would print the firm's exclusions twice; ignoring would make
    // this method mean two different things depending on what happened before.
    const s = setup();
    await standardSet(s);
    await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    await expect(s.service.seedBlocks(TENANT, PROPOSAL, "IN")).rejects.toBeInstanceOf(
      BlocksAlreadySeeded,
    );
  });

  it("seeds nothing, and does not fail, for a firm with no standard set", async () => {
    // The state every firm is in on day one. A document with no exclusions is a
    // real document; refusing to draft one would be this feature holding the
    // product hostage to configuration nobody has written yet.
    const s = setup();
    const copied = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(copied).toEqual([]);
  });

  it("takes only what is true everywhere when the country is unknown", async () => {
    // A prospect's country is often unknown at drafting, and `*` reaches here.
    // It matches no jurisdiction, so scoped lines are left out — which is the
    // safe direction: an unscoped line is true anywhere, a scoped one might not
    // be, and printing it is how the GST note reached a UAE proposal.
    const s = setup();
    await standardSet(s);
    const copied = await s.service.seedBlocks(TENANT, PROPOSAL, "*");
    expect(copied.map((b) => b.body)).not.toContain("All fees are exclusive of GST as applicable.");
    expect(copied).toHaveLength(3);
  });
});

describe("what a document says is its own from then on", () => {
  it("does not change when the firm edits its standard set", async () => {
    // THE ACCEPTANCE, first half — and the whole argument for a copy over a
    // reference. A reference would silently rewrite what an issued document
    // says the firm excluded.
    const s = setup();
    await standardSet(s);
    await s.service.seedBlocks(TENANT, LETTER, "IN");
    const before = (await s.service.listBlocks(TENANT, LETTER)).map((b) => b.body);

    const standard = await s.service.listStandardBlocks(TENANT);
    const first = standard.find((b) => b.body.startsWith("Statutory"));
    if (first === undefined) throw new Error("fixture missing");
    await s.service.editStandardBlock(
      TENANT,
      first.id,
      { body: "Statutory fees, filing fees and stamp duty are not included." },
      ACTOR,
    );
    await s.service.editStandardBlock(TENANT, first.id, { isActive: false }, ACTOR);

    // The issued letter is untouched, by both the rewrite and the retirement.
    expect((await s.service.listBlocks(TENANT, LETTER)).map((b) => b.body)).toEqual(before);

    // …and the NEXT document gets the firm's new mind: the retired line is gone.
    const next = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(next.map((b) => b.body)).not.toContain("Statutory fees are not included.");
  });

  it("takes a line this client negotiated, marked as the document's own", async () => {
    const s = setup();
    await standardSet(s);
    await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    const added = await s.service.addBlock({
      tenantId: TENANT,
      owner: PROPOSAL,
      kind: "exclusion",
      body: "Transfer pricing documentation is quoted separately.",
      sortOrder: 9,
    });
    // sourceId null is what lets a screen say "this document's own" beside it.
    expect(added.sourceId).toBeNull();
    expect((await s.service.listBlocks(TENANT, PROPOSAL)).map((b) => b.id)).toContain(added.id);
  });

  it("strikes the third exclusion off — the sentence this table's shape exists for", async () => {
    const s = setup();
    await standardSet(s);
    await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    const exclusions = (await s.service.listBlocks(TENANT, PROPOSAL)).filter(
      (b) => b.kind === "exclusion",
    );
    const second = exclusions[1];
    if (second === undefined) throw new Error("fixture missing");

    await s.service.removeBlock(TENANT, second.id);
    const left = await s.service.listBlocks(TENANT, PROPOSAL);
    expect(left.map((b) => b.id)).not.toContain(second.id);
    // The others are untouched — no renumbering, no string surgery.
    expect(left.filter((b) => b.kind === "exclusion")).toHaveLength(1);
  });

  it("keeps one document's prose out of another's", async () => {
    const s = setup();
    await standardSet(s);
    await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(await s.service.listBlocks(TENANT, LETTER)).toEqual([]);
  });
});

// ── The Annexure letter's own prose (0083) ────────────────────────────────
//
// A cover letter and an acceptance are an ENGAGEMENT LETTER's, and they are the
// firm's own words: legal text this product never writes. They are copied
// onto a letter like everything else — and never onto a proposal, which has no
// cover letter and which nobody signs to accept.

describe("the cover letter and the acceptance (0083)", () => {
  async function withLetterProse(s: ReturnType<typeof setup>): Promise<void> {
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "cover", body: "This letter confirms our engagement.", sortOrder: 1 },
      ACTOR,
    );
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "acceptance", body: "The terms are accepted.", sortOrder: 1 },
      ACTOR,
    );
    await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "exclusion", body: "Statutory audit.", sortOrder: 1 },
      ACTOR,
    );
  }

  it("are copied onto a letter", async () => {
    const s = setup();
    await withLetterProse(s);
    const copied = await s.service.seedBlocks(TENANT, LETTER, "IN");
    expect(copied.map((b) => b.kind)).toEqual(["exclusion", "cover", "acceptance"]);
  });

  it("are never copied onto a proposal", async () => {
    const s = setup();
    await withLetterProse(s);
    const copied = await s.service.seedBlocks(TENANT, PROPOSAL, "IN");
    expect(copied.map((b) => b.kind)).toEqual(["exclusion"]);
  });

  it("cannot be written onto a proposal by hand, and are refused by name", async () => {
    const s = setup();
    await expect(
      s.service.addBlock({ tenantId: TENANT, owner: PROPOSAL, kind: "cover", body: "x", sortOrder: 1 }),
    ).rejects.toBeInstanceOf(LetterOnlyBlockKind);
    const onLetter = await s.service.addBlock({
      tenantId: TENANT,
      owner: LETTER,
      kind: "acceptance",
      body: "Accepted, for the group.",
      sortOrder: 2,
    });
    expect(onLetter.kind).toBe("acceptance");
  });

  it("are filtered by the rule itself, not only by the service", () => {
    const standard: StandardBlock[] = [
      { id: "c", tenantId: TENANT, kind: "cover", body: "x", isHeading: false, sortOrder: 1, jurisdiction: null, issuingEntityPartyId: null, isActive: true },
      { id: "e", tenantId: TENANT, kind: "exclusion", body: "y", isHeading: false, sortOrder: 1, jurisdiction: null, issuingEntityPartyId: null, isActive: true },
    ];
    expect(blocksFor(standard, "IN", "proposal").map((b) => b.id)).toEqual(["e"]);
    expect(blocksFor(standard, "IN", "engagement_letter").map((b) => b.id)).toEqual(["e", "c"]);
  });
});
