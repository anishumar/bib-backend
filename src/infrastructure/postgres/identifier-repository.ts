// Postgres adapter for party identifiers. All reads/writes run under withTenant
// so the tenant wall applies. `value` is citext, so equality is
// case-insensitive; the service normalises before insert and lookup, so the
// dedup match is exact either way. Dates come back as ::text ISO strings.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { IdentifierType, PartyIdentifier } from "../../domain/party/model";
import type { IdentifierRepository, NewIdentifier } from "../../usecase/party/ports";

interface IdentifierRow {
  id: string;
  tenant_id: string;
  party_id: string;
  type: IdentifierType;
  value: string;
  jurisdiction: string | null;
  is_primary: boolean;
  valid_from: string;
  valid_to: string | null;
}

function toIdentifier(r: IdentifierRow): PartyIdentifier {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    partyId: r.party_id,
    type: r.type,
    value: r.value,
    jurisdiction: r.jurisdiction,
    isPrimary: r.is_primary,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  };
}

export class PostgresIdentifierRepository implements IdentifierRepository {
  constructor(private readonly app: Db) {}

  async add(i: NewIdentifier): Promise<PartyIdentifier> {
    return withTenant(this.app, i.tenantId, async (db) => {
      const [row] = await db<IdentifierRow[]>`
        INSERT INTO core.party_identifier
          (id, tenant_id, party_id, type, value, jurisdiction, is_primary, valid_from, valid_to)
        VALUES
          (${i.id}, ${i.tenantId}, ${i.partyId}, ${i.type}, ${i.value},
           ${i.jurisdiction}, ${i.isPrimary}, ${i.validFrom}, ${i.validTo})
        RETURNING id, tenant_id, party_id, type, value, jurisdiction, is_primary,
                  valid_from::text AS valid_from, valid_to::text AS valid_to
      `;
      if (!row) throw new Error("party_identifier insert returned no row");
      return toIdentifier(row);
    });
  }

  async listForParty(tenantId: string, partyId: string): Promise<PartyIdentifier[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<IdentifierRow[]>`
        SELECT id, tenant_id, party_id, type, value, jurisdiction, is_primary,
               valid_from::text AS valid_from, valid_to::text AS valid_to
        FROM core.party_identifier WHERE party_id = ${partyId} ORDER BY created_at
      `;
      return rows.map(toIdentifier);
    });
  }

  async findByValue(
    tenantId: string,
    type: IdentifierType,
    value: string,
  ): Promise<PartyIdentifier | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<IdentifierRow[]>`
        SELECT id, tenant_id, party_id, type, value, jurisdiction, is_primary,
               valid_from::text AS valid_from, valid_to::text AS valid_to
        FROM core.party_identifier WHERE type = ${type} AND value = ${value}
      `;
      return row ? toIdentifier(row) : null;
    });
  }
}
