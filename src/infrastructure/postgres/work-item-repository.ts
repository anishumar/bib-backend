// Postgres adapter for work items (T3.1) — the row on somebody's desk, its
// checklist and its dependencies. Every read and write goes through withTenant:
// a work item belongs to the firm that owes the work, and nothing asks "this
// user's work across firms", so there is no identity-mode path here at all.
//
// `due_on` is selected `::text`. postgres.js parses a `date` column into a JS
// `Date`, which is an INSTANT and moves the day for anybody east or west of
// UTC — and a deadline is a calendar fact in the firm's own office. The whole
// domain compares these as ISO strings; the same cast `client-assignment-` and
// `relationship-repository` make, for the same reason.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  ChecklistItem,
  WorkItem,
  WorkItemBlocker,
  WorkItemDependency,
  WorkItemRecord,
} from "../../domain/workitem/model";
import type {
  NewWorkItem,
  WorkItemFilter,
  WorkItemPatch,
  WorkItemRepository,
  WorkItemStateWrite,
} from "../../usecase/workitem/ports";

interface ItemRow {
  id: string;
  tenant_id: string;
  client_party_id: string;
  entity_party_id: string | null;
  engagement_id: string | null;
  job_id: string | null;
  service_version_id: string | null;
  dept_axis_id: string | null;
  title: string;
  description: string | null;
  state_id: string;
  priority_id: string;
  assignee_user_id: string | null;
  assignment_note: string | null;
  due_on: string | null;
  is_statutory_due: boolean;
  sla_days_snapshot: number | null;
  is_client_visible: boolean;
  blocked_reason: string | null;
  blocked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface RecordRow extends ItemRow {
  client_name: string;
  entity_name: string | null;
  state_code: string;
  state_name: string;
  state_is_initial: boolean;
  state_is_terminal: boolean;
  state_is_blocked: boolean;
  state_sort_order: number;
  state_is_active: boolean;
  priority_code: string;
  priority_name: string;
  priority_rank: number;
  priority_is_default: boolean;
  priority_is_statutory_default: boolean;
  priority_is_active: boolean;
  assignee_email: string | null;
  assignee_display_name: string | null;
  dept_name: string | null;
  checklist_done: number;
  checklist_total: number;
  has_open_review: boolean;
  blocked_by_open: WorkItemBlocker[] | null;
}

interface ChecklistRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  label: string;
  sort_order: number;
  done_at: string | null;
  done_by_user_id: string | null;
}

interface DependencyRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  depends_on_work_item_id: string;
}

function toItem(r: ItemRow): WorkItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    clientPartyId: r.client_party_id,
    entityPartyId: r.entity_party_id,
    engagementId: r.engagement_id,
    jobId: r.job_id,
    serviceVersionId: r.service_version_id,
    deptAxisId: r.dept_axis_id,
    title: r.title,
    description: r.description,
    stateId: r.state_id,
    priorityId: r.priority_id,
    assigneeUserId: r.assignee_user_id,
    assignmentNote: r.assignment_note,
    dueOn: r.due_on,
    isStatutoryDue: r.is_statutory_due,
    slaDaysSnapshot: r.sla_days_snapshot,
    isClientVisible: r.is_client_visible,
    blockedReason: r.blocked_reason,
    blockedAt: r.blocked_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  };
}

/**
 * The board's row, resolved.
 *
 * The joins are in the QUERY and not a lookup per row: a read model carries
 * NAMES, not ids, or the screen fetches a person, a client and a state per line
 * to render itself. This codebase has learnt that six times.
 */
function toRecord(r: RecordRow): WorkItemRecord {
  return {
    item: toItem(r),
    clientName: r.client_name,
    entityName: r.entity_name,
    state: {
      id: r.state_id,
      tenantId: r.tenant_id,
      code: r.state_code,
      name: r.state_name,
      isInitial: r.state_is_initial,
      isTerminal: r.state_is_terminal,
      isBlocked: r.state_is_blocked,
      sortOrder: r.state_sort_order,
      isActive: r.state_is_active,
    },
    priority: {
      id: r.priority_id,
      tenantId: r.tenant_id,
      code: r.priority_code,
      name: r.priority_name,
      rank: r.priority_rank,
      isDefault: r.priority_is_default,
      isStatutoryDefault: r.priority_is_statutory_default,
      isActive: r.priority_is_active,
    },
    assignee:
      r.assignee_user_id === null || r.assignee_email === null
        ? null
        : {
            userId: r.assignee_user_id,
            email: r.assignee_email,
            displayName: r.assignee_display_name,
          },
    deptName: r.dept_name,
    checklistDone: Number(r.checklist_done),
    checklistTotal: Number(r.checklist_total),
    hasOpenReview: r.has_open_review,
    blockedByOpen: r.blocked_by_open ?? [],
  };
}

const COLUMNS =
  "id, tenant_id, client_party_id, entity_party_id, engagement_id, job_id, " +
  "service_version_id, dept_axis_id, title, description, state_id, priority_id, " +
  "assignee_user_id, assignment_note, due_on::text AS due_on, is_statutory_due, " +
  "sla_days_snapshot, is_client_visible, blocked_reason, blocked_at, started_at, " +
  "completed_at, created_at";

/**
 * The one SELECT the board and the task screen both use.
 *
 * ONE query rather than five, and the sub-selects are the reason it is written
 * out here rather than assembled per call: a board of thirty rows would
 * otherwise be thirty checklist counts, thirty review checks and thirty
 * dependency reads. Written once, used by `list` and `findRecord`, so a row and
 * its own page can never disagree about what is on it.
 */
const RECORD_SELECT = `
  SELECT w.id, w.tenant_id, w.client_party_id, w.entity_party_id, w.engagement_id,
         w.job_id, w.service_version_id, w.dept_axis_id, w.title, w.description,
         w.state_id, w.priority_id, w.assignee_user_id, w.assignment_note,
         w.due_on::text AS due_on, w.is_statutory_due, w.sla_days_snapshot,
         w.is_client_visible, w.blocked_reason, w.blocked_at, w.started_at,
         w.completed_at, w.created_at,
         cp.display_name AS client_name,
         ep.display_name AS entity_name,
         s.code AS state_code, s.name AS state_name, s.is_initial AS state_is_initial,
         s.is_terminal AS state_is_terminal, s.is_blocked AS state_is_blocked,
         s.sort_order AS state_sort_order, s.is_active AS state_is_active,
         p.code AS priority_code, p.name AS priority_name, p.rank AS priority_rank,
         p.is_default AS priority_is_default,
         p.is_statutory_default AS priority_is_statutory_default,
         p.is_active AS priority_is_active,
         u.email::text AS assignee_email, u.display_name AS assignee_display_name,
         x.name AS dept_name,
         coalesce(cl.done, 0)  AS checklist_done,
         coalesce(cl.total, 0) AS checklist_total,
         EXISTS (
           SELECT 1 FROM delivery.work_item_approval a
            WHERE a.work_item_id = w.id AND a.decision = 'pending'
         ) AS has_open_review,
         blockers.rows AS blocked_by_open
  FROM delivery.work_item w
  JOIN core.party cp ON cp.id = w.client_party_id AND cp.tenant_id = w.tenant_id
  LEFT JOIN core.party ep ON ep.id = w.entity_party_id AND ep.tenant_id = w.tenant_id
  JOIN delivery.work_item_state s ON s.id = w.state_id AND s.tenant_id = w.tenant_id
  JOIN delivery.work_item_priority p ON p.id = w.priority_id AND p.tenant_id = w.tenant_id
  -- By id alone, and correctly: tenancy.user_account is GLOBAL (ADR-02) and has
  -- no tenant_id to join on. What refuses a stranger is the roster check in the
  -- service, not this join.
  LEFT JOIN tenancy.user_account u ON u.id = w.assignee_user_id
  LEFT JOIN tenancy.service_axis x ON x.id = w.dept_axis_id AND x.tenant_id = w.tenant_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS total, count(c.done_at) AS done
      FROM delivery.checklist_item c
     WHERE c.work_item_id = w.id AND c.tenant_id = w.tenant_id
  ) cl ON true
  -- What this item is still WAITING ON. Unfinished is read off the blocker's
  -- own state flag, never its code: the firm may rename any of these.
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('workItemId', b.id, 'title', b.title)
                    ORDER BY b.title) AS rows
      FROM delivery.work_item_dependency d
      JOIN delivery.work_item b
        ON b.id = d.depends_on_work_item_id AND b.tenant_id = d.tenant_id
      JOIN delivery.work_item_state bs
        ON bs.id = b.state_id AND bs.tenant_id = b.tenant_id
     WHERE d.work_item_id = w.id AND d.tenant_id = w.tenant_id
       AND NOT bs.is_terminal
  ) blockers ON true
`;

export class PostgresWorkItemRepository implements WorkItemRepository {
  constructor(private readonly app: Db) {}

  async create(item: NewWorkItem): Promise<WorkItem> {
    return withTenant(this.app, item.tenantId, async (db) => {
      const [row] = await this.insert(db, item);
      if (!row) throw new Error("work_item insert returned no row");
      return toItem(row);
    });
  }

  /**
   * The spawn path's insert: conflict on the engagement means the work already
   * exists, and the correct answer is null and NOT an error.
   *
   * `ON CONFLICT` names the partial unique index by its predicate, because the
   * index is partial (`WHERE engagement_id IS NOT NULL`) and Postgres will not
   * infer a partial index without one. That is also why this method exists at
   * all rather than a flag on `create`: an ad hoc item has no engagement and
   * must not be silenced by an index it is not covered by.
   */
  async createIfAbsentForEngagement(item: NewWorkItem): Promise<WorkItem | null> {
    return withTenant(this.app, item.tenantId, async (db) => {
      const rows = await db<ItemRow[]>`
        INSERT INTO delivery.work_item
          (id, tenant_id, client_party_id, entity_party_id, engagement_id, job_id,
           service_version_id, dept_axis_id, title, description, state_id, priority_id,
           assignee_user_id, assignment_note, due_on, is_statutory_due, sla_days_snapshot,
           is_client_visible)
        VALUES
          (${item.id}, ${item.tenantId}, ${item.clientPartyId}, ${item.entityPartyId},
           ${item.engagementId}, ${item.jobId}, ${item.serviceVersionId}, ${item.deptAxisId},
           ${item.title}, ${item.description}, ${item.stateId}, ${item.priorityId},
           ${item.assigneeUserId}, ${item.assignmentNote}, ${item.dueOn}::date,
           ${item.isStatutoryDue}, ${item.slaDaysSnapshot}, ${item.isClientVisible})
        ON CONFLICT (tenant_id, engagement_id) WHERE engagement_id IS NOT NULL DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      const row = rows[0];
      return row ? toItem(row) : null;
    });
  }

  async findById(tenantId: string, workItemId: string): Promise<WorkItem | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ItemRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.work_item WHERE id = ${workItemId}
      `;
      return row ? toItem(row) : null;
    });
  }

  /**
   * The board.
   *
   * Every filter is applied in ONE statement — "my open work for this client"
   * as three round trips is three chances to read a different state than the
   * first. Each predicate is written as `(${flag} IS NOT TRUE OR …)` rather than
   * assembled as a string, so the SQL is one readable statement and every value
   * is still a bound parameter.
   *
   * `openOnly` reads the state's FLAG and never its code, like everything else
   * in this module.
   */
  async list(tenantId: string, filter: WorkItemFilter): Promise<readonly WorkItemRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<RecordRow[]>`
        ${db.unsafe(RECORD_SELECT)}
        WHERE (${filter.assigneeUserId ?? null}::uuid IS NULL
               OR w.assignee_user_id = ${filter.assigneeUserId ?? null}::uuid)
          AND (${filter.unassignedOnly ?? false}::boolean IS NOT TRUE
               OR w.assignee_user_id IS NULL)
          AND (${filter.clientPartyId ?? null}::uuid IS NULL
               OR w.client_party_id = ${filter.clientPartyId ?? null}::uuid)
          AND (${filter.jobId ?? null}::uuid IS NULL
               OR w.job_id = ${filter.jobId ?? null}::uuid)
          AND (${filter.openOnly ?? false}::boolean IS NOT TRUE OR NOT s.is_terminal)
      `;
      // Ordering is the domain's job (`boardOrder`) — "overdue" needs the
      // CALLER's calendar day, which SQL here has no honest access to.
      return rows.map(toRecord);
    });
  }

  async findRecord(tenantId: string, workItemId: string): Promise<WorkItemRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<RecordRow[]>`
        ${db.unsafe(RECORD_SELECT)}
        WHERE w.id = ${workItemId}
      `;
      return row ? toRecord(row) : null;
    });
  }

  async update(
    tenantId: string,
    workItemId: string,
    patch: WorkItemPatch,
  ): Promise<WorkItem> {
    return withTenant(this.app, tenantId, async (db) => {
      // The service has already resolved absent fields to their current values,
      // so the SQL needs no dynamic assembly.
      const [row] = await db<ItemRow[]>`
        UPDATE delivery.work_item
        SET title = ${patch.title},
            description = ${patch.description},
            priority_id = ${patch.priorityId},
            due_on = ${patch.dueOn}::date,
            is_client_visible = ${patch.isClientVisible}
        WHERE id = ${workItemId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`work_item ${workItemId} vanished between the read and the write`);
      return toItem(row);
    });
  }

  /**
   * The state and its timestamps, in ONE statement.
   *
   * They cannot be two: 0051's trigger reads the state's flags and refuses a row
   * whose state and timestamps disagree, so a two-phase write is always refused
   * on the first phase — a blocked state with no reason yet, or a terminal one
   * with no completion time yet.
   */
  async setState(
    tenantId: string,
    workItemId: string,
    write: WorkItemStateWrite,
  ): Promise<WorkItem> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ItemRow[]>`
        UPDATE delivery.work_item
        SET state_id = ${write.stateId},
            blocked_reason = ${write.blockedReason},
            blocked_at = ${write.blockedAt}::timestamptz,
            started_at = ${write.startedAt}::timestamptz,
            completed_at = ${write.completedAt}::timestamptz
        WHERE id = ${workItemId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`work_item ${workItemId} vanished between the read and the write`);
      return toItem(row);
    });
  }

  async setAssignee(
    tenantId: string,
    workItemId: string,
    assigneeUserId: string | null,
    note: string | null,
  ): Promise<WorkItem> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ItemRow[]>`
        UPDATE delivery.work_item
        SET assignee_user_id = ${assigneeUserId},
            -- A CHECK refuses a note on an assigned row, so the two move
            -- together: assigning clears the sentence that explained why nobody
            -- had it, and un-assigning writes a new one.
            assignment_note = ${assigneeUserId === null ? note : null}
        WHERE id = ${workItemId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`work_item ${workItemId} vanished between the read and the write`);
      return toItem(row);
    });
  }

  // ── the checklist ────────────────────────────────────────────────────────

  async listChecklist(tenantId: string, workItemId: string): Promise<readonly ChecklistItem[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ChecklistRow[]>`
        SELECT id, tenant_id, work_item_id, label, sort_order, done_at, done_by_user_id
        FROM delivery.checklist_item
        WHERE work_item_id = ${workItemId}
        ORDER BY sort_order, label
      `;
      return rows.map(toChecklist);
    });
  }

  async addChecklistItem(item: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly label: string;
    readonly sortOrder: number;
  }): Promise<ChecklistItem> {
    return withTenant(this.app, item.tenantId, async (db) => {
      const [row] = await db<ChecklistRow[]>`
        INSERT INTO delivery.checklist_item
          (id, tenant_id, work_item_id, label, sort_order)
        VALUES (${item.id}, ${item.tenantId}, ${item.workItemId}, ${item.label},
                ${item.sortOrder})
        RETURNING id, tenant_id, work_item_id, label, sort_order, done_at, done_by_user_id
      `;
      if (!row) throw new Error("checklist_item insert returned no row");
      return toChecklist(row);
    });
  }

  async findChecklistItem(
    tenantId: string,
    checklistItemId: string,
  ): Promise<ChecklistItem | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ChecklistRow[]>`
        SELECT id, tenant_id, work_item_id, label, sort_order, done_at, done_by_user_id
        FROM delivery.checklist_item WHERE id = ${checklistItemId}
      `;
      return row ? toChecklist(row) : null;
    });
  }

  async setChecklistDone(
    tenantId: string,
    checklistItemId: string,
    doneAt: string | null,
    doneByUserId: string | null,
  ): Promise<ChecklistItem> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ChecklistRow[]>`
        UPDATE delivery.checklist_item
        SET done_at = ${doneAt}::timestamptz, done_by_user_id = ${doneByUserId}
        WHERE id = ${checklistItemId}
        RETURNING id, tenant_id, work_item_id, label, sort_order, done_at, done_by_user_id
      `;
      if (!row) throw new Error(`checklist_item ${checklistItemId} vanished before the write`);
      return toChecklist(row);
    });
  }

  /** One of only two DELETE grants in this schema, and a trigger refuses a
   *  TICKED line — the tick is the record that somebody did it and lives nowhere
   *  else. */
  async removeChecklistItem(tenantId: string, checklistItemId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`DELETE FROM delivery.checklist_item WHERE id = ${checklistItemId}`;
    });
  }

  // ── dependencies ─────────────────────────────────────────────────────────

  /** The whole edge list. Read whole so `wouldCycle` can walk it in the domain:
   *  reachability is not expressible in SQL, and a firm's edge list is tens to
   *  low hundreds of rows. */
  async listAllDependencies(tenantId: string): Promise<readonly WorkItemDependency[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DependencyRow[]>`
        SELECT id, tenant_id, work_item_id, depends_on_work_item_id
        FROM delivery.work_item_dependency
      `;
      return rows.map(toDependency);
    });
  }

  async addDependency(dep: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly dependsOnWorkItemId: string;
  }): Promise<WorkItemDependency> {
    return withTenant(this.app, dep.tenantId, async (db) => {
      const [row] = await db<DependencyRow[]>`
        INSERT INTO delivery.work_item_dependency
          (id, tenant_id, work_item_id, depends_on_work_item_id)
        VALUES (${dep.id}, ${dep.tenantId}, ${dep.workItemId}, ${dep.dependsOnWorkItemId})
        RETURNING id, tenant_id, work_item_id, depends_on_work_item_id
      `;
      if (!row) throw new Error("work_item_dependency insert returned no row");
      return toDependency(row);
    });
  }

  async findDependency(
    tenantId: string,
    dependencyId: string,
  ): Promise<WorkItemDependency | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DependencyRow[]>`
        SELECT id, tenant_id, work_item_id, depends_on_work_item_id
        FROM delivery.work_item_dependency WHERE id = ${dependencyId}
      `;
      return row ? toDependency(row) : null;
    });
  }

  async removeDependency(tenantId: string, dependencyId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`DELETE FROM delivery.work_item_dependency WHERE id = ${dependencyId}`;
    });
  }

  /** Unfinished is the blocker's state FLAG, never its code. */
  async openBlockers(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly WorkItemBlocker[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; title: string }[]>`
        SELECT b.id, b.title
        FROM delivery.work_item_dependency d
        JOIN delivery.work_item b
          ON b.id = d.depends_on_work_item_id AND b.tenant_id = d.tenant_id
        JOIN delivery.work_item_state bs
          ON bs.id = b.state_id AND bs.tenant_id = b.tenant_id
        WHERE d.work_item_id = ${workItemId} AND NOT bs.is_terminal
        ORDER BY b.title
      `;
      return rows.map((r) => ({ workItemId: r.id, title: r.title }));
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async insert(
    db: Parameters<Parameters<typeof withTenant>[2]>[0],
    item: NewWorkItem,
  ): Promise<ItemRow[]> {
    return db<ItemRow[]>`
      INSERT INTO delivery.work_item
        (id, tenant_id, client_party_id, entity_party_id, engagement_id, job_id,
         service_version_id, dept_axis_id, title, description, state_id, priority_id,
         assignee_user_id, assignment_note, due_on, is_statutory_due, sla_days_snapshot,
         is_client_visible)
      VALUES
        (${item.id}, ${item.tenantId}, ${item.clientPartyId}, ${item.entityPartyId},
         ${item.engagementId}, ${item.jobId}, ${item.serviceVersionId}, ${item.deptAxisId},
         ${item.title}, ${item.description}, ${item.stateId}, ${item.priorityId},
         ${item.assigneeUserId}, ${item.assignmentNote}, ${item.dueOn}::date,
         ${item.isStatutoryDue}, ${item.slaDaysSnapshot}, ${item.isClientVisible})
      RETURNING ${db.unsafe(COLUMNS)}
    `;
  }
}

function toChecklist(r: ChecklistRow): ChecklistItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workItemId: r.work_item_id,
    label: r.label,
    sortOrder: r.sort_order,
    doneAt: r.done_at,
    doneByUserId: r.done_by_user_id,
  };
}

function toDependency(r: DependencyRow): WorkItemDependency {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workItemId: r.work_item_id,
    dependsOnWorkItemId: r.depends_on_work_item_id,
  };
}
