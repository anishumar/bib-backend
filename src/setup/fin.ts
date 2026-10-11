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
import { DEFAULT_ARCHIVE_LIMITS } from "../domain/fin/archive";
import { PdfJsTextReader } from "../infrastructure/fin/pdf-text";
import { SharpImageNormaliser } from "../infrastructure/fin/image-normaliser";
import { NodeZipArchiveReader } from "../infrastructure/fin/zip-archive";
import type {
  ArchiveLimits,
  ArchiveReader,
  DocumentReader,
  ImageNormaliser,
  PdfTextReader,
} from "../usecase/fin/reading";
import { pdfStatementReader } from "../usecase/fin/statement-pdf-reader";

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

// ── The file readers (F2.3, F2.7, F2.9 PDF half, F2.10) ─────────────────────
//
// The adapters behind `usecase/fin/reading.ts` and the PDF statement reader
// built on them. The read sweep (F2.5/F2.6) takes `statementPdf` into its
// ordered reader list (sheet, pdf_text, vision); the AI reader takes `images`
// and `pdfText`; archive intake takes `archives` with `archiveLimits`. Built
// here and not in `wireFinJob` so the sweep's wiring is one line wherever it
// lands. Each adapter loads its library (pdf.js, sharp) on first use, so
// importing this file, as the API's composition root does, loads neither.
export interface FinFileReaders {
  readonly pdfText: PdfTextReader;
  readonly images: ImageNormaliser;
  readonly archives: ArchiveReader;
  readonly archiveLimits: ArchiveLimits;
  readonly statementPdf: DocumentReader;
}

export function finFileReaders(): FinFileReaders {
  const pdfText = new PdfJsTextReader();
  return {
    pdfText,
    images: new SharpImageNormaliser(),
    archives: new NodeZipArchiveReader(),
    archiveLimits: DEFAULT_ARCHIVE_LIMITS,
    statementPdf: pdfStatementReader(pdfText),
  };
}
