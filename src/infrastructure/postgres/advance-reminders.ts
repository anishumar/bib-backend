// Who is reminded about an advance, and the firm's settings for it (0322).
//
// Ashish (2026-10-02): the advance invoice is drafted at signing, the work
// starts at once, "the system should keep on notifying the spoc key manager and
// partner about the invoice pending finalisation or non receipt of payment ...
// and once every week it should escalate to ceo coo". The use case decides who
// and when; this reads the people (active staff only, in force on the day), the
// firm's policy on the tenant row, the companies' default tax rates and the
// weekly summary's record.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { AdvancePolicy } from "../../domain/billing/advance";
import type {
  AdvanceDigestStore,
  AdvancePeople,
  AdvancePolicySource,
  AdvanceReminderFacts,
  IssuerTaxDefaults,
  PersonRef,
} from "../../usecase/billing/ports";

interface PersonRow {
  user_id: string;
  display_name: string | null;
  email: string;
}

function personOf(r: PersonRow): PersonRef {
  return { userId: r.user_id, displayName: r.display_name, email: r.email };
}

export class PostgresAdvanceReminderFacts implements AdvanceReminderFacts {
  constructor(private readonly app: Db) {}

  async peopleFor(
    tenantId: string,
    advances: readonly { readonly dueId: string; readonly partyId: string; readonly deptCodes: readonly string[] }[],
    onDate: string,
    partnerMinRank: number,
  ): Promise<ReadonlyMap<string, AdvancePeople>> {
    const out = new Map<string, AdvancePeople>();
    if (advances.length === 0) return out;
    const parties = [...new Set(advances.map((a) => a.partyId))];
    return withTenant(this.app, tenantId, async (db) => {
      // The client's SPOCs, per Dept, and its Key Manager, as the routing and
      // the billing manager read them: a role in force on the day, held by
      // somebody still on the staff.
      const spocs = await db<(PersonRow & { client_party_id: string; dept_code: string })[]>`
        SELECT a.client_party_id, x.code AS dept_code, a.user_id, u.display_name, u.email::text AS email
          FROM crm.client_assignment a
          JOIN tenancy.service_axis x
            ON x.id = a.axis_id AND x.tenant_id = a.tenant_id AND x.axis = 'dept'
          JOIN tenancy.membership m
            ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
           AND m.audience = 'STAFF' AND m.is_active
          JOIN tenancy.user_account u ON u.id = a.user_id
         WHERE a.client_party_id = ANY(${db.array(parties)}::uuid[])
           AND a.role = 'spoc'
           AND a.valid_from <= ${onDate}::date
           AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
         ORDER BY a.valid_from, a.user_id
      `;
      const keyManagers = await db<(PersonRow & { client_party_id: string })[]>`
        SELECT DISTINCT ON (a.client_party_id)
               a.client_party_id, a.user_id, u.display_name, u.email::text AS email
          FROM crm.client_assignment a
          JOIN tenancy.membership m
            ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
           AND m.audience = 'STAFF' AND m.is_active
          JOIN tenancy.user_account u ON u.id = a.user_id
         WHERE a.client_party_id = ANY(${db.array(parties)}::uuid[])
           AND a.role = 'key_manager'
           AND a.valid_from <= ${onDate}::date
           AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
         ORDER BY a.client_party_id, a.valid_from DESC
      `;
      // THE PARTNER: up the Key Manager's reporting line to the first person
      // whose grade rank is at least the firm's (the user, 2026-10-02: "KM ke
      // upar ka Director/Partner"). The walk passes THROUGH somebody who has
      // left (their line still says who was above them); only the person it
      // lands on must be on the staff today. Twenty rungs is far past any
      // firm's ladder and stops a loop somebody typed into reports-to.
      const kmIds = [...new Set(keyManagers.map((k) => k.user_id))];
      const partners =
        kmIds.length === 0
          ? []
          : await db<(PersonRow & { start_user_id: string })[]>`
              WITH RECURSIVE up AS (
                SELECT m.user_id AS start_user_id, m.reports_to_user_id AS next_user_id, 1 AS depth
                  FROM tenancy.membership m
                 WHERE m.tenant_id = ${tenantId} AND m.user_id = ANY(${db.array(kmIds)}::uuid[])
                   AND m.audience = 'STAFF'
                UNION ALL
                SELECT up.start_user_id, m.reports_to_user_id, up.depth + 1
                  FROM up
                  JOIN tenancy.membership m
                    ON m.tenant_id = ${tenantId} AND m.user_id = up.next_user_id AND m.audience = 'STAFF'
                 WHERE up.next_user_id IS NOT NULL AND up.depth < 20
              )
              SELECT DISTINCT ON (up.start_user_id)
                     up.start_user_id, p.user_id, u.display_name, u.email::text AS email
                FROM up
                JOIN tenancy.membership p
                  ON p.tenant_id = ${tenantId} AND p.user_id = up.next_user_id
                 AND p.audience = 'STAFF' AND p.is_active
                JOIN tenancy.staff_grade g ON g.id = p.grade_id AND g.tenant_id = p.tenant_id
                JOIN tenancy.user_account u ON u.id = p.user_id
               WHERE g.rank >= ${partnerMinRank}
               ORDER BY up.start_user_id, up.depth
            `;

      for (const a of advances) {
        const seen = new Set<string>();
        const spocsFor: PersonRef[] = [];
        for (const s of spocs) {
          if (s.client_party_id !== a.partyId || !a.deptCodes.includes(s.dept_code) || seen.has(s.user_id)) continue;
          seen.add(s.user_id);
          spocsFor.push(personOf(s));
        }
        const km = keyManagers.find((k) => k.client_party_id === a.partyId) ?? null;
        const partner = km === null ? undefined : partners.find((p) => p.start_user_id === km.user_id);
        out.set(a.dueId, {
          spocs: spocsFor,
          keyManager: km === null ? null : personOf(km),
          partner: partner === undefined ? null : personOf(partner),
        });
      }
      return out;
    });
  }

  /** Active staff whose role carries `tenant:admin`, by the database's own
   *  reading of a role (0078's `is_administering_role`). */
  async admins(tenantId: string): Promise<readonly (PersonRef & { readonly seesFees: boolean })[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<(PersonRow & { sees_fees: boolean })[]>`
        SELECT m.user_id, u.display_name, u.email::text AS email, m.commercial_visibility AS sees_fees
          FROM tenancy.membership m
          JOIN tenancy.user_account u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId}
           AND m.audience = 'STAFF' AND m.is_active
           AND tenancy.is_administering_role(m.tenant_id, m.role)
         ORDER BY u.display_name NULLS LAST, u.email
      `;
      return rows.map((r) => ({ ...personOf(r), seesFees: r.sees_fees }));
    });
  }
}

interface PolicyRow {
  advance_draft_overdue_days: number;
  advance_unpaid_overdue_days: number;
  advance_partner_min_rank: number;
  advance_digest_weekday: number;
  advance_digest_hour: number;
}

export class PostgresAdvancePolicy implements AdvancePolicySource {
  constructor(private readonly app: Db) {}

  async policyFor(tenantId: string): Promise<AdvancePolicy> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PolicyRow[]>`
        SELECT advance_draft_overdue_days, advance_unpaid_overdue_days, advance_partner_min_rank,
               advance_digest_weekday, advance_digest_hour
          FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (row === undefined) throw new Error(`no tenant ${tenantId} to read the advance policy of`);
      return {
        draftOverdueDays: row.advance_draft_overdue_days,
        unpaidOverdueDays: row.advance_unpaid_overdue_days,
        partnerMinRank: row.advance_partner_min_rank,
        digestWeekday: row.advance_digest_weekday,
        digestHour: row.advance_digest_hour,
      };
    });
  }

  async setPolicy(tenantId: string, p: AdvancePolicy): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE tenancy.tenant
           SET advance_draft_overdue_days = ${p.draftOverdueDays},
               advance_unpaid_overdue_days = ${p.unpaidOverdueDays},
               advance_partner_min_rank = ${p.partnerMinRank},
               advance_digest_weekday = ${p.digestWeekday},
               advance_digest_hour = ${p.digestHour}
         WHERE id = ${tenantId}
      `;
    });
  }
}

export class PostgresIssuerTaxDefaults implements IssuerTaxDefaults {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly { readonly entityPartyId: string; readonly taxPercent: string }[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ entity_party_id: string; tax_percent: string }[]>`
        SELECT entity_party_id, tax_percent::text AS tax_percent
          FROM crm.issuer_tax_default ORDER BY entity_party_id
      `;
      return rows.map((r) => ({ entityPartyId: r.entity_party_id, taxPercent: r.tax_percent }));
    });
  }

  async set(tenantId: string, entityPartyId: string, taxPercent: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        INSERT INTO crm.issuer_tax_default (tenant_id, entity_party_id, tax_percent)
        VALUES (${tenantId}, ${entityPartyId}, ${taxPercent}::numeric)
        ON CONFLICT (tenant_id, entity_party_id)
          DO UPDATE SET tax_percent = EXCLUDED.tax_percent, updated_at = now()
      `;
    });
  }
}

/** How long a claim on a week's summary holds before another worker may take
 *  it again: long enough for one firm's letters, short enough that a crash
 *  mid-send does not lose the week. */
const DIGEST_CLAIM_LIFETIME = "30 minutes";

export class PostgresAdvanceDigestStore implements AdvanceDigestStore {
  constructor(private readonly app: Db) {}

  /** GLOBAL and ids only, like every sweep's first read: which firms have an
   *  advance pending is only answerable inside each one's wall, so this is
   *  every active firm, and the use case asks each. */
  async firmsWithPendingAdvances(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }

  async firmName(tenantId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ name: string }[]>`SELECT name FROM tenancy.tenant WHERE id = ${tenantId}`;
      return row?.name ?? null;
    });
  }

  /**
   * The week's row, or a stale claim on it, in one statement; refused when
   * another summary went out in the six days before, so a firm moving its day
   * mid-week (Monday sent, then Friday chosen) is not sent a second one.
   */
  async claim(tenantId: string, weekOf: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const recent = await db<{ id: string }[]>`
        SELECT id FROM crm.advance_digest
         WHERE week_of <> ${weekOf}::date
           AND week_of > ${weekOf}::date - 6
           AND week_of <= ${weekOf}::date
         LIMIT 1
      `;
      if (recent.length > 0) return false;
      const rows = await db<{ id: string }[]>`
        INSERT INTO crm.advance_digest (tenant_id, week_of)
        VALUES (${tenantId}, ${weekOf}::date)
        ON CONFLICT (tenant_id, week_of) DO UPDATE
          SET claimed_at = now()
          WHERE crm.advance_digest.sent_at IS NULL
            AND crm.advance_digest.claimed_at < now() - ${DIGEST_CLAIM_LIFETIME}::interval
        RETURNING id
      `;
      return rows.length === 1;
    });
  }

  async markSent(tenantId: string, weekOf: string, recipients: number, advances: number): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.advance_digest
           SET sent_at = now(), recipients = ${recipients}, advances = ${advances}
         WHERE week_of = ${weekOf}::date
      `;
    });
  }
}
