// cmd/server — the process shell. It is only about being an OS process: load
// and validate config, wire the app, refuse to serve if the tenant wall is not
// intact, start listening, and drain cleanly on a signal. No business logic.
import { serve } from "@hono/node-server";
import pino from "pino";
import { load, redacted } from "../config/config";
import { validateServer } from "../config/validate";
import { wire } from "../setup/server";

async function main(): Promise<void> {
  const cfg = load();
  const log = pino({ level: cfg.logLevel });

  // Fail at boot, not at 3 a.m. — crash-loop beats silent degradation.
  validateServer(cfg);
  log.info({ config: redacted(cfg) }, "config loaded");

  const wired = wire(cfg, log);

  try {
    await wired.assertReady();
    log.info(
      "boot checks passed: app role is NOBYPASSRLS, RLS is enabled, and the ledger is append-only",
    );
  } catch (err) {
    log.error({ err }, "boot check failed — refusing to serve");
    await wired.pools.close();
    process.exit(1);
  }

  const server = serve({ fetch: wired.app.fetch, port: cfg.port }, (info) => {
    log.info(`listening on :${info.port}`);
  });

  const shutdown = (signal: string): void => {
    log.info(`${signal} received — draining`);
    server.close(() => {
      void wired.pools.close().then(() => {
        log.info("closed cleanly");
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Last resort: nothing structured is up yet, so print and die.
  console.error("fatal during startup:", err);
  process.exit(1);
});
