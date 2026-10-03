// Postgres adapter for the configuration registry.
//
// ONE class, FIVE ports, deliberately — the same pattern as the
// users/memberships repositories serving both tenancy and identity.
// `ConfigRepository` is the registry's own seam; `PermissionSource` is gate 3's;
// `RoleDirectory` is what firm administration asks (which roles exist here, and
// which of them can administer the place); `ServiceCatalogue` and
// `PolicyDirectory` are what quoting asks (resolve this pin, and what is the
// firm's discount limit right now). All five questions are config reads over the
// same two tables. Splitting them would put five files' worth of "what published
// means" over one pair of tables, and the day they disagreed, one of them would
// be answering an authorization question wrongly.
//
// Every method runs under withTenant, so the RLS tenant wall applies to each
// statement. timestamptz arrives as a Date and leaves as an ISO 8601 string —
// the door where Postgres types become ours.
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

/** entry LEFT JOIN its published version: every entry column, and the version
 *  columns nullable because an entry with only drafts publishes nothing. */
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
   * The `ServiceDirectory` port T3.2 declares — does this catalogue ENTRY exist,
   * and what is it called?
   *
   * The entry and not a version, deliberately: a compliance rule is about what
   * the firm SELLS, and a firm publishing v4 of 'gst-filing' has not stopped
   * owing its clients GSTR-3B. Pinning a version on a rule would quietly stop
   * it generating the day somebody edited the catalogue.
   *
   * The name is `usedIn`'s own derivation (`serviceNameSql`), because the link
   * and unlink events are named from it and the library shows the other: one
   * service, one name, on the screen and in /audit.
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

      // Version 1 by definition — there is nothing to count yet, so this is the
      // one insert that does not need the max+1 read the others do.
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
      // LEFT JOIN, not INNER: an entry whose only version is a draft still
      // belongs in the list, saying plainly that it publishes nothing. Dropping
      // it would make a half-finished service look like one that was never
      // created, and the two need different actions.
      // The pending draft joins here rather than being fetched per row. A screen
      // needs to know whether anything is waiting, and asking again once per
      // entry is the per-row lookup CLAUDE.md warns about — it also left a draft
      // UNPUBLISHABLE from a list once its entry had something in force.
      //
      // LATERAL with LIMIT 1 and not a second plain LEFT JOIN: several drafts
      // may sit beside a published version (0005's unique index is partial), and
      // a plain join would multiply the entry into one row per draft and quietly
      // repeat it in the list.
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
        // A draft has neither date by definition — 0005's coherence CHECK says
        // so — which is why they are not selected above.
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

  /** The clause library's terms in force now (T6.18) — `listPublished`'s read,
   *  narrowed to what a letter pins. */
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
      // Lock the ENTRY, then count. Two people drafting against the same
      // service at once would otherwise both read max=2, both insert version 3,
      // and one would lose to the unique constraint after doing the work. The
      // lock is on the entry rather than the versions because the thing being
      // serialised is "the next number for this entry".
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

      // Same lock as addVersion, for the neighbouring race: two drafts
      // published at once would both try to become the single published
      // version, and the partial unique index would reject one AFTER the other
      // had already archived what was in force.
      await db`SELECT id FROM config.entry WHERE id = ${target.entry_id} FOR UPDATE`;

      // Archive first. Reversed, the partial unique index (one published
      // version per entry) rejects the second statement — and there is no
      // moment in between when a permission check could see two answers.
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
        // The service checks this first; reaching here means somebody else
        // published the same draft in the moment between the two.
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

  // ── PermissionSource — gate 3 reads the registry ───────────────────────────
  //
  // HONEST LIMITATION: one indexed query per authenticated request, uncached.
  // The session guard already makes a round trip to re-check the membership, so
  // this is a second on the same request rather than the first. It is uncached
  // on purpose: a cache means a revoked permission stays live for its TTL, and
  // a firm that takes an access away expects it gone this afternoon. A shared
  // cache with explicit invalidation on publish is the fix when the traffic
  // justifies it, and it goes behind this same port.

  /**
   * Gate 3's read, and the one place this body is turned into a role.
   *
   * `permissionsFor` is implemented in terms of it rather than beside it: two
   * statements reading the same published body is how the audience and the
   * permissions come to be read under different conditions, and this is a
   * middleware that runs on every request.
   */
  async roleFor(tenantId: string, role: string): Promise<StoredRole | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'role' AND e.key = ${role}
      `;
      // No row is the ordinary answer for a role this firm does not define.
      // AuthzService asks knownRoles() to tell that apart from a role that
      // exists and simply lacks the permission.
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
      // Published only. A role that exists as a draft is not in force, and
      // listing it would tell someone locked out to use a role that will not
      // work.
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
   * The roles carrying one permission — the third port this class satisfies
   * (`RoleDirectory`, for firm administration).
   *
   * One query rather than `knownRoles` followed by `permissionsFor` per role.
   * The caller — "does this firm still have anyone who can administer it" —
   * asks on every role change and every deactivation, and it should not cost a
   * round trip per role to answer.
   *
   * `jsonb_exists` over the permissions array asks the question in the database
   * rather than reading every role body back to filter in TypeScript.
   *
   * -- AND WHY IT IS STAFF-ONLY -----------------------------------------------
   *
   * The one caller asks "does this firm still have anyone who can administer
   * it", and only a STAFF role can be an answer to that: gate 2 admits a
   * CLIENT_PORTAL session to `PORTAL_PATHS` and nothing else, so a portal role
   * carrying `tenant:admin` grants the ability to administer precisely nothing.
   * Counting one meant a firm could move `tenant:admin` onto `client_contact`,
   * satisfy both last-administrator guards, and end up with nobody able to
   * change its configuration back — the unrecoverable state the guards exist to
   * prevent, reached THROUGH them.
   *
   * An absent `audience` reads as STAFF, which is `readRoleAudience`'s rule and
   * the fail-closed direction: every role written before the field existed was
   * a staff role.
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
   * RESOLVE A PIN — for quoting (`ServiceCatalogue`) and for assembling an
   * engagement letter's terms (`ClauseLibrary`). Both use cases declared the
   * same question about the same two tables, so it is answered once.
   *
   * Deliberately does NOT filter on status: a proposal line pins the version it
   * was quoted from, and the whole promise of the registry is that the pin
   * still resolves after the catalogue moved on and archived it. The CALLER
   * decides what to do with a draft — the proposal service refuses one, because
   * a price the firm never put in force must not reach a client's document.
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

  /**
   * The firm's discount limit, right now (`PolicyDirectory`).
   *
   * Published only, and read LIVE rather than pinned — a firm that lowers its
   * limit expects the new one to apply this afternoon, the same reasoning that
   * makes roles a live read. Null means no policy is published, which the
   * domain reads as zero rather than as "no limit".
   */
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
   * When this firm's compliance calendar goes live (`CompliancePolicySource`).
   *
   * The same shape as `maxDiscountPercent` and the OPPOSITE default, which is
   * the part worth reading twice. No published discount policy means ZERO —
   * nothing is allowed — because a firm that never set a limit has not decided
   * anything goes. No published compliance policy means NO FLOOR — everything
   * is asked about — because the failure to avoid here is a missed deadline
   * nobody was told about, and hiding rows is the direction that produces it.
   *
   * Live rather than pinned: a firm that moves its go-live date expects the
   * queue to change tonight.
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

  /** The month the firm's financial year starts (T6.13), off the same
   *  published policy, or null when the firm has not said. Live, like the
   *  floor, and for the same reason: a firm that answers expects the next
   *  sweep to cut its quarters. */
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

  // ── TemplateSource (the orchestrator's seam) ────────────────────────────────
  //
  // Two reads, and the difference between them IS pinning. `publishedTemplate`
  // is asked once, when a job starts; `pinnedTemplate` every time afterwards. A
  // single "get the template" method would have collapsed them, and a job would
  // silently move onto a process edited under it.

  async publishedTemplate(tenantId: string, key: string): Promise<ResolvedTemplate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'workflow_template' AND e.key = ${key}
      `;
      // No row is the ordinary answer for a firm that has not written this
      // process yet, and the orchestrator turns it into a job that WAITS.
      // A draft is deliberately not accepted: a process somebody is still
      // writing is not one to run a client's work through.
      return row ? toResolvedTemplate(row.id, row.body) : null;
    });
  }

  /**
   * The firm's confidence thresholds, as published (T2.8).
   *
   * One entry per firm under a fixed key, not one per agent. A per-agent
   * threshold is a knob nobody can fill today — there are no agents, so there is
   * no accuracy record to set one from — and a knob set by guessing is worse
   * than one that does not exist. When agents exist and their accuracy differs,
   * this becomes a key per agent and the port does not change.
   *
   * Null is the ordinary answer and NOT an error: the caller falls back to
   * "never commit, always ask" rather than to numbers this code invented, which
   * is why T2.8 changed no firm's behaviour on the day it shipped.
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
      // A published row that no longer parses reads as nothing published. The
      // safe direction: a machine that cannot establish what it is allowed to do
      // does not act unattended.
      return tiers === null ? null : { tiers, versionId: row.id };
    });
  }

  // ── VerificationPolicySource (T2.9's seam) ─────────────────────────────────
  //
  // The same two reads, for the same reason, one kind later. `publishedPolicy`
  // is asked ONCE, when a check is opened; `pinnedPolicy` every time
  // afterwards — so a firm raising its review bar this afternoon does not make
  // this morning's open checks unapprovable by the people already looking at
  // them, and an audit asking "who was allowed to approve this" gets the answer
  // that was true then.

  async publishedPolicy(tenantId: string, key: string): Promise<ResolvedPolicy | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'verification_policy' AND e.key = ${key}
      `;
      // No row is the ordinary answer for a firm that has written no review rule
      // — or has withdrawn one a template still names. The caller opens the
      // check anyway, under maker != checker alone: the firm said this step is
      // reviewed, and unpublishing the rule about WHO does it is not the same as
      // saying nobody does.
      return row ? toResolvedPolicy(row.id, key, row.body) : null;
    });
  }

  /** Every rule in force at the firm (CA#27): what a task is checked under
   *  when its sender names none. Ordered by key, so "the first" is stable. */
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
      // By VERSION id with no status filter, exactly as `pinnedTemplate` does:
      // the version a check pinned is `archived` the moment the firm publishes a
      // newer rule, and reading it is the entire point.
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
      // By VERSION id, with no status filter — the version a job pinned is
      // `archived` the moment the firm publishes a newer one, and reading it is
      // the entire point. Filtering on `published` here would quietly break
      // every job the first time its process was revised.
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT id, body FROM config.version WHERE id = ${versionId}
      `;
      return row ? toResolvedTemplate(row.id, row.body) : null;
    });
  }
}

/** A stored body as the verification port states it. Null when the row does not
 *  read as a policy — which for a PINNED version is a fact about the past, not
 *  today's rule applied retroactively to a check somebody already opened. */
function toResolvedPolicy(
  versionId: string,
  key: string,
  body: Record<string, unknown>,
): ResolvedPolicy | null {
  const policy = readVerificationPolicyBody(body);
  return policy === null ? null : { versionId, key, policy };
}

/** A stored body as the orchestrator's port states it. Null when the row does
 *  not read as a template — which for a PINNED version is a fact about the past,
 *  not an exception to raise at whoever asked. */
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
      // Both lists, field by field like the rest (T6.15). `readWorkflowTemplate`
      // has already turned an absent list into an empty one, so a version
      // published before the fields existed reaches the orchestrator as a step
      // with no sub-steps and no review points: exactly what it meant.
      checklist: s.checklist.map((l) => ({ key: l.key, label: l.label })),
      reviewPoints: s.reviewPoints.map((l) => ({ key: l.key, label: l.label })),
    })),
  };

}
