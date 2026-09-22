// pg-boss behind the JobQueue port (T2.6). THE ONLY FILE THAT IMPORTS pg-boss.
//
// A queue is the kind of component a product replaces once — Redis, SQS, a
// table with SKIP LOCKED — and the whole value of the port is that the
// replacement costs this file and nothing else. Nothing above it knows a cron
// string from a queue name.
//
// ── WHY pg-boss AND NOT A TABLE OF OUR OWN ──────────────────────────────────
//
// It keeps its queue in the same Postgres, in one transaction with nothing, so
// a job that was scheduled survives a restart, a deploy and a crash — which is
// the difference between a schedule and a hope. Writing that ourselves means
// re-deriving visibility timeouts, retry with backoff, and cron drift, and
// being wrong about at least one of them for a while.
//
// ── THE DEVIATION, AND WHERE THE LINE IS DRAWN ──────────────────────────────
//
// `migrations/README.md` says migrations own the schema. pg-boss migrates its
// OWN tables when `start()` runs, which is a real exception to a real rule. It
// is accepted because the alternative is vendoring somebody else's schema into
// our migration history and hand-porting it on every upgrade — which is how a
// dependency silently becomes a fork.
//
// It is NOT accepted at any price, and the split is exact:
//
//   WE own the namespace. Migration 0042 creates the `pgboss` schema, like every
//   other schema in this database, and grants bib_app CREATE on THAT SCHEMA and
//   no other.
//   pg-boss owns what is inside it — hence `createSchema: false` below. Left at
//   its default, pg-boss issues `CREATE SCHEMA IF NOT EXISTS`, and PostgreSQL
//   checks the database ACL BEFORE the existence check: the statement fails with
//   42501 even though the schema is already there. Granting bib_app CREATE on
//   the database to get past that would let the application role create objects
//   anywhere, to buy a statement that has nothing to do.
//
// Keeping it in a separate schema also means the two migration histories cannot
// collide, and nothing we own has a foreign key into it.
import { PgBoss } from "pg-boss";
import type { JobQueue, QueueHandler } from "../../usecase/scheduler/ports";
import type { Logger } from "../../platform/log";

/** pg-boss keeps its own tables out of the way of ours. Not `public`, and never
 *  one of ours: the two migration histories must not be able to collide. */
export const QUEUE_SCHEMA = "pgboss";

export interface BossQueueOptions {
  readonly connectionString: string;
  readonly log: Logger;
}

/**
 * The same URL with any `sslmode` removed.
 *
 * Returns the string untouched if it will not parse — a malformed URL is a
 * problem for the driver to report against the value the operator actually set,
 * not one to mask here by handing pg-boss something different from what the API
 * is using.
 */
function withoutSslMode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return connectionString;
  }
}

export class BossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly log: Logger;
  private started = false;

  constructor(opts: BossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: withoutSslMode(opts.connectionString),
      // TWO DRIVERS, ONE URL, AND THEY DISAGREE ABOUT `sslmode=require`.
      //
      // src/db/pool.ts hands this same connection string to postgres.js, which
      // reads `require` the way libpq defines it: ENCRYPT, do not verify the
      // certificate. pg-boss is built on node-postgres, which verifies — so
      // against Cloud SQL, whose server certificate is signed by a per-instance
      // CA that is in no public trust store, the API connects and the WORKER
      // dies at startup with:
      //
      //   Error: unable to verify the first certificate
      //   code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      //     at Contractor.isInstalled ... at BossJobQueue.start
      //
      // Read that failure carefully before "fixing" it somewhere else: it is
      // NOT the app's pool being wrong, and it is not a missing grant. It is one
      // URL meaning two things.
      //
      // Matching node-postgres to what postgres.js already does on the identical
      // string weakens nothing that was not already true of every query this
      // product makes. What it does NOT do is make the traffic plaintext — TLS
      // is still negotiated; only the certificate chain goes unchecked, and on
      // Cloud SQL private IP that traffic never leaves the VPC.
      //
      // The stronger answer is to verify against Cloud SQL's server CA in BOTH
      // drivers, which means distributing that CA to every container. That is a
      // deliberate piece of work, not a line here, and until somebody does it
      // the honest position is that these two agree.
      // AND THE `ssl` OPTION ALONE IS NOT ENOUGH, which is why the string is
      // rewritten rather than merely accompanied. node-postgres parses
      // `sslmode` OUT of the connection string and the parsed value wins over
      // an explicit `ssl` passed beside it — so the first attempt at this fix
      // changed the stack trace's line number and nothing else. The parameter
      // has to be gone before the driver sees it.
      ssl: { rejectUnauthorized: false },
      schema: QUEUE_SCHEMA,
      // Migration 0042 created it. See the note above: leaving this at its
      // default makes the worker refuse to start with `permission denied for
      // database`, at deploy time, in a process nobody is watching.
      createSchema: false,
    });
    this.log = opts.log;
    // pg-boss emits errors it has already recovered from — a lost connection it
    // will retry, a maintenance pass that overlapped. Unhandled, an 'error'
    // event on an EventEmitter throws and takes the process down, so a
    // transient blip would kill the worker. Logged and survived instead.
    this.boss.on("error", (error: unknown) => {
      this.log.error({ err: error }, "pg-boss error");
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    this.started = true;
  }

  async register(queue: string, handler: QueueHandler): Promise<void> {
    // v12 requires a queue to exist before anything works it. Idempotent, so a
    // restart re-declares the same queue rather than failing.
    await this.boss.createQueue(queue);
    await this.boss.work(queue, async () => {
      await handler();
    });
  }

  async schedule(queue: string, cron: string): Promise<void> {
    // Keyed by the queue NAME. A restart therefore REPLACES the schedule
    // instead of adding a second one — without which every deploy would double
    // the sweep rate, quietly, and only ever in the direction of more.
    await this.boss.schedule(queue, cron);
  }

  async stop(graceMs: number): Promise<void> {
    if (!this.started) return;
    // `graceful` is the load-bearing part: a sweep halfway through a firm has
    // written some jobs and not others, and killing it there leaves work for the
    // next start to rediscover. It lets handlers in flight finish, and `timeout`
    // bounds that wait so a wedged handler cannot hold a deploy open forever.
    //
    // v12 has no `wait` option — earlier versions needed it to make this promise
    // resolve only once everything had stopped, and v12 always does. If this is
    // ever ported back to v10, `wait: true` has to come with it.
    await this.boss.stop({ graceful: true, timeout: graceMs });
    this.started = false;
  }
}
