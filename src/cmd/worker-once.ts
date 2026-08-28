// cmd/worker-once — run the sweep once and exit (T2.6).
//
// The scheduled worker waits for its cron; this is the same sweep with no queue
// in front of it, so the engine can be demonstrated and smoke-tested on demand
// instead of by waiting an hour. **A different entry point, never a different
// rule** — it calls the same `SchedulerService.sweepActivations` the queue
// handler calls, so anything true here is true there.
//
//   npm run worker:once
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
  } finally {
    await wired.pools.close();
  }
}

main().catch((err: unknown) => {
  console.error("worker:once failed:", err);
  process.exit(1);
});
