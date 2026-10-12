// The AI document reader (F2.4, usecase/fin/extract.ts), against fakes: when it
// reads, when it waits ("later"), when it gives the file to a person, and that
// every call it makes is recorded with its model, prompt version and tokens.
import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, VISION_MAX_EDGE, weighedTokens } from "../../src/domain/fin/extraction-usage";
import { BREAKER_AFTER, UnavailableVisionReader, VisionReader } from "../../src/usecase/fin/extract";
import type { VisionLimits } from "../../src/usecase/fin/extract";
import type { ReadInput, ReadOutcome } from "../../src/usecase/fin/reading";
import type { IntakeRoute } from "../../src/domain/fin/intake";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import {
  FAKE_MODEL,
  FAKE_PROMPT_VERSION,
  FakeBooksOwners,
  FakeExtractor,
  FakeImageNormaliser,
  FakePdfPages,
  FakeUsageStore,
  TYPICAL_USAGE,
  answered,
  failed,
  printed,
  reading,
} from "../../src/testfakes/fin-extract";

const FIRM = "00000000-0000-4000-8000-0000000000a1";
const OTHER_FIRM = "00000000-0000-4000-8000-0000000000b2";
const CLIENT = "00000000-0000-4000-8000-0000000000c3";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

let seq = 0;
function input(over: Partial<ReadInput> & { route?: IntakeRoute } = {}): ReadInput {
  seq += 1;
  const route = over.route ?? "pdf";
  return {
    tenantId: FIRM,
    intakeItemId: `item-${String(seq)}`,
    documentVersionId: `version-${String(seq)}`,
    clientPartyId: CLIENT,
    route,
    mediaType: route === "image" ? "image/jpeg" : "application/pdf",
    filename: route === "image" ? "IMG_20250620_084323.jpg" : "Singa_Mobile_K03467.pdf",
    bytes: route === "image" ? JPEG : PDF,
    ...over,
  };
}

/** Lumen Cloudworks' purchase from Singa Mobile (A-X01), as the model reads it. */
const INVOICE = reading("purchase_invoice", {
  counterpartyName: printed("Singa Mobile and Fibre Pte Ltd"),
  docNumber: printed("K03467"),
  docDate: printed("21/04/2025"),
  currency: printed("SGD"),
  net: printed("575.00"),
  gstRate: printed("8%"),
  gst: printed("46.00"),
  total: printed("621.00"),
});

/** The same reading with a confidence out of range: shaped right, not a reading. */
const BROKEN = { ...INVOICE, overallConfidence: 1.4 };

function harness(over: { limits?: Partial<VisionLimits>; pdfPages?: FakePdfPages | null } = {}) {
  const extractor = new FakeExtractor();
  const usage = new FakeUsageStore();
  const owners = new FakeBooksOwners();
  owners.set(FIRM, CLIENT, { names: ["Lumen Cloudworks Pte Ltd"], uen: "202134890G", gstNo: "M2-9588401-7" });
  const images = new FakeImageNormaliser();
  const pdfPages = over.pdfPages === undefined ? new FakePdfPages() : over.pdfPages;
  const reader = new VisionReader({
    extractor,
    usage,
    owners,
    images,
    pdfPages,
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-10-11T02:00:00Z")),
    limits: { runCap: 50, monthlyTokens: 20_000_000, ...over.limits },
  });
  return { reader, extractor, usage, owners, images, pdfPages };
}

function later(reason: "ai_unavailable" | "ai_budget_reached"): ReadOutcome {
  return { kind: "later", reader: "vision", reason };
}

function person(problem: string): ReadOutcome {
  return { kind: "needs_person", reader: "vision", problem } as ReadOutcome;
}

describe("with no provider", () => {
  const reader = new UnavailableVisionReader();

  it("is still the vision reader, and answers later for every PDF and image it would read", async () => {
    expect(reader.name).toBe("vision");
    expect(await reader.read(input({ route: "pdf" }))).toEqual(later("ai_unavailable"));
    expect(await reader.read(input({ route: "image" }))).toEqual(later("ai_unavailable"));
  });

  it("leaves what it would never read to the next reader", async () => {
    for (const route of ["sheet", "archive", "manual"] as const) {
      expect(await reader.read(input({ route }))).toEqual({ kind: "not_mine" });
    }
  });
});

describe("reading a file", () => {
  it("reads a PDF into one document line, records the call, and sends the PDF as it is", async () => {
    const h = harness();
    h.extractor.queue(answered(INVOICE));
    const item = input();
    const outcome = await h.reader.read(item);

    expect(outcome.kind).toBe("read");
    if (outcome.kind !== "read") return;
    expect(outcome.draft).toMatchObject({
      docKind: "purchase_invoice",
      reader: "vision",
      model: FAKE_MODEL,
      promptVersion: FAKE_PROMPT_VERSION,
    });
    expect(outcome.draft.lines[0]).toMatchObject({
      docNumber: "K03467",
      docDate: "2025-04-21",
      gstRate: "8",
      total: "621.00",
      provenance: { documentVersionId: item.documentVersionId, page: 1, row: null },
    });

    expect(h.extractor.requests).toHaveLength(1);
    expect(h.extractor.requests[0]).toEqual({
      content: { kind: "pdf", bytes: PDF },
      owner: { names: ["Lumen Cloudworks Pte Ltd"], uen: "202134890G", gstNo: "M2-9588401-7" },
      correction: null,
    });
    expect(h.usage.rows).toEqual([
      {
        id: expect.any(String) as string,
        tenantId: FIRM,
        intakeItemId: item.intakeItemId,
        model: FAKE_MODEL,
        promptVersion: FAKE_PROMPT_VERSION,
        attempt: 1,
        usage: TYPICAL_USAGE,
        outcome: "ok",
        failure: null,
        docClass: "purchase_invoice",
        requestId: "req_fake",
      },
    ]);
  });

  it("shrinks an image to the reader's edge first and sends what came back", async () => {
    const h = harness();
    h.images.outputBytes = 1234;
    h.extractor.queue(answered(reading("receipt", { total: printed("24.72") })));
    const outcome = await h.reader.read(input({ route: "image" }));

    expect(h.images.asked).toEqual([VISION_MAX_EDGE]);
    expect(h.extractor.requests[0]?.content).toEqual({
      kind: "image",
      bytes: new Uint8Array(1234),
      mediaType: "image/jpeg",
    });
    expect(outcome.kind === "read" ? outcome.draft.lines[0]?.provenance.page : "not read").toBeNull();
  });

  it("tells the model nobody's name when the file belongs to no client", async () => {
    const h = harness();
    h.extractor.queue(answered(INVOICE));
    await h.reader.read(input({ clientPartyId: null }));
    expect(h.extractor.requests[0]?.owner).toBeNull();
  });

  it("does not read a statement, payroll or a non-books file, and keeps what the model said it was", async () => {
    const h = harness();
    h.extractor.queue(answered(reading("bank_statement")), answered(reading("not_books")));
    expect(await h.reader.read(input())).toEqual({ kind: "not_mine" });
    expect(await h.reader.read(input({ route: "image" }))).toEqual({ kind: "not_mine" });
    expect(h.usage.rows.map((r) => [r.outcome, r.docClass])).toEqual([
      ["ok", "bank_statement"],
      ["ok", "not_books"],
    ]);
  });

  it("leaves a sheet, an archive and a manual file alone, without a call", async () => {
    const h = harness();
    for (const route of ["sheet", "archive", "manual"] as const) {
      expect(await h.reader.read(input({ route }))).toEqual({ kind: "not_mine" });
    }
    expect(h.extractor.requests).toHaveLength(0);
    expect(h.usage.rows).toHaveLength(0);
  });
});

describe("an answer that is not a reading: retried once, then a person", () => {
  it("retries invalid output once, naming what was wrong, and reads the second answer", async () => {
    const h = harness();
    h.extractor.queue(answered(BROKEN), answered(INVOICE));
    const item = input();
    const outcome = await h.reader.read(item);

    expect(outcome.kind).toBe("read");
    expect(h.extractor.requests[1]?.correction).toEqual(["overallConfidence: must be at most 1"]);
    expect(h.usage.forItem(item.intakeItemId).map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "invalid_output"],
      [2, "ok"],
    ]);
  });

  it("gives the file to a person after a second invalid answer, with both calls recorded", async () => {
    const h = harness();
    h.extractor.queue(answered("not json at all"), answered(BROKEN));
    const item = input();
    expect(await h.reader.read(item)).toEqual(person("ai_invalid_output"));
    expect(h.extractor.requests).toHaveLength(2);
    expect(h.usage.forItem(item.intakeItemId).map((r) => [r.attempt, r.outcome, r.docClass])).toEqual([
      [1, "invalid_output", null],
      [2, "invalid_output", null],
    ]);
  });

  it("treats an answer without the tool call, or cut off, as one to retry", async () => {
    const h = harness();
    h.extractor.queue(answered(null, { stop: "no_tool_call" }), answered(null, { stop: "truncated" }));
    const item = input();
    expect(await h.reader.read(item)).toEqual(person("ai_invalid_output"));
    expect(h.extractor.requests[1]?.correction).toEqual([
      "You answered without calling record_document. Call it exactly once.",
    ]);
    expect(h.usage.forItem(item.intakeItemId).map((r) => r.outcome)).toEqual(["no_tool_call", "truncated"]);
  });

  it("does not argue with a model that declined the file: a person reads it", async () => {
    const h = harness();
    h.extractor.queue(answered(null, { stop: "refused" }));
    const item = input();
    expect(await h.reader.read(item)).toEqual(person("ai_invalid_output"));
    expect(h.extractor.requests).toHaveLength(1);
    expect(h.usage.forItem(item.intakeItemId).map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("answers later, not a person, when the retry fails in transit", async () => {
    const h = harness();
    h.extractor.queue(answered(BROKEN), failed("overloaded"));
    const item = input();
    expect(await h.reader.read(item)).toEqual(later("ai_unavailable"));
    expect(h.usage.forItem(item.intakeItemId).map((r) => [r.outcome, r.failure])).toEqual([
      ["invalid_output", null],
      ["transport_error", "overloaded"],
    ]);
  });
});

describe("the circuit breaker", () => {
  it(`opens after ${String(BREAKER_AFTER)} transport failures in a row, and the run asks nobody after`, async () => {
    const h = harness();
    h.extractor.queue(failed("rate_limited"), failed("overloaded"), failed("timeout"));
    for (let i = 0; i < BREAKER_AFTER; i += 1) {
      expect(await h.reader.read(input())).toEqual(later("ai_unavailable"));
    }
    expect(await h.reader.read(input())).toEqual(later("ai_unavailable"));
    expect(await h.reader.read(input({ route: "image" }))).toEqual(later("ai_unavailable"));
    expect(h.extractor.requests).toHaveLength(BREAKER_AFTER);
    expect(h.reader.report().breakerOpen).toBe(true);
    expect(h.usage.rows.map((r) => [r.outcome, r.failure, weighedTokens(r.usage)])).toEqual([
      ["transport_error", "rate_limited", 0],
      ["transport_error", "overloaded", 0],
      ["transport_error", "timeout", 0],
    ]);
  });

  it("counts only failures IN A ROW: an answer in between resets it", async () => {
    const h = harness();
    h.extractor.queue(failed("server_error"), failed("connection"), answered(INVOICE), failed("timeout"), failed("timeout"));
    for (let i = 0; i < 5; i += 1) await h.reader.read(input());
    expect(h.reader.report().breakerOpen).toBe(false);
    h.extractor.queue(answered(INVOICE));
    expect((await h.reader.read(input())).kind).toBe("read");
  });

  it("opens at once on a refused key: every call would be refused", async () => {
    const h = harness();
    h.extractor.queue(failed("auth"));
    expect(await h.reader.read(input())).toEqual(later("ai_unavailable"));
    expect(await h.reader.read(input())).toEqual(later("ai_unavailable"));
    expect(h.extractor.requests).toHaveLength(1);
  });

  it("does not count invalid output: the transport worked", async () => {
    const h = harness({});
    const reader = new VisionReader({
      extractor: h.extractor,
      usage: h.usage,
      owners: h.owners,
      images: h.images,
      pdfPages: null,
      ids: new FakeIds(),
      clock: new FakeClock(),
      limits: { runCap: 50, monthlyTokens: 20_000_000 },
      breakerAfter: 1,
    });
    h.extractor.queue(answered(BROKEN), answered(BROKEN), answered(INVOICE));
    await reader.read(input());
    expect(reader.report().breakerOpen).toBe(false);
    expect((await reader.read(input())).kind).toBe("read");
  });
});

describe("the caps: this run's, and the month's", () => {
  it("reads at most runCap documents per firm per run; another firm still gets its own", async () => {
    const h = harness({ limits: { runCap: 2 } });
    h.extractor.queue(answered(INVOICE), answered(INVOICE), answered(INVOICE));
    expect((await h.reader.read(input())).kind).toBe("read");
    expect((await h.reader.read(input())).kind).toBe("read");
    expect(await h.reader.read(input())).toEqual(later("ai_budget_reached"));
    expect((await h.reader.read(input({ tenantId: OTHER_FIRM, clientPartyId: null }))).kind).toBe("read");
    expect(h.extractor.requests).toHaveLength(3);
  });

  it("counts a document once however many attempts it took", async () => {
    const h = harness({ limits: { runCap: 1 } });
    h.extractor.queue(answered(BROKEN), answered(INVOICE));
    expect((await h.reader.read(input())).kind).toBe("read");
    expect(await h.reader.read(input())).toEqual(later("ai_budget_reached"));
  });

  it("answers later, with no call, for a firm that has spent its month", async () => {
    const h = harness({ limits: { monthlyTokens: 50_000 } });
    h.usage.earlier.set(FIRM, { inputTokens: 50_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(await h.reader.read(input())).toEqual(later("ai_budget_reached"));
    expect(h.extractor.requests).toHaveLength(0);
  });

  it("stops a firm in the run that crosses its month, counting what this run spent", async () => {
    // TYPICAL_USAGE weighs 8,960: two calls fit under 10,000 only one at a time.
    const h = harness({ limits: { monthlyTokens: 10_000 } });
    h.extractor.queue(answered(INVOICE), answered(INVOICE));
    expect((await h.reader.read(input())).kind).toBe("read");
    expect((await h.reader.read(input())).kind).toBe("read");
    expect(await h.reader.read(input())).toEqual(later("ai_budget_reached"));
    // The month is read from the store once per firm per run, then kept.
    expect(h.usage.monthReads.get(FIRM)).toBe(1);
  });

  it("weighs the budget, so output tokens count five times", async () => {
    const h = harness({ limits: { monthlyTokens: 1_000 } });
    h.usage.earlier.set(FIRM, { inputTokens: 0, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(await h.reader.read(input())).toEqual(later("ai_budget_reached"));
  });
});

describe("a file too big to send, or that cannot be prepared, is a person's", () => {
  it("refuses a PDF over the byte limit before any call", async () => {
    const h = harness();
    expect(await h.reader.read(input({ bytes: new Uint8Array(MAX_PDF_BYTES + 1) }))).toEqual(person("too_large"));
    expect(h.extractor.requests).toHaveLength(0);
  });

  it("refuses a PDF with more pages than one document has", async () => {
    const pages = new FakePdfPages();
    pages.pages = 21;
    const h = harness({ pdfPages: pages });
    expect(await h.reader.read(input())).toEqual(person("too_large"));
    expect(h.extractor.requests).toHaveLength(0);
  });

  it("gives a person a PDF the page counter cannot open, or one with no pages", async () => {
    const pages = new FakePdfPages();
    const h = harness({ pdfPages: pages });
    pages.broken = true;
    expect(await h.reader.read(input())).toEqual(person("unreadable"));
    pages.broken = false;
    pages.pages = 0;
    expect(await h.reader.read(input())).toEqual(person("unreadable"));
  });

  it("checks only the bytes where no page counter is wired", async () => {
    const h = harness({ pdfPages: null });
    h.extractor.queue(answered(INVOICE));
    expect((await h.reader.read(input())).kind).toBe("read");
  });

  it("gives a person an image that will not decode, or is still too big once shrunk", async () => {
    const h = harness();
    h.images.broken = true;
    expect(await h.reader.read(input({ route: "image" }))).toEqual(person("unreadable"));
    h.images.broken = false;
    h.images.outputBytes = 5 * 1024 * 1024 + 1;
    expect(await h.reader.read(input({ route: "image" }))).toEqual(person("too_large"));
    expect(h.extractor.requests).toHaveLength(0);
  });

  it("gives a person a file the provider calls too large (413)", async () => {
    const h = harness();
    h.extractor.queue(failed("too_large"));
    expect(await h.reader.read(input())).toEqual(person("too_large"));
    expect(h.reader.report().breakerOpen).toBe(false);
  });
});

describe("a request the provider refuses (400)", () => {
  it("waits while nothing else has been answered: a broken request must not park files", async () => {
    const h = harness();
    const item = input();
    h.extractor.queue(failed("bad_request"));
    expect(await h.reader.read(item)).toEqual(later("ai_unavailable"));

    const next = harness();
    // The second run, same item, same store: still nothing answered since.
    const run2 = new VisionReader({
      extractor: next.extractor,
      usage: h.usage,
      owners: h.owners,
      images: h.images,
      pdfPages: null,
      ids: new FakeIds(),
      clock: new FakeClock(),
      limits: { runCap: 50, monthlyTokens: 20_000_000 },
    });
    next.extractor.queue(failed("bad_request"));
    expect(await run2.read(item)).toEqual(later("ai_unavailable"));
  });

  it("gives a person a file refused twice while the firm's other files were read", async () => {
    const h = harness();
    const stubborn = input();
    h.extractor.queue(failed("bad_request"), answered(INVOICE));
    expect(await h.reader.read(stubborn)).toEqual(later("ai_unavailable"));
    expect((await h.reader.read(input())).kind).toBe("read");

    const run2 = new VisionReader({
      extractor: new FakeExtractor([failed("bad_request")]),
      usage: h.usage,
      owners: h.owners,
      images: h.images,
      pdfPages: null,
      ids: new FakeIds(),
      clock: new FakeClock(),
      limits: { runCap: 50, monthlyTokens: 20_000_000 },
    });
    expect(await run2.read(stubborn)).toEqual(person("unreadable"));
  });
});

describe("every call is recorded", () => {
  it("writes one row per attempt, whatever the attempt came to, and the report adds them up", async () => {
    const h = harness();
    h.extractor.queue(
      answered(INVOICE),
      answered(BROKEN),
      answered(INVOICE),
      failed("rate_limited"),
      answered(reading("payroll")),
    );
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) outcomes.push((await h.reader.read(input())).kind);
    expect(outcomes).toEqual(["read", "read", "later", "not_mine"]);
    expect(h.usage.rows).toHaveLength(h.extractor.requests.length);
    for (const row of h.usage.rows) {
      expect(row.model).toBe(FAKE_MODEL);
      expect(row.promptVersion).toBe(FAKE_PROMPT_VERSION);
    }
    const report = h.reader.report();
    expect(report).toMatchObject({
      read: 2,
      notMine: 1,
      later: { unavailable: 1, budget: 0 },
      calls: 5,
      breakerOpen: false,
    });
    expect(report.tokens.outputTokens).toBe(TYPICAL_USAGE.outputTokens * 4);
  });
});
