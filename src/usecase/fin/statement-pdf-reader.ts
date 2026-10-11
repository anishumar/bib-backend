// The PDF statement reader (docs/FIN_BUILD_PLAN.md F2.9 PDF half, F2.10): a
// `DocumentReader` named `pdf_text` that reads a bank or card statement PDF
// with no AI, from the positions of its text.
//
// It is offered every intake item on the `pdf` route and answers:
//
//   read          a statement it read: the lines and the printed control figures
//   not_mine      no statement (an invoice, a receipt), or a scan with no text
//                 layer: the next reader (the AI reader) is offered it
//   needs_person  a statement it recognised and could not read
//                 (`unrecognised_layout`), or a PDF nobody can open:
//                 `encrypted`, `unreadable` (damaged) or `too_large`
//
// Deterministic code, so a read has no confidence, no model and no prompt
// version; the read sweep checks the control figures for every read, this
// one's included (`opening + Σ lines = closing`, holder-signed, see
// `domain/fin/statement-pdf.ts`).
import { PdfUnreadable } from "../../domain/fin/errors";
import type { ReadProblem } from "../../domain/fin/lines";
import { parseStatementPdf, statementReadDraft } from "../../domain/fin/statement-pdf";
import type { DocumentReader, PdfTextReader, ReadInput, ReadOutcome } from "./reading";

const PROBLEM: Readonly<Record<PdfUnreadable["reason"], ReadProblem>> = {
  damaged: "unreadable",
  encrypted: "encrypted",
  too_large: "too_large",
};

export function pdfStatementReader(pdf: PdfTextReader): DocumentReader {
  return {
    name: "pdf_text",
    async read(input: ReadInput): Promise<ReadOutcome> {
      if (input.route !== "pdf") return { kind: "not_mine" };
      let text;
      try {
        text = await pdf.read(input.bytes);
      } catch (err) {
        if (err instanceof PdfUnreadable) {
          return { kind: "needs_person", reader: "pdf_text", problem: PROBLEM[err.reason] };
        }
        throw err;
      }
      // A scan: no text to read positions from. The AI reader's.
      if (!text.hasTextLayer) return { kind: "not_mine" };
      const parsed = parseStatementPdf(text);
      switch (parsed.kind) {
        case "not_statement":
          return { kind: "not_mine" };
        case "unrecognised":
          return { kind: "needs_person", reader: "pdf_text", problem: "unrecognised_layout" };
        case "statement":
          return { kind: "read", draft: statementReadDraft(parsed.statement, input.documentVersionId) };
      }
    },
  };
}
