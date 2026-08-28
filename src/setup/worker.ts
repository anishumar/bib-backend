// The worker's composition root (T2.6) — the ONE place a concrete type meets an
// interface, for the second process.
//
// Separate from `setup/server.ts` on purpose. The worker and the API share a
// database and a domain and almost nothing else: the worker has no HTTP, no
// session, no rate limiter and no CORS, and building it out of the server's
// wiring would drag all of that into a process that must never serve a request.
// What they DO share arrives the same way it always does — through ports.
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import type { Config } from "../config/config";
import type { Logger } from "../platform/log";
import { systemIds } from "../platform/ids";
import { systemClock } from "../platform/clock";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import {
  PostgresJobRepository,
  PostgresTenantDirectory,
} from "../infrastructure/postgres/job-repository";
import { BossJobQueue } from "../infrastructure/pgboss/boss-queue";
import { LedgerService } from "../usecase/ledger/service";
import { SchedulerService } from "../usecase/scheduler/service";
import type { JobQueue } from "../usecase/scheduler/ports";

/** The queue the spawn sweep runs on. A name, because pg-boss keys a schedule
 *  by it — see `BossJobQueue.schedule`. */
export const SPAWN_QUEUE = "delivery.spawn";

export interface WiredWorker {
  readonly pools: Pools;
  readonly queue: JobQueue;
  readonly scheduler: SchedulerService;
  /** Register the queues and their cadences. Split from `wireWorker` so a test
   *  can build the graph without starting anything. */
  run(): Promise<void>;
}

export function wireWorker(cfg: Config, log: Logger): WiredWorker {
  const pools = createPools(cfg.db);

  // The same ledger service the API uses, constructed the same way: exactly one
  // implementation of the event contract per process, and no service reaching
  // the table around it. A job spawned by a cron is an event like any other,
  // and it names `system` as its actor because a clock did it.
  const ledger = new LedgerService({
    events: new PostgresEventStore(pools.app),
    ids: systemIds,
  });

  // ONE adapter, two ports again: the job table is the scheduler's own, and the
  // activation feed is a read of the ledger. Both are tenant-scoped reads, so
  // they belong to the same RLS-aware adapter rather than to two.
  const jobs = new PostgresJobRepository(pools.app);

  const scheduler = new SchedulerService({
    jobs,
    activations: jobs,
    // The one read in this process that is not inside a tenant context, because
    // `tenancy.tenant` is GLOBAL. It returns ids and nothing else; every read
    // that follows is scoped to one of them.
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  const queue = new BossJobQueue({ connectionString: cfg.db.appUrl, log });

  return {
    pools,
    queue,
    scheduler,
    async run(): Promise<void> {
      await queue.start();
      await queue.register(SPAWN_QUEUE, async () => {
        const reports = await scheduler.sweepActivations();
        for (const r of reports) {
          if (r.spawned === 0 && r.alreadySpawned === 0) continue;
          // `alreadySpawned` is logged rather than dropped: it is the number
          // that shows idempotency working. A sweep reporting spawned:0 and
          // alreadySpawned:40 is the system correctly doing nothing, which
          // looks identical to a broken sweep if it says nothing at all.
          log.info(
            { tenantId: r.tenantId, spawned: r.spawned, alreadySpawned: r.alreadySpawned },
            "spawn sweep",
          );
        }
      });
      await queue.schedule(SPAWN_QUEUE, cfg.worker.spawnCron);
    },
  };
}
