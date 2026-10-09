// Postgres adapter for the configuration registry: one class for every port that is a config
// read over `config.entry`/`config.version` (the registry, gate 3's PermissionSource,
// RoleDirectory, ServiceCatalogue, PolicyDirectory, ...). Split, they could disagree on what
// "published" means and answer an authorization question wrongly. Every method runs under
// withTenant; timestamptz arrives as a Date and leaves as an ISO 8601 string.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  PublishedTiers,
  ResolvedTemplate,
  TemplateSource,
  TierSource,
} from "../../usecase/orchestrator/ports";
import type {
  ResolvedPolicy,
  VerificationPolicySource,
} from "../../usecase/verification/ports";
import type { Permission } from "../../domain/authz/model";
import type {
  ConfigEntry,
  ConfigKind,
  ConfigVersion,
  PublishedEntry,
  VersionStatus,
} from "../../domain/config/model";
import {
  CONFIDENCE_TIER_KEY,
  COMPLIANCE_POLICY_KEY,
  DISCOUNT_POLICY_KEY,
  readConfidenceTierBody,
  readMaxDiscountPercent,
  readFiscalYearStartMonth,
  readMissedFromOn,
  readRoleAudience,
  readRolePermissions,
  readWorkflowTemplate,
  readVerificationPolicyBody,
} from "../../domain/config/model";
import type { PermissionSource, StoredRole } from "../../usecase/authz/ports";
import type { RoleDirectory } from "../../usecase/tenancy/ports";
import type {
  ConfigRepository,
  DefinedEntry,
  NewEntry,
  NewVersion,
  PublishOutcome,
  SeedRow,
} from "../../usecase/config/ports";
import type {
  ServiceDirectory as ObligationServiceDirectory,
  ServiceRef as ObligationServiceRef,
} from "../../usecase/obligation/ports";
import { serviceNameSql } from "./obligation-link-repository";
import type { CompliancePolicySource as SchedulerCompliancePolicySource } from "../../usecase/scheduler/ports";
import type { PolicyDirectory, ServiceCatalogue } from "../../usecase/proposal/ports";
import type { Amount } from "../../domain/money/model";

interface EntryRow {
  id: string;
  tenant_id: string;
  kind: ConfigKind;
  key: string;
}

interface VersionRow {
  id: string;
  tenant_id: string;
  entry_id: string;
  version: number;
  status: VersionStatus;
  body: Record<string, unknown>;
  published_at: Date | null;
  archived_at: Date | null;
}

/** entry LEFT JOIN its published version; nullable because a draft-only entry publishes nothing. */
interface PublishedRow extends EntryRow {
  v_id: string | null;
  v_version: number | null;
  v_status: VersionStatus | null;
  v_body: Record<string, unknown> | null;
  v_published_at: Date | null;
  v_archived_at: Date | null;
  d_id: string | null;
  d_version: number | null;
  d_status: VersionStatus | null;
  d_body: Record<string, unknown> | null;
}

function toEntry(r: EntryRow): ConfigEntry {
  return { id: r.id, tenantId: r.tenant_id, kind: r.kind, key: r.key };
}

function toVersion(r: VersionRow): ConfigVersion {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entryId: r.entry_id,
    version: r.version,
    status: r.status,
    body: r.body,
    publishedAt: r.published_at?.toISOString() ?? null,
    archivedAt: r.archived_at?.toISOString() ?? null,
  };
}

export class PostgresConfigRepository
  implements
    ConfigRepository,
    PermissionSource,
    RoleDirectory,
    ServiceCatalogue,
    PolicyDirectory,
    TemplateSource,
    TierSource,
    VerificationPolicySource,
    SchedulerCompliancePolicySource,
    ObligationServiceDirectory
{
  constructor(private readonly app: Db) {}

  /**
   * `ServiceDirectory` (T3.2): does this catalogue ENTRY exist, and its name. The entry, not a
   * version: publishing v4 of 'gst-filing' does not stop the firm owing GSTR-3B, so pinning a
   * version would silently stop the rule generating. The name is `serviceNameSql`, as in `usedIn`
   * and the link/unlink events: one service, one name, on screen and in /audit.
   */
  async findService(tenantId: string, entryId: string): Promise<ObligationServiceRef | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ key: string; name: string | null }[]>`
        SELECT e.key, ${db.unsafe(serviceNameSql("e"))} AS name
          FROM config.entry e
         WHERE e.id = ${entryId} AND e.kind = 'service'
      `;
      return row ? { key: row.key, name: row.name } : null;
    });
  }

  async define(entry: NewEntry, firstDraft: NewVersion): Promise<DefinedEntry> {
    return withTenant(this.app, entry.tenantId, async (db) => {
      const [entryRow] = await db<EntryRow[]>`
        INSERT INTO config.entry (id, tenant_id, kind, key)
        VALUES (${entry.id}, ${entry.tenantId}, ${entry.kind}, ${entry.key})
        RETURNING id, tenant_id, kind, key
      `;
      if (!entryRow) throw new Error("config.entry insert returned no row");

      // Version 1 by definition, so no max+1 read.
      const [versionRow] = await db<VersionRow[]>`
        INSERT INTO config.version (id, tenant_id, entry_id, version, body)
        VALUES (${firstDraft.id}, ${firstDraft.tenantId}, ${entry.id}, 1,
                ${db.json(firstDraft.body as Parameters<typeof db.json>[0])})
        RETURNING id, tenant_id, entry_id, version, status, body, published_at, archived_at
      `;
      if (!versionRow) throw new Error("config.version insert returned no row");
      return { entry: toEntry(entryRow), draft: toVersion(versionRow) };
    });
  }

  async findEntry(tenantId: string, kind: ConfigKind, key: string): Promise<ConfigEntry | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<EntryRow[]>`
        SELECT id, tenant_id, kind, key
        FROM config.entry WHERE kind = ${kind} AND key = ${key}
      `;
      return row ? toEntry(row) : null;
    });
  }

  async listPublished(tenantId: string, kind: ConfigKind): Promise<readonly PublishedEntry[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // LEFT JOIN: a draft-only entry still lists, saying it publishes nothing (a half-finished
      // service is not one never created). The pending draft joins here, not per row (a per-row
      // lookup left a draft UNPUBLISHABLE once its entry had something in force). LATERAL LIMIT 1:
      // several drafts may sit beside a published version (0005's unique index is partial).
      const rows = await db<PublishedRow[]>`
        SELECT e.id, e.tenant_id, e.kind, e.key,
               v.id           AS v_id,
               v.version      AS v_version,
               v.status       AS v_status,
               v.body         AS v_body,
               v.published_at AS v_published_at,
               v.archived_at  AS v_archived_at,
               d.id           AS d_id,
               d.version      AS d_version,
               d.status       AS d_status,
               d.body         AS d_body
        FROM config.entry e
        LEFT JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        LEFT JOIN LATERAL (
          SELECT id, version, status, body
          FROM config.version
          WHERE entry_id = e.id AND status = 'draft'
          ORDER BY version DESC
          LIMIT 1
        ) d ON true
        WHERE e.kind = ${kind}
        ORDER BY e.key
      `;
      return rows.map((r) => ({
        entry: toEntry(r),
        published:
          r.v_id === null || r.v_version === null || r.v_status === null || r.v_body === null
            ? null
            : toVersion({
                id: r.v_id,
                tenant_id: r.tenant_id,
                entry_id: r.id,
                version: r.v_version,
                status: r.v_status,
                body: r.v_body,
                published_at: r.v_published_at,
                archived_at: r.v_archived_at,
              }),
        // A draft has neither date (0005's coherence CHECK).
        pendingDraft:
          r.d_id === null || r.d_version === null || r.d_status === null || r.d_body === null
            ? null
            : toVersion({
                id: r.d_id,
                tenant_id: r.tenant_id,
                entry_id: r.id,
                version: r.d_version,
                status: r.d_status,
                body: r.d_body,
                published_at: null,
                archived_at: null,
              }),
      }));
    });
  }

  /** The clause library's terms in force now (T6.18), narrowed to what a letter pins. */
  async publishedClauses(
    tenantId: string,
  ): Promise<readonly { versionId: string; key: string; body: Record<string, unknown> }[]> {
    const entries = await this.listPublished(tenantId, "clause");
    return entries.flatMap((e) =>
      e.published === null
        ? []
        : [{ versionId: e.published.id, key: e.entry.key, body: e.published.body }],
    );
  }

  async listVersions(tenantId: string, entryId: string): Promise<readonly ConfigVersion[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<VersionRow[]>`
        SELECT id, tenant_id, entry_id, version, status, body, published_at, archived_at
        FROM config.version WHERE entry_id = ${entryId} ORDER BY version DESC
      `;
      return rows.map(toVersion);
    });
  }

  async addVersion(v: NewVersion): Promise<ConfigVersion> {
    return withTenant(this.app, v.tenantId, async (db) => {
      // Lock the ENTRY (what is serialised is its next number), then count: two concurrent
      // drafts would otherwise both insert version 3 and one lose to the unique constraint.
      await db`SELECT id FROM config.entry WHERE id = ${v.entryId} FOR UPDATE`;
      const [row] = await db<VersionRow[]>`
        INSERT INTO config.version (id, tenant_id, entry_id, version, body)
        SELECT ${v.id}, ${v.tenantId}, ${v.entryId},
               COALESCE(MAX(version), 0) + 1,
               ${db.json(v.body as Parameters<typeof db.json>[0])}
        FROM config.version WHERE entry_id = ${v.entryId}
        RETURNING id, tenant_id, entry_id, version, status, body, published_at, archived_at
      `;
      if (!row) throw new Error("config.version insert returned no row");
      return toVersion(row);
    });
  }

  async findVersionById(tenantId: string, versionId: string): Promise<ConfigVersion | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<VersionRow[]>`
        SELECT id, tenant_id, entry_id, version, status, body, published_at, archived_at FROM config.version WHERE id = ${versionId}
      `;
      return row ? toVersion(row) : null;
    });
  }

  async publish(tenantId: string, versionId: string): Promise<PublishOutcome> {
    return withTenant(this.app, tenantId, async (db) => {
      const [target] = await db<{ entry_id: string }[]>`
        SELECT entry_id FROM config.version WHERE id = ${versionId}
      `;
      if (!target) throw new Error(`config.version ${versionId} not found`);

      // Same lock as addVersion: of two drafts published at once, the partial unique index would
      // reject one AFTER the other had already archived what was in force.
      await db`SELECT id FROM config.entry WHERE id = ${target.entry_id} FOR UPDATE`;

      // Archive first; reversed, the partial unique index (one published per entry) rejects it.
      const [archived] = await db<VersionRow[]>`
        UPDATE config.version SET status = 'archived', archived_at = now()
        WHERE entry_id = ${target.entry_id} AND status = 'published'
        RETURNING id, tenant_id, entry_id, version, status, body, published_at, archived_at
      `;
      const [published] = await db<VersionRow[]>`
        UPDATE config.version SET status = 'published', published_at = now()
        WHERE id = ${versionId} AND status = 'draft'
        RETURNING id, tenant_id, entry_id, version, status, body, published_at, archived_at
      `;
      if (!published) {
        // The service checks first; reaching here means another caller published it in between.
        throw new Error(
          `config.version ${versionId} was not a draft by the time it was published — ` +
            `another caller published it first. Re-read the entry and try the new draft.`,
        );
      }
      return {
        published: toVersion(published),
        archived: archived ? toVersion(archived) : null,
      };
    });
  }

  async seedPublished(
    tenantId: string,
    kind: ConfigKind,
    rows: readonly SeedRow[],
  ): Promise<readonly ConfigEntry[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const created: ConfigEntry[] = [];
      for (const row of rows) {
        const [entryRow] = await db<EntryRow[]>`
          INSERT INTO config.entry (id, tenant_id, kind, key)
          VALUES (${row.entryId}, ${tenantId}, ${kind}, ${row.key})
          RETURNING id, tenant_id, kind, key
        `;
        if (!entryRow) throw new Error(`config.entry insert returned no row for ${row.key}`);
        await db`
          INSERT INTO config.version
            (id, tenant_id, entry_id, version, status, body, published_at)
          VALUES
            (${row.versionId}, ${tenantId}, ${row.entryId}, 1, 'published',
             ${db.json(row.body as Parameters<typeof db.json>[0])}, now())
        `;
        created.push(toEntry(entryRow));
      }
      return created;
    });
  }

  // ── PermissionSource (gate 3) ──
  // One indexed query per request (the second, after the session guard's), uncached on purpose:
  // a cache keeps a revoked permission live for its TTL. A shared cache invalidated on publish
  // goes behind this port when traffic justifies it.

  /** Gate 3's read and the one place a body becomes a role; `permissionsFor` is built on it so
   *  audience and permissions are never read under different conditions. */
  async roleFor(tenantId: string, role: string): Promise<StoredRole | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'role' AND e.key = ${role}
      `;
      // No row: a role this firm does not define (AuthzService tells it apart via knownRoles()).
      if (!row) return null;
      return {
        audience: readRoleAudience(row.body),
        permissions: readRolePermissions(row.body),
      };
    });
  }

  async permissionsFor(tenantId: string, role: string): Promise<readonly Permission[]> {
    return (await this.roleFor(tenantId, role))?.permissions ?? [];
  }

  async knownRoles(tenantId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Published only: listing a draft role would point a locked-out user at one that won't work.
      const rows = await db<{ key: string }[]>`
        SELECT e.key
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'role'
        ORDER BY e.key
      `;
      return rows.map((r) => r.key);
    });
  }

  /**
   * `RoleDirectory`: the STAFF roles carrying a permission, in one query (`jsonb_exists`), since
   * "does anyone still administer this firm" is asked on every role change and deactivation.
   * Staff-only: gate 2 confines a CLIENT_PORTAL session to `PORTAL_PATHS`, so counting a portal
   * role with `tenant:admin` let a firm move it onto `client_contact`, pass both
   * last-administrator guards and lock itself out for good. Absent `audience` reads as STAFF
   * (`readRoleAudience`, fail-closed: roles older than the field were staff).
   */
  async rolesWith(tenantId: string, permission: Permission): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ key: string }[]>`
        SELECT e.key
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'role'
          AND jsonb_exists(v.body -> 'permissions', ${permission})
          AND COALESCE(v.body ->> 'audience', 'STAFF') = 'STAFF'
        ORDER BY e.key
      `;
      return rows.map((r) => r.key);
    });
  }

  /**
   * Resolve a pin, for quoting (`ServiceCatalogue`) and letter terms (`ClauseLibrary`). No status
   * filter: a proposal line's pin must resolve after the catalogue archived it. The CALLER judges
   * a draft; the proposal service refuses one (an unpublished price must not reach a client).
   */
  async readPinnedVersion(
    tenantId: string,
    versionId: string,
  ): Promise<{
    readonly kind: string;
    readonly status: string;
    readonly key: string;
    readonly version: number;
    readonly body: Record<string, unknown>;
  } | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        {
          kind: string;
          status: string;
          key: string;
          version: number;
          body: Record<string, unknown>;
        }[]
      >`
        SELECT e.kind, v.status, e.key, v.version, v.body
        FROM config.version v
        JOIN config.entry e ON e.id = v.entry_id
        WHERE v.id = ${versionId}
      `;
      return row ?? null;
    });
  }

  /** The firm's discount limit (`PolicyDirectory`), published and read LIVE, not pinned. Null =
   *  no policy, which the domain reads as zero, not "no limit". */
  async maxDiscountPercent(tenantId: string): Promise<Amount | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'policy' AND e.key = ${DISCOUNT_POLICY_KEY}
      `;
      return row ? readMaxDiscountPercent(row.body) : null;
    });
  }

  /**
   * The compliance calendar's go-live date (`CompliancePolicySource`), read live. The OPPOSITE
   * default to the discount limit: no policy means NO FLOOR (everything is asked about), because
   * hiding rows is what produces a missed deadline nobody was told about.
   */
  async missedFromOn(tenantId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'compliance_policy' AND e.key = ${COMPLIANCE_POLICY_KEY}
      `;
      return row ? readMissedFromOn(row.body) : null;
    });
  }

  /** The month the firm's financial year starts (T6.13), off the same policy; null when unsaid.
   *  Live, so the next sweep cuts quarters by it. */
  async fiscalYearStartMonth(tenantId: string): Promise<number | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'compliance_policy' AND e.key = ${COMPLIANCE_POLICY_KEY}
      `;
      return row ? readFiscalYearStartMonth(row.body) : null;
    });
  }

  // ── TemplateSource (orchestrator) ──
  // `publishedTemplate` is asked once when a job starts, `pinnedTemplate` ever after; one method
  // would let a job silently move onto a process edited under it.

  async publishedTemplate(tenantId: string, key: string): Promise<ResolvedTemplate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'workflow_template' AND e.key = ${key}
      `;
      // No row: the process is unwritten and the job WAITS. A draft is never run.
      return row ? toResolvedTemplate(row.id, row.body) : null;
    });
  }

  /**
   * The firm's confidence thresholds (T2.8): one entry per firm under a fixed key, not per agent
   * (no agents yet, so no accuracy record to set one from; later a key per agent, same port).
   * Null is ordinary: the caller falls back to "never commit, always ask", never invented numbers.
   */
  async publishedTiers(tenantId: string): Promise<PublishedTiers | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'confidence_tier' AND e.key = ${CONFIDENCE_TIER_KEY}
      `;
      if (!row) return null;
      const tiers = readConfidenceTierBody(row.body);
      // A body that no longer parses reads as none: unsure what it may do, a machine does not act.
      return tiers === null ? null : { tiers, versionId: row.id };
    });
  }

  // ── VerificationPolicySource (T2.9) ──
  // `publishedPolicy` once when a check opens, `pinnedPolicy` after: raising the review bar does
  // not strand open checks, and an audit gets who could approve THEN.

  async publishedPolicy(tenantId: string, key: string): Promise<ResolvedPolicy | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'verification_policy' AND e.key = ${key}
      `;
      // No row (no rule, or a withdrawn one a template still names): the caller still opens the
      // check under maker != checker alone. Unpublishing WHO reviews is not "nobody does".
      return row ? toResolvedPolicy(row.id, key, row.body) : null;
    });
  }

  /** Every rule in force (CA#27): what a task is checked under when its sender names none.
   *  Ordered by key, so "the first" is stable. */
  async publishedPolicies(tenantId: string): Promise<readonly ResolvedPolicy[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; key: string; body: Record<string, unknown> }[]>`
        SELECT v.id, e.key, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'verification_policy'
        ORDER BY e.key
      `;
      return rows.flatMap((r) => {
        const resolved = toResolvedPolicy(r.id, r.key, r.body);
        return resolved === null ? [] : [resolved];
      });
    });
  }

  async pinnedPolicy(tenantId: string, versionId: string): Promise<ResolvedPolicy | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // By VERSION id, no status filter, as in `pinnedTemplate`.
      const [row] = await db<{ id: string; key: string; body: Record<string, unknown> }[]>`
        SELECT v.id, e.key, v.body
        FROM config.version v
        JOIN config.entry e ON e.id = v.entry_id
        WHERE v.id = ${versionId}
      `;
      return row ? toResolvedPolicy(row.id, row.key, row.body) : null;
    });
  }

  async pinnedTemplate(tenantId: string, versionId: string): Promise<ResolvedTemplate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // By VERSION id, no status filter: a pinned version is `archived` once a newer one
      // publishes, and filtering on `published` would break every job at its first revision.
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT id, body FROM config.version WHERE id = ${versionId}
      `;
      return row ? toResolvedTemplate(row.id, row.body) : null;
    });
  }
}

/** Null when the body is not a policy: for a PINNED version a fact about the past, never today's
 *  rule applied retroactively. */
function toResolvedPolicy(
  versionId: string,
  key: string,
  body: Record<string, unknown>,
): ResolvedPolicy | null {
  const policy = readVerificationPolicyBody(body);
  return policy === null ? null : { versionId, key, policy };
}

/** Null when the body is not a template: for a PINNED version a fact about the past, not an error. */
function toResolvedTemplate(
  versionId: string,
  body: Record<string, unknown>,
): ResolvedTemplate | null {
  const template = readWorkflowTemplate(body);
  if (!template) return null;
  return {
    versionId,
    label: template.label,
    steps: template.steps.map((s) => ({
      key: s.key,
      label: s.label,
      executor: s.executor,
      dependsOn: s.dependsOn,
      condition: s.condition,
      verificationPolicyKey: s.verificationPolicyKey,
      performer: s.performer,
      // T6.15: an absent list is already empty, so an older version means no sub-steps/review points.
      checklist: s.checklist.map((l) => ({ key: l.key, label: l.label })),
      reviewPoints: s.reviewPoints.map((l) => ({ key: l.key, label: l.label })),
    })),
  };

}
