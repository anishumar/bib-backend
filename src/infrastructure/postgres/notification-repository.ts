// Notifications, in Postgres (0323): one colleague's inbox, and who hears what.
//
// Three things live here and nowhere else:
//
//   THE SECOND WALL. Every inbox method runs inside `withRecipient`, which arms
//   the restrictive policy on `notify.notification`, AND filters on the
//   recipient in its own WHERE. Either alone keeps one colleague out of
//   another's bell; the integration test removes each in turn.
//
//   THE NAMES, JOINED AT READ TIME. A row stores ids; the client, the subject
//   (a task's title, a proposal's reference, an invoice number) and the person
//   who acted are read from where they live now, so a correction made today
//   reads correctly in yesterday's notification.
//
//   ONE CLOCK FOR PAGING. `isoInstant` writes milliseconds and Postgres keeps
//   microseconds, so the list orders, pages and marks by the instant truncated
//   to the millisecond — the same instant the client was handed back. Comparing
//   the full value against a truncated cursor would skip the rows inside that
//   millisecond.
import type { Db } from "../../db/pool";
import { withRecipient, withTenant } from "../../db/tenant";
import type { NotifyCategory, NotifyChannel } from "../../domain/notify/model";
import { channelEnabled, isNotifyCategory, isNotifyChannel } from "../../domain/notify/model";
import type {
  ChannelChange,
  ChannelSetting,
  InboxQuery,
  NotificationInbox,
  NotificationRecord,
  NotificationSettingsStore,
} from "../../usecase/notify/ports";
import { isoInstant } from "./instant";
import { MAX_LIST_ROWS } from "../../db/limits";

const MS = (expr: string): string => `date_trunc('milliseconds', ${expr})`;

interface InboxRow {
  id: string;
  category: string;
  source_type: string;
  source_id: string;
  payload: Record<string, unknown>;
  actor_name: string | null;
  client_name: string | null;
  subject_label: string | null;
  created_at: string;
  read_at: string | null;
  resolved_at: string | null;
}

/** Which notifications a read wants: one person's page, or named rows (email). */
type RecordFilter =
  | { readonly kind: "inbox"; readonly userId: string; readonly q: InboxQuery }
  | { readonly kind: "ids"; readonly ids: readonly string[] };

/**
 * Notifications with their names joined: the ONE query the bell, the list and
 * the emails share, so a notification reads the same everywhere.
 */
export async function readRecords(
  db: Db,
  tenantId: string,
  filter: RecordFilter,
): Promise<readonly (NotificationRecord & { readonly recipientUserId: string })[]> {
  const q = filter.kind === "inbox" ? filter.q : null;
  const rows = await db<(InboxRow & { recipient_user_id: string })[]>`
        SELECT n.id,
               n.recipient_user_id,
               n.category,
               n.source_type,
               n.source_id,
               -- What the read adds for the words and the link: a step's own
               -- label, and the task an ask was raised on.
               n.payload || jsonb_strip_nulls(jsonb_build_object(
                 'stepLabel', js.label,
                 'workItemId', ca.work_item_id
               )) AS payload,
               COALESCE(NULLIF(btrim(au.display_name), ''), au.email) AS actor_name,
               client.display_name AS client_name,
               CASE n.source_type
                 WHEN 'work_item'           THEN wi.title
                 WHEN 'job'                 THEN jwi.title
                 WHEN 'client_request'      THEN cr.subject
                 WHEN 'lead'                THEN ld.title
                 WHEN 'proposal'            THEN pr.ref
                 WHEN 'engagement_letter'   THEN el.ref
                 WHEN 'invoice'             THEN inv.number
                 WHEN 'billing_due'         THEN COALESCE(bel.ref, bd.period_label)
                 WHEN 'client_ask'          THEN caw.title
                 WHEN 'obligation_instance' THEN concat_ws(' ', ot.name, oi.period_label)
               END AS subject_label,
               ${db.unsafe(isoInstant("n.created_at", "created_at"))},
               ${db.unsafe(isoInstant("n.read_at", "read_at"))},
               ${db.unsafe(isoInstant("n.resolved_at", "resolved_at"))}
        FROM notify.notification n
        LEFT JOIN tenancy.user_account au ON au.id = n.actor_user_id
        LEFT JOIN delivery.work_item wi
          ON n.source_type = 'work_item' AND wi.id = n.source_id AND wi.tenant_id = n.tenant_id
        -- A job has no title of its own; its first task names it, the way the
        -- work board does.
        LEFT JOIN LATERAL (
          SELECT w.title, w.client_party_id
          FROM delivery.work_item w
          WHERE w.job_id = n.source_id AND w.tenant_id = n.tenant_id
          ORDER BY w.created_at, w.id
          LIMIT 1
        ) jwi ON n.source_type = 'job'
        LEFT JOIN delivery.job_step js
          ON n.source_type = 'job' AND js.job_id = n.source_id AND js.tenant_id = n.tenant_id
         AND js.step_key = n.payload->>'stepKey'
        LEFT JOIN delivery.client_ask ca
          ON n.source_type = 'client_ask' AND ca.id = n.source_id AND ca.tenant_id = n.tenant_id
        LEFT JOIN delivery.work_item caw
          ON caw.id = ca.work_item_id AND caw.tenant_id = ca.tenant_id
        LEFT JOIN delivery.client_request cr
          ON n.source_type = 'client_request' AND cr.id = n.source_id AND cr.tenant_id = n.tenant_id
        LEFT JOIN crm.lead ld
          ON n.source_type = 'lead' AND ld.id = n.source_id AND ld.tenant_id = n.tenant_id
        LEFT JOIN crm.proposal pr
          ON n.source_type = 'proposal' AND pr.id = n.source_id AND pr.tenant_id = n.tenant_id
        LEFT JOIN crm.engagement_letter el
          ON n.source_type = 'engagement_letter' AND el.id = n.source_id AND el.tenant_id = n.tenant_id
        LEFT JOIN crm.invoice inv
          ON n.source_type = 'invoice' AND inv.id = n.source_id AND inv.tenant_id = n.tenant_id
        LEFT JOIN crm.billing_due bd
          ON n.source_type = 'billing_due' AND bd.id = n.source_id AND bd.tenant_id = n.tenant_id
        -- An advance is named by its letter.
        LEFT JOIN crm.engagement_letter bel
          ON bel.id = bd.engagement_letter_id AND bel.tenant_id = bd.tenant_id
        LEFT JOIN delivery.obligation_instance oi
          ON n.source_type = 'obligation_instance' AND oi.id = n.source_id AND oi.tenant_id = n.tenant_id
        LEFT JOIN delivery.obligation_template ot
          ON ot.id = oi.template_id AND ot.tenant_id = oi.tenant_id
        -- The client is the one the source names. A filing is owed by an ENTITY,
        -- which is the company its notification should name.
        LEFT JOIN core.party client
          ON client.tenant_id = n.tenant_id
         AND client.id = COALESCE(wi.client_party_id, jwi.client_party_id, ca.client_party_id, cr.client_party_id,
                                  ld.party_id, pr.party_id, el.party_id, inv.party_id,
                                  bd.party_id, oi.entity_party_id)
        WHERE n.tenant_id = ${tenantId}
        ${
          filter.kind === "ids"
            ? db`AND n.id = ANY(${filter.ids as string[]}::uuid[])`
            : db`
          AND n.recipient_user_id = ${filter.userId}
          AND (${!(q?.unreadOnly ?? false)} OR (n.read_at IS NULL AND n.resolved_at IS NULL))
          AND (${q?.category ?? null}::text IS NULL OR n.category = ${q?.category ?? null})
          AND (${q?.before?.createdAt ?? null}::timestamptz IS NULL
               OR (${db.unsafe(MS("n.created_at"))}, n.id)
                  < (${q?.before?.createdAt ?? null}::timestamptz, ${q?.before?.id ?? null}::uuid))`
        }
        ORDER BY ${db.unsafe(MS("n.created_at"))} DESC, n.id DESC
        LIMIT ${q?.limit ?? MAX_LIST_ROWS}
  `;
  return rows.flatMap((r) => {
    // A category this build no longer knows is a row from a later release
    // read by an older one; skipping it beats rendering a sentence for it.
    if (!isNotifyCategory(r.category)) return [];
    return [
      {
        id: r.id,
        recipientUserId: r.recipient_user_id,
        category: r.category,
        sourceType: r.source_type,
        sourceId: r.source_id,
        payload: r.payload,
        actorName: r.actor_name,
        clientName: r.client_name,
        subjectLabel: r.subject_label,
        createdAt: r.created_at,
        readAt: r.read_at,
        resolvedAt: r.resolved_at,
      },
    ];
  });
}

export class PostgresNotificationInbox implements NotificationInbox {
  constructor(private readonly app: Db) {}

  async list(tenantId: string, userId: string, q: InboxQuery): Promise<readonly NotificationRecord[]> {
    return withRecipient(this.app, tenantId, userId, (db) => readRecords(db, tenantId, { kind: "inbox", userId, q }));
  }

  async unreadCount(tenantId: string, userId: string, cap: number): Promise<number> {
    return withRecipient(this.app, tenantId, userId, async (db) => {
      const [row] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM (
          SELECT 1
          FROM notify.notification
          WHERE tenant_id = ${tenantId}
            AND recipient_user_id = ${userId}
            AND read_at IS NULL
            AND resolved_at IS NULL
          LIMIT ${cap}
        ) unread
      `;
      return row?.n ?? 0;
    });
  }

  async markRead(tenantId: string, userId: string, id: string): Promise<{ readonly readAt: string } | null> {
    return withRecipient(this.app, tenantId, userId, async (db) => {
      const [row] = await db<{ read_at: string }[]>`
        UPDATE notify.notification
        SET read_at = COALESCE(read_at, now())
        WHERE tenant_id = ${tenantId}
          AND recipient_user_id = ${userId}
          AND id = ${id}
        RETURNING ${db.unsafe(isoInstant("read_at", "read_at"))}
      `;
      return row === undefined ? null : { readAt: row.read_at };
    });
  }

  async markAllRead(tenantId: string, userId: string, upTo: string | null): Promise<number> {
    return withRecipient(this.app, tenantId, userId, async (db) => {
      const rows = await db`
        UPDATE notify.notification
        SET read_at = now()
        WHERE tenant_id = ${tenantId}
          AND recipient_user_id = ${userId}
          AND read_at IS NULL
          AND (${upTo}::timestamptz IS NULL OR ${db.unsafe(MS("created_at"))} <= ${upTo}::timestamptz)
        RETURNING 1
      `;
      return rows.length;
    });
  }
}

interface SettingRow {
  category: string;
  channel: string;
  enabled: boolean;
}

function toSettings(rows: readonly SettingRow[]): readonly ChannelSetting[] {
  return rows.flatMap((r) =>
    isNotifyCategory(r.category) && isNotifyChannel(r.channel)
      ? [{ category: r.category, channel: r.channel, enabled: r.enabled }]
      : [],
  );
}

export class PostgresNotificationSettings implements NotificationSettingsStore {
  constructor(private readonly app: Db) {}

  async firmDefaults(tenantId: string): Promise<readonly ChannelSetting[]> {
    return withTenant(this.app, tenantId, async (db) =>
      toSettings(await db<SettingRow[]>`
        SELECT category, channel, enabled FROM notify.firm_default WHERE tenant_id = ${tenantId}
      `),
    );
  }

  async userPreferences(tenantId: string, userId: string): Promise<readonly ChannelSetting[]> {
    return withTenant(this.app, tenantId, async (db) =>
      toSettings(await db<SettingRow[]>`
        SELECT category, channel, enabled
        FROM notify.user_preference
        WHERE tenant_id = ${tenantId} AND user_id = ${userId}
      `),
    );
  }

  async setFirmDefaults(
    tenantId: string,
    byUserId: string,
    rows: readonly ChannelSetting[],
  ): Promise<readonly ChannelChange[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const changes: ChannelChange[] = [];
      for (const r of rows) {
        // FOR UPDATE: two administrators saving at once each see the other's
        // value as `from`, so the ledger's two rows chain rather than both
        // claiming to have moved it from the same place.
        const [before] = await db<{ enabled: boolean }[]>`
          SELECT enabled FROM notify.firm_default
          WHERE tenant_id = ${tenantId} AND category = ${r.category} AND channel = ${r.channel}
          FOR UPDATE
        `;
        await db`
          INSERT INTO notify.firm_default (tenant_id, category, channel, enabled, updated_by_user_id)
          VALUES (${tenantId}, ${r.category}, ${r.channel}, ${r.enabled}, ${byUserId})
          ON CONFLICT (tenant_id, category, channel)
          DO UPDATE SET enabled = EXCLUDED.enabled,
                        updated_by_user_id = EXCLUDED.updated_by_user_id,
                        updated_at = now()
        `;
        const from = before?.enabled ?? null;
        if ((from ?? productDefault(r.category, r.channel)) !== r.enabled) {
          changes.push({ category: r.category, channel: r.channel, from, to: r.enabled });
        }
      }
      return changes;
    });
  }

  async setUserPreferences(tenantId: string, userId: string, rows: readonly ChannelSetting[]): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      for (const r of rows) {
        await db`
          INSERT INTO notify.user_preference (tenant_id, user_id, category, channel, enabled)
          VALUES (${tenantId}, ${userId}, ${r.category}, ${r.channel}, ${r.enabled})
          ON CONFLICT (tenant_id, user_id, category, channel)
          DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
        `;
      }
    });
  }
}

function productDefault(category: NotifyCategory, channel: NotifyChannel): boolean {
  return channelEnabled(category, channel, undefined, undefined);
}
