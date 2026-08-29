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
import { PostgresWorkSplitSetting } from "../infrastructure/postgres/service-axis-repository";
import { SchedulerService } from "../usecase/scheduler/service";
import { DunningService } from "../usecase/dunning/service";
import { OrchestratorService } from "../usecase/orchestrator/service";
import { PostgresJobStepRepository } from "../infrastructure/postgres/job-step-repository";
import { PostgresJobSubjectRepository } from "../infrastructure/postgres/job-subject-repository";
import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import { NoAgentsBuiltYet } from "../infrastructure/agent/no-agents";
import { PostgresAgentRunRepository } from "../infrastructure/postgres/agent-run-repository";
import { PostgresInvoiceRepository } from "../infrastructure/postgres/invoice-repository";
import {
  PostgresDunningLadder,
  PostgresDunningRepository,
} from "../infrastructure/postgres/dunning-repository";
import type { JobQueue } from "../usecase/scheduler/ports";

/** The queue the spawn sweep runs on. A name, because pg-boss keys a schedule
 *  by it — see `BossJobQueue.schedule`. */
export const SPAWN_QUEUE = "delivery.spawn";

/** The queue the dunning sweep runs on. Its own name and its own cadence: the
 *  ladder is counted in days and the spawn sweep in hours, and one queue doing
 *  both would have to run at the faster of the two. */
export const DUNNING_QUEUE = "billing.dunning";

/** The queue the orchestrator sweep runs on. Its own name and its own cadence
 *  again — this one is minutes rather than hours or days, because what it is
 *  waiting for is not a clock but a colleague finishing a step. */
export const ORCHESTRATOR_QUEUE = "delivery.orchestrate";

export interface WiredWorker {
  readonly pools: Pools;
  readonly queue: JobQueue;
  readonly scheduler: SchedulerService;
  readonly dunning: DunningService;
  readonly orchestrator: OrchestratorService;
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
    // ONE adapter satisfying two ports declared in two use cases — the shape
    // AxisDirectory and RoleDirectory already have. `usecase/serviceaxis` owns
    // the write side of this setting; the scheduler reads it, and neither
    // imports the other.
    splitAxis: new PostgresWorkSplitSetting(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // CHASING RECEIVABLES runs here rather than in the API for the reason every
  // sweep does: it is work nobody asked for, on a clock, across every firm. The
  // API's own composition root builds a DunningService too — for the half a
  // PARTNER drives, deciding a terminal rung — and the two are separate graphs
  // because a worker and an API are separate processes.
  const invoiceRepository = new PostgresInvoiceRepository(pools.app);
  const dunning = new DunningService({
    dunning: new PostgresDunningRepository(pools.app),
    ladders: new PostgresDunningLadder(pools.app),
    invoices: invoiceRepository,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE THIRD SWEEP (T2.7). It shares the job repository with the scheduler on
  // purpose: the scheduler creates jobs and this one walks them, and two
  // adapters over `delivery.job` would eventually disagree about what "runnable"
  // means — which is the one thing both of them turn on.
  // ONE config repository, in three roles: the template source, the tier source
  // and the catalogue. Two instances would be two adapters over the same table
  // free to disagree about what is published — and one of the two answers here
  // decides whether a machine may act with nobody watching.
  const configRepository = new PostgresConfigRepository(pools.app);
  const orchestrator = new OrchestratorService({
    jobs,
    steps: new PostgresJobStepRepository(pools.app),
    // The config repository, in its `TemplateSource` role. The same class the
    // API reads roles and services through — one adapter over `config`, so what
    // is published is one answer rather than two that agree by luck.
    templates: configRepository,
    subjects: new PostgresJobSubjectRepository(pools.app),
    // There are no agents. Not a stub standing in for something missing — a
    // true statement about this product today, which is why it is not gated on
    // config the way the dev auth resolver is. Every step waits for a person,
    // and the firm's work runs. T2.8 replaces this line.
    agents: new NoAgentsBuiltYet(),
    // The guardrail's two seams (T2.8). Both are wired even though nothing runs
    // through them yet, and that is the order the board asks for — the rails
    // exist before anything is on them, so the first real agent is a change to
    // ONE line above and not a conversation about what it may do while somebody
    // waits for it to ship.
    tiers: configRepository,
    runs: new PostgresAgentRunRepository(pools.app),
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
    dunning,
    orchestrator,
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

      await queue.register(DUNNING_QUEUE, async () => {
        const reports = await dunning.sweep();
        for (const r of reports) {
          if (r.escalated === 0 && r.alreadyTaken === 0) continue;
          // `awaitingApproval` is logged because it is the number somebody has
          // to ACT on: the worker has climbed to a credit hold and stopped, and
          // nothing further happens until a partner decides.
          log.info(
            {
              tenantId: r.tenantId,
              escalated: r.escalated,
              alreadyTaken: r.alreadyTaken,
              awaitingApproval: r.awaitingApproval,
            },
            "dunning sweep",
          );
        }
      });
      await queue.schedule(DUNNING_QUEUE, cfg.worker.dunningCron);

      await queue.register(ORCHESTRATOR_QUEUE, async () => {
        const reports = await orchestrator.sweep();
        for (const r of reports) {
          if (r.started === 0 && r.advanced === 0 && r.awaitingTemplate === 0) continue;
          // `awaitingPeople` and `awaitingTemplate` are the two numbers somebody
          // has to ACT on, and they are different people: the first is work on
          // colleagues' desks, the second is a partner who has not written a
          // process yet. A sweep that logged only what it moved would say the
          // engine is idle when it is actually waiting on the firm.
          log.info(
            {
              tenantId: r.tenantId,
              started: r.started,
              advanced: r.advanced,
              awaitingPeople: r.awaitingPeople,
              completed: r.completed,
              awaitingTemplate: r.awaitingTemplate,
            },
            "orchestrator sweep",
          );
        }
      });
      await queue.schedule(ORCHESTRATOR_QUEUE, cfg.worker.orchestratorCron);
    },
  };
}
