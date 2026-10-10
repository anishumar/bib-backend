// Configuration-registry HTTP surface — transport only. Each route declares its
// wire shape (the zod schemas ARE the DTOs and the OpenAPI spec) and its handler
// parses the validated input, calls exactly one use-case method, and maps the
// result.
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route. A firm edits
// its own catalogue and its own roles; there is no shape of request here that
// can name someone else's.
//
// Note what is NOT here: no DELETE, and no "retire this entry". Removing a role
// that memberships still name locks those people out, and removing a service a
// proposal was quoted from breaks a pin — both need a confirmation flow that
// says how many rows are affected, which is a screen and a decision, not an
// endpoint to add quietly. Until then a firm changes what something SAYS by
// publishing a new version, which is the whole point of the registry.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { ConfigEntry, ConfigKind, ConfigVersion } from "../../domain/config/model";
import { bodyWithoutFees, kindCarriesFees } from "../../domain/config/model";
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from "../../domain/authz/model";
import type { ConfigService } from "../../usecase/config/service";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";

export interface ConfigDeps {
  readonly service: ConfigService;
  /**
   * The FEE AXIS only (B09, audit 2026-10-03). A service's list price is nulled
   * for a login that cannot see fees, and that login may not write a service:
   * it reads null, so whatever it sent back would wipe a price it never saw.
   * Gate 3 is middleware.
   */
  readonly authz: AuthzService;
}

/** What the refusal says was refused. */
const WRITE_SERVICE = "change a service in the catalogue";


// The closed kind set lives in the domain (CONFIG_KINDS). `satisfies` makes a
// value that is not a ConfigKind a compile error here; a unit test asserts the
// two lists are the same length, so a kind added to the domain and forgotten
// here fails the build rather than 400ing at runtime.
export const KIND_VALUES = [
  "service",
  "role",
  "policy",
  "clause",
  "dunning",
  "workflow_template",
  "confidence_tier",
  "verification_policy",
  "compliance_policy",
  "escalation",
  "chaser",
  "nudge",
  "request_template",
] as const satisfies readonly ConfigKind[];

// ── Response schemas ────────────────────────────────────────────────────────

const ConfigEntrySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    kind: z.enum(KIND_VALUES),
    key: z.string(),
  })
  .openapi("ConfigEntry");

const ConfigVersionSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    entryId: z.string().uuid(),
    version: z.number().int().positive(),
    status: z.enum(["draft", "published", "archived"]),
    body: z.record(z.unknown()),
    publishedAt: z.string().nullable(),
    archivedAt: z.string().nullable(),
  })
  .openapi("ConfigVersion");

const PublishedEntrySchema = z
  .object({
    entry: ConfigEntrySchema,
    // Null when the entry has only drafts. Present-and-null rather than absent,
    // so "not published yet" and "not returned by this route" stay different
    // answers on the wire.
    published: ConfigVersionSchema.nullable(),
    // The newest draft waiting beside what is in force, or null. Here rather
    // than behind a second request per entry: a screen has to know whether
    // anything is pending, and until this field existed a draft was invisible —
    // and therefore unpublishable — from a list as soon as its entry had a
    // published version.
    pendingDraft: ConfigVersionSchema.nullable(),
  })
  .openapi("PublishedConfigEntry");

const DefinedEntrySchema = z
  .object({ entry: ConfigEntrySchema, draft: ConfigVersionSchema })
  .openapi("DefinedConfigEntry");

// ── Request schemas ──────────────────────────────────────────────────────────

const KindParam = z.object({ kind: z.enum(KIND_VALUES) });
const EntryParam = z.object({ kind: z.enum(KIND_VALUES), key: z.string().min(1) });
const VersionParam = z.object({
  kind: z.enum(KIND_VALUES),
  key: z.string().min(1),
  // Path params arrive as strings; the registry counts in integers.
  version: z.coerce.number().int().positive(),
});

// The body is kind-specific and validated in the domain, per kind, with a
// message naming the field and the valid set. Restating those shapes here would
// be two validators to keep in step, and the DTO one would be the one people
// forget — so the wire check is only "it is an object".
//
// What the spec CAN carry without a second validator is words: the frontend
// generates its client from this spec, so the shapes F1 added (a screen is
// about to build an editor for them) are described here, field by field.
const BodySchema = z.record(z.unknown()).openapi({
  description:
    "The configuration body. Its shape depends on the kind, and the domain refuses an " +
    "unknown field with a sentence naming it. " +
    "`request_template`: `{ label, items: [{ key, label, askKind, documentKind, " +
    "sendOffsetDays, dueOffsetDays }] }`, 1 to 30 items; `askKind` is document, question or " +
    "approval; `documentKind` is a document kind when `askKind` is document and null " +
    "otherwise; both offsets are whole days counted from the period's LAST day, send 0 to " +
    "90 and due 1 to 120 and later than send. " +
    "`workflow_template`: each step may carry `requestTemplateKey`, the key of a " +
    "`request_template` (read live when a job reaches the step), or null or absent for a " +
    "step that asks the client for nothing.",
});

const DefineBody = z
  .object({
    key: z.string().min(1).openapi({
      description: "Stable url-safe handle, e.g. \"gst-filing\". Not the display name.",
    }),
    body: BodySchema,
  })
  .openapi("DefineConfigEntryRequest");

const AddVersionBody = z.object({ body: BodySchema }).openapi("AddConfigVersionRequest");

/**
 * The permission vocabulary, as data.
 *
 * A role body names permissions, so anything that lets somebody EDIT a role has
 * to offer the set to choose from — and the set is a closed product fact in the
 * domain, not a firm's configuration. Without this route the only way to build a
 * permission picker is to retype the list in the frontend, where it would drift
 * from what the code actually checks. On this subject that drift means a screen
 * offering a permission that grants nothing, or hiding one that grants
 * everything.
 *
 * Not a config `kind`: these are not rows a firm owns, and they cannot be.
 */
const PermissionsResponse = z
  .object({
    permissions: z.array(
      z.object({ key: z.string(), description: z.string() }),
    ),
  })
  .openapi("PermissionVocabulary");

// ── Routes ────────────────────────────────────────────────────────────────

const permissionsRoute = createRoute({
  method: "get",
  path: "/api/v1/config/permissions",
  tags: ["config"],
  summary: "The permissions a role can be given, and what each one means",
  responses: {
    200: {
      description: "The product's closed permission set",
      content: { "application/json": { schema: PermissionsResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read config"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/config/{kind}",
  tags: ["config"],
  summary: "List configured things of a kind, with what each currently says",
  request: { params: KindParam },
  responses: {
    200: {
      description: "Entries and their published versions",
      content: {
        "application/json": {
          schema: z.object({ entries: z.array(PublishedEntrySchema) }).openapi("ConfigList"),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read config"),
  },
});

const describeRoute = createRoute({
  method: "get",
  path: "/api/v1/config/{kind}/{key}",
  tags: ["config"],
  summary: "One configured thing and its whole version history",
  request: { params: EntryParam },
  responses: {
    200: {
      description: "The entry and its versions, newest first",
      content: {
        "application/json": {
          schema: z
            .object({ entry: ConfigEntrySchema, versions: z.array(ConfigVersionSchema) })
            .openapi("ConfigEntryHistory"),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read config"),
    404: errorResponse("This firm has no such entry"),
  },
});

const defineRoute = createRoute({
  method: "post",
  path: "/api/v1/config/{kind}",
  tags: ["config"],
  summary: "Define a configured thing, with its first draft",
  request: {
    params: KindParam,
    body: { content: { "application/json": { schema: DefineBody } }, required: true },
  },
  responses: {
    201: {
      description: "Defined. The first version is a DRAFT and is not yet in force.",
      content: { "application/json": { schema: DefinedEntrySchema } },
    },
    400: errorResponse("Invalid key, or a body that does not satisfy its kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("This firm already has an entry with that key"),
  },
});

const addVersionRoute = createRoute({
  method: "post",
  path: "/api/v1/config/{kind}/{key}/versions",
  tags: ["config"],
  summary: "Draft a new version; what is published stays in force",
  request: {
    params: EntryParam,
    body: { content: { "application/json": { schema: AddVersionBody } }, required: true },
  },
  responses: {
    201: {
      description: "Draft created",
      content: { "application/json": { schema: ConfigVersionSchema } },
    },
    400: errorResponse("A body that does not satisfy its kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("This firm has no such entry"),
  },
});

const publishRoute = createRoute({
  method: "post",
  path: "/api/v1/config/{kind}/{key}/versions/{version}/publish",
  tags: ["config"],
  summary: "Put a draft in force, archiving the version it replaces",
  request: { params: VersionParam },
  responses: {
    200: {
      description: "Published and frozen. Anything pinned to the archived version still reads it.",
      content: { "application/json": { schema: ConfigVersionSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such entry or version"),
    409: errorResponse(
      "The version is not a draft, or publishing it would leave the firm with no administrator",
    ),
  },
});

// ── Registration ────────────────────────────────────────────────────────────

/** Field by field (B48): these were forwarded whole. `fees` false nulls a
 *  service's list price (B09). */
function entryToWire(e: ConfigEntry): z.infer<typeof ConfigEntrySchema> {
  return { id: e.id, tenantId: e.tenantId, kind: e.kind, key: e.key };
}

function versionToWire(kind: ConfigKind, v: ConfigVersion, fees: boolean): z.infer<typeof ConfigVersionSchema> {
  return {
    id: v.id,
    tenantId: v.tenantId,
    entryId: v.entryId,
    version: v.version,
    status: v.status,
    body: fees ? { ...v.body } : bodyWithoutFees(kind, v.body),
    publishedAt: v.publishedAt,
    archivedAt: v.archivedAt,
  };
}

export function registerConfigRoutes(app: OpenAPIHono<AppEnv>, deps: ConfigDeps): void {
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);
  /** B09: a service carries its list price, so writing one is a money write. */
  const requireFeesToWrite = (principal: Principal | null, kind: ConfigKind): void => {
    if (principal !== null && kindCarriesFees(kind)) deps.authz.requireFees(principal, WRITE_SERVICE);
  };

  // Registered BEFORE /config/{kind}: "permissions" is not a kind, and a
  // template route would otherwise swallow it and answer 400 for a value that
  // was never meant to be a kind at all.
  app.openapi(permissionsRoute, (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(
      {
        permissions: PERMISSIONS.map((key) => ({
          key,
          description: PERMISSION_DESCRIPTIONS[key],
        })),
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { kind } = c.req.valid("param");
    const entries = await deps.service.list(s.tenantId, kind);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        entries: entries.map((e) => ({
          entry: entryToWire(e.entry),
          published: e.published === null ? null : versionToWire(kind, e.published, fees),
          pendingDraft: e.pendingDraft === null ? null : versionToWire(kind, e.pendingDraft, fees),
        })),
      },
      200,
    );
  });

  app.openapi(describeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { kind, key } = c.req.valid("param");
    const history = await deps.service.describe(s.tenantId, kind, key);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        entry: entryToWire(history.entry),
        versions: history.versions.map((v) => versionToWire(kind, v, fees)),
      },
      200,
    );
  });

  app.openapi(defineRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    const { kind } = c.req.valid("param");
    requireFeesToWrite(principal, kind);
    const { key, body } = c.req.valid("json");
    const defined = await deps.service.define(
      { tenantId: s.tenantId, kind, key, body },
      s.actor,
    );
    return c.json(
      { entry: entryToWire(defined.entry), draft: versionToWire(kind, defined.draft, true) },
      201,
    );
  });

  app.openapi(addVersionRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    const { kind, key } = c.req.valid("param");
    requireFeesToWrite(principal, kind);
    const { body } = c.req.valid("json");
    // No actor: drafting records nothing, because nothing has taken effect.
    // See ConfigService.addVersion.
    const version = await deps.service.addVersion({ tenantId: s.tenantId, kind, key, body });
    return c.json(versionToWire(kind, version, true), 201);
  });

  app.openapi(publishRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    const { kind, key, version } = c.req.valid("param");
    requireFeesToWrite(principal, kind);
    const published = await deps.service.publish(
      { tenantId: s.tenantId, kind, key, version },
      s.actor,
    );
    return c.json(versionToWire(kind, published, true), 200);
  });
}
