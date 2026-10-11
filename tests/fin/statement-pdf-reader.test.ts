// The `pdf_text` reader (docs/FIN_BUILD_PLAN.md F2.9, F2.10) over the PDF port's
// fake: which answer it gives for each kind of file, and that it hands the
// read sweep a draft and never an exception for a client's bad file.
import { describe, expect, it } from "vitest";
import { PdfUnreadable } from "../../src/domain/fin/errors";
import type { PdfText, PdfTextItem } from "../../src/domain/fin/lines";
import type { ReadInput } from "../../src/usecase/fin/reading";
import { pdfStatementReader } from "../../src/usecase/fin/statement-pdf-reader";
import { FakePdfTextReader } from "../../src/testfakes/fin-readers";

function run(x: number, baseline: number, text: string, right = false): PdfTextItem {
  const width = text.length * 4;
  return { text, x: right ? x - width : x, y: baseline - 7.6, width, height: 7.6 };
}

const STATEMENT: PdfText = {
  hasTextLayer: true,
  pages: [
    {
      number: 1,
      width: 595,
      height: 842,
      items: [
        run(36, 42, "Merlion Bank"),
        run(464, 42, "Statement of Account"),
        run(345, 96, "Account No."),
        run(559, 96, "1742-180-967", true),
        run(345, 108, "Statement period"),
        run(559, 108, "01 Feb 2025 to 28 Feb 2025", true),
        run(345, 120, "Currency"),
        run(559, 120, "SGD", true),
        run(36, 156, "Date"),
        run(88, 156, "Description"),
        run(410, 156, "Withdrawals", true),
        run(480, 156, "Deposits", true),
        run(559, 156, "Balance", true),
        run(88, 172, "Balance Brought Forward"),
        run(559, 172, "1,000.00", true),
        run(36, 185, "03 Feb"),
        run(88, 185, "ACCOUNT SERVICE FEE"),
        run(410, 185, "15.00", true),
        run(559, 185, "985.00", true),
      ],
    },
  ],
};

const INVOICE: PdfText = {
  hasTextLayer: true,
  pages: [{ number: 1, width: 595, height: 842, items: [run(36, 42, "TAX INVOICE"), run(36, 60, "Invoice No: INV-25-1001 for services rendered in February")] }],
};

const UNKNOWN_TABLE: PdfText = {
  hasTextLayer: true,
  pages: [{ number: 1, width: 595, height: 842, items: [run(36, 42, "Merlion Bank"), run(464, 42, "Statement of Account"), run(36, 156, "Datum"), run(88, 156, "Saldo")] }],
};

function input(bytes: string, over: Partial<ReadInput> = {}): ReadInput {
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    intakeItemId: "00000000-0000-4000-8000-000000000002",
    documentVersionId: "00000000-0000-4000-8000-000000000003",
    clientPartyId: "00000000-0000-4000-8000-0000000000c1",
    route: "pdf",
    mediaType: "application/pdf",
    filename: "statement.pdf",
    bytes: new TextEncoder().encode(bytes),
    ...over,
  };
}

function reader(): { pdf: FakePdfTextReader; read: ReturnType<typeof pdfStatementReader> } {
  const pdf = new FakePdfTextReader();
  pdf.set("statement", STATEMENT);
  pdf.set("invoice", INVOICE);
  pdf.set("unknown-table", UNKNOWN_TABLE);
  pdf.set("scan", { hasTextLayer: false, pages: [{ number: 1, width: 595, height: 842, items: [] }] });
  pdf.set("locked", new PdfUnreadable("encrypted", "PasswordException"));
  pdf.set("broken", new PdfUnreadable("damaged", "Invalid PDF structure"));
  pdf.set("huge", new PdfUnreadable("too_large", "900 pages"));
  return { pdf, read: pdfStatementReader(pdf) };
}

describe("the pdf_text statement reader", () => {
  it("is named pdf_text", () => {
    expect(reader().read.name).toBe("pdf_text");
  });

  it("reads a statement into a draft carrying the version it read", async () => {
    const outcome = await reader().read.read(input("statement"));
    expect(outcome.kind).toBe("read");
    if (outcome.kind !== "read") return;
    expect(outcome.draft.docKind).toBe("bank_statement");
    expect(outcome.draft.control).toEqual({ opening: "1000.00", closing: "985.00", lineCount: null, declaredTotal: null });
    expect(outcome.draft.lines).toHaveLength(1);
    expect(outcome.draft.lines[0]?.provenance).toEqual({
      documentVersionId: "00000000-0000-4000-8000-000000000003",
      page: 1,
      row: null,
    });
  });

  it("leaves an invoice and a scan to the next reader", async () => {
    const { read } = reader();
    expect(await read.read(input("invoice"))).toEqual({ kind: "not_mine" });
    expect(await read.read(input("scan"))).toEqual({ kind: "not_mine" });
  });

  it("does not open a file routed anywhere but pdf", async () => {
    const { pdf, read } = reader();
    expect(await read.read(input("statement", { route: "image" }))).toEqual({ kind: "not_mine" });
    expect(pdf.calls).toBe(0);
  });

  it("sends a statement it cannot read to a person, as an unrecognised layout", async () => {
    expect(await reader().read.read(input("unknown-table"))).toEqual({
      kind: "needs_person",
      reader: "pdf_text",
      problem: "unrecognised_layout",
    });
  });

  it.each([
    ["locked", "encrypted"],
    ["broken", "unreadable"],
    ["huge", "too_large"],
  ] as const)("a PDF nobody can open (%s) goes to a person as %s, never as an exception", async (bytes, problem) => {
    expect(await reader().read.read(input(bytes))).toEqual({ kind: "needs_person", reader: "pdf_text", problem });
  });

  it("lets a fault that is not the file's escape, so the sweep reports it and retries", async () => {
    const read = pdfStatementReader({ read: () => Promise.reject(new Error("out of memory")) });
    await expect(read.read(input("statement"))).rejects.toThrow("out of memory");
  });
});
