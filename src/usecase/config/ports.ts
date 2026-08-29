// The ports the configuration registry needs from the world. Interfaces are
// owned by the use case that needs them, stated in our vocabulary; adapters in
// infrastructure/ implement them. Every method is tenant-scoped and expected to
// run under the RLS context (withTenant) inside the adapter.
import type { ConfigEntry, ConfigKind, ConfigVersion, PublishedEntry } from "../../domain/config/model";

export interface NewEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: ConfigKind;
  readonly key: string;
}

/**
 * A version to insert. Note what is ABSENT: the version NUMBER.
 *
 * The repository assigns it, under a lock on the entry row, because computing
 * `max + 1` up here and inserting it down there is a race two people editing
 * the same service would eventually lose. The unique constraint would catch it,
 * but a caller should not have to retry to find that out.
 */
export interface NewVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly entryId: string;
  readonly body: Record<string, unknown>;
}

/** An entry and its first version, created together — an entry with no version
 *  says nothing, so the two are never separately observable. */
export interface DefinedEntry {
  readonly entry: ConfigEntry;
  readonly draft: ConfigVersion;
}

export interface PublishOutcome {
  readonly published: ConfigVersion;
  /** The version this one replaced, now archived. Null when it is the first. */
  readonly archived: ConfigVersion | null;
}

/** One entry to write straight into a published state — provisioning only. */
export interface SeedRow {
  readonly entryId: string;
  readonly versionId: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

export interface ConfigRepository {
  /** Creates the entry and its first draft in ONE transaction. */
  define(entry: NewEntry, firstDraft: NewVersion): Promise<DefinedEntry>;

  findEntry(tenantId: string, kind: ConfigKind, key: string): Promise<ConfigEntry | null>;

  /** The catalogue read: every entry of a kind, with whatever it currently
   *  says. Entries with only drafts come back with `published: null`. */
  listPublished(tenantId: string, kind: ConfigKind): Promise<readonly PublishedEntry[]>;

  /** One entry's history, newest version first. */
  listVersions(tenantId: string, entryId: string): Promise<readonly ConfigVersion[]>;

  /** A new draft on an existing entry. The number is assigned here. */
  addVersion(v: NewVersion): Promise<ConfigVersion>;

  /**
   * RESOLVE A PIN. The one read that must keep working after the version has
   * been superseded and archived — that is the entire promise the registry
   * makes to a job that started three weeks ago.
   */
  findVersionById(tenantId: string, versionId: string): Promise<ConfigVersion | null>;

  /**
   * Archive whatever this entry currently publishes and publish this draft, in
   * ONE transaction. Two steps that must not be separately observable: between
   * them there would be either two published versions or none, and a permission
   * check landing in that window would get the wrong answer.
   */
  publish(tenantId: string, versionId: string): Promise<PublishOutcome>;

  /**
   * Create entries whose first version is already published, in one
   * transaction. Provisioning only: a new firm's role registry has to exist
   * before anyone can sign in to edit it, so it cannot be assembled through the
   * draft-then-publish path the product uses.
   */
  seedPublished(
    tenantId: string,
    kind: ConfigKind,
    rows: readonly SeedRow[],
  ): Promise<readonly ConfigEntry[]>;
}

/**
 * Which roles anybody actually HOLDS at this firm.
 *
 * The registry's lockout guard can see that some role carries `tenant:admin`.
 * It cannot see whether a single person has that role — and a firm where the
 * permission exists only on a role nobody holds is stranded exactly as
 * completely as one where no role carries it at all.
 *
 * Narrow on purpose: the registry does not want to know what a membership is,
 * only which role names are live. Satisfied by the membership adapter, which is
 * where that fact lives.
 */
export interface RoleHolders {
  /** Role keys held by ACTIVE members. Empty for a firm with no members yet —
   *  there is nobody to strand, so the holder check does not apply. */
  rolesInUse(tenantId: string): Promise<readonly string[]>;
}

/**
 * The firm's own Depts and delivery teams — the lists a `service` body's
 * `module` and `group` must name (G2.4).
 *
 * The registry validates a body against its KIND, and that check is pure: it can
 * see that `module` is in canonical form, and it cannot see whether the firm has
 * ever heard of it. That was enough while these fields were only grouped by on a
 * dashboard. It stops being enough at T2.7, where the orchestrator gives each
 * group of an engagement's lines its own job: `FINCOMPLIANCE` and
 * `FIN COMPLIANCE` are both canonical, they are one team to a person, and they
 * would silently become two jobs with nobody told.
 *
 * Narrow on purpose: the registry does not want to know what a Dept IS, only
 * which codes are defined and which are still in use. Satisfied by the
 * service-axis adapter, which is where that fact lives — so the two use cases
 * never import each other, exactly as `RoleDirectory` and `RoleHolders` do.
 */
export interface KnownAxis {
  /** `dept` or `team`. Stated as a plain string here rather than importing the
   *  service-axis domain: this is the registry's own vocabulary for a fact it
   *  gets from elsewhere, and the adapter is what reconciles the two. */
  readonly axis: string;
  readonly code: string;
  readonly isActive: boolean;
}

export interface AxisDirectory {
  /** Both lists at this firm, retired rows included — a body naming a retired
   *  code is refused with a different message than one naming an unknown code,
   *  and telling them apart needs both. */
  knownAxes(tenantId: string): Promise<readonly KnownAxis[]>;
}
