// Deleting a draft engagement letter made by mistake (0086), at the use-case
// level. The acceptance: a draft nobody was asked to sign comes off the list of
// letters, stays readable by id and never changes again — while a letter the
// client has seen is withdrawn, not deleted, and a signed one is the agreement.
//
// The database half — the guard trigger, the signed-letter freeze refusing the
// same columns, and the live-successor index skipping a deleted draft — is
// proven in tests/deletion/deletion.integration.test.ts.
import { describe, expect, it } from "vitest";
import { EngagementService } from "../../src/usecase/engagement/service";
import { makeEngagementFakes, writeOpening } from "../../src/testfakes/engagement";
import type { QuotedProposal } from "../../src/usecase/engagement/ports";
import {
  LetterDeleted,
  LetterNotDeletable,
  LetterNotFound,
  QuoteDeleted,
} from "../../src/domain/engagement/errors";
import { letterDeletionBlock } from "../../src/domain/engagement/model";
import { SEEDED_FIRM_ENTITY } from "../../src/testfakes/document";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000b1";
const USER = "00000000-0000-0000-0000-0000000000cc";
const ACTOR = { type: "human" as const, id: USER };
const GST = "00000000-0000-0000-0000-0000000000d1";
const SCOPE_CLAUSE = "00000000-0000-0000-0000-0000000000e1";
const QUOTE = "00000000-0000-0000-0000-0000000000f7";

function setup(): ReturnType<typeof makeEngagementFakes> & { service: EngagementService } {
  const fakes = makeEngagementFakes();
  fakes.structure.record(PARTY, { entities: [ENTITY], people: [] });
  fakes.library.publishService(GST, "gst-filing", { name: "GST monthly filing", billingBasis: "fixed" });
  fakes.library.publishClause(SCOPE_CLAUSE, "scope", {
    title: "Scope of work",
    text: "The firm will perform the services listed above.",
    jurisdictions: [],
  });
  fakes.letters.userNames.set(USER, "Anish");
  return { ...fakes, service: new EngagementService(fakes) };
}

async function draft(s: ReturnType<typeof setup>, proposalId?: string): Promise<string> {
  const letter = await s.service.draft(
    {
      tenantId: TENANT,
      partyId: PARTY,
      jurisdiction: "IN",
      title: "Acme — FY26 compliance",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      advanceRequired: false,
      ...(proposalId === undefined ? {} : { proposalId }),
    },
    ACTOR,
  );
  return letter.id;
}

async function completeTerms(s: ReturnType<typeof setup>, id: string): Promise<void> {
  await s.service.addLine({
    tenantId: TENANT,
    letterId: id,
    entityPartyId: ENTITY,
    serviceVersionId: GST,
    description: "GST filing, 12 months",
    quantity: "12",
    unitAmount: "2000",
    discountPercent: "0",
  });
  await s.service.addClause(TENANT, id, SCOPE_CLAUSE);
  await writeOpening(s.prose, TENANT, id);
}

function quote(over: Partial<QuotedProposal["proposal"]> = {}): QuotedProposal {
  return {
    proposal: {
      id: QUOTE,
      ref: "PR-2026-0007",
      partyId: PARTY,
      issuingEntityPartyId: SEEDED_FIRM_ENTITY,
      title: "Compliance retainer",
      status: "draft",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      rates: [],
      deletedAt: null,
      ...over,
    },
    lines: [],
    feeGroups: [],
  };
}

describe("deleting a draft letter made by mistake", () => {
  it("takes it off the list, under every filter, and says who deleted it", async () => {
    const s = setup();
    const id = await draft(s);

    const deleted = await s.service.delete(TENANT, id, ACTOR);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedByUserId).toBe(USER);
    // Not withdrawn: that is a letter the client has seen. The status stays.
    expect(deleted.status).toBe("draft");
    expect(deleted.withdrawnAt).toBeNull();
    expect(await s.service.list(TENANT, {})).toEqual([]);
    expect(await s.service.list(TENANT, { status: "draft" })).toEqual([]);
  });

  it("still opens by id, marked, naming who deleted it", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);

    const view = await s.service.describe(TENANT, id);
    expect(view.letter.deletedAt).not.toBeNull();
    expect(view.deletedBy?.displayName).toBe("Anish");
    expect(view.deleteRefusal?.code).toBe("LETTER_DELETED");
  });

  it("records one engagement_letter.deleted, and no withdrawal", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);

    const recorded = s.events.recorded.filter((e) => e.verb === "engagement_letter.deleted");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({ ref: "EL-2026-0001", partyId: PARTY });
    expect(s.events.verbs()).not.toContain("engagement_letter.withdrawn");
  });

  it("is final: nothing about a deleted draft changes, and it cannot be withdrawn", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.delete(TENANT, id, ACTOR);

    await expect(s.service.delete(TENANT, id, ACTOR)).rejects.toBeInstanceOf(LetterDeleted);
    await expect(completeTerms(s, id)).rejects.toBeInstanceOf(LetterDeleted);
    await expect(s.service.send(TENANT, id, ACTOR)).rejects.toBeInstanceOf(LetterDeleted);
    await expect(s.service.withdraw(TENANT, id, ACTOR)).rejects.toBeInstanceOf(LetterDeleted);
  });

  it("offers Delete on a live draft", async () => {
    const s = setup();
    const id = await draft(s);
    expect((await s.service.describe(TENANT, id)).deleteRefusal).toBeNull();
  });

  it("answers for a letter that does not exist as not found", async () => {
    await expect(
      setup().service.delete(TENANT, "00000000-0000-0000-0000-00000000ffff", ACTOR),
    ).rejects.toBeInstanceOf(LetterNotFound);
  });
});

describe("what a letter that went out keeps", () => {
  it("refuses one that was sent, pointing at Withdraw", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);

    const refused = s.service.delete(TENANT, id, ACTOR);
    await expect(refused).rejects.toBeInstanceOf(LetterNotDeletable);
    await expect(refused).rejects.toThrow(/withdraw it instead/);
    expect((await s.service.describe(TENANT, id)).deleteRefusal?.code).toBe(
      "LETTER_NOT_DELETABLE",
    );
  });

  it("refuses one that was signed, pointing at supersession", async () => {
    const s = setup();
    const id = await draft(s);
    await completeTerms(s, id);
    await s.service.send(TENANT, id, ACTOR);
    await s.service.sign({ tenantId: TENANT, letterId: id, signedByName: "Priya Menon" }, ACTOR);

    await expect(s.service.delete(TENANT, id, ACTOR)).rejects.toThrow(
      /signed letter is the record of what the client agreed to/,
    );
  });

  it("refuses one that was withdrawn — it stays on record as that", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.withdraw(TENANT, id, ACTOR);
    await expect(s.service.delete(TENANT, id, ACTOR)).rejects.toBeInstanceOf(LetterNotDeletable);
  });
});

describe("a deleted quote gains no letter", () => {
  it("refuses a letter citing it, naming the quote", async () => {
    const s = setup();
    s.quotes.add(quote({ deletedAt: "2026-07-01T09:00:00.000Z" }));
    const refused = draft(s, QUOTE);
    await expect(refused).rejects.toBeInstanceOf(QuoteDeleted);
    await expect(refused).rejects.toThrow(/PR-2026-0007 was deleted as made by mistake/);
  });

  it("refuses writing one up from it, before asking whether it was accepted", async () => {
    // A deleted quote is always a draft, so "record the acceptance first" would
    // send somebody off to accept a mistake.
    const s = setup();
    s.quotes.add(quote({ deletedAt: "2026-07-01T09:00:00.000Z" }));
    await expect(
      s.service.draftFromQuote(
        { tenantId: TENANT, proposalId: QUOTE, advanceRequired: false },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(QuoteDeleted);
  });

  it("still lets a letter cite a live draft quote, as before", async () => {
    const s = setup();
    s.quotes.add(quote());
    const id = await draft(s, QUOTE);
    expect((await s.letters.findLetter(TENANT, id))?.proposalId).toBe(QUOTE);
  });
});

describe("letterDeletionBlock — the rule, alone", () => {
  it("names the deletion first, then the status", () => {
    expect(
      letterDeletionBlock({ status: "draft", deletedAt: "2026-07-01T09:00:00.000Z" }),
    ).toEqual({ kind: "deleted" });
    expect(letterDeletionBlock({ status: "sent", deletedAt: null })).toEqual({
      kind: "not_draft",
      status: "sent",
    });
    expect(letterDeletionBlock({ status: "draft", deletedAt: null })).toBeNull();
  });
});
