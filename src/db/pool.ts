// The only module that imports the Postgres driver and holds a live connection.
// The architecture wall (.dependency-cruiser.cjs) forbids anyone outside
// db/, infrastructure/, and setup/ from importing this file — so no use case,
// domain type, or HTTP handler can ever obtain a connection that has not passed
// through the tenant resolver. This is the physical enforcement of the wall.
import postgres from "postgres";
import type { DbConfig } from "../config/config";

/** The query interface repositories receive. Both the app pool and a
 *  transaction handle satisfy it, so a repo never knows which it holds. */
export type Db = postgres.Sql;

export interface Pools {
  /** RLS-enforced, NOBYPASSRLS. Every business query. Reached only via the
   *  resolver in tenant.ts — never used raw. */
  readonly app: postgres.Sql;
  close(): Promise<void>;
}

/**
 * The API's and the worker's ONE pool: `bib_app`.
 *
 * There was a second, the OWNER pool (`BIB_DATABASE_URL`), and nothing ever
 * queried it (B37, audit 2026-10-03). It is the RLS-bypassing credential:
 * `bib_owner` owns every table and no table forces its row policies. A pool
 * nothing uses is still that credential loaded into the request process,
 * waiting for the first person to reach for it. The migrator, the one thing
 * that needs the owner, opens its own connection (`cmd/migrate.ts`); the boot
 * check asks its questions as `bib_app`, the role whose powers it checks.
 * `tests/architecture/owner-pool.test.ts` keeps it that way.
 */
export function createPools(cfg: DbConfig): Pools {
  // F-06-2: every connection starts with the server-side limits, so a stuck
  // statement or an idle transaction is ended by Postgres itself and its pool
  // slot comes back, whatever the code holding it does.
  const app = postgres(cfg.appUrl, {
    max: cfg.appPoolSize,
    connect_timeout: cfg.connectTimeoutSeconds,
    connection: {
      statement_timeout: cfg.statementTimeoutMs,
      idle_in_transaction_session_timeout: cfg.idleInTransactionTimeoutMs,
    },
  });
  return {
    app,
    close: async () => {
      await app.end({ timeout: 5 });
    },
  };
}
