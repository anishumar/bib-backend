// The AI reader's seams (docs/FIN_BUILD_PLAN.md F2.4). Adapters live in
// `infrastructure/fin/` (`claude-extractor.ts`, `postgres-extraction.ts`); fakes
// in `testfakes/fin-extract.ts`. No vendor type crosses these: the SDK's
// messages, content blocks and error classes are translated at the adapter's
// door, and what comes back is plain data and our own codes.
import type { DocClass } from "../../domain/fin/extraction";
import type { TokenUsage, TransportFailure, UsageOutcome } from "../../domain/fin/extraction-usage";

/** What is sent: a PDF as it is (the provider reads its pages itself, text and
 *  image together), or an image already shrunk by the `ImageNormaliser`. */
export type ExtractionContent =
  | { readonly kind: "pdf"; readonly bytes: Uint8Array }
  | { readonly kind: "image"; readonly bytes: Uint8Array; readonly mediaType: "image/jpeg" | "image/png" };

/**
 * Whose books the file is for. The model needs it to tell a purchase invoice
 * (sent TO the owner) from a sales invoice (sent BY it), and to keep the owner's
 * own name, UEN and GST number, printed on every invoice it receives, out of
 * the counterparty fields.
 */
export interface BooksOwner {
  /** Every name the owner trades under (display, legal, trade), distinct. */
  readonly names: readonly string[];
  readonly uen: string | null;
  readonly gstNo: string | null;
}

export interface ExtractionRequest {
  readonly content: ExtractionContent;
  /** Null when the file was stored against no client. */
  readonly owner: BooksOwner | null;
  /** On the retry: what was wrong with the first answer, as short sentences
   *  (field paths and rules, never a value from the document). */
  readonly correction: readonly string[] | null;
}

/** How an answered call ended. */
export type AnswerStop = "tool_call" | "no_tool_call" | "truncated" | "refused";

export type ExtractionAttempt =
  | {
      readonly kind: "answered";
      /** The model that answered, as the provider reported it. */
      readonly model: string;
      readonly promptVersion: string;
      readonly requestId: string | null;
      readonly usage: TokenUsage;
      readonly stop: AnswerStop;
      /** The tool call's input, as plain JSON data; meaningful only when `stop`
       *  is `tool_call`. Unknown until `parseDocumentReading` says otherwise. */
      readonly output: unknown;
    }
  | {
      readonly kind: "failed";
      /** The model that was asked. */
      readonly model: string;
      readonly promptVersion: string;
      readonly requestId: string | null;
      readonly failure: TransportFailure;
    };

/**
 * The model behind the AI reader. It never throws for the provider's trouble:
 * a rate limit, an outage, a timeout or a refused key is a `failed` attempt
 * with our own code, so the reader's breaker can count it. It throws only for a
 * fault in this program.
 */
export interface DocumentExtractor {
  extract(request: ExtractionRequest): Promise<ExtractionAttempt>;
}

/** One call, as `fin.extraction_usage` keeps it (0389). */
export interface NewUsageRow {
  readonly id: string;
  readonly tenantId: string;
  readonly intakeItemId: string;
  readonly model: string;
  readonly promptVersion: string;
  /** 1 for the read, 2 for its one retry. */
  readonly attempt: number;
  readonly usage: TokenUsage;
  readonly outcome: UsageOutcome;
  /** Exactly when `outcome` is `transport_error`. */
  readonly failure: TransportFailure | null;
  /** What the model said the file is, on an `ok` answer. */
  readonly docClass: DocClass | null;
  readonly requestId: string | null;
}

export interface ExtractionUsageStore {
  record(row: NewUsageRow): Promise<void>;
  /** Every call this firm made in its own calendar month (its time zone) up
   *  to `asOf` (an ISO instant), summed. */
  monthToDate(tenantId: string, asOf: string): Promise<TokenUsage>;
  /**
   * How many times the provider refused this item's request (`bad_request`),
   * and whether, since the first of those, the firm had any call answer `ok`:
   * the proof that the request itself works and the file is what is refused.
   */
  refusals(
    tenantId: string,
    intakeItemId: string,
  ): Promise<{ readonly count: number; readonly okSinceFirst: boolean }>;
}

/** Who a client is, for the prompt. */
export interface BooksOwners {
  describe(tenantId: string, clientPartyId: string): Promise<BooksOwner | null>;
}

/** How many pages a PDF has. Throws for bytes that are not a readable PDF. The
 *  fin job satisfies it with the PDF text port (`reading.ts`), so one parser
 *  answers both questions. */
export interface PdfPageCounter {
  count(bytes: Uint8Array): Promise<number>;
}
