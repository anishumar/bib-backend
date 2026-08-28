// In-memory port fakes for the configuration registry. `implements` both ports
// the real Postgres adapter implements (a compile-time assertion that they stay
// in step), so the registry's rules and gate 3's role lookup can both be tested
// with zero infrastructure.
//
// It reproduces the behaviours business rules depend on — version numbers count
// per entry, publishing archives whatever it replaced, and an archived version
// still resolves by id — and nothing else. It does NOT enforce RLS, the freeze
// trigger, or the one-published-version index: those are database properties,
// proven against real Postgres in tests/config/registry.integration.test.ts.
import type { Permission } from "../domain/authz/model";
import { DEFAULT_ROLES } from "../domain/authz/model";
import type {
  ConfigEntry,
  ConfigKind,
  ConfigVersion,
  PublishedEntry,
} from "../domain/config/model";
import { readRolePermissions, roleBodyOf } from "../domain/config/model";
import type { PermissionSource } from "../usecase/authz/ports";
import type {
  ConfigRepository,
  DefinedEntry,
  NewEntry,
  NewVersion,
  PublishOutcome,
  SeedRow,
} from "../usecase/config/ports";
import type { Deps } from "../usecase/config/service";
import { ConfigService } from "../usecase/config/service";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

/** A fixed clock. Real timestamps come from the database; the fake needs only
 *  to be ordered and deterministic. */
const EPOCH = Date.parse("2026-01-01T00:00:00Z");

export class FakeConfigRepo implements ConfigRepository, PermissionSource {
  readonly entries: ConfigEntry[] = [];
  readonly versions: ConfigVersion[] = [];
  private tick = 0;

  private now(): string {
    const at = new Date(EPOCH + this.tick * 1000).toISOString();
    this.tick += 1;
    return at;
  }

  define(entry: NewEntry, firstDraft: NewVersion): Promise<DefinedEntry> {
    const created: ConfigEntry = {
      id: entry.id,
      tenantId: entry.tenantId,
      kind: entry.kind,
      key: entry.key,
    };
    this.entries.push(created);
    const draft: ConfigVersion = {
      id: firstDraft.id,
      tenantId: firstDraft.tenantId,
      entryId: entry.id,
      version: 1,
      status: "draft",
      body: firstDraft.body,
      publishedAt: null,
      archivedAt: null,
    };
    this.versions.push(draft);
    return Promise.resolve({ entry: created, draft });
  }

  findEntry(tenantId: string, kind: ConfigKind, key: string): Promise<ConfigEntry | null> {
    return Promise.resolve(
      this.entries.find((e) => e.tenantId === tenantId && e.kind === kind && e.key === key) ?? null,
    );
  }

  listPublished(tenantId: string, kind: ConfigKind): Promise<readonly PublishedEntry[]> {
    const rows = this.entries
      .filter((e) => e.tenantId === tenantId && e.kind === kind)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((entry) => ({
        entry,
        published:
          this.versions.find((v) => v.entryId === entry.id && v.status === "published") ?? null,
      }));
    return Promise.resolve(rows);
  }

  listVersions(tenantId: string, entryId: string): Promise<readonly ConfigVersion[]> {
    return Promise.resolve(
      this.versions
        .filter((v) => v.tenantId === tenantId && v.entryId === entryId)
        .sort((a, b) => b.version - a.version),
    );
  }

  addVersion(v: NewVersion): Promise<ConfigVersion> {
    const highest = this.versions
      .filter((row) => row.entryId === v.entryId)
      .reduce((max, row) => Math.max(max, row.version), 0);
    const draft: ConfigVersion = {
      id: v.id,
      tenantId: v.tenantId,
      entryId: v.entryId,
      version: highest + 1,
      status: "draft",
      body: v.body,
      publishedAt: null,
      archivedAt: null,
    };
    this.versions.push(draft);
    return Promise.resolve(draft);
  }

  findVersionById(tenantId: string, versionId: string): Promise<ConfigVersion | null> {
    return Promise.resolve(
      this.versions.find((v) => v.tenantId === tenantId && v.id === versionId) ?? null,
    );
  }

  publish(tenantId: string, versionId: string): Promise<PublishOutcome> {
    const index = this.versions.findIndex((v) => v.tenantId === tenantId && v.id === versionId);
    const target = this.versions[index];
    if (!target) throw new Error(`fake registry: no version ${versionId}`);

    // Archive first, exactly as the adapter does — reversed, there would be a
    // moment with two published versions.
    let archived: ConfigVersion | null = null;
    const currentIndex = this.versions.findIndex(
      (v) => v.entryId === target.entryId && v.status === "published",
    );
    const current = this.versions[currentIndex];
    if (current) {
      archived = { ...current, status: "archived", archivedAt: this.now() };
      this.versions[currentIndex] = archived;
    }
    const published: ConfigVersion = { ...target, status: "published", publishedAt: this.now() };
    this.versions[index] = published;
    return Promise.resolve({ published, archived });
  }

  seedPublished(
    tenantId: string,
    kind: ConfigKind,
    rows: readonly SeedRow[],
  ): Promise<readonly ConfigEntry[]> {
    return Promise.resolve(this.seedNow(tenantId, kind, rows));
  }

  /** The same write, without the promise. Tests that build a router
   *  synchronously need a firm that already has its roles, and awaiting is not
   *  available to them — so the sync half is named rather than smuggled in
   *  behind a promise that happens to resolve immediately. */
  seedNow(
    tenantId: string,
    kind: ConfigKind,
    rows: readonly SeedRow[],
  ): readonly ConfigEntry[] {
    const created = rows.map((row) => {
      const entry: ConfigEntry = { id: row.entryId, tenantId, kind, key: row.key };
      this.entries.push(entry);
      this.versions.push({
        id: row.versionId,
        tenantId,
        entryId: row.entryId,
        version: 1,
        status: "published",
        body: row.body,
        publishedAt: this.now(),
        archivedAt: null,
      });
      return entry;
    });
    return created;
  }

  // ── PermissionSource ───────────────────────────────────────────────────────

  permissionsFor(tenantId: string, role: string): Promise<readonly Permission[]> {
    const entry = this.entries.find(
      (e) => e.tenantId === tenantId && e.kind === "role" && e.key === role,
    );
    if (!entry) return Promise.resolve([]);
    const published = this.versions.find(
      (v) => v.entryId === entry.id && v.status === "published",
    );
    return Promise.resolve(published ? readRolePermissions(published.body) : []);
  }

  knownRoles(tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(
      this.entries
        .filter(
          (e) =>
            e.tenantId === tenantId &&
            e.kind === "role" &&
            this.versions.some((v) => v.entryId === e.id && v.status === "published"),
        )
        .map((e) => e.key)
        .sort((a, b) => a.localeCompare(b)),
    );
  }
}

/** A ready-made dependency set for ConfigService, matching makePartyFakes(). */
export function makeConfigFakes(): Deps & { registry: FakeConfigRepo } {
  return {
    registry: new FakeConfigRepo(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
  };
}

/**
 * A registry with a tenant already seeded — the state every real tenant is in
 * from the moment it is created, so a test that is not ABOUT provisioning
 * should start here rather than from an empty registry.
 */
export async function seededConfig(tenantId: string): Promise<{
  service: ConfigService;
  registry: FakeConfigRepo;
  events: RecordingEventSink;
}> {
  const fakes = makeConfigFakes();
  const service = new ConfigService(fakes);
  await service.seedDefaultRoles(tenantId);
  return {
    service,
    registry: fakes.registry,
    events: fakes.events as RecordingEventSink,
  };
}

/**
 * A registry in the state EVERY real tenant is in — its four default roles
 * already written and published, because that happens inside createTenant.
 *
 * Synchronous, so a test that builds a router in a plain function can use it. A
 * test that starts from an empty registry is testing a firm that cannot be
 * created, so this is the right default for anything not about provisioning.
 */
export function withDefaultRoles(tenantId: string): FakeConfigRepo {
  const repo = new FakeConfigRepo();
  const ids = new FakeIds();
  repo.seedNow(
    tenantId,
    "role",
    Object.entries(DEFAULT_ROLES).map(([key, definition]) => ({
      entryId: ids.newId(),
      versionId: ids.newId(),
      key,
      body: roleBodyOf(definition),
    })),
  );
  return repo;
}
