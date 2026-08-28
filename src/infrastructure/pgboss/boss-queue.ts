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

export class BossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly log: Logger;
  private started = false;

  constructor(opts: BossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
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
