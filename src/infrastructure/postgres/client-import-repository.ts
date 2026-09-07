// Postgres behind the client import: the staging row, and the one-snapshot
// read of what the firm already has.
//
// The DIRECTORY queries the party, config, tenancy and crm tables directly
// rather than going through their services, because these are READS the
// import needs in one shape — "every organization, with its registration and
// its group parent" — that no service exposes and that a per-row lookup over
// four hundred rows would make a four-hundred-query import. An adapter may
// read any table; what it may not do is WRITE one that belongs to another
// module, and this one writes only `crm.client_import`.

import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { IsoDate, KnownAxis, KnownService } from "../../domain/clientimport/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { isBillingFrequency } from "../../domain/document/model";
import { isIdentifierType, type IdentifierType } from "../../domain/party/model";
import type { ImportReport, ImportRows } from "../../domain/clientimport/model";
import type {
  ClauseOnFile,
  ClientImportStore,
  EngagementInForce,
  FirmFacts,
  IdentifierHolder,
  ImportDirectory,
  ImportOutcome,
  NewStagedImport,
  OrganizationOnFile,
  PersonOnFile,
  StaffMember,
  StagedImport,
  StagedImportSummary,
} from "../../usecase/clientimport/ports";
import { isoInstant } from "./instant";

// ── The staging row ──────────────────────────────────────────────────────────

interface ImportRow {
  id: string;
  tenant_id: string;
  status: string;
  file_names: StagedImport["fileNames"];
  rows: ImportRows;
  report: ImportReport;
  outcome: ImportOutcome | null;
  staged_by: string;
  staged_by_email: string;
  staged_by_name: string | null;
  staged_at: string;
  confirmed_by: string | null;
  confirmed_by_email: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
}

interface SummaryRow {
  id: string;
  status: string;
  file_names: StagedImport["fileNames"];
  blocking: number;
  warnings: number;
  counts: ImportReport["counts"];
  staged_by: string;
  staged_by_email: string;
  staged_by_name: string | null;
  staged_at: string;
  confirmed_at: string | null;
}

function toStaged(r: ImportRow): StagedImport {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    status: r.status === "confirmed" ? "confirmed" : "staged",
    fileNames: r.file_names,
    rows: r.rows,
    report: r.report,
    outcome: r.outcome,
    stagedBy: { userId: r.staged_by, email: r.staged_by_email, name: r.staged_by_name },
    stagedAt: r.staged_at,
    confirmedBy:
      r.confirmed_by === null || r.confirmed_by_email === null
        ? null
        : { userId: r.confirmed_by, email: r.confirmed_by_email, name: r.confirmed_by_name },
    confirmedAt: r.confirmed_at,
  };
}

export class PostgresClientImportRepository implements ClientImportStore {
  constructor(private readonly app: Db) {}

  async create(row: NewStagedImport): Promise<StagedImport> {
    return withTenant(this.app, row.tenantId, async (db) => {
      await db`
        INSERT INTO crm.client_import (id, tenant_id, file_names, rows, report, staged_by)
        VALUES (
          ${row.id}, ${row.tenantId},
          ${db.json(row.fileNames as unknown as Parameters<typeof db.json>[0])},
          ${db.json(row.rows as unknown as Parameters<typeof db.json>[0])},
          ${db.json(row.report as unknown as Parameters<typeof db.json>[0])},
          ${row.stagedBy}
        )
      `;
      const [found] = await db<ImportRow[]>`${db.unsafe(SELECT_ONE)} WHERE i.id = ${row.id}`;
      if (!found) throw new Error("client_import insert returned no row");
      return toStaged(found);
    });
  }

  async find(tenantId: string, importId: string): Promise<StagedImport | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ImportRow[]>`${db.unsafe(SELECT_ONE)} WHERE i.id = ${importId}`;
      return row ? toStaged(row) : null;
    });
  }

  async list(tenantId: string): Promise<readonly StagedImportSummary[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<SummaryRow[]>`
        SELECT i.id, i.status, i.file_names,
               (i.report->>'blocking')::int AS blocking,
               (i.report->>'warnings')::int AS warnings,
               i.report->'counts' AS counts,
               i.staged_by, su.email::text AS staged_by_email, su.display_name AS staged_by_name,
               ${db.unsafe(isoInstant("i.staged_at", "staged_at"))},
               ${db.unsafe(isoInstant("i.confirmed_at", "confirmed_at"))}
        FROM crm.client_import i
        JOIN tenancy.user_account su ON su.id = i.staged_by
        ORDER BY i.staged_at DESC
      `;
      return rows.map((r) => ({
        id: r.id,
        status: r.status === "confirmed" ? "confirmed" : "staged",
        fileNames: r.file_names,
        blocking: r.blocking,
        warnings: r.warnings,
        counts: r.counts,
        stagedBy: { userId: r.staged_by, email: r.staged_by_email, name: r.staged_by_name },
        stagedAt: r.staged_at,
        confirmedAt: r.confirmed_at,
      }));
    });
  }

  async confirm(
    tenantId: string,
    importId: string,
    outcome: ImportOutcome,
    confirmedBy: string,
    confirmedAt: string,
  ): Promise<StagedImport> {
    return withTenant(this.app, tenantId, async (db) => {
      const updated = await db`
        UPDATE crm.client_import
        SET status = 'confirmed',
            outcome = ${db.json(outcome as unknown as Parameters<typeof db.json>[0])},
            confirmed_by = ${confirmedBy},
            confirmed_at = ${confirmedAt}::timestamptz
        WHERE id = ${importId} AND status = 'staged'
        RETURNING id
      `;
      if (updated.length === 0) throw new Error(`client_import ${importId} is not staged`);
      const [row] = await db<ImportRow[]>`${db.unsafe(SELECT_ONE)} WHERE i.id = ${importId}`;
      if (!row) throw new Error("client_import update returned no row");
      return toStaged(row);
    });
  }
}

const SELECT_ONE = `
  SELECT i.id, i.tenant_id, i.status, i.file_names, i.rows, i.report, i.outcome,
         i.staged_by, su.email::text AS staged_by_email, su.display_name AS staged_by_name,
         ${isoInstant("i.staged_at", "staged_at")},
         i.confirmed_by, cu.email::text AS confirmed_by_email, cu.display_name AS confirmed_by_name,
         ${isoInstant("i.confirmed_at", "confirmed_at")}
  FROM crm.client_import i
  JOIN tenancy.user_account su ON su.id = i.staged_by
  LEFT JOIN tenancy.user_account cu ON cu.id = i.confirmed_by
`;

// ── What the firm already has ────────────────────────────────────────────────

interface OrgRow {
  party_id: string;
  legal_name: string;
  trade_name: string | null;
  display_name: string;
  archived: boolean;
  jurisdiction: string | null;
  parent_party_id: string | null;
}

interface VersionRow {
  entry_id: string;
  key: string;
  version_id: string;
  body: Record<string, unknown>;
}

export class PostgresClientImportDirectory implements ImportDirectory {
  constructor(private readonly app: Db) {}

  async firm(tenantId: string): Promise<FirmFacts> {
    return withTenant(this.app, tenantId, async (db) => {
      const [self] = await db<{ party_id: string }[]>`
        SELECT party_id FROM core.organization WHERE is_firm_self
      `;
      const [tenant] = await db<{ reporting_currency: string | null }[]>`
        SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      return {
        selfPartyId: self?.party_id ?? null,
        reportingCurrency: tenant?.reporting_currency ?? null,
      };
    });
  }

  async liveServices(tenantId: string): Promise<readonly KnownService[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<VersionRow[]>`
        SELECT e.id AS entry_id, e.key, v.id AS version_id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.tenant_id = e.tenant_id AND v.status = 'published'
        WHERE e.kind = 'service'
      `;
      return rows.map((r) => {
        const body = readServiceBody(r.body);
        const recurrence = body.recurrence;
        return {
          serviceId: r.entry_id,
          serviceVersionId: r.version_id,
          code: body.ref ?? r.key,
          name: body.name === "" ? r.key : body.name,
          module: body.module,
          billingFrequency: recurrence !== null && isBillingFrequency(recurrence) ? recurrence : null,
        };
      });
    });
  }

  async axes(tenantId: string): Promise<readonly KnownAxis[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; axis: string; code: string; name: string; is_active: boolean }[]>`
        SELECT id, axis, code, name, is_active FROM tenancy.service_axis ORDER BY sort_order, code
      `;
      return rows.map((r) => ({
        id: r.id,
        axis: r.axis === "team" ? "team" : "dept",
        code: r.code,
        name: r.name,
        isActive: r.is_active,
      }));
    });
  }

  async activeStaff(tenantId: string): Promise<readonly StaffMember[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ email: string; user_id: string }[]>`
        SELECT u.email::text AS email, m.user_id
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        WHERE m.audience = 'STAFF' AND m.is_active AND u.status = 'active'
      `;
      return rows.map((r) => ({ email: r.email, userId: r.user_id }));
    });
  }

  async relationshipTypes(): Promise<readonly string[]> {
    // A global table with no tenant column; read on the app pool as-is.
    const rows = await this.app<{ code: string }[]>`SELECT code FROM core.relationship_type`;
    return rows.map((r) => r.code);
  }

  async clauses(tenantId: string): Promise<readonly ClauseOnFile[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<VersionRow[]>`
        SELECT e.id AS entry_id, e.key, v.id AS version_id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.tenant_id = e.tenant_id AND v.status = 'published'
        WHERE e.kind = 'clause'
      `;
      return rows.map((r) => {
        const body = readClauseBody(r.body);
        return {
          versionId: r.version_id,
          jurisdictions: body.jurisdictions,
          governingLawJurisdiction: body.governingLaw?.jurisdiction ?? null,
          courtsJurisdiction: body.courts?.jurisdiction ?? null,
        };
      });
    });
  }

  async organizations(tenantId: string, onDate: IsoDate): Promise<readonly OrganizationOnFile[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<OrgRow[]>`
        SELECT o.party_id, o.legal_name, o.trade_name, p.display_name,
               (p.archived_at IS NOT NULL) AS archived,
               le.jurisdiction,
               (SELECT r.from_party_id
                  FROM core.party_relationship r
                 WHERE r.to_party_id = o.party_id AND r.tenant_id = o.tenant_id
                   AND r.type = 'parent_of'
                   AND r.valid_from <= ${onDate}::date
                   AND (r.valid_to IS NULL OR r.valid_to > ${onDate}::date)
                 ORDER BY r.valid_from DESC
                 LIMIT 1) AS parent_party_id
        FROM core.organization o
        JOIN core.party p ON p.id = o.party_id AND p.tenant_id = o.tenant_id
        LEFT JOIN core.legal_entity le ON le.party_id = o.party_id AND le.tenant_id = o.tenant_id
        WHERE NOT o.is_firm_self
      `;
      return rows.map((r) => ({
        partyId: r.party_id,
        legalName: r.legal_name,
        tradeName: r.trade_name,
        displayName: r.display_name,
        registered: r.jurisdiction !== null,
        jurisdiction: r.jurisdiction,
        parentPartyId: r.parent_party_id,
        archived: r.archived,
      }));
    });
  }

  async identifierHolders(
    tenantId: string,
    wanted: readonly { readonly type: IdentifierType; readonly value: string }[],
  ): Promise<readonly IdentifierHolder[]> {
    if (wanted.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ type: string; value: string; party_id: string }[]>`
        SELECT i.type, i.value, i.party_id
        FROM core.party_identifier i
        JOIN unnest(
          ${db.array(wanted.map((w) => w.type))}::text[],
          ${db.array(wanted.map((w) => w.value))}::text[]
        ) AS w(type, value) ON w.type = i.type AND w.value = i.value
      `;
      return rows.flatMap((r) =>
        isIdentifierType(r.type) ? [{ type: r.type, value: r.value, partyId: r.party_id }] : [],
      );
    });
  }

  async peopleByEmail(tenantId: string, emails: readonly string[]): Promise<readonly PersonOnFile[]> {
    if (emails.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ email: string; party_id: string; full_name: string }[]>`
        SELECT i.value AS email, i.party_id, pe.full_name
        FROM core.party_identifier i
        JOIN core.person pe ON pe.party_id = i.party_id AND pe.tenant_id = i.tenant_id
        WHERE i.type = 'email' AND i.value = ANY(${db.array([...emails])}::text[])
      `;
      return rows.map((r) => ({ email: r.email, partyId: r.party_id, name: r.full_name }));
    });
  }

  async engagementsInForce(tenantId: string, onDate: IsoDate): Promise<readonly EngagementInForce[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ entity_party_id: string; service_id: string }[]>`
        SELECT e.entity_party_id, v.entry_id AS service_id
        FROM crm.engagement e
        JOIN crm.engagement_letter_line l ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
        JOIN config.version v ON v.id = l.service_version_id AND v.tenant_id = l.tenant_id
        WHERE e.status IN ('pending_advance', 'active', 'paused')
          AND (e.ends_on IS NULL OR e.ends_on > ${onDate}::date)
      `;
      return rows.map((r) => ({ entityPartyId: r.entity_party_id, serviceId: r.service_id }));
    });
  }

  async missedFromOn(tenantId: string): Promise<IsoDate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ missed_from_on: string | null }[]>`
        SELECT v.body->>'missedFromOn' AS missed_from_on
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.tenant_id = e.tenant_id AND v.status = 'published'
        WHERE e.kind = 'compliance_policy'
        ORDER BY v.published_at DESC
        LIMIT 1
      `;
      return row?.missed_from_on ?? null;
    });
  }
}
