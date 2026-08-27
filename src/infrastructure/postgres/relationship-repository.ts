// Postgres adapter for party relationships. Tenant-scoped reads/writes run under
// withTenant; relationship_type is a GLOBAL product lookup (no RLS) so its
// existence check is a plain read on the app pool. Dates return as ::text ISO
// strings; attributes is jsonb, written as a JSON string cast to ::jsonb.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { PartyRelationship } from "../../domain/party/model";
import type { NewRelationship, RelationshipRepository } from "../../usecase/party/ports";

interface RelationshipRow {
  id: string;
  tenant_id: string;
  from_party_id: string;
  to_party_id: string;
  type: string;
  valid_from: string;
  valid_to: string | null;
  attributes: Record<string, unknown>;
}

function toRelationship(r: RelationshipRow): PartyRelationship {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    fromPartyId: r.from_party_id,
    toPartyId: r.to_party_id,
    type: r.type,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    attributes: r.attributes,
  };
}

export class PostgresRelationshipRepository implements RelationshipRepository {
  constructor(private readonly app: Db) {}

  async add(r: NewRelationship): Promise<PartyRelationship> {
    return withTenant(this.app, r.tenantId, async (db) => {
      const [row] = await db<RelationshipRow[]>`
        INSERT INTO core.party_relationship
          (id, tenant_id, from_party_id, to_party_id, type, valid_from, valid_to, attributes)
        VALUES
          (${r.id}, ${r.tenantId}, ${r.fromPartyId}, ${r.toPartyId}, ${r.type},
           ${r.validFrom}, ${r.validTo}, ${db.json(r.attributes as Parameters<typeof db.json>[0])})
        RETURNING id, tenant_id, from_party_id, to_party_id, type,
                  valid_from::text AS valid_from, valid_to::text AS valid_to, attributes
      `;
      if (!row) throw new Error("party_relationship insert returned no row");
      return toRelationship(row);
    });
  }

  async relationshipTypeExists(code: string): Promise<boolean> {
    const [row] = await this.app<{ code: string }[]>`
      SELECT code FROM core.relationship_type WHERE code = ${code}
    `;
    return row !== undefined;
  }

  async listForParty(tenantId: string, partyId: string): Promise<PartyRelationship[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<RelationshipRow[]>`
        SELECT id, tenant_id, from_party_id, to_party_id, type,
               valid_from::text AS valid_from, valid_to::text AS valid_to, attributes
        FROM core.party_relationship
        WHERE from_party_id = ${partyId} OR to_party_id = ${partyId}
        ORDER BY valid_from DESC
      `;
      return rows.map(toRelationship);
    });
  }
}
