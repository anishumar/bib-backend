// What the worker says about a sweep's reports (audit 2026-10-03, B32).
//
// The decisions were inline in `worker.ts`'s queue handlers, where nothing
// could test them, and one of them was wrong: the spawn sweep skipped every
// report with nothing spawned BEFORE looking at `failure`, so a firm whose
// spawn failed every hour was invisible except under `worker:once`. It also
// skipped a report whose only news was period jobs (T6.13) or a task that
// failed to route. Each sweep's rule now lives here, and a FAILURE is always
// logged at error, first, whatever else the report says.
import type { Logger } from "../platform/log";
import type { SweepReport } from "../usecase/scheduler/service";
import type { WalkReport } from "../usecase/orchestrator/service";
import type { DunningSweepReport } from "../usecase/dunning/service";

/** The hourly spawn sweep (T2.6, T6.13). */
export function logSpawnSweep(log: Logger, reports: readonly SweepReport[]): void {
  for (const r of reports) {
    if (r.failure !== undefined) {
      log.error({ tenantId: r.tenantId, failure: r.failure }, "spawn sweep could not visit firm");
      continue;
    }
    if (r.tasksFailed > 0) {
      // The job stands and the task did not: the work is owed and on nobody's
      // desk, which looks exactly like a job nobody has started.
      log.warn({ tenantId: r.tenantId, tasksFailed: r.tasksFailed }, "spawn sweep: jobs with no task");
    }
    if (r.spawned === 0 && r.alreadySpawned === 0 && r.periodsSpawned === 0 && r.awaitingFiscalYear === 0) continue;
    // `alreadySpawned` is logged rather than dropped: it is the number that
    // shows idempotency working. A sweep reporting spawned:0 and
    // alreadySpawned:40 is the system correctly doing nothing, which looks
    // identical to a broken sweep if it says nothing at all.
    log.info(
      {
        tenantId: r.tenantId,
        spawned: r.spawned,
        alreadySpawned: r.alreadySpawned,
        periodsSpawned: r.periodsSpawned,
        awaitingFiscalYear: r.awaitingFiscalYear,
      },
      "spawn sweep",
    );
  }
}

/** The five-minute orchestrator walk (T2.7). */
export function logOrchestratorSweep(log: Logger, reports: readonly WalkReport[]): void {
  for (const r of reports) {
    if (r.failure !== undefined) {
      // A whole firm that could not be visited, or the first job of it that
      // failed: either way somebody has to look (B11).
      log.error({ tenantId: r.tenantId, failed: r.failed ?? null, failure: r.failure }, "orchestrator sweep failed");
    }
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
}

/** The daily dunning climb (T3.5). */
export function logDunningSweep(log: Logger, reports: readonly DunningSweepReport[]): void {
  for (const r of reports) {
    if (r.failure !== undefined) {
      log.error({ tenantId: r.tenantId, failure: r.failure }, "dunning sweep could not visit firm");
      continue;
    }
    if (r.escalated === 0 && r.alreadyTaken === 0) continue;
    // `awaitingApproval` is logged because it is the number somebody has to
    // ACT on: the worker has climbed to a credit hold and stopped, and
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
}
