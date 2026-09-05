// Postgres adapter for the firm's own work vocabulary (T3.1) — states and
// priorities as rows. Every read and write goes through withTenant: a firm's
// vocabulary is its own, so there is no identity-mode path here at all.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { WorkItemPriority, WorkItemState } from "../../domain/workitem/model";
import type {
  NewWorkItemPriority,
  NewWorkItemState,
  WorkItemPriorityPatch,
  WorkItemStatePatch,
  WorkVocabularyRepository,
} from "../../usecase/workitem/ports";

interface StateRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  is_initial: boolean;
  is_terminal: boolean;
  is_blocked: boolean;
  is_success: boolean;
  is_under_review: boolean;
  sort_order: number;
  is_active: boolean;
}

interface PriorityRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  rank: number;
  is_default: boolean;
  is_statutory_default: boolean;
  is_active: boolean;
}

function toState(r: StateRow): WorkItemState {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    isInitial: r.is_initial,
    isTerminal: r.is_terminal,
    isBlocked: r.is_blocked,
    isSuccess: r.is_success,
    isUnderReview: r.is_under_review,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  };
}

function toPriority(r: PriorityRow): WorkItemPriority {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    rank: r.rank,
    isDefault: r.is_default,
    isStatutoryDefault: r.is_statutory_default,
    isActive: r.is_active,
  };
}

const STATE_COLUMNS =
  "id, tenant_id, code, name, is_initial, is_terminal, is_blocked, is_success, " +
  "is_under_review, sort_order, is_active";
const PRIORITY_COLUMNS =
  "id, tenant_id, code, name, rank, is_default, is_statutory_default, is_active";

export class PostgresWorkVocabularyRepository implements WorkVocabularyRepository {
  constructor(private readonly app: Db) {}

  async listStates(tenantId: string): Promise<readonly WorkItemState[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<StateRow[]>`
        SELECT ${db.unsafe(STATE_COLUMNS)} FROM delivery.work_item_state
      `;
      // Ordering is the domain's job (`stateOrder`), not the query's — one
      // statement of what "in order" means, testable without a database.
      return rows.map(toState);
    });
  }

  async findState(tenantId: string, stateId: string): Promise<WorkItemState | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StateRow[]>`
        SELECT ${db.unsafe(STATE_COLUMNS)} FROM delivery.work_item_state WHERE id = ${stateId}
      `;
      return row ? toState(row) : null;
    });
  }

  async findStateByCode(tenantId: string, code: string): Promise<WorkItemState | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StateRow[]>`
        SELECT ${db.unsafe(STATE_COLUMNS)} FROM delivery.work_item_state WHERE code = ${code}
      `;
      return row ? toState(row) : null;
    });
  }

  async createState(state: NewWorkItemState): Promise<WorkItemState> {
    return withTenant(this.app, state.tenantId, async (db) => {
      // A new state that claims the starting flag must un-claim the incumbent
      // in the SAME transaction — the partial unique index refuses the insert
      // otherwise, and the caller would see a constraint violation where the
      // firm made a perfectly ordinary change.
      if (state.isInitial) await this.clearInitial(db, null);
      // Same transaction, same reason: 0073's partial unique index is the same
      // shape as the starting state's, so a firm moving "with a checker" from
      // one state to another must not pass through a moment where both hold it.
      if (state.isUnderReview) await this.clearUnderReview(db, null);
      const [row] = await db<StateRow[]>`
        INSERT INTO delivery.work_item_state
          (id, tenant_id, code, name, is_initial, is_terminal, is_blocked, is_success,
           is_under_review, sort_order)
        VALUES
          (${state.id}, ${state.tenantId}, ${state.code}, ${state.name},
           ${state.isInitial}, ${state.isTerminal}, ${state.isBlocked}, ${state.isSuccess},
           ${state.isUnderReview}, ${state.sortOrder})
        RETURNING ${db.unsafe(STATE_COLUMNS)}
      `;
      if (!row) throw new Error("work_item_state insert returned no row");
      return toState(row);
    });
  }

  async updateState(
    tenantId: string,
    stateId: string,
    patch: WorkItemStatePatch,
  ): Promise<WorkItemState> {
    return withTenant(this.app, tenantId, async (db) => {
      if (patch.isInitial) await this.clearInitial(db, stateId);
      if (patch.isUnderReview) await this.clearUnderReview(db, stateId);
      // The service has already resolved absent fields to their current values,
      // so every column is present here and the SQL needs no dynamic assembly —
      // the convention `StaffGradeRepository.update` set, and it means there is
      // one statement to read rather than a branch per column.
      const [row] = await db<StateRow[]>`
        UPDATE delivery.work_item_state
        SET name        = ${patch.name},
            is_initial  = ${patch.isInitial},
            is_terminal = ${patch.isTerminal},
            is_blocked  = ${patch.isBlocked},
            is_success  = ${patch.isSuccess},
            is_under_review = ${patch.isUnderReview},
            sort_order  = ${patch.sortOrder},
            is_active   = ${patch.isActive}
        WHERE id = ${stateId}
        RETURNING ${db.unsafe(STATE_COLUMNS)}
      `;
      if (!row) throw new Error(`work_item_state ${stateId} vanished between read and write`);
      return toState(row);
    });
  }

  async listPriorities(tenantId: string): Promise<readonly WorkItemPriority[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<PriorityRow[]>`
        SELECT ${db.unsafe(PRIORITY_COLUMNS)} FROM delivery.work_item_priority
      `;
      return rows.map(toPriority);
    });
  }

  async findPriority(tenantId: string, priorityId: string): Promise<WorkItemPriority | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PriorityRow[]>`
        SELECT ${db.unsafe(PRIORITY_COLUMNS)} FROM delivery.work_item_priority
        WHERE id = ${priorityId}
      `;
      return row ? toPriority(row) : null;
    });
  }

  async findPriorityByCode(tenantId: string, code: string): Promise<WorkItemPriority | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PriorityRow[]>`
        SELECT ${db.unsafe(PRIORITY_COLUMNS)} FROM delivery.work_item_priority
        WHERE code = ${code}
      `;
      return row ? toPriority(row) : null;
    });
  }

  async createPriority(priority: NewWorkItemPriority): Promise<WorkItemPriority> {
    return withTenant(this.app, priority.tenantId, async (db) => {
      if (priority.isDefault) await this.clearFlag(db, "is_default", null);
      if (priority.isStatutoryDefault) await this.clearFlag(db, "is_statutory_default", null);
      const [row] = await db<PriorityRow[]>`
        INSERT INTO delivery.work_item_priority
          (id, tenant_id, code, name, rank, is_default, is_statutory_default)
        VALUES
          (${priority.id}, ${priority.tenantId}, ${priority.code}, ${priority.name},
           ${priority.rank}, ${priority.isDefault}, ${priority.isStatutoryDefault})
        RETURNING ${db.unsafe(PRIORITY_COLUMNS)}
      `;
      if (!row) throw new Error("work_item_priority insert returned no row");
      return toPriority(row);
    });
  }

  async updatePriority(
    tenantId: string,
    priorityId: string,
    patch: WorkItemPriorityPatch,
  ): Promise<WorkItemPriority> {
    return withTenant(this.app, tenantId, async (db) => {
      if (patch.isDefault) await this.clearFlag(db, "is_default", priorityId);
      if (patch.isStatutoryDefault) await this.clearFlag(db, "is_statutory_default", priorityId);
      const [row] = await db<PriorityRow[]>`
        UPDATE delivery.work_item_priority
        SET name                 = ${patch.name},
            rank                 = ${patch.rank},
            is_default           = ${patch.isDefault},
            is_statutory_default = ${patch.isStatutoryDefault},
            is_active            = ${patch.isActive}
        WHERE id = ${priorityId}
        RETURNING ${db.unsafe(PRIORITY_COLUMNS)}
      `;
      if (!row) throw new Error(`work_item_priority ${priorityId} vanished between read and write`);
      return toPriority(row);
    });
  }

  /**
   * A new firm's eight states in ONE statement.
   *
   * One decision, not eight, and inserting them row by row would leave a
   * half-built vocabulary behind any failure. `ON CONFLICT DO NOTHING` because
   * `createTenant` and the seeder share no unit of work: a retry after a
   * partial failure must find the rows already there and add nothing.
   */
  async createStates(states: readonly NewWorkItemState[]): Promise<readonly WorkItemState[]> {
    const first = states[0];
    if (!first) return [];
    return withTenant(this.app, first.tenantId, async (db) => {
      const rows = await db<StateRow[]>`
        INSERT INTO delivery.work_item_state ${db(
          states.map((s) => ({
            id: s.id,
            tenant_id: s.tenantId,
            code: s.code,
            name: s.name,
            is_initial: s.isInitial,
            is_terminal: s.isTerminal,
            is_blocked: s.isBlocked,
            is_success: s.isSuccess,
            sort_order: s.sortOrder,
          })),
        )}
        ON CONFLICT (tenant_id, code) DO NOTHING
        RETURNING ${db.unsafe(STATE_COLUMNS)}
      `;
      return rows.map(toState);
    });
  }

  async createPriorities(
    priorities: readonly NewWorkItemPriority[],
  ): Promise<readonly WorkItemPriority[]> {
    const first = priorities[0];
    if (!first) return [];
    return withTenant(this.app, first.tenantId, async (db) => {
      const rows = await db<PriorityRow[]>`
        INSERT INTO delivery.work_item_priority ${db(
          priorities.map((p) => ({
            id: p.id,
            tenant_id: p.tenantId,
            code: p.code,
            name: p.name,
            rank: p.rank,
            is_default: p.isDefault,
            is_statutory_default: p.isStatutoryDefault,
          })),
        )}
        ON CONFLICT (tenant_id, code) DO NOTHING
        RETURNING ${db.unsafe(PRIORITY_COLUMNS)}
      `;
      return rows.map(toPriority);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────
  //
  // Both of these run INSIDE the caller's transaction — they take the scoped
  // `db` handle rather than opening their own. That is the whole point: the
  // partial unique index means the old holder must lose the flag and the new
  // one gain it atomically, and two round trips would leave a window where
  // either both hold it (refused) or neither does (the firm cannot create work).

  private async clearInitial(
    db: Parameters<Parameters<typeof withTenant>[2]>[0],
    exceptId: string | null,
  ): Promise<void> {
    await db`
      UPDATE delivery.work_item_state SET is_initial = false
      WHERE is_initial AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
    `;
  }

  private async clearUnderReview(
    db: Parameters<Parameters<typeof withTenant>[2]>[0],
    exceptId: string | null,
  ): Promise<void> {
    await db`
      UPDATE delivery.work_item_state SET is_under_review = false
      WHERE is_under_review AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
    `;
  }

  private async clearFlag(
    db: Parameters<Parameters<typeof withTenant>[2]>[0],
    column: "is_default" | "is_statutory_default",
    exceptId: string | null,
  ): Promise<void> {
    // The column name is a closed union checked by the compiler, never caller
    // input — `db.unsafe` here interpolates one of exactly two literals.
    await db`
      UPDATE delivery.work_item_priority SET ${db.unsafe(column)} = false
      WHERE ${db.unsafe(column)} AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
    `;
  }
}
