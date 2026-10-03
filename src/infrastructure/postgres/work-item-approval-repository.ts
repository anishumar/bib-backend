// Postgres adapter for work-item reviews (T3.1) — the second approval table,
// beside `step-approval-repository`. Migration 0051 argues why there are two:
// a step approval hangs off a `job_step`, so work with no template could never
// be reviewed, and *"every task is mostly reviewed"* is the client's own words
// about the TASK.
//
// What is NOT duplicated is the rule about who may check. That is T2.9's
// `isEligible`, pure, applied by the use case to both.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ApprovalDecision, WorkItemApproval, WorkItemCheck } from "../../domain/workitem/model";
import type {
  ApprovalDecisionWrite,
  NewWorkItemApproval,
  WorkItemApprovalRepository,
} from "../../usecase/workitem/ports";

interface ApprovalRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  submitted_by: string | null;
  submitted_at: string;
  policy_version_id: string | null;
  policy_key: string | null;
  request_note: string | null;
  decision: string;
  notes: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

interface CheckRow extends ApprovalRow {
  work_item_title: string;
  client_name: string;
  client_party_id: string;
  entity_party_id: string | null;
  entity_name: string | null;
  due_on: string | null;
  submitted_by_name: string | null;
  policy_label: string | null;
}

function toApproval(r: ApprovalRow): WorkItemApproval {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workItemId: r.work_item_id,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    policyVersionId: r.policy_version_id,
    policyKey: r.policy_key,
    requestNote: r.request_note,
    // The CHECK constraint guarantees this, so the cast states a fact the
    // database already enforces rather than hoping for one.
    decision: r.decision as ApprovalDecision,
    notes: r.notes,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

function toCheck(r: CheckRow): WorkItemCheck {
  return {
    approval: toApproval(r),
    workItemId: r.work_item_id,
    workItemTitle: r.work_item_title,
    clientName: r.client_name,
    clientPartyId: r.client_party_id,
    entityPartyId: r.entity_party_id,
    entityName: r.entity_name,
    dueOn: r.due_on,
    submittedByName: r.submitted_by_name,
    policyLabel: r.policy_label,
  };
}

const COLUMNS =
  "id, tenant_id, work_item_id, submitted_by, submitted_at, policy_version_id, " +
  "policy_key, request_note, decision, notes, decided_by, decided_at";

/**
 * The queue's row, resolved.
 *
 * The policy LABEL comes out of the PINNED version's body, so a queue can say
 * "Manager review" without the caller resolving a config version per row — and
 * it says what the rule was called WHEN THE CHECK OPENED, not what today's
 * version of it is called.
 */
const CHECK_SELECT = `
  SELECT a.id, a.tenant_id, a.work_item_id, a.submitted_by, a.submitted_at,
         a.policy_version_id, a.policy_key, a.request_note, a.decision, a.notes, a.decided_by,
         a.decided_at,
         w.title AS work_item_title,
         cp.display_name AS client_name,
         w.client_party_id,
         -- The company the work is for, when it names one (F32).
         w.entity_party_id, ep.display_name AS entity_name,
         -- A DAY, read as text: no Date is built, so no zone can move it.
         w.due_on::text AS due_on,
         mk.display_name AS submitted_by_name,
         v.body ->> 'label' AS policy_label
  FROM delivery.work_item_approval a
  JOIN delivery.work_item w ON w.id = a.work_item_id AND w.tenant_id = a.tenant_id
  JOIN core.party cp ON cp.id = w.client_party_id AND cp.tenant_id = w.tenant_id
  LEFT JOIN core.party ep ON ep.id = w.entity_party_id AND ep.tenant_id = w.tenant_id
  -- By id alone: tenancy.user_account is GLOBAL and has no tenant_id to join on.
  LEFT JOIN tenancy.user_account mk ON mk.id = a.submitted_by
  LEFT JOIN config.version v ON v.id = a.policy_version_id AND v.tenant_id = a.tenant_id
`;

export class PostgresWorkItemApprovalRepository implements WorkItemApprovalRepository {
  constructor(private readonly app: Db) {}

  /**
   * Open a check, unless one is already open.
   *
   * `submitted_by` is deliberately ABSENT from the column list: a BEFORE INSERT
   * trigger derives it from `work_item.assignee_user_id`. A maker the
   * application could set is not a maker-checker control, because the way past
   * the CHECK would be to name somebody else as the maker and approve it
   * yourself. Do not add it here.
   *
   * The unique partial index (`WHERE decision = 'pending'`) turns a second
   * simultaneous request into a conflict, which becomes null — "already open"
   * rather than an error.
   */
  async openIfAbsent(approval: NewWorkItemApproval): Promise<WorkItemApproval | null> {
    return withTenant(this.app, approval.tenantId, async (db) => {
      const rows = await db<ApprovalRow[]>`
        INSERT INTO delivery.work_item_approval
          (id, tenant_id, work_item_id, policy_version_id, policy_key, request_note)
        VALUES (${approval.id}, ${approval.tenantId}, ${approval.workItemId},
                ${approval.policyVersionId}, ${approval.policyKey}, ${approval.requestNote})
        ON CONFLICT (work_item_id) WHERE decision = 'pending' DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      const row = rows[0];
      return row ? toApproval(row) : null;
    });
  }

  async findById(tenantId: string, approvalId: string): Promise<WorkItemApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ApprovalRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.work_item_approval WHERE id = ${approvalId}
      `;
      return row ? toApproval(row) : null;
    });
  }

  async findOpenFor(tenantId: string, workItemId: string): Promise<WorkItemApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ApprovalRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.work_item_approval
        WHERE work_item_id = ${workItemId} AND decision = 'pending'
      `;
      return row ? toApproval(row) : null;
    });
  }

  /**
   * Decide, only if it is still pending.
   *
   * Conditional in SQL, not in the service: two people can be looking at the
   * same queue and both click. Null means somebody else got there first, and
   * their decision is the one that stands.
   */
  async decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<WorkItemApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ApprovalRow[]>`
        UPDATE delivery.work_item_approval
        SET decision = ${write.decision},
            notes = ${write.notes},
            decided_by = ${write.decidedBy},
            decided_at = ${write.decidedAt}::timestamptz
        WHERE id = ${approvalId} AND decision = 'pending'
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toApproval(row) : null;
    });
  }

  async listPending(tenantId: string): Promise<readonly WorkItemCheck[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<CheckRow[]>`
        ${db.unsafe(CHECK_SELECT)}
        WHERE a.decision = 'pending'
        ORDER BY a.submitted_at
      `;
      return rows.map(toCheck);
    });
  }

  /** Every check this item has ever had, newest first. The REJECTIONS are the
   *  point: a list of only open ones makes work that was sent back twice read
   *  as work that sailed through. */
  async listForWorkItem(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly WorkItemCheck[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<CheckRow[]>`
        ${db.unsafe(CHECK_SELECT)}
        WHERE a.work_item_id = ${workItemId}
        ORDER BY a.submitted_at DESC
      `;
      return rows.map(toCheck);
    });
  }
}
