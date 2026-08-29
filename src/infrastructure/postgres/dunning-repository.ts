// The dunning ladder, in Postgres (T3.5).
//
// Two things live here and nowhere else:
//
//   THE IDEMPOTENT TAKE. `ON CONFLICT DO NOTHING` on
//   `UNIQUE (tenant_id, invoice_id, step)`, returning null when the rung was
//   already climbed. That null is what stops the service writing a second
//   `dunning.escalated` event — so a redelivered queue message, a re-run sweep
//   and a restarted worker all leave exactly one row and exactly one event. A
//   second reminder to a client who has already paid is the kind of mistake a
//   firm hears about, so it is made impossible rather than avoided.
//
//   THE GUARDED DECISION. `WHERE state = 'pending_approval'` in the UPDATE, so
//   the transition itself is the lock: two partners clicking approve at once
//   cannot both succeed, and the loser gets a null rather than a second
//   `dunning.decided` event about one hold. The same arrangement
//   `signAndFanOut` and `recordAdvance` use.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DunningBody } from "../../domain/config/model";
import { readDunningBody } from "../../domain/config/model";
import type {
  DunningActionRecord,
  DunningLadderSource,
  DunningRepository,
  NewDunningAction,
} from "../../usecase/invoice/ports";

interface DunningRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  step: string;
  after_days: number;
  action: string;
  state: string;
  approved_by: string | null;
  decided_at: Date | null;
  note: string | null;
}

const COLUMNS =
  "id, tenant_id, invoice_id, step, after_days, action, state, approved_by, decided_at, note";

const STATES = ["taken", "pending_approval", "approved", "rejected"] as const;

function toRecord(r: DunningRow): DunningActionRecord {
  const state = STATES.find((s) => s === r.state);
  if (state === undefined) {
    throw new Error(
      `crm.dunning_action holds state ${JSON.stringify(r.state)}, which this code does not ` +
        `know. The CHECK constraint and usecase/invoice/ports.ts have drifted apart.`,
    );
  }
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    step: r.step,
    afterDays: r.after_days,
    action: r.action,
    state,
    approvedBy: r.approved_by,
    decidedAt: r.decided_at === null ? null : r.decided_at.toISOString(),
    note: r.note,
  };
}

export class PostgresDunningRepository implements DunningRepository {
  constructor(private readonly app: Db) {}

  async take(a: NewDunningAction): Promise<DunningActionRecord | null> {
    return withTenant(this.app, a.tenantId, async (db) => {
      const [row] = await db<DunningRow[]>`
        INSERT INTO crm.dunning_action
          (id, tenant_id, invoice_id, step, after_days, action, state)
        VALUES (${a.id}, ${a.tenantId}, ${a.invoiceId}, ${a.step}, ${a.afterDays}, ${a.action},
                ${a.state})
        -- The rung was already climbed. Not an error: the sweep re-reads
        -- invoices it has seen and pg-boss redelivers on a crash. Returning no
        -- row is what tells the caller not to record a second event.
        ON CONFLICT (tenant_id, invoice_id, step) DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toRecord(row) : null;
    });
  }

  async taken(tenantId: string, invoiceId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ step: string }[]>`
        SELECT step FROM crm.dunning_action WHERE invoice_id = ${invoiceId}
      `;
      return rows.map((r) => r.step);
    });
  }

  async pending(tenantId: string): Promise<readonly DunningActionRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DunningRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM crm.dunning_action
        WHERE state = 'pending_approval'
        ORDER BY created_at
      `;
      return rows.map(toRecord);
    });
  }

  async find(tenantId: string, actionId: string): Promise<DunningActionRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DunningRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM crm.dunning_action WHERE id = ${actionId}
      `;
      return row ? toRecord(row) : null;
    });
  }

  async listFor(tenantId: string, invoiceId: string): Promise<readonly DunningActionRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DunningRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM crm.dunning_action
        WHERE invoice_id = ${invoiceId}
        ORDER BY after_days, created_at
      `;
      return rows.map(toRecord);
    });
  }

  async decide(
    tenantId: string,
    actionId: string,
    state: "approved" | "rejected",
    approvedBy: string,
    at: string,
    note: string | null,
  ): Promise<DunningActionRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DunningRow[]>`
        UPDATE crm.dunning_action
           SET state = ${state}, approved_by = ${approvedBy}, decided_at = ${at},
               note = COALESCE(${note}, note)
        -- THE TRANSITION IS THE LOCK. Two partners approving one credit hold at
        -- the same instant: exactly one row matches, so exactly one succeeds.
         WHERE id = ${actionId} AND state = 'pending_approval'
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toRecord(row) : null;
    });
  }
}

/**
 * The ladder a firm publishes, read LIVE from the configuration registry.
 *
 * Live rather than pinned: a firm that softens its ladder expects the next
 * sweep to use the new one, the same reading roles get. What a rung MEANT when
 * it fired is already on the action row — `after_days` is snapshotted there —
 * so nothing historical depends on this read.
 *
 * ONE entry per firm, keyed `default`. A firm running two ladders (by client
 * segment, say) is a real thing and is not this: it would key on something, and
 * nobody has said what. Keeping it to one key now means that decision is taken
 * when there is a firm to take it with, rather than guessed at here.
 */
export class PostgresDunningLadder implements DunningLadderSource {
  constructor(private readonly app: Db) {}

  async ladderFor(tenantId: string): Promise<DunningBody | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id
        WHERE e.kind = 'dunning' AND e.key = 'default' AND v.status = 'published'
        ORDER BY v.version DESC
        LIMIT 1
      `;
      return row ? readDunningBody(row.body) : null;
    });
  }
}

// NOTE: there is no `PostgresTenantDirectory` here, and there nearly was.
// `job-repository.ts` already answers "which firms exist" — and answers it
// better, filtering `status = 'active'` — so a second adapter would have been
// two pieces of SQL that could disagree about which firms a sweep walks. The
// PORT is declared twice (once per use case, as this codebase does
// deliberately); the ADAPTER is one. TypeScript caught it as a duplicate
// identifier at the composition root, which is where it should be caught.
