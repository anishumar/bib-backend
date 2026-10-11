// What a reader makes of one file: the standard line (docs/FIN_BUILD_PLAN.md
// F2.5) in its three shapes, and the read that carries them.
//
// Pure, and the CONTRACT the readers are built against: the sheet reader, the
// PDF statement reader and the AI document reader each produce a `ReadDraft`,
// and the read sweep stores every one the same way (`fin.read`,
// `fin.transaction_line`). A field a reader cannot see is null, never a guess.
//
// ── MONEY IS A DECIMAL STRING ────────────────────────────────────────────────
//
// As everywhere in this product (CLAUDE.md, "Domain non-negotiables"): an
// amount is "1499.50", never a JS number, and only the database adds them up.
// A statement line is SIGNED: money IN is positive, money OUT negative, in the
// statement's own currency. A document line keeps the signs it prints (a credit
// note's total is negative only when the document prints it so).
//
// ── NOTHING HERE COUNTS UNTIL A PERSON COMMITS ───────────────────────────────
//
// A draft is what a machine READ. It becomes books only through staging (F2.8),
// where a person commits it; the proposed values are kept beside what the
// person applied, for ever (ground rule 2).

/** What kind of file a read found. Decided by the reader, from the content. */
export type DocKind =
  | "purchase_invoice"
  | "sales_invoice"
  | "credit_note"
  | "receipt"
  | "customs_permit"
  | "pos_summary"
  | "bank_statement"
  | "card_statement"
  | "payroll"
  | "cpf_submission"
  | "master"
  | "unknown";

export const DOC_KINDS: readonly DocKind[] = [
  "purchase_invoice",
  "sales_invoice",
  "credit_note",
  "receipt",
  "customs_permit",
  "pos_summary",
  "bank_statement",
  "card_statement",
  "payroll",
  "cpf_submission",
  "master",
  "unknown",
];

/** Which reader produced a read. `vision` is the AI reader (F2.4); the other
 *  two are deterministic code. */
export type Reader = "sheet" | "pdf_text" | "vision";

export const READERS: readonly Reader[] = ["sheet", "pdf_text", "vision"];

export type LineKind = "document" | "statement" | "payroll";

/** `YYYY-MM-DD`. A calendar day, never an instant. */
export type Day = string;

/** A decimal string that may be negative ("-120.00"). */
export type SignedDecimal = string;

/** Where a line came from, so every line links back to its file. */
export interface Provenance {
  readonly documentVersionId: string;
  /** 1-based page of a PDF; null for a sheet. */
  readonly page: number | null;
  /** 1-based row of a sheet (the grid row the values were read from); null
   *  for a PDF. */
  readonly row: number | null;
}

/** One document: an invoice, a receipt, a credit note, a customs permit or
 *  one day's POS summary. One line per document, not per item on it. */
export interface DocumentLineDraft {
  readonly kind: "document";
  readonly docType: Extract<
    DocKind,
    "purchase_invoice" | "sales_invoice" | "credit_note" | "receipt" | "customs_permit" | "pos_summary"
  >;
  readonly counterpartyName: string | null;
  /** Singapore UEN as printed. */
  readonly counterpartyUen: string | null;
  /** The supplier's GST registration number as printed. Its ABSENCE on an
   *  invoice that charges GST is a finding (F4.3), so null must mean "not
   *  printed", never "not read". A reader that could not tell says so in
   *  `uncertain`. */
  readonly counterpartyGstNo: string | null;
  readonly docNumber: string | null;
  readonly docDate: Day | null;
  /** ISO 4217, as printed; null when the document does not say. */
  readonly currency: string | null;
  /** The rate to the client's base currency when the document prints one. */
  readonly fxRate: string | null;
  readonly net: SignedDecimal | null;
  /** The GST rate as printed, in percent ("9"), when printed. */
  readonly gstRate: string | null;
  readonly gst: SignedDecimal | null;
  readonly total: SignedDecimal | null;
  readonly servicePeriodFrom: Day | null;
  readonly servicePeriodTo: Day | null;
  /** On a credit note: the number of the invoice it credits. */
  readonly creditNoteRef: string | null;
  readonly provenance: Provenance;
  /** Field names the reader was not sure of. Empty from a deterministic
   *  reader. Staging (F2.8) shows exactly these to a person. */
  readonly uncertain: readonly (keyof DocumentFields)[];
}

/** The value fields of a document line, for `uncertain`. */
export type DocumentFields = Omit<DocumentLineDraft, "kind" | "provenance" | "uncertain">;

/** One transaction on a bank or card statement. */
export interface StatementLineDraft {
  readonly kind: "statement";
  readonly statementType: "bank" | "card";
  /** The account or card as printed, usually the last four digits. */
  readonly accountRef: string | null;
  readonly txnDate: Day;
  readonly valueDate: Day | null;
  readonly narration: string;
  readonly reference: string | null;
  /** IN positive, OUT negative, in `currency`. */
  readonly amount: SignedDecimal;
  readonly currency: string;
  /** The running balance printed after this line, when printed. */
  readonly balance: SignedDecimal | null;
  /** A card line spent in another currency: what was charged there. */
  readonly originalCurrency: string | null;
  readonly originalAmount: SignedDecimal | null;
  readonly provenance: Provenance;
  readonly uncertain: readonly (keyof StatementFields)[];
}

export type StatementFields = Omit<StatementLineDraft, "kind" | "provenance" | "uncertain">;

/** Singapore work pass types, as payroll sheets name them. */
export type PassType = "citizen" | "pr" | "employment_pass" | "s_pass" | "work_permit";

/** One employee for one month, from a payroll sheet or a CPF submission. */
export interface PayrollLineDraft {
  readonly kind: "payroll";
  /** `YYYY-MM`, the month paid. */
  readonly period: string;
  /** The employee's id as the sheet prints it. Never an NRIC/FIN: a reader
   *  that sees one keeps only the last four characters. */
  readonly employeeRef: string;
  readonly employeeName: string | null;
  readonly passType: PassType | null;
  /** Age in whole years in `period`, when the sheet gives it or a birth date. */
  readonly age: number | null;
  readonly ordinaryWage: SignedDecimal | null;
  readonly additionalWage: SignedDecimal | null;
  readonly grossPay: SignedDecimal | null;
  readonly cpfEmployee: SignedDecimal | null;
  readonly cpfEmployer: SignedDecimal | null;
  /** Skills Development Levy. */
  readonly sdl: SignedDecimal | null;
  /** Foreign Worker Levy. */
  readonly fwl: SignedDecimal | null;
  readonly netPay: SignedDecimal | null;
  readonly provenance: Provenance;
  readonly uncertain: readonly (keyof PayrollFields)[];
}

export type PayrollFields = Omit<PayrollLineDraft, "kind" | "provenance" | "uncertain">;

export type LineDraft = DocumentLineDraft | StatementLineDraft | PayrollLineDraft;

/**
 * The figures a file states about itself, to check the lines against (F2.6,
 * F2.9). Each is what the FILE prints, null when it prints nothing; the read
 * sweep compares them with the lines and never invents one.
 */
export interface ReadControl {
  readonly opening: SignedDecimal | null;
  readonly closing: SignedDecimal | null;
  readonly lineCount: number | null;
  /** A total the file prints for its lines (a payroll sheet's total row, a
   *  POS day's total). */
  readonly declaredTotal: SignedDecimal | null;
}

/** Everything one reader made of one file. */
export interface ReadDraft {
  readonly docKind: DocKind;
  readonly reader: Reader;
  readonly lines: readonly LineDraft[];
  readonly control: ReadControl | null;
  /** 0..1 for the AI reader; null for a deterministic one. */
  readonly confidence: number | null;
  /** The AI reader's provenance (ground rule: "extraction got worse in March"
   *  needs something to blame). Both or neither; null for code. */
  readonly model: string | null;
  readonly promptVersion: string | null;
  /** The source layout a sheet was read with (`fin.source_format`), when one. */
  readonly formatId: string | null;
}

/** Why a file went to a person instead of to staging. Codes, not sentences:
 *  the screen writes the words. */
export type ReadProblem =
  | "no_reader"
  | "unrecognised_layout"
  | "control_mismatch"
  | "unreadable"
  | "encrypted"
  | "too_large"
  | "ai_unavailable"
  | "ai_invalid_output"
  | "ai_budget_reached";

export const READ_PROBLEMS: readonly ReadProblem[] = [
  "no_reader",
  "unrecognised_layout",
  "control_mismatch",
  "unreadable",
  "encrypted",
  "too_large",
  "ai_unavailable",
  "ai_invalid_output",
  "ai_budget_reached",
];

// ── PDF text, as a reader sees it ────────────────────────────────────────────
//
// What the PDF text port (F2.3) returns: every text run with its position, so a
// statement parser can find columns. Coordinates are PDF points from the page's
// TOP-left (y grows downward), whatever the library's own convention.

export interface PdfTextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfTextPage {
  /** 1-based. */
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly items: readonly PdfTextItem[];
}

export interface PdfText {
  readonly pages: readonly PdfTextPage[];
  /** False for a scan: no text layer worth reading, so it goes to the AI
   *  reader (or a person). */
  readonly hasTextLayer: boolean;
}
