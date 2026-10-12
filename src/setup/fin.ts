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
import { FindingService } from "../usecase/fin/findings";
import { PostgresFindingStore, PostgresRuleParameters } from "../infrastructure/fin/postgres-findings";
import type { FinDeps } from "../api/handler/fin";

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
  return { intake: intakeService(app, events), findings: findingService(app, events) };
}

/** The findings store (F4.2): the API decides and reads through it; the fin
 *  job will raise through it once committed lines exist (F2.8). */
export function findingService(app: Db, events: EventSink): FindingService {
  return new FindingService({
    firms: new PostgresFinFirms(app),
    store: new PostgresFindingStore(app),
    parameters: new PostgresRuleParameters(app),
    events,
    ids: systemIds,
  });
}
