// Who won the work of a letter (0355, Q049): `crm.letter_originator`, read
// through `crm.letter_originator_in_force` (a person's word, else the lead's
// owner, else who prepared the proposal). Names come from THIS firm's
// memberships, never straight from the global user account.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { LetterOriginatorRecord, OriginatorHow, OriginatorStore } from "../../usecase/originator/ports";
import { isoInstant } from "./instant";

export class PostgresOriginatorStore implements OriginatorStore {
  constructor(private readonly app: Db) {}

  find(tenantId: string, letterId: string): Promise<LetterOriginatorRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [r] = await db<
        {
          letter_id: string;
          ref: string;
          deleted: boolean;
          user_id: string | null;
          name: string | null;
          active: boolean | null;
          how: OriginatorHow;
          set_at: string | null;
          set_by: string | null;
          set_by_name: string | null;
        }[]
      >`
        SELECT l.id AS letter_id, l.ref, l.deleted_at IS NOT NULL AS deleted,
               o.originator_user_id AS user_id,
               who.name, who.active,
               o.how,
               ${db.unsafe(isoInstant("o.set_at", "set_at"))},
               o.set_by_user_id AS set_by,
               setter.name AS set_by_name
          FROM crm.engagement_letter l
          JOIN crm.letter_originator_in_force o
            ON o.engagement_letter_id = l.id AND o.tenant_id = l.tenant_id
          LEFT JOIN LATERAL (
            SELECT coalesce(nullif(btrim(u.display_name), ''), u.email::text) AS name, bool_or(m.is_active) AS active
              FROM tenancy.membership m
              JOIN tenancy.user_account u ON u.id = m.user_id
             WHERE m.tenant_id = l.tenant_id AND m.user_id = o.originator_user_id AND m.audience = 'STAFF'
             GROUP BY u.display_name, u.email
          ) who ON true
          LEFT JOIN LATERAL (
            SELECT coalesce(nullif(btrim(u.display_name), ''), u.email::text) AS name
              FROM tenancy.membership m
              JOIN tenancy.user_account u ON u.id = m.user_id
             WHERE m.tenant_id = l.tenant_id AND m.user_id = o.set_by_user_id AND m.audience = 'STAFF'
             LIMIT 1
          ) setter ON true
         WHERE l.id = ${letterId}
      `;
      if (r === undefined) return null;
      return {
        letterId: r.letter_id,
        letterRef: r.ref,
        deleted: r.deleted,
        userId: r.user_id,
        // A person from no membership here (only possible for an old lead
        // owner who never belonged to this firm) is shown as nobody's name.
        name: r.user_id === null ? null : r.name,
        activeStaff: r.active === true,
        how: r.how,
        setAt: r.set_at,
        setBy: r.set_by === null ? null : { userId: r.set_by, name: r.set_by_name },
      };
    });
  }

  async write(tenantId: string, letterId: string, userId: string | null, byUserId: string | null): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        INSERT INTO crm.letter_originator (tenant_id, engagement_letter_id, originator_user_id, set_by_user_id)
        VALUES (${tenantId}, ${letterId}, ${userId}, ${byUserId})
        ON CONFLICT (tenant_id, engagement_letter_id) DO UPDATE
          SET originator_user_id = EXCLUDED.originator_user_id,
              set_by_user_id     = EXCLUDED.set_by_user_id,
              set_at             = now()
      `;
    });
  }

  isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const [r] = await db<{ ok: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM tenancy.membership
           WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND audience = 'STAFF' AND is_active
        ) AS ok
      `;
      return r?.ok === true;
    });
  }
}
