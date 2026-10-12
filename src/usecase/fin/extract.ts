// The AI document reader (docs/FIN_BUILD_PLAN.md F2.4): the one place in fin a
// model looks at a file. It reads what the deterministic readers decline, PDFs
// (`pdf_text` runs first and keeps the statements it recognises) and images,
// and turns an invoice, a receipt, a credit note, a customs permit or a day's
// POS summary into ONE document line for staging, where nothing counts until a
// person commits (F2.8). It never posts, codes, matches or decides anything.
//
// It is a `DocumentReader` named `vision` (`reading.ts`); the read sweep offers
// it every item it has not read, and stores what it answers.
//
// ── WHEN IT ANSWERS "LATER" ──────────────────────────────────────────────────
//
// `later` writes nothing, so the item is offered again next run. It is the
// answer whenever the AI cannot run NOW, so a file never lands on a person's
// desk because of the provider's afternoon:
//
//   * no provider is configured (`UnavailableVisionReader`, below);
//   * the breaker is open: BREAKER_AFTER transport failures in a row, or one
//     refused key, and the rest of the run asks nobody;
//   * this firm has had its documents for this run (`runCap`): the backlog is
//     finished on the next runs, and no firm's month-end starves another;
//   * this firm has spent its month (`monthlyTokens`, in input-token
//     equivalents, its own calendar month);
//   * this one call failed in transit (a 429, a 529, a timeout).
//
// The contract has two reasons for `later`; the run cap and the month are both
// a budget, so both say `ai_budget_reached`.
//
// ── WHEN IT ANSWERS "A PERSON MUST" ──────────────────────────────────────────
//
//   * the file is too big to send (`too_large`): a PDF over MAX_PDF_BYTES or
//     MAX_PDF_PAGES, an image still over MAX_IMAGE_BYTES once shrunk, or the
//     provider's own 413;
//   * it cannot be prepared (`unreadable`): the image will not decode, the PDF
//     will not open, or the provider has refused this file's request twice
//     while answering the firm's others (the proof it is the file, not us);
//   * the model's answer was not a reading twice running (`ai_invalid_output`):
//     the first problems go back to it once, named, and the second miss is a
//     person's. A model that DECLINES the file is not asked again: a person
//     reads it, and the usage row says `refused`.
//
// ── EVERY CALL IS RECORDED, BEFORE ANYTHING IS DECIDED ABOUT IT ──────────────
//
// One `fin.extraction_usage` row per attempt, failures and the retry included,
// with the model that answered, the prompt version and the tokens, written as
// soon as the call returns. The budget is counted from those rows, so a call
// that was not recorded would be a call the budget never saw.
//
// ── ONE READER IS ONE RUN ────────────────────────────────────────────────────
//
// The breaker, the run cap and the month's running total live on the instance,
// and `setup/fin.ts` builds one per fin run (`fin:once` is one run per
// process). Two overlapping runs each keep their own count, so the month can be
// overshot by at most one run's documents: a soft ceiling, stated.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { ReadProblem } from "../../domain/fin/lines";
import { FIELD_CERTAIN_ABOVE, toReadDraft } from "../../domain/fin/extraction";
import type { DocClass } from "../../domain/fin/extraction";
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  NO_TOKENS,
  VISION_MAX_EDGE,
  addTokens,
  weighedTokens,
} from "../../domain/fin/extraction-usage";
import type { TokenUsage, TransportFailure, UsageOutcome } from "../../domain/fin/extraction-usage";
import type { DocumentReader, ImageNormaliser, NormalisedImage, ReadInput, ReadOutcome } from "./reading";
import type {
  BooksOwners,
  DocumentExtractor,
  ExtractionAttempt,
  ExtractionContent,
  ExtractionUsageStore,
  NewUsageRow,
  PdfPageCounter,
} from "./extract-ports";
import { parseDocumentReading } from "./extract-output";

/** Transport failures in a row that open the breaker for the rest of the run. */
export const BREAKER_AFTER = 3;

/** The read and its one retry. */
const ATTEMPTS = 2;

export interface VisionLimits {
  /** Documents per firm per run (BIB_FIN_AI_RUN_CAP). */
  readonly runCap: number;
  /** Input-token equivalents per firm per calendar month (BIB_FIN_AI_MONTHLY_TOKENS). */
  readonly monthlyTokens: number;
}

export interface VisionReaderDeps {
  readonly extractor: DocumentExtractor;
  readonly usage: ExtractionUsageStore;
  readonly owners: BooksOwners;
  readonly images: ImageNormaliser;
  /** Null where no PDF parser is wired: then only the byte limit applies. */
  readonly pdfPages: PdfPageCounter | null;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly limits: VisionLimits;
  readonly breakerAfter?: number;
  readonly certainAbove?: number;
}

/** What one run did, for `fin:once` to print. */
export interface VisionRunReport {
  readonly read: number;
  readonly notMine: number;
  readonly needsPerson: Readonly<Partial<Record<ReadProblem, number>>>;
  readonly later: { readonly unavailable: number; readonly budget: number };
  readonly calls: number;
  readonly tokens: TokenUsage;
  readonly breakerOpen: boolean;
}

type Prepared =
  | { readonly kind: "ready"; readonly content: ExtractionContent }
  | { readonly kind: "refused"; readonly problem: "too_large" | "unreadable" };

/** What one answered attempt amounts to. */
type Verdict =
  | { readonly kind: "done"; readonly outcome: ReadOutcome; readonly docClass: DocClass }
  | {
      readonly kind: "retry";
      readonly usageOutcome: "invalid_output" | "no_tool_call" | "truncated";
      readonly problems: readonly string[];
    }
  /** The model declined. Not argued with: a person reads the file. */
  | { readonly kind: "stop"; readonly usageOutcome: "refused" };

const NOT_MINE: ReadOutcome = { kind: "not_mine" };

function takesRoute(input: ReadInput): boolean {
  return input.route === "pdf" || input.route === "image";
}

export class VisionReader implements DocumentReader {
  readonly name = "vision" as const;

  private consecutiveFailures = 0;
  private breakerOpen = false;
  private readonly itemsThisRun = new Map<string, number>();
  private readonly spentThisMonth = new Map<string, number>();

  private readCount = 0;
  private notMine = 0;
  private readonly needsPerson: Partial<Record<ReadProblem, number>> = {};
  private laterUnavailable = 0;
  private laterBudget = 0;
  private calls = 0;
  private tokens: TokenUsage = NO_TOKENS;

  constructor(private readonly deps: VisionReaderDeps) {}

  async read(input: ReadInput): Promise<ReadOutcome> {
    if (!takesRoute(input)) return this.count(NOT_MINE);
    if (this.breakerOpen) return this.count(later("ai_unavailable"));
    if ((this.itemsThisRun.get(input.tenantId) ?? 0) >= this.deps.limits.runCap) {
      return this.count(later("ai_budget_reached"));
    }
    if ((await this.spent(input.tenantId)) >= this.deps.limits.monthlyTokens) {
      return this.count(later("ai_budget_reached"));
    }

    const prepared = await this.prepare(input);
    if (prepared.kind === "refused") return this.count(person(prepared.problem));

    this.itemsThisRun.set(input.tenantId, (this.itemsThisRun.get(input.tenantId) ?? 0) + 1);
    const owner =
      input.clientPartyId === null
        ? null
        : await this.deps.owners.describe(input.tenantId, input.clientPartyId);

    let correction: readonly string[] | null = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const result = await this.deps.extractor.extract({ content: prepared.content, owner, correction });
      if (result.kind === "failed") {
        await this.record(input, attempt, result, "transport_error", null);
        return this.count(await this.onFailure(input, result.failure));
      }

      this.consecutiveFailures = 0;
      this.addSpend(input.tenantId, result.usage);
      const verdict = this.judge(input, result);
      if (verdict.kind === "done") {
        await this.record(input, attempt, result, "ok", verdict.docClass);
        return this.count(verdict.outcome);
      }
      await this.record(input, attempt, result, verdict.usageOutcome, null);
      if (verdict.kind === "stop") return this.count(person("ai_invalid_output"));
      correction = verdict.problems;
    }
    return this.count(person("ai_invalid_output"));
  }

  /** What this run has done so far. */
  report(): VisionRunReport {
    return {
      read: this.readCount,
      notMine: this.notMine,
      needsPerson: { ...this.needsPerson },
      later: { unavailable: this.laterUnavailable, budget: this.laterBudget },
      calls: this.calls,
      tokens: this.tokens,
      breakerOpen: this.breakerOpen,
    };
  }

  // ── Preparing the file ─────────────────────────────────────────────────────

  private async prepare(input: ReadInput): Promise<Prepared> {
    if (input.route === "pdf") {
      if (input.bytes.byteLength > MAX_PDF_BYTES) return { kind: "refused", problem: "too_large" };
      if (this.deps.pdfPages !== null) {
        let pages: number;
        try {
          pages = await this.deps.pdfPages.count(input.bytes);
        } catch {
          return { kind: "refused", problem: "unreadable" };
        }
        if (pages < 1) return { kind: "refused", problem: "unreadable" };
        if (pages > MAX_PDF_PAGES) return { kind: "refused", problem: "too_large" };
      }
      return { kind: "ready", content: { kind: "pdf", bytes: input.bytes } };
    }

    let image: NormalisedImage;
    try {
      image = await this.deps.images.normalise(input.bytes, VISION_MAX_EDGE);
    } catch {
      // Bytes no image library can decode: no model would do better.
      return { kind: "refused", problem: "unreadable" };
    }
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) return { kind: "refused", problem: "too_large" };
    return { kind: "ready", content: { kind: "image", bytes: image.bytes, mediaType: image.mediaType } };
  }

  // ── Judging an answer ──────────────────────────────────────────────────────

  private judge(input: ReadInput, result: Extract<ExtractionAttempt, { kind: "answered" }>): Verdict {
    switch (result.stop) {
      case "no_tool_call":
        return {
          kind: "retry",
          usageOutcome: "no_tool_call",
          problems: ["You answered without calling record_document. Call it exactly once."],
        };
      case "truncated":
        return {
          kind: "retry",
          usageOutcome: "truncated",
          problems: ["The answer was cut off before record_document was complete. Keep the reading brief."],
        };
      case "refused":
        return { kind: "stop", usageOutcome: "refused" };
      case "tool_call":
        break;
    }

    const parsed = parseDocumentReading(result.output);
    if (!parsed.ok) return { kind: "retry", usageOutcome: "invalid_output", problems: parsed.problems };

    const mapped = toReadDraft(parsed.reading, {
      provenance: {
        documentVersionId: input.documentVersionId,
        // The document starts on the PDF's first page; an image has no pages.
        page: input.route === "pdf" ? 1 : null,
        row: null,
      },
      model: result.model,
      promptVersion: result.promptVersion,
      certainAbove: this.deps.certainAbove ?? FIELD_CERTAIN_ABOVE,
    });
    if (mapped.kind === "not_a_document") {
      // A statement, payroll, a bundle or not for the books: not this reader's
      // file. With no reader after it the sweep gives it to a person as
      // `no_reader`; the class the model saw is on the usage row.
      return { kind: "done", outcome: NOT_MINE, docClass: mapped.docClass };
    }
    return { kind: "done", outcome: { kind: "read", draft: mapped.draft }, docClass: parsed.reading.docType };
  }

  // ── When the call itself failed ────────────────────────────────────────────

  private async onFailure(input: ReadInput, failure: TransportFailure): Promise<ReadOutcome> {
    if (failure === "too_large") {
      // The provider answered, about this file alone.
      this.consecutiveFailures = 0;
      return person("too_large");
    }
    if (failure === "auth") {
      // A refused key refuses every call; asking again only adds rows.
      this.breakerOpen = true;
      return later("ai_unavailable");
    }
    if (failure === "bad_request") {
      // Usually our request or the model name, which fails every call and so
      // must not park files. But once the firm's other calls have been answered
      // since this file was first refused, the request works and the FILE is
      // what the provider will not take: on its second refusal, a person.
      const refusals = await this.deps.usage.refusals(input.tenantId, input.intakeItemId);
      if (refusals.count >= 2 && refusals.okSinceFirst) return person("unreadable");
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.deps.breakerAfter ?? BREAKER_AFTER)) this.breakerOpen = true;
    return later("ai_unavailable");
  }

  // ── Recording and counting ─────────────────────────────────────────────────

  private async record(
    input: ReadInput,
    attempt: number,
    result: ExtractionAttempt,
    outcome: UsageOutcome,
    docClass: DocClass | null,
  ): Promise<void> {
    const usage = result.kind === "answered" ? result.usage : NO_TOKENS;
    const row: NewUsageRow = {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      intakeItemId: input.intakeItemId,
      model: result.model,
      promptVersion: result.promptVersion,
      attempt,
      usage,
      outcome,
      failure: result.kind === "failed" ? result.failure : null,
      docClass,
      requestId: result.requestId,
    };
    this.calls += 1;
    this.tokens = addTokens(this.tokens, usage);
    await this.deps.usage.record(row);
  }

  private async spent(tenantId: string): Promise<number> {
    const known = this.spentThisMonth.get(tenantId);
    if (known !== undefined) return known;
    const month = await this.deps.usage.monthToDate(tenantId, this.deps.clock.now().toISOString());
    const total = weighedTokens(month);
    this.spentThisMonth.set(tenantId, total);
    return total;
  }

  private addSpend(tenantId: string, usage: TokenUsage): void {
    this.spentThisMonth.set(tenantId, (this.spentThisMonth.get(tenantId) ?? 0) + weighedTokens(usage));
  }

  private count(outcome: ReadOutcome): ReadOutcome {
    switch (outcome.kind) {
      case "read":
        this.readCount += 1;
        break;
      case "not_mine":
        this.notMine += 1;
        break;
      case "needs_person":
        this.needsPerson[outcome.problem] = (this.needsPerson[outcome.problem] ?? 0) + 1;
        break;
      case "later":
        if (outcome.reason === "ai_unavailable") this.laterUnavailable += 1;
        else this.laterBudget += 1;
        break;
    }
    return outcome;
  }
}

function later(reason: "ai_unavailable" | "ai_budget_reached"): ReadOutcome {
  return { kind: "later", reader: "vision", reason };
}

function person(problem: ReadProblem): ReadOutcome {
  return { kind: "needs_person", reader: "vision", problem };
}

/**
 * The AI reader with no provider (BIB_FIN_AI_PROVIDER=none). Registered all the
 * same, so the sweep's list of readers does not change with configuration, and
 * it answers `later` for every PDF and image it would read: the file stays
 * listed as unread and is offered again the run after a key is set. Answering
 * `needs_person` instead would put every scan on a person's desk for good,
 * because a read row is never re-read.
 *
 * Not a stub that lies (CLAUDE.md's honest registry): like `NoAgentsBuiltYet`,
 * it is the complete implementation of a true statement, "this firm's fin has
 * no AI", and fin without AI is a state a deployment may run in.
 */
export class UnavailableVisionReader implements DocumentReader {
  readonly name = "vision" as const;

  read(input: ReadInput): Promise<ReadOutcome> {
    return Promise.resolve(takesRoute(input) ? later("ai_unavailable") : NOT_MINE);
  }
}

/**
 * A usage store that keeps one process's rows in memory. For the one-file try
 * (`fin:extract-one`), which reads for no firm and has no intake item to record
 * against, so it PRINTS the rows instead; never wired into the fin job.
 */
export class MemoryUsage implements ExtractionUsageStore {
  readonly rows: NewUsageRow[] = [];

  record(row: NewUsageRow): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }

  monthToDate(): Promise<TokenUsage> {
    return Promise.resolve(this.rows.reduce((sum, r) => addTokens(sum, r.usage), NO_TOKENS));
  }

  refusals(): Promise<{ readonly count: number; readonly okSinceFirst: boolean }> {
    return Promise.resolve({ count: 0, okSinceFirst: false });
  }
}
