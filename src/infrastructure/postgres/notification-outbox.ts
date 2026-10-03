// The notification writers' side, in Postgres (0323): the outbox over the
// ledger, and the relationships a notification is addressed by.
//
// Everything here runs in the WORKER under `withTenant` — never
// `withRecipient` — because it writes for many people and resolves by source.
//
// ── THE CURSOR KEEPS MICROSECONDS ──────────────────────────────────────────
//
// `recorded_at` is compared against the cursor, and `isoInstant` (milliseconds)
// would round the cursor below events it has already passed. Harmless (they are
// re-read and refused by the dedupe key) but noisy, so the cursor travels at
// full precision. It never reaches a browser.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { NotifyCategory } from "../../domain/notify/model";
import type {
  NewNotification,
  NotificationOutbox,
  NotifyDirectory,
  OpenReminder,
  OutboxEvent,
  ResolveCriteria,
  StaffMember,
} from "../../usecase/notify/ports";
import { fullInstant } from "./instant";


interface EventRow {
  id: string;
  verb: string;
  object_id: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  recorded_at: string;
}

export class PostgresNotificationOutbox implements NotificationOutbox {
  constructor(private readonly app: Db) {}

  async activeTenantIds(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }

  async cursor(tenantId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ at: string }[]>`
        SELECT ${db.unsafe(fullInstant("recorded_through", "at"))}
        FROM notify.fanout_cursor WHERE tenant_id = ${tenantId}
      `;
      return row?.at ?? null;
    });
  }

  async startCursor(tenantId: string, aheadMs: number): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        INSERT INTO notify.fanout_cursor (tenant_id, recorded_through)
        VALUES (${tenantId}, now() + make_interval(secs => ${aheadMs / 1000}))
        ON CONFLICT (tenant_id) DO NOTHING
      `;
    });
  }

  async eventsAfter(
    tenantId: string,
    overlapFrom: string,
    cursor: string,
    verbs: readonly string[],
    limit: number,
  ): Promise<readonly OutboxEvent[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<EventRow[]>`
        SELECT id, verb, object_id, actor_user_id, payload, ${db.unsafe(fullInstant("recorded_at", "recorded_at"))}
        FROM (
          (SELECT e.id, e.verb, e.object_id, e.payload, e.recorded_at,
                  CASE WHEN e.actor_type = 'human' THEN e.actor_id END AS actor_user_id
             FROM ledger.event e
            WHERE e.tenant_id = ${tenantId}
              AND e.recorded_at >  ${overlapFrom}::timestamptz
              AND e.recorded_at <= ${cursor}::timestamptz
              AND e.verb = ANY(${verbs as string[]}))
          UNION ALL
          (SELECT e.id, e.verb, e.object_id, e.payload, e.recorded_at,
                  CASE WHEN e.actor_type = 'human' THEN e.actor_id END AS actor_user_id
             FROM ledger.event e
            WHERE e.tenant_id = ${tenantId}
              AND e.recorded_at > ${cursor}::timestamptz
              AND e.verb = ANY(${verbs as string[]})
            ORDER BY e.recorded_at, e.id
            LIMIT ${limit})
        ) ev
        ORDER BY ev.recorded_at, ev.id
      `;
      return rows.map((r) => ({
        id: r.id,
        verb: r.verb,
        objectId: r.object_id,
        actorUserId: r.actor_user_id,
        payload: r.payload,
        recordedAt: r.recorded_at,
      }));
    });
  }

  async advanceCursor(tenantId: string, to: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE notify.fanout_cursor
        SET recorded_through = GREATEST(recorded_through, ${to}::timestamptz), updated_at = now()
        WHERE tenant_id = ${tenantId}
      `;
    });
  }

  async insert(rows: readonly NewNotification[]): Promise<number> {
    const first = rows[0];
    if (first === undefined) return 0;
    return withTenant(this.app, first.tenantId, async (db) => {
      let created = 0;
      for (const r of rows) {
        // One firm per call, by construction: every row names the same firm the
        // transaction is scoped to, and RLS's WITH CHECK refuses one that does not.
        const inserted = await db`
          INSERT INTO notify.notification
            (tenant_id, recipient_user_id, category, source_type, source_id, payload,
             event_id, actor_user_id, dedupe_key)
          VALUES (${r.tenantId}, ${r.recipientUserId}, ${r.category}, ${r.sourceType}, ${r.sourceId},
                  ${db.json(r.payload as Record<string, never>)}, ${r.eventId}, ${r.actorUserId}, ${r.dedupeKey})
          ON CONFLICT (tenant_id, recipient_user_id, dedupe_key) DO NOTHING
          RETURNING 1
        `;
        created += inserted.length;
      }
      return created;
    });
  }

  async resolve(tenantId: string, c: ResolveCriteria): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      // CAUSED BEFORE the resolving event: the causing event's own
      // `recorded_at`, or a reminder's creation. A re-read of an old "task
      // finished" must not close the notification for the task's NEXT round.
      const rows = await db`
        UPDATE notify.notification n
        SET resolved_at = now()
        WHERE n.tenant_id = ${tenantId}
          AND n.source_type = ${c.sourceType}
          AND n.source_id = ${c.sourceId}
          AND n.resolved_at IS NULL
          AND n.category = ANY(${c.categories as string[]})
          AND (${c.stepKey ?? null}::text IS NULL OR n.payload->>'stepKey' = ${c.stepKey ?? null})
          AND (${c.exceptRecipient ?? null}::uuid IS NULL OR n.recipient_user_id <> ${c.exceptRecipient ?? null}::uuid)
          AND COALESCE(
                (SELECT e.recorded_at FROM ledger.event e WHERE e.id = n.event_id AND e.tenant_id = n.tenant_id),
                n.created_at
              ) < ${c.causedBefore}::timestamptz
        RETURNING 1
      `;
      return rows.length;
    });
  }

  async openReminders(tenantId: string, category: NotifyCategory): Promise<readonly OpenReminder[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; source_id: string; stage: string | null }[]>`
        SELECT id, source_id, payload->>'stage' AS stage
        FROM notify.notification
        WHERE tenant_id = ${tenantId} AND category = ${category} AND resolved_at IS NULL
      `;
      return rows.map((r) => ({ id: r.id, sourceId: r.source_id, stage: r.stage }));
    });
  }

  async resolveIds(tenantId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db`
        UPDATE notify.notification SET resolved_at = now()
        WHERE tenant_id = ${tenantId} AND id = ANY(${ids as string[]}::uuid[]) AND resolved_at IS NULL
        RETURNING 1
      `;
      return rows.length;
    });
  }

  async prune(tenantId: string, before: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ n: number }[]>`SELECT notify.prune(${before}::timestamptz) AS n`;
      return row?.n ?? 0;
    });
  }
}

export class PostgresNotifyDirectory implements NotifyDirectory {
  constructor(private readonly app: Db) {}

  async activeStaff(tenantId: string): Promise<readonly StaffMember[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ user_id: string; role: string; rank: number | null }[]>`
        SELECT m.user_id, m.role, g.rank
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        LEFT JOIN tenancy.staff_grade g ON g.id = m.grade_id AND g.tenant_id = m.tenant_id
        WHERE m.tenant_id = ${tenantId} AND m.audience = 'STAFF' AND m.is_active
      `;
      return rows.map((r) => ({ userId: r.user_id, role: r.role, gradeRank: r.rank }));
    });
  }

  async keyManagerOf(tenantId: string, clientPartyId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // In force on the FIRM's day, the same reading the advance reminders use.
      const [row] = await db<{ user_id: string }[]>`
        SELECT a.user_id
        FROM crm.client_assignment a
        JOIN tenancy.tenant t ON t.id = a.tenant_id
        WHERE a.tenant_id = ${tenantId}
          AND a.client_party_id = ${clientPartyId}
          AND a.role = 'key_manager'
          AND a.valid_from <= (now() AT TIME ZONE t.time_zone)::date
          AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE t.time_zone)::date)
        ORDER BY a.valid_from DESC
        LIMIT 1
      `;
      return row?.user_id ?? null;
    });
  }

  async workItemAssignee(tenantId: string, workItemId: string): Promise<string | null> {
    return this.oneUser(tenantId, "delivery.work_item", "assignee_user_id", workItemId);
  }

  async proposalPreparer(tenantId: string, proposalId: string): Promise<string | null> {
    return this.oneUser(tenantId, "crm.proposal", "prepared_by_user_id", proposalId);
  }

  async letterSender(tenantId: string, letterId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ actor_id: string }[]>`
        SELECT actor_id FROM ledger.event
        WHERE tenant_id = ${tenantId}
          AND object_type = 'engagement_letter' AND object_id = ${letterId}
          AND verb = 'engagement_letter.sent' AND actor_type = 'human'
        ORDER BY recorded_at DESC
        LIMIT 1
      `;
      return row?.actor_id ?? null;
    });
  }

  async invoiceOwner(tenantId: string, invoiceId: string) {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ manager_user_id: string | null; party_id: string }[]>`
        SELECT manager_user_id, party_id FROM crm.invoice WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
      `;
      return row === undefined ? null : { managerUserId: row.manager_user_id, clientPartyId: row.party_id };
    });
  }

  async dueOwner(tenantId: string, dueId: string) {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ manager_user_id: string | null; party_id: string }[]>`
        SELECT manager_user_id, party_id FROM crm.billing_due WHERE tenant_id = ${tenantId} AND id = ${dueId}
      `;
      return row === undefined ? null : { managerUserId: row.manager_user_id, clientPartyId: row.party_id };
    });
  }

  async requestOwner(tenantId: string, requestId: string) {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ assignee_user_id: string | null; client_party_id: string }[]>`
        SELECT assignee_user_id, client_party_id FROM delivery.client_request
        WHERE tenant_id = ${tenantId} AND id = ${requestId}
      `;
      return row === undefined ? null : { assigneeUserId: row.assignee_user_id, clientPartyId: row.client_party_id };
    });
  }

  async askOwner(tenantId: string, askId: string) {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ raised_by: string | null; assignee_user_id: string | null }[]>`
        SELECT a.raised_by, wi.assignee_user_id
        FROM delivery.client_ask a
        JOIN delivery.work_item wi ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
        WHERE a.tenant_id = ${tenantId} AND a.id = ${askId}
      `;
      return row === undefined ? null : { raisedBy: row.raised_by, assigneeUserId: row.assignee_user_id };
    });
  }

  async pendingStepApproval(tenantId: string, jobId: string, stepKey: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string }[]>`
        SELECT sa.id
        FROM delivery.step_approval sa
        JOIN delivery.job_step js ON js.id = sa.job_step_id AND js.tenant_id = sa.tenant_id
        WHERE sa.tenant_id = ${tenantId} AND sa.job_id = ${jobId}
          AND js.step_key = ${stepKey} AND sa.decision = 'pending'
        ORDER BY sa.created_at DESC
        LIMIT 1
      `;
      return row?.id ?? null;
    });
  }

  private async oneUser(tenantId: string, table: string, column: string, id: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ user_id: string | null }[]>`
        SELECT ${db(column)} AS user_id FROM ${db(table)} WHERE tenant_id = ${tenantId} AND id = ${id}
      `;
      return row?.user_id ?? null;
    });
  }
}
