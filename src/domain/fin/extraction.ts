// The AI document reader's contract with the model, and what becomes of its
// answer (docs/FIN_BUILD_PLAN.md F2.4). Pure.
//
// ── THE MODEL READS; CODE DECIDES ────────────────────────────────────────────
//
// Ground rule 1. The model is asked one thing: what does this document PRINT.
// It transcribes every value as printed ("20.06.2025", "SGD 3,125.00") and says,
// field by field, how sure it is. Everything after that is this file and
// `extraction-normalise.ts`: the day, the decimal string, the currency code,
// which fields a person must look at, and whether the file is a document this
// reader turns into a line at all. A rule can be tested; a model can only be
// measured, which is what the scorecard (S.2) does.
//
// ── NULL MEANS NOT PRINTED, AND THE MODEL HAS TO SAY WHICH ───────────────────
//
// `lines.ts` makes null mean "not printed", never "not read", because the
// ABSENCE of a supplier's GST number on an invoice that charges GST is a
// finding (F4.3): an invalid tax invoice whose GST may not be claimed. So the
// model never answers with a bare null. Every field carries a STATUS:
//
//   read          printed, and this is what it says;
//   not_printed   the document does not show it anywhere;
//   unreadable    it is or may be there, but cut off, blurred, covered or
//                 outside the photo.
//
// `unreadable` becomes null AND an entry in `uncertain`, so staging (F2.8)
// shows it to a person; `not_printed` becomes a null nobody is asked about only
// when the model is sure (`>` the bar, as T2.8 counts: 1.0 means never).
//
// ── ONE FILE, ONE DOCUMENT, ONE LINE ─────────────────────────────────────────
//
// An invoice, a receipt, a credit note, a customs permit or a day's POS summary
// is one `DocumentLineDraft`. A bank or card statement, payroll, a bundle of
// several documents, or a file that is not for the books at all is classified
// and NOT read: this reader answers `not_mine` for it, and with no reader after
// it the read sweep puts it on a person's desk as `no_reader` (F2 contract).
import type {
  DocumentFields,
  DocumentLineDraft,
  Provenance,
  ReadDraft,
} from "./lines";
import {
  normaliseAmount,
  normaliseCurrencyMark,
  normaliseDay,
  normaliseName,
  normalisePercent,
  normalisePeriodEnd,
  normalisePeriodStart,
  normaliseRate,
  normaliseReference,
  normaliseRegistration,
} from "./extraction-normalise";

/** The one tool the model is given. */
export const DOCUMENT_TOOL_NAME = "record_document";

/** What the model may say a file is. The first six are the document line's own
 *  kinds; the rest are what this reader does not read. */
export const DOC_CLASSES = [
  "purchase_invoice",
  "sales_invoice",
  "credit_note",
  "receipt",
  "customs_permit",
  "pos_summary",
  "bank_statement",
  "card_statement",
  "payroll",
  "bundle",
  "not_books",
] as const;

export type DocClass = (typeof DOC_CLASSES)[number];

/** The classes that become a document line. */
export type DocumentClass = DocumentLineDraft["docType"];

const DOCUMENT_CLASSES: ReadonlySet<DocClass> = new Set<DocumentClass>([
  "purchase_invoice",
  "sales_invoice",
  "credit_note",
  "receipt",
  "customs_permit",
  "pos_summary",
]);

export function isDocumentClass(c: DocClass): c is DocumentClass {
  return DOCUMENT_CLASSES.has(c);
}

export const FIELD_STATUSES = ["read", "not_printed", "unreadable"] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** The value fields the model reads: the document line's, without `docType`
 *  (classified on its own) and without provenance (ours, not the model's). */
export type ReadField = Exclude<keyof DocumentFields, "docType">;

type FieldShape =
  | "name"
  | "registration"
  | "reference"
  | "day"
  | "period_start"
  | "period_end"
  | "currency"
  | "rate"
  | "amount"
  | "percent";

interface FieldSpec {
  readonly shape: FieldShape;
  /** What the model is told about this field, in the tool's own schema. */
  readonly help: string;
}

/**
 * Every field, how it is normalised, and what the model is told about it. A
 * Record, so a field added to `DocumentLineDraft` is a compile error here until
 * somebody decides how it is read.
 */
const FIELD_SPECS: Readonly<Record<ReadField, FieldSpec>> = {
  counterpartyName: {
    shape: "name",
    help:
      "The OTHER party's name as printed: the supplier for a purchase invoice, receipt or customs " +
      "permit; the customer for a sales invoice; on a credit note, whichever party is not the books " +
      "owner. Never the books owner itself.",
  },
  counterpartyUen: {
    shape: "registration",
    help: "The other party's UEN (company registration number) as printed. Not the books owner's.",
  },
  counterpartyGstNo: {
    shape: "registration",
    help:
      "The other party's GST registration number as printed. Not the books owner's. If the document " +
      "shows no GST registration number for that party, status is not_printed: its absence matters.",
  },
  docNumber: {
    shape: "reference",
    help: "The document's own number (invoice, receipt, credit note or permit number) as printed.",
  },
  docDate: {
    shape: "day",
    help: "The document's date (invoice date, receipt date) exactly as printed, e.g. \"20.06.2025\".",
  },
  currency: {
    shape: "currency",
    help: "The currency of the amounts as printed: a code (\"SGD\") or a symbol (\"S$\", \"US$\").",
  },
  fxRate: {
    shape: "rate",
    help: "An exchange rate to SGD only if the document itself prints one; otherwise not_printed.",
  },
  net: {
    shape: "amount",
    help:
      "The subtotal before GST (and before any service charge) exactly as printed, sign included. " +
      "not_printed if the document prints no subtotal.",
  },
  gstRate: {
    shape: "percent",
    help: "The GST rate as printed, e.g. \"9%\". not_printed if no rate is shown, even when GST is charged.",
  },
  gst: {
    shape: "amount",
    help: "The GST amount exactly as printed. not_printed if the document shows no GST amount.",
  },
  total: {
    shape: "amount",
    help: "The total payable (including GST) exactly as printed, sign included.",
  },
  servicePeriodFrom: {
    shape: "period_start",
    help:
      "The first day of the period the goods or services are for, only if the document states a " +
      "period: a day as printed, or a month (\"December 2025\") when it names only a month.",
  },
  servicePeriodTo: {
    shape: "period_end",
    help:
      "The last day of that period: a day as printed, or the month (\"December 2025\") when it names " +
      "only a month.",
  },
  creditNoteRef: {
    shape: "reference",
    help: "On a credit note, the number of the invoice it credits, as printed. not_printed otherwise.",
  },
};

export const READ_FIELDS: readonly ReadField[] = Object.keys(FIELD_SPECS) as ReadField[];

/** One field, as the model reported it (after validation). */
export interface FieldReading {
  readonly value: string | null;
  readonly status: FieldStatus;
  /** 0..1. */
  readonly confidence: number;
}

/** The whole answer, validated (`usecase/fin/extract-output.ts`). */
export interface DocumentReading {
  readonly docType: DocClass;
  readonly docTypeConfidence: number;
  readonly fields: Readonly<Record<ReadField, FieldReading>>;
  readonly overallConfidence: number;
}

// ── The tool's JSON schema ───────────────────────────────────────────────────
//
// Written for STRICT tool use, so the provider guarantees the shape: every
// object closed (`additionalProperties: false`), every property required, and no
// numeric or length bounds (strict mode does not take them; the validator
// checks 0..1 instead). Nullable is `anyOf` with null, the form strict mode
// documents.

/** The schema as plain data; the adapter hands it to the SDK unchanged. */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

function fieldSchema(help: string): Record<string, unknown> {
  return {
    type: "object",
    description: help,
    properties: {
      value: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Exactly as printed. null unless status is read.",
      },
      status: { type: "string", enum: [...FIELD_STATUSES] },
      confidence: {
        type: "number",
        description: "From 0 to 1: how sure you are that the value and the status are right.",
      },
    },
    required: ["value", "status", "confidence"],
    additionalProperties: false,
  };
}

export function documentToolSchema(): ToolInputSchema {
  return {
    type: "object",
    properties: {
      docType: {
        type: "string",
        enum: [...DOC_CLASSES],
        description:
          "What this file is, from the books owner's side. bundle: several separate documents in one " +
          "file. not_books: anything that is not a document for the books (a quotation, a contract, a " +
          "letter, a delivery order, a photo with no document).",
      },
      docTypeConfidence: { type: "number", description: "From 0 to 1: how sure you are of docType." },
      fields: {
        type: "object",
        properties: Object.fromEntries(READ_FIELDS.map((f) => [f, fieldSchema(FIELD_SPECS[f].help)])),
        required: [...READ_FIELDS],
        additionalProperties: false,
      },
      overallConfidence: {
        type: "number",
        description: "From 0 to 1: how sure you are that this whole reading is right.",
      },
    },
    required: ["docType", "docTypeConfidence", "fields", "overallConfidence"],
    additionalProperties: false,
  };
}

export const DOCUMENT_TOOL_DESCRIPTION =
  "Record what one document prints, field by field, with how sure you are of each. Call it exactly " +
  "once for the file.";

// ── From the reading to the draft ────────────────────────────────────────────

/** A field is CERTAIN only when its confidence is strictly above this. Not the
 *  staging bar (F2.8 takes that from `confidence_tier`): this only decides which
 *  fields a person is shown, so it errs towards showing. */
export const FIELD_CERTAIN_ABOVE = 0.9;

export interface DraftContext {
  readonly provenance: Provenance;
  /** The model that ANSWERED (the provider's own report), and the prompt. */
  readonly model: string;
  readonly promptVersion: string;
  /** Strictly above this is certain; at or below it, the field is shown. */
  readonly certainAbove: number;
}

export type ReadingResult =
  | { readonly kind: "document"; readonly draft: ReadDraft }
  | { readonly kind: "not_a_document"; readonly docClass: Exclude<DocClass, DocumentClass> };

function normalise(shape: FieldShape, text: string): string | null {
  switch (shape) {
    case "name":
      return normaliseName(text);
    case "registration":
      return normaliseRegistration(text);
    case "reference":
      return normaliseReference(text);
    case "day":
      return normaliseDay(text);
    case "period_start":
      return normalisePeriodStart(text);
    case "period_end":
      return normalisePeriodEnd(text);
    case "currency":
      return normaliseCurrencyMark(text);
    case "rate":
      return normaliseRate(text);
    case "amount":
      return normaliseAmount(text);
    case "percent":
      return normalisePercent(text);
  }
}

/** One field's stored value and whether a person must look at it. */
export function judgeField(
  field: ReadField,
  reading: FieldReading,
  certainAbove: number,
): { readonly value: string | null; readonly uncertain: boolean } {
  const sure = reading.confidence > certainAbove;
  if (reading.status !== "read" || reading.value === null) {
    // not_printed: null, and certain only when the model is sure it looked.
    // unreadable: null, and always a person's.
    return { value: null, uncertain: reading.status === "unreadable" || !sure };
  }
  const value = normalise(FIELD_SPECS[field].shape, reading.value);
  // Printed but unreadable by the rule: a person reads it, never a guess.
  return { value, uncertain: value === null || !sure };
}

/**
 * The reader's draft for a validated reading, or the class it does not read.
 * The overall confidence is the LOWER of the model's two (the reading's and the
 * classification's): a perfect reading of the wrong kind of document is not a
 * reading anybody should trust.
 */
export function toReadDraft(reading: DocumentReading, ctx: DraftContext): ReadingResult {
  const docType = reading.docType;
  if (!isDocumentClass(docType)) return { kind: "not_a_document", docClass: docType };

  const values = {} as Record<ReadField, string | null>;
  const uncertain: (keyof DocumentFields)[] = [];
  if (!(reading.docTypeConfidence > ctx.certainAbove)) uncertain.push("docType");
  for (const field of READ_FIELDS) {
    const judged = judgeField(field, reading.fields[field], ctx.certainAbove);
    values[field] = judged.value;
    if (judged.uncertain) uncertain.push(field);
  }

  const line: DocumentLineDraft = {
    kind: "document",
    docType,
    counterpartyName: values.counterpartyName,
    counterpartyUen: values.counterpartyUen,
    counterpartyGstNo: values.counterpartyGstNo,
    docNumber: values.docNumber,
    docDate: values.docDate,
    currency: values.currency,
    fxRate: values.fxRate,
    net: values.net,
    gstRate: values.gstRate,
    gst: values.gst,
    total: values.total,
    servicePeriodFrom: values.servicePeriodFrom,
    servicePeriodTo: values.servicePeriodTo,
    creditNoteRef: values.creditNoteRef,
    provenance: ctx.provenance,
    uncertain,
  };

  return {
    kind: "document",
    draft: {
      docKind: docType,
      reader: "vision",
      lines: [line],
      control: null,
      confidence: Math.min(reading.overallConfidence, reading.docTypeConfidence),
      model: ctx.model,
      promptVersion: ctx.promptVersion,
      formatId: null,
    },
  };
}
