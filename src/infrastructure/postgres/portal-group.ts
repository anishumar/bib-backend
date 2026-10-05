// A client's GROUP, for portal access (Q064, Sid 2026-10-04: a group's
// contact "can see" its sister companies).
//
// THE GROUP is every company joined to the client by OWNERSHIP, followed both
// ways and to any depth: its parent, the parent's other subsidiaries (the
// sisters), their subsidiaries, and companies holding or held by shares. It is
// the frontend's `lib/group.ts` definition (the ownership pair `parent_of` and
// `shareholder_of`, organizations only) carried past one hop, because one hop
// never reaches a sister: two subsidiaries of one parent have no row between
// them.
//
// What it never contains, each enforced here rather than trusted to a caller:
// a PERSON (a director or a shareholder who is a human is not a company whose
// records exist to be shown), the FIRM's own companies, an archived company,
// a relationship not in force on the firm's day, and anything of another
// tenant (RLS, and every join carries the tenant). Twenty hops ends a loop a
// firm typed into its structure.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";

export interface GroupCompanyRow {
  readonly id: string;
  readonly displayName: string;
}

export class PostgresPortalGroup {
  constructor(private readonly app: Db) {}

  /** The OTHER companies in the client's group on `onDay`, by name. */
  async groupOf(tenantId: string, clientPartyId: string, onDay: string): Promise<readonly GroupCompanyRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; display_name: string }[]>`
        WITH RECURSIVE grp(party_id, depth) AS (
          SELECT p.id, 0
            FROM core.party p
           WHERE p.id = ${clientPartyId} AND p.tenant_id = ${tenantId} AND p.kind = 'organization'
          UNION
          SELECT CASE WHEN r.from_party_id = g.party_id THEN r.to_party_id ELSE r.from_party_id END, g.depth + 1
            FROM grp g
            JOIN core.party_relationship r
              ON r.tenant_id = ${tenantId}
             AND (r.from_party_id = g.party_id OR r.to_party_id = g.party_id)
            JOIN core.party a ON a.id = r.from_party_id AND a.tenant_id = r.tenant_id AND a.kind = 'organization'
            JOIN core.party b ON b.id = r.to_party_id AND b.tenant_id = r.tenant_id AND b.kind = 'organization'
           WHERE r.type IN ('parent_of', 'shareholder_of')
             AND r.valid_from <= ${onDay}::date
             AND (r.valid_to IS NULL OR r.valid_to > ${onDay}::date)
             AND g.depth < 20
        )
        SELECT DISTINCT p.id, p.display_name
          FROM grp
          JOIN core.party p ON p.id = grp.party_id AND p.tenant_id = ${tenantId}
         WHERE p.id <> ${clientPartyId}
           AND p.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM crm.firm_entity fe WHERE fe.party_id = p.id AND fe.tenant_id = p.tenant_id
           )
         ORDER BY p.display_name, p.id
      `;
      return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
    });
  }
}
