// Postgres adapter for the firm's list of signatories (0343, Q005). Every read
// and write goes through withTenant: a signatory is somebody who binds THIS
// firm, and the list means nothing outside it.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { FirmSignatoryEntry } from "../../domain/tenancy/model";
import type { NewFirmSignatory, SignatoryRepository } from "../../usecase/tenancy/ports";
import { isoInstant } from "./instant";

interface SignatoryRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  signature_version_id: string | null;
  is_active: boolean;
  created_at: string;
}

const COLUMNS = `id, tenant_id, user_id, title, signature_version_id, is_active, ${isoInstant("created_at", "created_at")}`;

function toEntry(r: SignatoryRow): FirmSignatoryEntry {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    title: r.title,
    signatureVersionId: r.signature_version_id,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

export class PostgresSignatoryRepository implements SignatoryRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly FirmSignatoryEntry[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Retired entries included: the list is where a partner who has left is
      // still named, and where they can be reinstated. Oldest first, a stable
      // order the screen does not have to re-sort.
      const rows = await db<SignatoryRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM tenancy.firm_signatory ORDER BY created_at, id
      `;
      return rows.map(toEntry);
    });
  }

  async find(tenantId: string, signatoryId: string): Promise<FirmSignatoryEntry | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<SignatoryRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM tenancy.firm_signatory WHERE id = ${signatoryId}
      `;
      return row ? toEntry(row) : null;
    });
  }

  async findByUser(tenantId: string, userId: string): Promise<FirmSignatoryEntry | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<SignatoryRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM tenancy.firm_signatory WHERE user_id = ${userId}
      `;
      return row ? toEntry(row) : null;
    });
  }

  async add(s: NewFirmSignatory): Promise<FirmSignatoryEntry> {
    return withTenant(this.app, s.tenantId, async (db) => {
      const [row] = await db<SignatoryRow[]>`
        INSERT INTO tenancy.firm_signatory (id, tenant_id, user_id, title, created_by)
        VALUES (${s.id}, ${s.tenantId}, ${s.userId}, ${s.title}, ${s.createdBy})
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`signatory ${s.id} was not written`);
      return toEntry(row);
    });
  }

  async update(
    tenantId: string,
    signatoryId: string,
    change: { readonly title?: string | undefined; readonly signatureVersionId?: string | null | undefined },
  ): Promise<FirmSignatoryEntry> {
    return withTenant(this.app, tenantId, async (db) => {
      // The default's title on the tenant row follows through the key's ON
      // UPDATE CASCADE (0343), in this same statement.
      const [row] = await db<SignatoryRow[]>`
        UPDATE tenancy.firm_signatory
           SET title = CASE WHEN ${change.title !== undefined} THEN ${change.title ?? null} ELSE title END,
               signature_version_id = CASE WHEN ${change.signatureVersionId !== undefined}
                                           THEN ${change.signatureVersionId ?? null}::uuid
                                           ELSE signature_version_id END
         WHERE id = ${signatoryId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`signatory ${signatoryId} vanished while being changed`);
      return toEntry(row);
    });
  }

  async setActive(tenantId: string, signatoryId: string, isActive: boolean): Promise<FirmSignatoryEntry> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<SignatoryRow[]>`
        UPDATE tenancy.firm_signatory SET is_active = ${isActive}
         WHERE id = ${signatoryId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`signatory ${signatoryId} vanished while being retired`);
      return toEntry(row);
    });
  }

  async makeDefault(tenantId: string, signatoryId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      // Both columns from the list's row in one statement: the key onto the
      // list (0343) holds them to an entry that exists, with its own title.
      const rows = await db`
        UPDATE tenancy.tenant t
           SET firm_signatory_user_id = s.user_id, firm_signatory_title = s.title
          FROM tenancy.firm_signatory s
         WHERE t.id = ${tenantId} AND s.id = ${signatoryId} AND s.tenant_id = t.id
        RETURNING t.id
      `;
      if (rows.length === 0) throw new Error(`signatory ${signatoryId} vanished while being made the default`);
    });
  }

  async versionMediaType(tenantId: string, versionId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ media_type: string }[]>`
        SELECT media_type FROM files.document_version WHERE id = ${versionId}
      `;
      return row?.media_type ?? null;
    });
  }
}
