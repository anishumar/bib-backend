// The AI reader's contract with the model, and what becomes of its answer
// (F2.4, domain/fin/extraction*.ts): the tool's schema, the normalisation of
// what a document prints, and the rule that null means "not printed".
//
// The values are shaped like the 10x training pack's own documents (Lumen
// Cloudworks' suppliers); the expected answers are what those documents print.
import { describe, expect, it } from "vitest";
import {
  DOC_CLASSES,
  FIELD_CERTAIN_ABOVE,
  READ_FIELDS,
  documentToolSchema,
  judgeField,
  toReadDraft,
} from "../../src/domain/fin/extraction";
import type { DraftContext } from "../../src/domain/fin/extraction";
import {
  normaliseAmount,
  normaliseCurrencyMark,
  normaliseDay,
  normaliseMonth,
  normalisePercent,
  normalisePeriodEnd,
  normalisePeriodStart,
  normaliseRate,
  normaliseReference,
  normaliseRegistration,
} from "../../src/domain/fin/extraction-normalise";
import { TOKEN_WEIGHTS, weighedTokens } from "../../src/domain/fin/extraction-usage";
import type { DocumentLineDraft } from "../../src/domain/fin/lines";
import { printed, reading } from "../../src/testfakes/fin-extract";

const ctx: DraftContext = {
  provenance: { documentVersionId: "00000000-0000-4000-8000-000000000001", page: 1, row: null },
  model: "claude-sonnet-5-5",
  promptVersion: "fin-doc@1",
  certainAbove: FIELD_CERTAIN_ABOVE,
};

function lineOf(result: ReturnType<typeof toReadDraft>): DocumentLineDraft {
  if (result.kind !== "document") throw new Error(`expected a document, got ${result.docClass}`);
  const line = result.draft.lines[0];
  if (line?.kind !== "document") throw new Error("expected one document line");
  return line;
}

describe("the tool's schema", () => {
  const schema = documentToolSchema();

  it("asks for every field of the document line, and nothing about provenance", () => {
    const fields = schema.properties.fields as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(fields.properties).sort()).toEqual([...READ_FIELDS].sort());
    expect(fields.required.sort()).toEqual([...READ_FIELDS].sort());
    expect(READ_FIELDS).not.toContain("docType");
    expect(Object.keys(fields.properties)).not.toContain("provenance");
  });

  it("lets the model say a statement, payroll, a bundle or not a books document", () => {
    const docType = schema.properties.docType as { enum: string[] };
    expect(docType.enum).toEqual([...DOC_CLASSES]);
    expect(docType.enum).toEqual(expect.arrayContaining(["bank_statement", "card_statement", "payroll", "not_books"]));
  });

  it("is written for strict tool use: every object closed and fully required, and no bounds", () => {
    const json = JSON.stringify(schema);
    // Strict mode takes no numeric or length bounds; the validator checks them.
    for (const keyword of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "pattern"]) {
      expect(json).not.toContain(`"${keyword}"`);
    }
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o.type === "object") objects.push(o);
        Object.values(o).forEach(walk);
      }
    };
    walk(schema);
    expect(objects.length).toBe(2 + READ_FIELDS.length);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
    }
  });

  it("makes every field say read, not printed or unreadable, never a bare null", () => {
    const fields = schema.properties.fields as { properties: Record<string, { properties: { status: { enum: string[] } } }> };
    for (const f of READ_FIELDS) {
      expect(fields.properties[f]?.properties.status.enum).toEqual(["read", "not_printed", "unreadable"]);
    }
  });
});

describe("dates, read day first as Singapore prints them", () => {
  it.each([
    ["20.06.2025", "2025-06-20"],
    ["15/03/2025", "2025-03-15"],
    ["03/04/2025", "2025-04-03"],
    ["15-03-25", "2025-03-15"],
    ["2025-03-15", "2025-03-15"],
    ["2025/03/15", "2025-03-15"],
    ["15 Mar 2025", "2025-03-15"],
    ["15th March, 2025", "2025-03-15"],
    ["15-Mar-25", "2025-03-15"],
    ["March 15, 2025", "2025-03-15"],
    ["Mon, 6 Jan 2026", "2026-01-06"],
    ["17/12/2024 14:32", "2024-12-17"],
    ["20250315", "2025-03-15"],
    ["29/02/2024", "2024-02-29"],
  ])("%s is %s", (text, day) => {
    expect(normaliseDay(text)).toBe(day);
  });

  it.each([
    ["31/02/2025", "no 31 February"],
    ["29/02/2025", "2025 is not a leap year"],
    ["12/31/2025", "a date that only reads month first is a person's"],
    ["32.01.2025", "no 32nd"],
    ["15 Smarch 2025", "no such month"],
    ["next Tuesday", "not a date"],
    ["15/03/1999", "outside the years this reads"],
    ["", "nothing"],
  ])("%s is refused (%s)", (text) => {
    expect(normaliseDay(text)).toBeNull();
  });

  it("reads a service month as its first and last day, for the cut-off check", () => {
    expect(normaliseMonth("December 2025")).toEqual({ first: "2025-12-01", last: "2025-12-31" });
    expect(normaliseMonth("Feb-24")).toEqual({ first: "2024-02-01", last: "2024-02-29" });
    expect(normaliseMonth("11/2025")).toEqual({ first: "2025-11-01", last: "2025-11-30" });
    expect(normalisePeriodStart("December 2025")).toBe("2025-12-01");
    expect(normalisePeriodEnd("December 2025")).toBe("2025-12-31");
    expect(normalisePeriodEnd("15/12/2025")).toBe("2025-12-15");
    expect(normaliseMonth("13/2025")).toBeNull();
  });
});

describe("amounts, as decimal strings with the sign printed", () => {
  it.each([
    ["SGD 3,125.00", "3125.00"],
    ["S$1,234.50", "1234.50"],
    ["3,125", "3125"],
    ["281.25", "281.25"],
    ["(120.00)", "-120.00"],
    ["-3,488.00", "-3488.00"],
    ["3,488.00-", "-3488.00"],
    ["S$ -46.00", "-46.00"],
    ["-S$46.00", "-46.00"],
    ["USD 12,000.00", "12000.00"],
    ["1,234.50 SGD", "1234.50"],
    ["0.00", "0.00"],
    ["-0.00", "0.00"],
    ["−5.00", "-5.00"],
    ["1 234.50", "1234.50"],
  ])("%s is %s", (text, amount) => {
    expect(normaliseAmount(text)).toBe(amount);
  });

  it.each([
    ["1.234,50", "a European amount is never read as 1.234"],
    ["12,34.50", "the thousands are grouped wrongly"],
    ["1234.56789", "more than four decimal places"],
    ["abc", "letters"],
    ["1,234.50 CR", "a suffix this does not know"],
    ["", "nothing"],
    ["N/A", "not an amount"],
  ])("%s is refused (%s)", (text) => {
    expect(normaliseAmount(text)).toBeNull();
  });

  it("reads an exchange rate's right-hand side, positive, to ten places", () => {
    expect(normaliseRate("1.3456")).toBe("1.3456");
    expect(normaliseRate("1 USD = 1.3456 SGD")).toBe("1.3456");
    expect(normaliseRate("0")).toBeNull();
    expect(normaliseRate("-1.3")).toBeNull();
    expect(normaliseRate("1.12345678901")).toBeNull();
  });

  it("reads a GST rate as percent, and refuses a fraction", () => {
    expect(normalisePercent("9%")).toBe("9");
    expect(normalisePercent("GST @ 9.00%")).toBe("9");
    expect(normalisePercent("8 %")).toBe("8");
    expect(normalisePercent("7.50%")).toBe("7.5");
    expect(normalisePercent("0%")).toBe("0");
    expect(normalisePercent("0.09")).toBeNull();
    expect(normalisePercent("150%")).toBeNull();
    expect(normalisePercent("nine")).toBeNull();
  });

  it("upper-cases a currency and names a symbol only when it names one currency", () => {
    expect(normaliseCurrencyMark("sgd")).toBe("SGD");
    expect(normaliseCurrencyMark("S$")).toBe("SGD");
    expect(normaliseCurrencyMark("US$")).toBe("USD");
    expect(normaliseCurrencyMark("€")).toBe("EUR");
    expect(normaliseCurrencyMark("$")).toBeNull();
    expect(normaliseCurrencyMark("¥")).toBeNull();
    expect(normaliseCurrencyMark("dollars")).toBeNull();
  });

  it("takes a label off a number and keeps the number", () => {
    expect(normaliseRegistration("UEN: 201924289W")).toBe("201924289W");
    expect(normaliseRegistration("GST Reg No: 201620219H")).toBe("201620219H");
    expect(normaliseRegistration("m2-9588401-7")).toBe("M2-9588401-7");
    expect(normaliseReference("Tax Invoice No. B01653")).toBe("B01653");
    expect(normaliseReference("SI/25/2842")).toBe("SI/25/2842");
    expect(normaliseReference("NO123")).toBe("NO123");
    expect(normaliseReference("REF2025-01")).toBe("REF2025-01");
    expect(normaliseReference("Reference: INV-25-1006")).toBe("INV-25-1006");
  });
});

describe("null means not printed, and a person is shown what is not certain", () => {
  it("keeps a confident not_printed as a null nobody is asked about", () => {
    expect(judgeField("counterpartyGstNo", { value: null, status: "not_printed", confidence: 0.97 }, 0.9)).toEqual({
      value: null,
      uncertain: false,
    });
  });

  it("shows a person an unreadable field, however sure the model is that it is unreadable", () => {
    expect(judgeField("total", { value: null, status: "unreadable", confidence: 0.99 }, 0.9)).toEqual({
      value: null,
      uncertain: true,
    });
  });

  it("shows a not_printed the model is not sure of: it may be printed and missed", () => {
    expect(judgeField("counterpartyGstNo", { value: null, status: "not_printed", confidence: 0.6 }, 0.9)).toEqual({
      value: null,
      uncertain: true,
    });
  });

  it("is certain only STRICTLY above the bar, as T2.8 counts: 1.0 means never", () => {
    expect(judgeField("docNumber", printed("K03467", 0.9), 0.9).uncertain).toBe(true);
    expect(judgeField("docNumber", printed("K03467", 0.9001), 0.9).uncertain).toBe(false);
    expect(judgeField("docNumber", printed("K03467", 1), 1).uncertain).toBe(true);
  });

  it("turns a printed value the rule cannot read into null and a person's, never a guess", () => {
    expect(judgeField("docDate", printed("31/02/2025", 0.99), 0.9)).toEqual({ value: null, uncertain: true });
    expect(judgeField("total", printed("1.234,50", 0.99), 0.9)).toEqual({ value: null, uncertain: true });
  });
});

describe("a reading becomes one document line", () => {
  it("reads a supplier's tax invoice charging GST at 8% (A-X01) as printed, rate and all", () => {
    const result = toReadDraft(
      reading("purchase_invoice", {
        counterpartyName: printed("Singa Mobile and Fibre Pte Ltd"),
        counterpartyUen: printed("UEN: 201811234K"),
        counterpartyGstNo: printed("GST Reg No: 201811234K"),
        docNumber: printed("K03467"),
        docDate: printed("21 Apr 2025"),
        currency: printed("SGD"),
        net: printed("SGD 575.00"),
        gstRate: printed("8%"),
        gst: printed("46.00"),
        total: printed("SGD 621.00"),
      }),
      ctx,
    );
    expect(result.kind).toBe("document");
    if (result.kind !== "document") return;
    expect(result.draft).toMatchObject({
      docKind: "purchase_invoice",
      reader: "vision",
      control: null,
      model: "claude-sonnet-5-5",
      promptVersion: "fin-doc@1",
      formatId: null,
      confidence: 0.95,
    });
    expect(lineOf(result)).toEqual({
      kind: "document",
      docType: "purchase_invoice",
      counterpartyName: "Singa Mobile and Fibre Pte Ltd",
      counterpartyUen: "201811234K",
      counterpartyGstNo: "201811234K",
      docNumber: "K03467",
      docDate: "2025-04-21",
      currency: "SGD",
      fxRate: null,
      net: "575.00",
      gstRate: "8",
      gst: "46.00",
      total: "621.00",
      servicePeriodFrom: null,
      servicePeriodTo: null,
      creditNoteRef: null,
      provenance: ctx.provenance,
      uncertain: [],
    });
  });

  it("keeps a supplier GST number that is not printed (A-X02) as a null that MEANS not printed", () => {
    const line = lineOf(
      toReadDraft(
        reading("purchase_invoice", {
          counterpartyName: printed("FreshPantry Supplies Pte Ltd"),
          docNumber: printed("SI/25/2842"),
          gst: printed("71.28"),
          total: printed("863.28"),
          counterpartyGstNo: { value: null, status: "not_printed", confidence: 0.96 },
        }),
        ctx,
      ),
    );
    expect(line.counterpartyGstNo).toBeNull();
    expect(line.uncertain).not.toContain("counterpartyGstNo");
  });

  it("reads the totals a phone photo cut off as unreadable: null and shown, never the right answer guessed", () => {
    // IMG_20250620_084323.jpg: the photo stops at "SGD 3,12" and the totals are
    // outside it. The answer key knows 3,406.25; the reader must not.
    const line = lineOf(
      toReadDraft(
        reading("purchase_invoice", {
          counterpartyName: printed("Shield Mutual Insurance Pte Ltd"),
          counterpartyUen: printed("201924289W"),
          counterpartyGstNo: printed("201620219H"),
          docNumber: printed("B01653"),
          docDate: printed("20.06.2025"),
          currency: printed("SGD", 0.93),
          net: { value: null, status: "unreadable", confidence: 0.9 },
          gstRate: { value: null, status: "unreadable", confidence: 0.85 },
          gst: { value: null, status: "unreadable", confidence: 0.92 },
          total: { value: null, status: "unreadable", confidence: 0.95 },
        }),
        ctx,
      ),
    );
    expect(line).toMatchObject({ docDate: "2025-06-20", net: null, gst: null, total: null, gstRate: null });
    expect(line.uncertain).toEqual(["net", "gstRate", "gst", "total"]);
  });

  it("dates a December service billed in January (A-X08) to the whole of December", () => {
    const line = lineOf(
      toReadDraft(
        reading("purchase_invoice", {
          docNumber: printed("K03599"),
          docDate: printed("06/01/2026"),
          servicePeriodFrom: printed("December 2025"),
          servicePeriodTo: printed("December 2025"),
        }),
        ctx,
      ),
    );
    expect(line).toMatchObject({ docDate: "2026-01-06", servicePeriodFrom: "2025-12-01", servicePeriodTo: "2025-12-31" });
  });

  it("reads a sales credit note (A-X04) with the invoice it credits", () => {
    const line = lineOf(
      toReadDraft(
        reading("credit_note", {
          counterpartyName: printed("Orchid Healthcare Services Pte Ltd"),
          docNumber: printed("CN-25-0002"),
          creditNoteRef: printed("Ref: INV-25-1006", 0.95),
          total: printed("(3,488.00)"),
        }),
        ctx,
      ),
    );
    expect(line).toMatchObject({ docType: "credit_note", total: "-3488.00", creditNoteRef: "INV-25-1006" });
  });

  it("marks the classification uncertain, and takes the lower of the two confidences", () => {
    const result = toReadDraft(
      reading("receipt", { total: printed("24.72") }, { docTypeConfidence: 0.7, overallConfidence: 0.88 }),
      ctx,
    );
    expect(lineOf(result).uncertain).toContain("docType");
    expect(result.kind === "document" ? result.draft.confidence : null).toBe(0.7);
  });

  it("puts the image's provenance on the line: no page for a photo", () => {
    const line = lineOf(
      toReadDraft(reading("receipt"), { ...ctx, provenance: { documentVersionId: "v", page: null, row: null } }),
    );
    expect(line.provenance).toEqual({ documentVersionId: "v", page: null, row: null });
  });

  it.each(["bank_statement", "card_statement", "payroll", "bundle", "not_books"] as const)(
    "does not read a %s: it says what it is and makes no line",
    (docClass) => {
      expect(toReadDraft(reading(docClass), ctx)).toEqual({ kind: "not_a_document", docClass });
    },
  );
});

describe("the budget unit", () => {
  it("weighs a call by Anthropic's price ratios, rounded up", () => {
    expect(TOKEN_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    expect(weighedTokens({ inputTokens: 4200, outputTokens: 900, cacheWriteTokens: 0, cacheReadTokens: 2600 })).toBe(
      4200 + 260 + 4500,
    );
    expect(weighedTokens({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 3, cacheReadTokens: 1 })).toBe(4);
  });
});
