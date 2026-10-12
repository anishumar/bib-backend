// setup/fin — FinCompliance's composition root (docs/FIN_BUILD_PLAN.md F0.5).
//
// Two consumers, two functions:
//
//   wireFinJob   the fin job's own process (`cmd/fin-once.ts`): its OWN pool,
//                capped at BIB_FIN_DB_POOL, so fin can never take the
//                connections the API and the core worker need.
//   finApiDeps   what the API mounts under /api/v1/fin, on the API's pool, or
//                nothing at all when BIB_FIN_ENABLED is off.
//
// Setup is the one place fin and core meet; `.dependency-cruiser.cjs`
// (`core-never-imports-fin`) refuses any other.
import type { Config } from "../config/config";
import type { Db, Pools } from "../db/pool";
import { createPools } from "../db/pool";
import { systemIds } from "../platform/ids";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import {
  PostgresFinFirms,
  PostgresIntakeCandidates,
  PostgresIntakeRepository,
} from "../infrastructure/fin/postgres-intake";
import { LedgerService } from "../usecase/ledger/service";
import type { EventSink } from "../usecase/ledger/ports";
import { FinIntakeService } from "../usecase/fin/intake";
import type { FinDeps } from "../api/handler/fin";
import { systemClock } from "../platform/clock";
import { routeFor } from "../domain/fin/intake";
import type { IntakeRoute } from "../domain/fin/intake";
import { ClaudeExtractor } from "../infrastructure/fin/claude-extractor";
import { AsIsImages } from "../infrastructure/fin/claude-as-is-images";
import { PostgresBooksOwners, PostgresExtractionUsage } from "../infrastructure/fin/postgres-extraction";
import { MemoryUsage, UnavailableVisionReader, VisionReader } from "../usecase/fin/extract";
import type { NewUsageRow, PdfPageCounter } from "../usecase/fin/extract-ports";
import type { ImageNormaliser, PdfTextReader, ReadOutcome } from "../usecase/fin/reading";

export interface WiredFinJob {
  readonly intake: FinIntakeService;
  readonly pools: Pools;
}

function intakeService(app: Db, events: EventSink): FinIntakeService {
  return new FinIntakeService({
    firms: new PostgresFinFirms(app),
    candidates: new PostgresIntakeCandidates(app),
    items: new PostgresIntakeRepository(app),
    events,
    ids: systemIds,
  });
}

export function wireFinJob(cfg: Config): WiredFinJob {
  const pools = createPools({ ...cfg.db, appPoolSize: cfg.fin.poolSize });
  const ledger = new LedgerService({ events: new PostgresEventStore(pools.app), ids: systemIds });
  return { intake: intakeService(pools.app, ledger), pools };
}

/** The API's fin routes, or undefined when the kill switch is off — in which
 *  case the router registers none and every /api/v1/fin path is a 404. */
export function finApiDeps(cfg: Config, app: Db, events: EventSink): FinDeps | undefined {
  if (!cfg.fin.enabled) return undefined;
  return { intake: intakeService(app, events) };
}

// ── The AI document reader (F2.4) ────────────────────────────────────────────
//
// For the read sweep's list of readers, AFTER `sheet` and `pdf_text`: it reads
// the PDFs and images they decline. One per fin run (`fin:once` builds its
// readers once per process): the breaker, the run cap and the month's running
// total live on it. With BIB_FIN_AI_PROVIDER=none it is still registered, as the
// reader that answers "later" for every PDF and image, so the list of readers
// never depends on configuration and nothing is parked with a person while there
// is no key.

/** The two readers' ports the AI reader borrows from F2.3 (agent R). */
export interface VisionReaderPorts {
  /** The image adapter: shrinks, re-encodes and turns a photo upright. */
  readonly images: ImageNormaliser;
  /** The PDF text port, used only to count pages before a PDF is sent; null
   *  leaves the byte limit as the only one. */
  readonly pdfText: PdfTextReader | null;
}

function pageCounter(pdfText: PdfTextReader): PdfPageCounter {
  return { count: async (bytes) => (await pdfText.read(bytes)).pages.length };
}

function claudeExtractor(cfg: Config): ClaudeExtractor {
  const key = cfg.finAi.anthropicApiKey;
  if (key === null) {
    // validateServer refuses this first; said again here so a caller that
    // skipped it learns which variable, not a stack trace from the SDK.
    throw new Error(
      "BIB_FIN_AI_PROVIDER=anthropic but BIB_FIN_ANTHROPIC_API_KEY is not set: the AI reader has no key.",
    );
  }
  return new ClaudeExtractor({
    apiKey: key.reveal(),
    model: cfg.finAi.model,
    timeoutMs: cfg.finAi.timeoutMs,
  });
}

/** The AI reader for one fin run, built from config. */
export function visionReader(
  cfg: Config,
  app: Db,
  ports: VisionReaderPorts,
): VisionReader | UnavailableVisionReader {
  if (cfg.finAi.provider === "none") return new UnavailableVisionReader();
  return new VisionReader({
    extractor: claudeExtractor(cfg),
    usage: new PostgresExtractionUsage(app),
    owners: new PostgresBooksOwners(app),
    images: ports.images,
    pdfPages: ports.pdfText === null ? null : pageCounter(ports.pdfText),
    ids: systemIds,
    clock: systemClock,
    limits: { runCap: cfg.finAi.runCap, monthlyTokens: cfg.finAi.monthlyTokens },
  });
}

/** Whose books a file is for, as the one-file try is told on its command line. */
export interface LocalBooksOwner {
  readonly names: readonly string[];
  readonly uen: string | null;
  readonly gstNo: string | null;
}

export interface ExtractOneResult {
  /** Which reader route the file took (`pdf`, `image`, or one the AI does not read). */
  readonly route: IntakeRoute;
  readonly outcome: ReadOutcome;
  /** Every call made, as `fin.extraction_usage` would have kept it. */
  readonly calls: readonly NewUsageRow[];
}

/**
 * Read ONE local file with the configured provider and answer what the reader
 * made of it (`npm run fin:extract-one`, cmd/fin-extract-one.ts). Nothing is
 * stored: there is no firm and no intake item, so the calls are kept in memory
 * and handed back to be printed. Refuses provider `none`, which would read
 * nothing. Images are sent as they are (`AsIsImages`), so a photo must already
 * be a JPEG or PNG within the reader's edge until the image adapter (F2.3) is
 * wired here.
 */
export async function extractOneFile(
  cfg: Config,
  file: { readonly bytes: Uint8Array; readonly filename: string; readonly mediaType: string },
  owner: LocalBooksOwner | null,
): Promise<ExtractOneResult> {
  if (cfg.finAi.provider === "none") {
    throw new Error(
      "BIB_FIN_AI_PROVIDER=none: there is no AI provider to read with. Set BIB_FIN_AI_PROVIDER=anthropic " +
        "and BIB_FIN_ANTHROPIC_API_KEY.",
    );
  }
  const usage = new MemoryUsage();
  const reader = new VisionReader({
    extractor: claudeExtractor(cfg),
    usage,
    owners: { describe: () => Promise.resolve(owner) },
    images: new AsIsImages(),
    pdfPages: null,
    ids: systemIds,
    clock: systemClock,
    limits: { runCap: 1, monthlyTokens: cfg.finAi.monthlyTokens },
  });
  const route = routeFor(file.mediaType, file.filename).route;
  const outcome = await reader.read({
    tenantId: "local",
    intakeItemId: "local",
    documentVersionId: "local",
    clientPartyId: owner === null ? null : "local",
    route,
    mediaType: file.mediaType,
    filename: file.filename,
    bytes: file.bytes,
  });
  return { route, outcome, calls: usage.rows };
}
