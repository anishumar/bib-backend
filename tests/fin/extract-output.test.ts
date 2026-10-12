// Is the model's answer a reading at all? (F2.4, usecase/fin/extract-output.ts)
// Strict tool use guarantees the shape; this holds what strict mode cannot say:
// confidences from 0 to 1, a value exactly when the status is `read`, and
// nothing extra.
import { describe, expect, it } from "vitest";
import { READ_FIELDS } from "../../src/domain/fin/extraction";
import { parseDocumentReading } from "../../src/usecase/fin/extract-output";
import { printed, reading } from "../../src/testfakes/fin-extract";

/** A reading as the model sends it: plain JSON, cloned so a test may break it. */
function good(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      reading("purchase_invoice", {
        counterpartyName: printed("Kavya Tech Pte Ltd"),
        docNumber: printed("INV2500233"),
        total: printed("SGD 1,090.00"),
      }),
    ),
  ) as Record<string, unknown>;
}

function fields(o: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return o.fields as Record<string, Record<string, unknown>>;
}

function problems(output: unknown): readonly string[] {
  const parsed = parseDocumentReading(output);
  if (parsed.ok) throw new Error("expected it to be refused");
  return parsed.problems;
}

describe("the reading validator", () => {
  it("accepts a complete reading and hands it back typed", () => {
    const parsed = parseDocumentReading(good());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.reading.docType).toBe("purchase_invoice");
    expect(parsed.reading.fields.total).toEqual({ value: "SGD 1,090.00", status: "read", confidence: 0.98 });
    expect(Object.keys(parsed.reading.fields).sort()).toEqual([...READ_FIELDS].sort());
  });

  it("refuses a reading with a field missing, and names it", () => {
    const o = good();
    delete fields(o).gst;
    expect(problems(o)).toEqual(["fields.gst: Required"]);
  });

  it("refuses a missing classification and a missing overall confidence", () => {
    const o = good();
    delete o.docType;
    delete o.overallConfidence;
    expect(problems(o)).toEqual(["docType: Required", "overallConfidence: Required"]);
  });

  it("refuses wrong types: a number for a value, a string for a confidence", () => {
    const o = good();
    fields(o).total = { value: 1090, status: "read", confidence: 0.9 };
    o.docTypeConfidence = "high";
    const found = problems(o);
    expect(found).toContain("docTypeConfidence: Expected number, received string");
    expect(found).toContain("fields.total.value: Expected string, received number");
  });

  it("refuses a confidence outside 0..1, which strict mode cannot", () => {
    const o = good();
    fields(o).docNumber = { value: "INV2500233", status: "read", confidence: 1.7 };
    o.overallConfidence = -0.1;
    expect(problems(o)).toEqual([
      "fields.docNumber.confidence: must be at most 1",
      "overallConfidence: must be at least 0",
    ]);
  });

  it("refuses a value with no status to stand behind it, either way round", () => {
    const o = good();
    fields(o).counterpartyGstNo = { value: "M2-9588401-7", status: "not_printed", confidence: 0.9 };
    fields(o).docDate = { value: null, status: "read", confidence: 0.9 };
    fields(o).currency = { value: "   ", status: "read", confidence: 0.9 };
    expect(problems(o)).toEqual([
      "fields.counterpartyGstNo: status is not_printed, so value must be null",
      "fields.docDate: status is read, so value must be the text as printed",
      "fields.currency: status is read, so value must be the text as printed",
    ]);
  });

  it("refuses a class or a status nobody defined, and a field nobody asked for", () => {
    const o = good();
    o.docType = "invoice";
    fields(o).net = { value: null, status: "blurry", confidence: 0.4 };
    fields(o).iban = { value: null, status: "not_printed", confidence: 0.9 };
    const found = problems(o);
    expect(found.some((p) => p.startsWith("docType: Invalid enum value"))).toBe(true);
    expect(found.some((p) => p.startsWith("fields.net.status: Invalid enum value"))).toBe(true);
    expect(found).toContain("fields: Unrecognized key(s) in object: 'iban'");
  });

  it("refuses what is not an object at all, in one sentence", () => {
    expect(problems("here is the invoice")).toEqual(["the input: Expected object, received string"]);
    expect(problems(null)).toEqual(["the input: Expected object, received null"]);
  });

  it("sends back at most twelve short problems", () => {
    const o = good();
    for (const f of READ_FIELDS) fields(o)[f] = { value: 1, status: "x", confidence: 5 };
    const found = problems(o);
    expect(found.length).toBe(12);
    for (const p of found) expect(p.length).toBeLessThanOrEqual(200);
  });

  it("never repeats a value from the document in a problem", () => {
    const o = good();
    fields(o).total = { value: "SGD 1,090.00", status: "not_printed", confidence: 0.9 };
    expect(problems(o).join(" ")).not.toContain("1,090");
  });
});
