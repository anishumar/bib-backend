// cmd/worker — the second process shell (T2.6).
//
// A separate long-running process, not a route and not a cron entry calling
// curl. Compliance work runs for months and pauses on a human decision; that
// does not belong inside a request, and a webhook that has to be poked by an
// external scheduler is one more thing that can be down without anybody
// noticing.
//
// Only about being an OS process: load and validate config, wire the engine,
// refuse to run if the tenant wall is not intact, register the queues, and
// drain cleanly. No business logic — that is `usecase/scheduler`.
import pino from "pino";
import { load, redacted } from "../config/config";
import { validateServer } from "../config/validate";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { wireWorker } from "../setup/worker";

async function main(): Promise<void> {
  const cfg = load();
  const log = pino({ level: cfg.logLevel });

  // The same gate the API passes. A worker writes to the ledger and reads every
  // firm's data in turn, so it is if anything MORE dependent on the wall being
  // up than a request handler is — it has no session to constrain it, only the
  // tenant context it sets for itself.
  validateServer(cfg);
  log.info({ config: redacted(cfg) }, "config loaded");

  const wired = wireWorker(cfg, log);

  try {
    await assertTenantWall(wired.pools.app);
    await assertLedgerAppendOnly(wired.pools.app);
    log.info("boot checks passed: app role is NOBYPASSRLS, RLS is enabled, ledger is append-only");
  } catch (err) {
    log.error({ err }, "boot check failed — refusing to run");
    await wired.pools.close();
    process.exit(1);
  }

  await wired.run();
  log.info({ spawnCron: cfg.worker.spawnCron }, "worker up");

  // Shutdown, and the reason it is written this way rather than inline.
  //
  // A sweep halfway through a firm has written some jobs and not others, so it
  // must be allowed to finish — that is the graceful stop. But the drain itself
  // can hang (a connection that never times out), and the process still has to
  // go, because an orchestrator's patience is finite and SIGKILL is a worse
  // ending than a deliberate exit. Hence a hard stop above the grace period: it
  // only ever fires when the drain FAILED, never when it was merely slow.
  //
  // WINDOWS: Node delivers no SIGTERM there at all, and SIGINT only from a real
  // console. So on a developer's machine this path may never run, and the
  // correctness of it cannot be established by pressing Ctrl-C — which is why
  // the ordering is stated here and the pieces it calls are ordinary awaited
  // functions rather than signal-handler internals.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return; // a second Ctrl-C must not race the first
    stopping = true;
    log.info(`${signal} received — draining`);

    const hardStop = setTimeout(() => {
      log.error("drain did not finish — hard stop");
      process.exit(1);
    }, cfg.worker.shutdownGraceMs + 15_000);
    // Do not let the timer itself keep the process alive once the drain wins.
    hardStop.unref();

    void (async () => {
      try {
        await wired.queue.stop(cfg.worker.shutdownGraceMs);
        await wired.pools.close();
        log.info("closed cleanly");
        process.exit(0);
      } catch (err) {
        log.error({ err }, "drain failed");
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });
}

main().catch((err: unknown) => {
  // Last resort: nothing structured is up yet, so print and die.
  console.error("fatal during worker startup:", err);
  process.exit(1);
});
