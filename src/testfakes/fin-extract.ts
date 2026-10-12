// In-memory fakes for the AI reader's ports (F2.4). `implements` keeps them in
// step with the adapters. They reproduce what the reader's rules depend on, the
// usage rows the budget and the refusal rule are counted from, and nothing
// else; RLS, the grants and the composite key are proven against Postgres in
// tests/fin/extraction-usage.integration.test.ts, and the Claude adapter
// against a recorded transport in tests/fin/claude-extractor.test.ts.
import type { DocClass, DocumentReading, FieldReading, ReadField } from "../domain/fin/extraction";
import { READ_FIELDS } from "../domain/fin/extraction";
import { NO_TOKENS, addTokens } from "../domain/fin/extraction-usage";
import type { TokenUsage, TransportFailure } from "../domain/fin/extraction-usage";
import type {
  AnswerStop,
  BooksOwner,
  BooksOwners,
  DocumentExtractor,
  ExtractionAttempt,
  ExtractionRequest,
  ExtractionUsageStore,
  NewUsageRow,
  PdfPageCounter,
} from "../usecase/fin/extract-ports";
import type { ImageNormaliser, NormalisedImage } from "../usecase/fin/reading";

export const FAKE_MODEL = "claude-sonnet-5-5";
export const FAKE_PROMPT_VERSION = "fin-doc@test";

/** A plausible call: an image, the cached prefix read, a short tool call. */
export const TYPICAL_USAGE: TokenUsage = {
  inputTokens: 4200,
  outputTokens: 900,
  cacheWriteTokens: 0,
  cacheReadTokens: 2600,
};

/** The model answered with this tool input. */
export function answered(
  output: unknown,
  over: { readonly stop?: AnswerStop; readonly usage?: TokenUsage; readonly model?: string } = {},
): ExtractionAttempt {
  return {
    kind: "answered",
    model: over.model ?? FAKE_MODEL,
    promptVersion: FAKE_PROMPT_VERSION,
    requestId: "req_fake",
    usage: over.usage ?? TYPICAL_USAGE,
    stop: over.stop ?? "tool_call",
    output,
  };
}

/** The call got no answer. */
export function failed(failure: TransportFailure): ExtractionAttempt {
  return {
    kind: "failed",
    model: FAKE_MODEL,
    promptVersion: FAKE_PROMPT_VERSION,
    requestId: null,
    failure,
  };
}

const NOT_PRINTED: FieldReading = { value: null, status: "not_printed", confidence: 0.97 };

/** A complete reading: every field not printed unless given. */
export function reading(
  docType: DocClass,
  fields: Partial<Record<ReadField, FieldReading>> = {},
  over: { readonly docTypeConfidence?: number; readonly overallConfidence?: number } = {},
): DocumentReading {
  const all = Object.fromEntries(READ_FIELDS.map((f) => [f, fields[f] ?? NOT_PRINTED])) as Record<
    ReadField,
    FieldReading
  >;
  return {
    docType,
    docTypeConfidence: over.docTypeConfidence ?? 0.98,
    fields: all,
    overallConfidence: over.overallConfidence ?? 0.95,
  };
}

/** A field read clearly. */
export function printed(value: string, confidence = 0.98): FieldReading {
  return { value, status: "read", confidence };
}

/**
 * Answers from a script, one per call, and keeps every request it was given.
 * A script entry may be a function of the request, for a test that answers
 * differently to the retry.
 */
export class FakeExtractor implements DocumentExtractor {
  readonly requests: ExtractionRequest[] = [];
  private readonly script: (ExtractionAttempt | ((r: ExtractionRequest) => ExtractionAttempt))[];

  constructor(script: (ExtractionAttempt | ((r: ExtractionRequest) => ExtractionAttempt))[] = []) {
    this.script = [...script];
  }

  queue(...more: (ExtractionAttempt | ((r: ExtractionRequest) => ExtractionAttempt))[]): this {
    this.script.push(...more);
    return this;
  }

  extract(request: ExtractionRequest): Promise<ExtractionAttempt> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) return Promise.reject(new Error("FakeExtractor: no scripted answer left"));
    return Promise.resolve(typeof next === "function" ? next(request) : next);
  }
}

/** The usage table, in memory: the rows, and the two questions asked of them. */
export class FakeUsageStore implements ExtractionUsageStore {
  readonly rows: NewUsageRow[] = [];
  /** Spend already in the month before this run, per firm. */
  readonly earlier = new Map<string, TokenUsage>();
  /** How many times `monthToDate` was asked, per firm (the reader asks once). */
  readonly monthReads = new Map<string, number>();

  record(row: NewUsageRow): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }

  monthToDate(tenantId: string): Promise<TokenUsage> {
    this.monthReads.set(tenantId, (this.monthReads.get(tenantId) ?? 0) + 1);
    const recorded = this.rows
      .filter((r) => r.tenantId === tenantId)
      .reduce((sum, r) => addTokens(sum, r.usage), NO_TOKENS);
    return Promise.resolve(addTokens(this.earlier.get(tenantId) ?? NO_TOKENS, recorded));
  }

  refusals(
    tenantId: string,
    intakeItemId: string,
  ): Promise<{ readonly count: number; readonly okSinceFirst: boolean }> {
    const firm = this.rows.filter((r) => r.tenantId === tenantId);
    const first = firm.findIndex((r) => r.intakeItemId === intakeItemId && r.failure === "bad_request");
    const count = firm.filter((r) => r.intakeItemId === intakeItemId && r.failure === "bad_request").length;
    const okSinceFirst = first !== -1 && firm.slice(first + 1).some((r) => r.outcome === "ok");
    return Promise.resolve({ count, okSinceFirst });
  }

  forItem(intakeItemId: string): NewUsageRow[] {
    return this.rows.filter((r) => r.intakeItemId === intakeItemId);
  }
}

export class FakeBooksOwners implements BooksOwners {
  readonly owners = new Map<string, BooksOwner>();

  describe(tenantId: string, clientPartyId: string): Promise<BooksOwner | null> {
    return Promise.resolve(this.owners.get(`${tenantId}/${clientPartyId}`) ?? null);
  }

  set(tenantId: string, clientPartyId: string, owner: BooksOwner): void {
    this.owners.set(`${tenantId}/${clientPartyId}`, owner);
  }
}

/** Shrinks nothing; records the edge it was asked for. */
export class FakeImageNormaliser implements ImageNormaliser {
  readonly asked: number[] = [];
  /** Throw, as for bytes that are no image. */
  broken = false;
  /** What a "normalised" image weighs, to test the after-shrinking limit. */
  outputBytes: number | null = null;

  normalise(bytes: Uint8Array, maxEdge: number): Promise<NormalisedImage> {
    this.asked.push(maxEdge);
    if (this.broken) return Promise.reject(new Error("not an image"));
    return Promise.resolve({
      bytes: this.outputBytes === null ? bytes : new Uint8Array(this.outputBytes),
      mediaType: "image/jpeg",
      width: maxEdge,
      height: Math.round((maxEdge * 3) / 4),
    });
  }
}

export class FakePdfPages implements PdfPageCounter {
  pages = 1;
  broken = false;

  count(): Promise<number> {
    return this.broken ? Promise.reject(new Error("not a PDF")) : Promise.resolve(this.pages);
  }
}
