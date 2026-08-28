// The configuration registry use case (P2 / T2.5) — orchestration + business
// rules against ports. No I/O, no SQL, no HTTP.
//
// What this service is FOR is the lifecycle, not the shapes:
//
//   define   an entry with its first draft
//   version  another draft, while the current one stays in force
//   publish  the draft takes effect and freezes; the one it replaced is
//            archived, and stays readable forever because something may be
//            pinned to it
//
// Two reads, and the difference is the point of the whole task:
//
//   list / describe  — what the firm says NOW. Roles are read this way, through
//                      the PermissionSource port: a firm that takes a permission
//                      away expects it gone this afternoon.
//   readPinned       — what it said WHEN, by version id. Jobs and quotes read
//                      this way, so editing a workflow never rewrites work
//                      already walking it.
//
// The registry never pins anything on a consumer's behalf. A pin is a value the
// consumer stores, and the registry's job is only to make sure that value keeps
// resolving to the same content forever.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { Permission } from "../../domain/authz/model";
import {
  ADMIN_PERMISSION,
  DEFAULT_ROLES,
  leavesNobodyAdmin,
} from "../../domain/authz/model";
import type {
  ConfigEntry,
  ConfigKind,
  ConfigVersion,
  PublishedEntry,
} from "../../domain/config/model";
import {
  CONFIG_KINDS,
  configRef,
  isConfigKind,
  isValidKey,
  readRolePermissions,
  roleBodyOf,
  validateBody,
} from "../../domain/config/model";
import {
  EntryExists,
  EntryNotFound,
  InvalidBody,
  InvalidKey,
  InvalidKind,
  VersionNotDraft,
  VersionNotFound,
  NoOneWouldAdminister,
  WouldLockOutAdministration,
} from "../../domain/config/errors";
import type { ConfigRepository, DefinedEntry, RoleHolders } from "./ports";

export interface Deps {
  readonly registry: ConfigRepository;
  /** Which roles are actually on somebody's membership — the half of the
   *  lockout guard the registry cannot see by itself. */
  readonly holders: RoleHolders;
  readonly ids: IdGen;
  /** The audit trail. Configuration decides what everyone else may do, so who
   *  changed it and when is exactly the sort of thing a regulator asks about. */
  readonly events: EventSink;
}

// Inputs are written `?: T | undefined` where optional, because the project
// runs exactOptionalPropertyTypes and these come straight from zod-parsed
// request bodies where an absent field IS `undefined`.
export interface DefineInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

export interface AddVersionInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly key: string;
  readonly body: Record<string, unknown>;
}

export interface PublishInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly key: string;
  readonly version: number;
}

export interface EntryHistory {
  readonly entry: ConfigEntry;
  readonly versions: readonly ConfigVersion[];
}

export class ConfigService {
  constructor(private readonly deps: Deps) {}

  /**
   * Define a new configured thing, with its first draft.
   *
   * It is NOT published: defining a service and putting it in front of clients
   * are different decisions, and collapsing them would mean a half-written
   * catalogue row is live the moment it is saved.
   */
  async define(input: DefineInput, actor: Actor): Promise<DefinedEntry> {
    const kind = this.parseKind(input.kind);
    if (!isValidKey(input.key)) throw new InvalidKey(input.key);
    this.checkBody(kind, input.body);

    const existing = await this.deps.registry.findEntry(input.tenantId, kind, input.key);
    if (existing) throw new EntryExists(kind, input.key);

    const entryId = this.deps.ids.newId();
    const defined = await this.deps.registry.define(
      { id: entryId, tenantId: input.tenantId, kind, key: input.key },
      { id: this.deps.ids.newId(), tenantId: input.tenantId, entryId, body: input.body },
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "config_entry.created",
      objectId: defined.entry.id,
      actor,
      payload: { kind, key: defined.entry.key, versionId: defined.draft.id },
    });
    return defined;
  }

  /**
   * Another draft on an existing entry. What is published stays published until
   * someone publishes this one.
   *
   * The only mutating method here that takes NO actor, because it records
   * nothing: a draft changes nothing about what the firm does, and the log
   * holds what took effect. `publish` is where that happens, and it names the
   * person who made it real. If a firm ever needs to see who prepared a pending
   * change, that is a verb and an argument added together, deliberately.
   */
  async addVersion(input: AddVersionInput): Promise<ConfigVersion> {
    const kind = this.parseKind(input.kind);
    this.checkBody(kind, input.body);
    const entry = await this.entryOrThrow(input.tenantId, kind, input.key);

    return this.deps.registry.addVersion({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      entryId: entry.id,
      body: input.body,
    });
  }

  /**
   * Put a draft in force. The version it replaces is archived, not deleted, so
   * every pin taken against it keeps resolving.
   */
  async publish(input: PublishInput, actor: Actor): Promise<ConfigVersion> {
    const kind = this.parseKind(input.kind);
    const entry = await this.entryOrThrow(input.tenantId, kind, input.key);
    const versions = await this.deps.registry.listVersions(input.tenantId, entry.id);
    const target = versions.find((v) => v.version === input.version);
    const ref = configRef(kind, entry.key, input.version);
    if (!target) throw new VersionNotFound(ref);
    if (target.status !== "draft") throw new VersionNotDraft(ref, target.status);

    if (kind === "role") await this.refuseIfItStrandsTheFirm(input.tenantId, entry, target);

    const outcome = await this.deps.registry.publish(input.tenantId, target.id);

    // Two events, because two things happened and a firm asking "why did this
    // change on the 14th" needs both halves. The archive is recorded first: it
    // is the older fact, and the publish names what replaced it.
    if (outcome.archived) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "config_version.archived",
        objectId: outcome.archived.id,
        actor,
        payload: {
          kind,
          key: entry.key,
          entryId: entry.id,
          version: outcome.archived.version,
          ref: configRef(kind, entry.key, outcome.archived.version),
          supersededBy: outcome.published.id,
        },
      });
    }
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "config_version.published",
      objectId: outcome.published.id,
      actor,
      payload: {
        kind,
        key: entry.key,
        entryId: entry.id,
        version: outcome.published.version,
        ref: configRef(kind, entry.key, outcome.published.version),
        ...(outcome.archived ? { replaced: outcome.archived.id } : {}),
      },
    });
    return outcome.published;
  }

  /** Everything of a kind, with what it currently says. The catalogue read. */
  async list(tenantId: string, kind: string): Promise<readonly PublishedEntry[]> {
    return this.deps.registry.listPublished(tenantId, this.parseKind(kind));
  }

  /** One entry and its whole history — drafts, what is live, what it replaced. */
  async describe(tenantId: string, kind: string, key: string): Promise<EntryHistory> {
    const parsed = this.parseKind(kind);
    const entry = await this.entryOrThrow(tenantId, parsed, key);
    return { entry, versions: await this.deps.registry.listVersions(tenantId, entry.id) };
  }

  /**
   * RESOLVE A PIN — read exactly the version a consumer stored, whatever has
   * been published since.
   *
   * The consumers that will call this are T2.2 (a proposal reading the
   * catalogue row it quoted) and T2.7 (a job reading the template version it
   * started on). It is here now rather than later because it is the property
   * the whole table pair exists to provide, and a spine whose central promise
   * has no way to be exercised is a spine nobody has checked.
   */
  async readPinned(tenantId: string, versionId: string): Promise<ConfigVersion> {
    const version = await this.deps.registry.findVersionById(tenantId, versionId);
    if (!version) throw new VersionNotFound(versionId);
    return version;
  }

  /**
   * Write the product's default roles as a new firm's own config rows.
   *
   * Called from tenant provisioning, in the same call that creates the tenant.
   * Every firm owns a complete role set from the moment it exists, so gate 3
   * never has to fall back to a built-in table — see the note in
   * migrations/0005_config.up.sql for why both available fallbacks are worse.
   *
   * Published immediately, unlike everything else here: a role set nobody has
   * published yet is a firm nobody can sign in to.
   */
  async seedDefaultRoles(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<readonly string[]> {
    const rows = Object.entries(DEFAULT_ROLES).map(([key, definition]) => ({
      entryId: this.deps.ids.newId(),
      versionId: this.deps.ids.newId(),
      key,
      body: roleBodyOf(definition),
    }));
    const entries = await this.deps.registry.seedPublished(tenantId, "role", rows);
    const keys = entries.map((e) => e.key);

    // ONE event, not two per role. Eight rows in a new firm's timeline for
    // something that is really one fact — "this firm's configuration was
    // initialised" — buries the events a person actually did.
    await this.deps.events.recordEvent({
      tenantId,
      verb: "config_registry.seeded",
      objectId: tenantId,
      actor,
      payload: { kind: "role", keys },
    });
    return keys;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private parseKind(kind: string): ConfigKind {
    if (!isConfigKind(kind)) throw new InvalidKind(kind, CONFIG_KINDS);
    return kind;
  }

  private checkBody(kind: ConfigKind, body: Record<string, unknown>): void {
    const problem = validateBody(kind, body);
    if (problem !== null) throw new InvalidBody(kind, problem);
  }

  private async entryOrThrow(
    tenantId: string,
    kind: ConfigKind,
    key: string,
  ): Promise<ConfigEntry> {
    const entry = await this.deps.registry.findEntry(tenantId, kind, key);
    if (!entry) throw new EntryNotFound(kind, key);
    return entry;
  }

  /**
   * Refuse a role publish that would leave the firm with nobody able to
   * administer it.
   *
   * Config writes require `tenant:admin`. Publish the last role holding it
   * without it, and there is no way back through the product — not a locked
   * screen, an unrecoverable state needing a database session. So it is checked
   * against the whole role set the firm would have AFTER this change, not just
   * the role being edited.
   */
  private async refuseIfItStrandsTheFirm(
    tenantId: string,
    entry: ConfigEntry,
    draft: ConfigVersion,
  ): Promise<void> {
    const [published, inUse] = await Promise.all([
      this.deps.registry.listPublished(tenantId, "role"),
      this.deps.holders.rolesInUse(tenantId),
    ]);
    const after = new Map<string, readonly Permission[]>();
    for (const row of published) {
      // The entry being published is represented by its DRAFT below, not by
      // what it says today — that version is about to be archived.
      if (row.entry.id === entry.id || row.published === null) continue;
      after.set(row.entry.key, readRolePermissions(row.published.body));
    }
    after.set(entry.key, readRolePermissions(draft.body));

    // First: does the permission survive at all?
    if (leavesNobodyAdmin(after)) {
      throw new WouldLockOutAdministration(entry.key, ADMIN_PERMISSION);
    }

    // Second, and the reason this guard needed a second half: does anybody HOLD
    // a role that has it? Moving the permission onto a role nobody is assigned
    // passes the first check and strands the firm just as completely. Skipped
    // when the firm has no members — there is nobody to strand, and the very
    // first tenant is in exactly that state while it is being provisioned.
    if (inUse.length === 0) return;
    const adminRoles = [...after.entries()]
      .filter(([, held]) => held.includes(ADMIN_PERMISSION))
      .map(([key]) => key);
    if (!adminRoles.some((role) => inUse.includes(role))) {
      throw new NoOneWouldAdminister(adminRoles);
    }
  }
}
