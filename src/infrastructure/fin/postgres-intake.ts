// FinCompliance intake, in Postgres (0381). Fin's adapters live here, apart
// from core's in `infrastructure/postgres/`, so the import wall can name them.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DocumentKind } from "../../domain/filestore/model";
import { INTAKE_ROUTES } from "../../domain/fin/intake";
import type { IntakeRoute, RouteBasis } from "../../domain/fin/intake";
import type {
  FinFirms,
  IntakeCandidate,
  IntakeCandidateSource,
  IntakeFilter,
  IntakeItemView,
  IntakeRepository,
  IntakeSummary,
  NewIntakeItem,
} from "../../usecase/fin/ports";
import { isoInstant } from "../postgres/instant";
import { finUnavailableOnFailure, withFinRead } from "./unavailable";

export class PostgresFinFirms implements FinFirms {
  constructor(private readonly app: Db) {}

  async enabledFirmIds(): Promise<readonly string[]> {
    // Above RLS, as every sweep's tenant list is: a job holds no session.
    // Everything under it is `withTenant`.
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant
       WHERE status = 'active' AND fin_enabled_since IS NOT NULL
       ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }

  async enabledSince(tenantId: string): Promise<string | null> {
    // Every fin route asks this first, so a database that does not answer
    // must reach the screen as fin's 503 here too (F0.6), not as a 500.
    return finUnavailableOnFailure("whether fin is on for this firm", async () => {
      const [row] = await this.app<{ since: string | null }[]>`
        SELECT CASE WHEN status = 'active'
                    THEN ${this.app.unsafe(isoInstant("fin_enabled_since"))} END AS since
          FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      return row?.since ?? null;
    });
  }
}

interface CandidateRow {
  document_version_id: string;
  client_party_id: string | null;
  media_type: string;
  byte_size: string;
  filename: string;
}

export class PostgresIntakeCandidates implements IntakeCandidateSource {
  constructor(private readonly app: Db) {}

  async untaken(
    tenantId: string,
    kinds: readonly DocumentKind[],
    limit: number,
  ): Promise<readonly IntakeCandidate[]> {
    if (kinds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // The cut is the firm's own switch, joined here rather than passed in,
      // so it is compared at full precision against the column it cuts.
      const rows = await db<CandidateRow[]>`
        SELECT v.id AS document_version_id,
               d.party_id AS client_party_id,
               v.media_type,
               v.byte_size::text AS byte_size,
               v.filename
          FROM files.document_version v
          JOIN files.document d ON d.id = v.document_id AND d.tenant_id = v.tenant_id
          JOIN tenancy.tenant t ON t.id = v.tenant_id
         WHERE v.tenant_id = ${tenantId}
           AND t.fin_enabled_since IS NOT NULL
           AND v.created_at >= t.fin_enabled_since
           AND d.origin = 'uploaded'
           AND d.kind IN ${db(kinds as string[])}
           AND NOT EXISTS (
                 SELECT 1 FROM fin.intake_item i
                  WHERE i.tenant_id = v.tenant_id AND i.document_version_id = v.id
               )
         ORDER BY v.created_at, v.id
         LIMIT ${limit}
      `;
      return rows.map((r) => ({
        documentVersionId: r.document_version_id,
        clientPartyId: r.client_party_id,
        mediaType: r.media_type,
        byteSize: Number(r.byte_size),
        filename: r.filename,
      }));
    });
  }
}

interface ItemRow {
  id: string;
  document_id: string;
  document_version_id: string;
  title: string;
  filename: string;
  client_party_id: string | null;
  client_name: string | null;
  media_type: string;
  byte_size: string;
  route: IntakeRoute;
  route_basis: RouteBasis;
  taken_at: string;
}

export class PostgresIntakeRepository implements IntakeRepository {
  constructor(private readonly app: Db) {}

  async insert(item: NewIntakeItem): Promise<boolean> {
    return withTenant(this.app, item.tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        INSERT INTO fin.intake_item
          (id, tenant_id, document_version_id, client_party_id, media_type, byte_size, route, route_basis)
        VALUES
          (${item.id}, ${item.tenantId}, ${item.documentVersionId}, ${item.clientPartyId},
           ${item.mediaType}, ${item.byteSize}, ${item.route}, ${item.routeBasis})
        ON CONFLICT ON CONSTRAINT intake_item_once DO NOTHING
        RETURNING id
      `;
      return rows.length === 1;
    });
  }

  async summary(tenantId: string, clientPartyId: string | null): Promise<IntakeSummary> {
    return withFinRead(this.app, tenantId, "the intake counts", async (db) => {
      const rows = await db<{ route: IntakeRoute; n: number }[]>`
        SELECT route, count(*)::int AS n
          FROM fin.intake_item
         WHERE (${clientPartyId}::uuid IS NULL OR client_party_id = ${clientPartyId}::uuid)
         GROUP BY route
      `;
      const byRoute = Object.fromEntries(INTAKE_ROUTES.map((r) => [r, 0])) as Record<IntakeRoute, number>;
      for (const r of rows) byRoute[r.route] = r.n;
      return { total: rows.reduce((n, r) => n + r.n, 0), byRoute };
    });
  }

  async list(tenantId: string, filter: IntakeFilter): Promise<readonly IntakeItemView[]> {
    return withFinRead(this.app, tenantId, "the intake list", async (db) => {
      const rows = await db<ItemRow[]>`
        SELECT i.id,
               v.document_id,
               i.document_version_id,
               d.title,
               v.filename,
               i.client_party_id,
               p.display_name AS client_name,
               i.media_type,
               i.byte_size::text AS byte_size,
               i.route,
               i.route_basis,
               ${db.unsafe(isoInstant("i.created_at", "taken_at"))}
          FROM fin.intake_item i
          JOIN files.document_version v ON v.id = i.document_version_id AND v.tenant_id = i.tenant_id
          JOIN files.document d ON d.id = v.document_id AND d.tenant_id = v.tenant_id
          LEFT JOIN core.party p ON p.id = i.client_party_id AND p.tenant_id = i.tenant_id
         WHERE (${filter.clientPartyId}::uuid IS NULL OR i.client_party_id = ${filter.clientPartyId}::uuid)
           AND (${filter.route}::text IS NULL OR i.route = ${filter.route}::text)
           -- The cursor is the previous page's last row, compared at that row's
           -- own precision. An id this firm does not hold matches no row, so
           -- the page is empty rather than another firm's.
           AND (${filter.before}::uuid IS NULL OR (i.created_at, i.id) < (
                 SELECT c.created_at, c.id FROM fin.intake_item c WHERE c.id = ${filter.before}::uuid))
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT ${filter.limit}
      `;
      return rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        documentVersionId: r.document_version_id,
        title: r.title,
        filename: r.filename,
        clientPartyId: r.client_party_id,
        clientName: r.client_name,
        mediaType: r.media_type,
        byteSize: Number(r.byte_size),
        route: r.route,
        routeBasis: r.route_basis,
        takenAt: r.taken_at,
      }));
    });
  }
}
