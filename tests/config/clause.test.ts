// G1.8, schema half — governing law and courts on a clause body.
//
// The finding this exists for is the sharpest one the original project
// produced: the real engagement letter was issued by the firm's US entity to a
// US client, and its standard terms named INDIAN law and DELHI courts. The
// firm's verdict was flat — "No. This is wrong. For US it's US. For UAE it's
// DIFC in Dubai."
//
// A clause carried `jurisdictions` already, and that field could never have
// caught it: it says where a clause may be USED, not what the clause SAYS. So
// nothing anywhere held the governing law, and the bug was representable again
// with no code able to see it.
//
// Four things are being proven here, and they are the reasons for the SHAPE
// rather than for the fields:
//
//   1. A term is a code AND words, together. The code cannot print ("the laws
//      of the State of Delaware" does not follow from "US"), and the words
//      cannot be compared — and the refusal G1.8 asks for is a machine
//      comparison, because a human review already let this exact letter out.
//   2. Both terms are OPTIONAL, so every clause already published and frozen —
//      and pinned by letters already issued — still validates and still reads.
//   3. Absence reads back as null and never as a default. There is no sensible
//      "default governing law", and a consumer that invented one would print a
//      law onto a signed contract that nobody chose.
//   4. The code is normalised at the READ but demanded at the WRITE, because a
//      body is stored verbatim and the comparison is an equality test.
//
// The other half of G1.8 — resolving the law FROM THE ISSUING ENTITY and
// refusing a mismatch — needs G1.2's `issuing_entity_party_id` and is not here.
// What is here is the field that makes that check possible at all.
import { describe, expect, it } from "vitest";
import { ConfigService } from "../../src/usecase/config/service";
import { makeConfigFakes } from "../../src/testfakes/config";
import { InvalidBody } from "../../src/domain/config/errors";
import { readClauseBody } from "../../src/domain/config/model";
import { isJurisdiction, normalizeJurisdiction } from "../../src/domain/engagement/model";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000b1" };

/** A clause as it could be written BEFORE G1.8 — the fixture for "a body
 *  published and frozen without these fields". */
const ORIGINAL = {
  title: "Governing law and jurisdiction",
  text: "This engagement is governed by the law stated below and disputes are heard by the courts stated below.",
  jurisdictions: ["US"],
};

const US_LAW = { jurisdiction: "US", text: "the laws of the State of Delaware" };
const DIFC_COURTS = { jurisdiction: "AE", text: "the DIFC Courts, Dubai" };

function service(): ConfigService {
  return new ConfigService(makeConfigFakes());
}

/** Define a clause with this body and hand back the failure, so a test can
 *  assert on the SENTENCE rather than only on the type. */
async function reject(body: Record<string, unknown>, key = "governing-law"): Promise<Error> {
  const err = await service()
    .define({ tenantId: TENANT, kind: "clause", key, body }, ACTOR)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidBody);
  return err as Error;
}

async function accept(body: Record<string, unknown>, key = "governing-law"): Promise<void> {
  await expect(
    service().define({ tenantId: TENANT, kind: "clause", key, body }, ACTOR),
  ).resolves.toBeDefined();
}

async function define(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { draft } = await service().define(
    { tenantId: TENANT, kind: "clause", key: "governing-law", body },
    ACTOR,
  );
  return draft.body;
}

describe("G1.8 — a clause states whose law governs", () => {
  it("carries the law and the courts, and reads both back", async () => {
    const stored = await define({ ...ORIGINAL, governingLaw: US_LAW, courts: DIFC_COURTS });

    // Verbatim in the stored body — that is what makes a published version
    // freezable, and what an issued letter is assembled from.
    expect(stored["governingLaw"]).toEqual(US_LAW);

    const body = readClauseBody(stored);
    expect(body.governingLaw).toEqual(US_LAW);
    expect(body.courts).toEqual(DIFC_COURTS);
  });

  it("makes the bug the firm caught visible to code for the first time", async () => {
    // The real letter, as a clause: Indian law, Delhi courts, issued by the US
    // entity. Nothing in this test refuses it — that is G1.8's other half, and
    // it needs G1.2's issuing entity. What this proves is that the refusal is
    // now WRITEABLE: the letter's issuing jurisdiction and the clause's are two
    // codes, and comparing them is an equality test rather than a lawyer
    // reading a paragraph.
    const body = readClauseBody(
      await define({
        ...ORIGINAL,
        jurisdictions: [],
        governingLaw: { jurisdiction: "IN", text: "the laws of India" },
        courts: { jurisdiction: "IN", text: "the courts at New Delhi" },
      }),
    );

    const issuingEntityJurisdiction = "US";
    expect(body.governingLaw?.jurisdiction).not.toBe(issuingEntityJurisdiction);
    expect(body.courts?.jurisdiction).not.toBe(issuingEntityJurisdiction);
    // And the words survive for the document, which the code alone could not
    // print: "US" does not spell Delaware.
    expect(body.governingLaw?.text).toBe("the laws of India");
  });

  it("keeps the two terms independent — a firm may state one without the other", async () => {
    // They are two choices. Requiring the pair would make a firm invent a forum
    // it never picked, and inventing a forum on a signed document is the same
    // class of bug as inventing the law.
    expect(readClauseBody(await define({ ...ORIGINAL, governingLaw: US_LAW })).courts).toBeNull();
    expect(
      readClauseBody(await define({ ...ORIGINAL, courts: DIFC_COURTS })).governingLaw,
    ).toBeNull();
  });

  it("does not cross-validate the law against the jurisdictions the clause is tagged with", async () => {
    // `jurisdictions` says where a clause may be USED; governingLaw says what it
    // SAYS. English law in clauses used across three countries is an ordinary
    // international arrangement, and refusing it here would turn one firm's rule
    // into a product rule. The check that matters is against the ISSUING ENTITY.
    await accept({
      ...ORIGINAL,
      jurisdictions: ["IN", "AE", "SG"],
      governingLaw: { jurisdiction: "GB", text: "the laws of England and Wales" },
    });
  });
});

describe("G1.8 — optional, because a published clause is frozen", () => {
  it("still validates a clause written before the fields existed", async () => {
    // The version rows already published cannot be edited to carry a new field
    // — the trigger in 0005 refuses it — and there is no honest law to backfill
    // into terms that never named one. So absent has to stay valid forever.
    await accept(ORIGINAL);
    await accept({ ...ORIGINAL, governingLaw: null, courts: null });
  });

  it("reads a pre-G1.8 clause back as null, never as a default", () => {
    const body = readClauseBody(ORIGINAL);
    expect(body.governingLaw).toBeNull();
    expect(body.courts).toBeNull();
    // The fields that were always there are untouched by the extension.
    expect(body.title).toBe(ORIGINAL.title);
    expect(body.jurisdictions).toEqual(["US"]);
  });

  it("does not let the clause's own tag stand in for a law it never stated", () => {
    // The tempting default, and the one that would recreate the bug quietly: a
    // clause tagged ["US"] is not a clause that says US law governs. It says it
    // may be used on a US letter.
    expect(readClauseBody(ORIGINAL).governingLaw).toBeNull();
  });
});

describe("G1.8 — a term is a code AND words", () => {
  it.each(["governingLaw", "courts"])("refuses %s with a code and no words", async (field) => {
    const err = await reject({ ...ORIGINAL, [field]: { jurisdiction: "US" } });
    expect(err.message).toContain(`"${field}.text"`);
    expect(err.message).toContain("Delaware");
  });

  it.each(["governingLaw", "courts"])("refuses %s with words and no code", async (field) => {
    const err = await reject({ ...ORIGINAL, [field]: { text: "the laws of India" } });
    expect(err.message).toContain(`"${field}.jurisdiction"`);
    expect(err.message).toContain("ISSUING");
  });

  it("refuses a bare sentence where the term goes, and says what the object looks like", async () => {
    // The shape somebody reaches for first, and the one that cannot be checked:
    // "Indian law" is invisible to an equality test against "US".
    const err = await reject({ ...ORIGINAL, governingLaw: "the laws of India" });
    expect(err.message).toContain('"governingLaw"');
    expect(err.message).toContain("whose law governs the engagement");
    expect(err.message).toContain('"jurisdiction"');
  });

  it("names what courts are FOR when the courts term is the bad one", async () => {
    const err = await reject({ ...ORIGINAL, courts: ["the DIFC Courts, Dubai"] });
    expect(err.message).toContain('"courts"');
    expect(err.message).toContain("which courts hear a dispute");
    expect(err.message).toContain("DIFC");
  });

  it("refuses an empty sentence rather than printing a term that says nothing", async () => {
    const err = await reject({ ...ORIGINAL, governingLaw: { jurisdiction: "US", text: "   " } });
    expect(err.message).toContain('"governingLaw.text"');
  });

  it("refuses a misspelt field inside the term instead of storing it silently", async () => {
    // A body is stored verbatim and read back by name, so `law:` for `text:`
    // would save, publish, freeze, and print nothing.
    const err = await reject({ ...ORIGINAL, governingLaw: { jurisdiction: "US", law: "Delaware" } });
    expect(err.message).toContain('"governingLaw"');
    expect(err.message).toContain('"law"');
    expect(err.message).toContain("jurisdiction, text");
  });

  it("refuses a misspelt term on the clause body", async () => {
    const err = await reject({ ...ORIGINAL, governing_law: US_LAW });
    expect(err.message).toContain('"governing_law"');
    expect(err.message).toContain("governingLaw");
    expect(err.message).toContain("courts");
  });
});

describe("G1.8 — the code is demanded at the write and normalised at the read", () => {
  it.each(["us", "USA", "U", "United States", " US"])("refuses %p", async (jurisdiction) => {
    const err = await reject({
      ...ORIGINAL,
      governingLaw: { jurisdiction, text: "the laws of the State of Delaware" },
    });
    expect(err.message).toContain('"governingLaw.jurisdiction"');
    expect(err.message).toContain("UPPER CASE");
  });

  it("says why the case matters, in terms of what the code is for", async () => {
    // Not a style rule. The code is compared to the issuing entity's
    // jurisdiction, a body is stored verbatim, and a comparison that misses
    // refuses a letter that was correct — or, wired the other way round, passes
    // one that was not.
    const err = await reject({ ...ORIGINAL, governingLaw: { jurisdiction: "us", text: "x" } });
    expect(err.message).toContain("compared");
    expect(err.message).toContain("verbatim");
    expect(err.message).toContain('"us"');
  });

  it("still resolves a hand-edited body, because a pinned version must always read", () => {
    // The read falls back rather than throwing — the property `readClauseBody`
    // already had and the one G1.8 must not break. A code that only differs in
    // case is the same country beyond doubt, so normalising it keeps a
    // hand-edited clause inside the mismatch check instead of silently outside
    // it.
    const body = readClauseBody({
      ...ORIGINAL,
      governingLaw: { jurisdiction: " ae ", text: "  the laws of the DIFC  " },
    });
    expect(body.governingLaw?.jurisdiction).toBe("AE");
    // The words are NOT re-rendered: they print on a signed document exactly as
    // the firm wrote them.
    expect(body.governingLaw?.text).toBe("  the laws of the DIFC  ");
  });

  it.each([
    { jurisdiction: "United States", text: "x" },
    { jurisdiction: "US" },
    { jurisdiction: "US", text: "" },
    { text: "the laws of India" },
    "the laws of India",
    ["US"],
    null,
  ])("reads %p back as no term at all rather than throwing", (governingLaw) => {
    expect(readClauseBody({ ...ORIGINAL, governingLaw }).governingLaw).toBeNull();
  });
});

describe("G1.8 — the jurisdiction code means the same thing on both sides", () => {
  it.each(["US", "AE", "IN", "GB"])("agrees with the engagement domain on %s", (code) => {
    // `domain/config` states this pattern itself rather than importing the
    // engagement module's, because config is upstream of engagement and the
    // import would invert the dependency. This test is the price of that
    // duplication: the two definitions cannot drift apart quietly, because a
    // clause's code is compared against a letter's.
    expect(isJurisdiction(code)).toBe(true);
    expect(readClauseBody({ ...ORIGINAL, governingLaw: { jurisdiction: code, text: "x" } })
      .governingLaw?.jurisdiction).toBe(code);
  });

  it.each(["us", "USA", "U", "United States", ""])("rejects %p on both sides", async (code) => {
    expect(isJurisdiction(code)).toBe(false);
    const err = await reject({ ...ORIGINAL, governingLaw: { jurisdiction: code, text: "x" } });
    expect(err.message).toContain('"governingLaw.jurisdiction"');
  });

  it("normalises a stored code the way the engagement domain normalises one", () => {
    const raw = " ae ";
    expect(
      readClauseBody({ ...ORIGINAL, governingLaw: { jurisdiction: raw, text: "x" } })
        .governingLaw?.jurisdiction,
    ).toBe(normalizeJurisdiction(raw));
  });
});
