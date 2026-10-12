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
import type { BlobStore } from "../usecase/filestore/ports";
import { PostgresDocumentStoreRepository } from "../infrastructure/postgres/document-store-repository";
import { Sha256ByteDigest } from "../infrastructure/storage/filesystem-blob-store";
import { PostgresFirmCurrency, PostgresReadStore, PostgresSourceFormats } from "../infrastructure/fin/postgres-read";
import { FinSheetGrid } from "../infrastructure/fin/sheet-grid";
import { StoredVersionBytes } from "../infrastructure/fin/version-bytes";
import { FinReadSweep } from "../usecase/fin/read";
import type { RegisteredReader } from "../usecase/fin/read";
import { FinReadQueries } from "../usecase/fin/read-queries";
import { SheetDocumentReader } from "../usecase/fin/read-sheet";
import { blobStoreFor } from "./blobs";

export interface WiredFinJob {
  readonly intake: FinIntakeService;
  /** The read sweep (F2.5): run after the intake, so a file taken in on this
   *  run is read on it. */
  readonly reads: FinReadSweep;
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

/**
 * The readers, in the order a file is offered to them, each with the routes
 * it takes. A new reader is a line here and never a branch in the sweep; the
 * PDF statement reader (`pdf_text`) and the AI reader (`vision`) join this
 * list after the sheet reader.
 */
function finReaders(app: Db): RegisteredReader[] {
  return [
    {
      reader: new SheetDocumentReader({
        grids: new FinSheetGrid(),
        formats: new PostgresSourceFormats(app),
        currency: new PostgresFirmCurrency(app),
        digest: new Sha256ByteDigest(),
        ids: systemIds,
      }),
      routes: ["sheet"],
    },
  ];
}

function readSweep(app: Db, events: EventSink, blobs: BlobStore): FinReadSweep {
  return new FinReadSweep({
    firms: new PostgresFinFirms(app),
    store: new PostgresReadStore(app),
    // The document store's own read of a version, under the firm's RLS, then
    // the blob store: the one way bytes leave (T3.6).
    bytes: new StoredVersionBytes(new PostgresDocumentStoreRepository(app), blobs),
    readers: finReaders(app),
    events,
    ids: systemIds,
  });
}

export function wireFinJob(cfg: Config): WiredFinJob {
  const pools = createPools({ ...cfg.db, appPoolSize: cfg.fin.poolSize });
  const ledger = new LedgerService({ events: new PostgresEventStore(pools.app), ids: systemIds });
  return {
    intake: intakeService(pools.app, ledger),
    reads: readSweep(pools.app, ledger, blobStoreFor(cfg)),
    pools,
  };
}

/** The API's fin routes, or undefined when the kill switch is off — in which
 *  case the router registers none and every /api/v1/fin path is a 404. */
export function finApiDeps(cfg: Config, app: Db, events: EventSink): FinDeps | undefined {
  if (!cfg.fin.enabled) return undefined;
  return {
    intake: intakeService(app, events),
    reads: new FinReadQueries({ firms: new PostgresFinFirms(app), reads: new PostgresReadStore(app) }),
  };
}
