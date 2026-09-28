// Postgres adapter for party identifiers. All reads/writes run under withTenant
// so the tenant wall applies. `value` is citext, so equality is
// case-insensitive; the service normalises before insert and lookup, so the
// dedup match is exact either way. Dates come back as ::text ISO strings.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { IdentifierType, PartyIdentifier } from "../../domain/party/model";
import type { IdentifierRepository, NewIdentifier } from "../../usecase/party/ports";
import { isoInstant } from "./instant";

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
  voided_at: string | null;
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
    voidedAt: r.voided_at,
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
                  valid_from::text AS valid_from, valid_to::text AS valid_to,
               ${db.unsafe(isoInstant("voided_at", "voided_at"))}
      `;
      if (!row) throw new Error("party_identifier insert returned no row");
      return toIdentifier(row);
    });
  }

  async listForParty(tenantId: string, partyId: string): Promise<PartyIdentifier[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<IdentifierRow[]>`
        SELECT id, tenant_id, party_id, type, value, jurisdiction, is_primary,
               valid_from::text AS valid_from, valid_to::text AS valid_to,
               ${db.unsafe(isoInstant("voided_at", "voided_at"))}
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
               valid_from::text AS valid_from, valid_to::text AS valid_to,
               ${db.unsafe(isoInstant("voided_at", "voided_at"))}
        FROM core.party_identifier
        WHERE type = ${type} AND value = ${value}
          -- OPEN only (V2.5, 0315): an ended or voided identifier frees its
          -- value, so the right PAN can be added after the wrong one is voided.
          AND voided_at IS NULL AND valid_to IS NULL
        LIMIT 1
      `;
      return row ? toIdentifier(row) : null;
    });
  }

  async findById(tenantId: string, identifierId: string): Promise<PartyIdentifier | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<IdentifierRow[]>`
        SELECT id, tenant_id, party_id, type, value, jurisdiction, is_primary,
               valid_from::text AS valid_from, valid_to::text AS valid_to,
               ${db.unsafe(isoInstant("voided_at", "voided_at"))}
        FROM core.party_identifier WHERE id = ${identifierId}
      `;
      return row ? toIdentifier(row) : null;
    });
  }

  async end(tenantId: string, identifierId: string, validTo: string): Promise<PartyIdentifier | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<IdentifierRow[]>`
        UPDATE core.party_identifier SET valid_to = ${validTo}::date
        WHERE id = ${identifierId} AND voided_at IS NULL AND valid_to IS NULL
        RETURNING id, tenant_id, party_id, type, value, jurisdiction, is_primary,
                  valid_from::text AS valid_from, valid_to::text AS valid_to,
                  ${db.unsafe(isoInstant("voided_at", "voided_at"))}
      `;
      return row ? toIdentifier(row) : null;
    });
  }

  async void(tenantId: string, identifierId: string, byUserId: string | null): Promise<PartyIdentifier | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<IdentifierRow[]>`
        UPDATE core.party_identifier SET voided_at = now(), voided_by_user_id = ${byUserId}
        WHERE id = ${identifierId} AND voided_at IS NULL
        RETURNING id, tenant_id, party_id, type, value, jurisdiction, is_primary,
                  valid_from::text AS valid_from, valid_to::text AS valid_to,
                  ${db.unsafe(isoInstant("voided_at", "voided_at"))}
      `;
      return row ? toIdentifier(row) : null;
    });
  }
}
