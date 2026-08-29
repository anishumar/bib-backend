// cmd/worker-once — run the sweep once and exit (T2.6).
//
// The scheduled worker waits for its cron; this is the same sweep with no queue
// in front of it, so the engine can be demonstrated and smoke-tested on demand
// instead of by waiting an hour. **A different entry point, never a different
// rule** — it calls the same `SchedulerService.sweepActivations` the queue
// handler calls, so anything true here is true there.
//
//   npm run worker:once
//
// It runs BOTH sweeps — spawn and dunning — because both are what the worker
// does, and an entry point that mirrored half the process would be a worse lie
// than none at all.
import pino from "pino";
import { load } from "../config/config";
import { wireWorker } from "../setup/worker";

async function main(): Promise<void> {
  const cfg = load();
  const log = pino({ level: cfg.logLevel });
  const wired = wireWorker(cfg, log);

  try {
    // No queue is started: `wireWorker` builds the graph, and only `run()`
    // touches pg-boss. This path therefore needs no DDL rights on the pgboss
    // schema, which is what makes it usable from a smoke test.
    const reports = await wired.scheduler.sweepActivations();
    const spawned = reports.reduce((n, r) => n + r.spawned, 0);
    const already = reports.reduce((n, r) => n + r.alreadySpawned, 0);

    if (spawned === 0 && already === 0) {
      console.log("\n  nothing to spawn — no activated contract is without a job.\n");
    } else {
      console.log(`\n  spawned ${String(spawned)} job(s) across ${String(reports.length)} firm(s)`);
      // Printed rather than dropped: it is the number that shows idempotency
      // working. Running this twice SHOULD spawn nothing the second time, and a
      // silent second run looks identical to a broken one.
      if (already > 0) {
        console.log(`  ${String(already)} activation(s) already had a job — nothing done`);
      }
      console.log();
    }

    // BOTH sweeps, because both are what the worker does. Running only the
    // spawn one here would make this entry point a partial mirror of the
    // process it exists to stand in for — and the dunning ladder would be
    // demonstrable only by waiting for a cron.
    const dunning = await wired.dunning.sweep();
    const escalated = dunning.reduce((n, r) => n + r.escalated, 0);
    const waiting = dunning.reduce((n, r) => n + r.awaitingApproval, 0);

    if (escalated === 0) {
      console.log("  nothing to chase — no receivable has reached a rung it has not had.\n");
    } else {
      console.log(`  climbed ${String(escalated)} dunning rung(s)`);
      // The number somebody has to ACT on: the worker reached a credit hold or
      // a legal step and stopped, and nothing further happens without a partner.
      if (waiting > 0) {
        console.log(`  ${String(waiting)} terminal step(s) are waiting for a partner`);
      }
      console.log();
    }
  } finally {
    await wired.pools.close();
  }
}

main().catch((err: unknown) => {
  console.error("worker:once failed:", err);
  process.exit(1);
});
