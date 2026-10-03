// Notifications by email, in Postgres (0324). Worker-only, under `withTenant`.
//
// The two claims live here: `emailed_at` set where still null (RETURNING says
// which rows THIS call won), and `notify.email_digest` inserted ON CONFLICT DO
// NOTHING (a row back means this call owns that person's daily email).
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { NotifyCategory } from "../../domain/notify/model";
import { DEFAULT_DIGEST_HOUR, isNotifyCategory } from "../../domain/notify/model";
import type {
  EmailRecipient,
  NotificationEmailStore,
  NotificationRecord,
  Unemailed,
} from "../../usecase/notify/ports";
import { readRecords } from "./notification-repository";

export class PostgresNotificationEmailStore implements NotificationEmailStore {
  constructor(private readonly app: Db) {}

  async activeTenantIds(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }

  async firmName(tenantId: string): Promise<string | null> {
    const [row] = await this.app<{ name: string | null }[]>`SELECT name FROM tenancy.tenant WHERE id = ${tenantId}`;
    return row?.name ?? null;
  }

  async digestHour(tenantId: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ digest_hour: number }[]>`
        SELECT digest_hour FROM notify.firm_setting WHERE tenant_id = ${tenantId}
      `;
      return row?.digest_hour ?? DEFAULT_DIGEST_HOUR;
    });
  }

  async setDigestHour(tenantId: string, byUserId: string, hour: number): Promise<{ readonly from: number; readonly to: number }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [before] = await db<{ digest_hour: number }[]>`
        SELECT digest_hour FROM notify.firm_setting WHERE tenant_id = ${tenantId} FOR UPDATE
      `;
      await db`
        INSERT INTO notify.firm_setting (tenant_id, digest_hour, updated_by_user_id)
        VALUES (${tenantId}, ${hour}, ${byUserId})
        ON CONFLICT (tenant_id) DO UPDATE
          SET digest_hour = EXCLUDED.digest_hour, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `;
      return { from: before?.digest_hour ?? DEFAULT_DIGEST_HOUR, to: hour };
    });
  }

  async unemailed(tenantId: string, categories: readonly NotifyCategory[], since: string): Promise<readonly Unemailed[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; recipient_user_id: string; category: string }[]>`
        SELECT id, recipient_user_id, category
        FROM notify.notification
        WHERE tenant_id = ${tenantId}
          AND emailed_at IS NULL
          AND resolved_at IS NULL
          AND read_at IS NULL
          AND category = ANY(${categories as string[]})
          AND created_at > ${since}::timestamptz
        ORDER BY created_at, id
      `;
      return rows.flatMap((r) =>
        isNotifyCategory(r.category) ? [{ id: r.id, recipientUserId: r.recipient_user_id, category: r.category }] : [],
      );
    });
  }

  async claimEmailed(tenantId: string, ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        UPDATE notify.notification SET emailed_at = now()
        WHERE tenant_id = ${tenantId} AND id = ANY(${ids as string[]}::uuid[]) AND emailed_at IS NULL
        RETURNING id
      `;
      return rows.map((r) => r.id);
    });
  }

  async releaseEmailed(tenantId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE notify.notification SET emailed_at = NULL
        WHERE tenant_id = ${tenantId} AND id = ANY(${ids as string[]}::uuid[])
      `;
    });
  }

  async recordsByIds(tenantId: string, ids: readonly string[]): Promise<readonly NotificationRecord[]> {
    if (ids.length === 0) return [];
    return withTenant(this.app, tenantId, (db) => readRecords(db, tenantId, { kind: "ids", ids }));
  }

  async recipients(tenantId: string, userIds: readonly string[]): Promise<readonly EmailRecipient[]> {
    if (userIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ user_id: string; email: string; display_name: string | null; sees_fees: boolean }[]>`
        SELECT m.user_id, u.email::text AS email, u.display_name, m.commercial_visibility AS sees_fees
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        WHERE m.tenant_id = ${tenantId}
          AND m.audience = 'STAFF' AND m.is_active
          AND u.status = 'active'
          AND m.user_id = ANY(${userIds as string[]}::uuid[])
      `;
      return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, seesFees: r.sees_fees }));
    });
  }

  async staffWithoutDigest(tenantId: string, day: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ user_id: string }[]>`
        SELECT DISTINCT m.user_id
        FROM tenancy.membership m
        WHERE m.tenant_id = ${tenantId} AND m.audience = 'STAFF' AND m.is_active
          AND NOT EXISTS (
            SELECT 1 FROM notify.email_digest d
            WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id AND d.digest_day = ${day}::date
          )
      `;
      return rows.map((r) => r.user_id);
    });
  }

  async claimDigest(tenantId: string, userId: string, day: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db`
        INSERT INTO notify.email_digest (tenant_id, user_id, digest_day)
        VALUES (${tenantId}, ${userId}, ${day}::date)
        ON CONFLICT DO NOTHING
        RETURNING 1
      `;
      return rows.length === 1;
    });
  }

  async markDigest(tenantId: string, userId: string, day: string, notifications: number, sent: boolean): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE notify.email_digest
        SET notifications = ${notifications}, sent_at = CASE WHEN ${sent} THEN now() ELSE NULL END
        WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND digest_day = ${day}::date
      `;
    });
  }
}
