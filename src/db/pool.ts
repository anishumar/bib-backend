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
  /** Migrations, role management, boot checks. Bypasses RLS. Never a request path. */
  readonly owner: postgres.Sql;
  close(): Promise<void>;
}

export function createPools(cfg: DbConfig): Pools {
  const app = postgres(cfg.appUrl, { max: cfg.appPoolSize });
  const owner = postgres(cfg.ownerUrl, { max: cfg.ownerPoolSize });
  return {
    app,
    owner,
    close: async () => {
      await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
    },
  };
}
