// Notifications over HTTP (0323): the bell, the list, and who hears what.
// Transport only. Parses the validated input, calls one use-case method, and
// maps the result field by field: zod-openapi documents a response without
// validating it, so a field not in the schema is one the frontend cannot see.
//
// ── EVERY ROUTE IS THE CALLER'S OWN ────────────────────────────────────────
//
// No route takes a user id. The inbox is the session's, resolved by
// `scopeOf`, and the database's restrictive policy enforces the same thing a
// second time. A portal session never gets here: these paths are not in
// `PORTAL_PATHS`, so gate 2 refuses it before any of this runs.
//
// ── THE COUNT IS BUILT TO BE POLLED ────────────────────────────────────────
//
// `GET /notifications/unread-count` is what the bell asks every minute while a
// tab is visible. It is one partial-index count capped at 100, and it answers
// nothing else: a 40-person office behind one address spends 40 of its 300
// requests a minute on it.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import { toEnvelope } from "../httpresp";
import type { AuthzService } from "../../usecase/authz/service";
import type { CategoryView, InboxItem, NotificationService } from "../../usecase/notify/service";
import { NOTIFY_CATEGORY_KEYS, NOTIFY_CHANNELS } from "../../domain/notify/model";
import type { NotifyCategory, NotifyChannel } from "../../domain/notify/model";

export interface NotificationDeps {
  readonly service: NotificationService;
  /** For the FEE AXIS only; gate 3 is middleware. */
  readonly authz: AuthzService;
}

const Category = z.enum(NOTIFY_CATEGORY_KEYS as [NotifyCategory, ...NotifyCategory[]]).openapi("NotificationCategory");
const Channel = z.enum(NOTIFY_CHANNELS as unknown as [NotifyChannel, ...NotifyChannel[]]).openapi("NotificationChannel");

const ItemSchema = z
  .object({
    id: z.string().uuid(),
    category: Category,
    title: z.string().openapi({ description: "One line: what happened." }),
    detail: z.string().nullable().openapi({
      description:
        "One line under it: what it is about. An amount appears here only for a reader who may see fees.",
    }),
    href: z.string().openapi({ description: "Where it opens on the web app, as a path." }),
    sourceType: z.string(),
    sourceId: z.string().uuid(),
    createdAt: z.string().openapi({ description: "ISO 8601 instant." }),
    readAt: z.string().nullable(),
    resolvedAt: z.string().nullable().openapi({
      description:
        "Set when the work it was about is over (the task finished, the advance was paid). A resolved " +
        "notification is kept and no longer counted as unread.",
    }),
  })
  .openapi("Notification");

const ListQuery = z.object({
  status: z.enum(["all", "unread"]).optional().openapi({
    description: "'unread' is unread and not resolved, the same rows the bell counts. Default 'all'.",
  }),
  category: Category.optional(),
  before: z.string().optional().openapi({
    description: "The `nextBefore` of the previous page. Absent for the newest page.",
  }),
  limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: "Default 30." }),
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/notifications",
  tags: ["notifications"],
  summary: "Your notifications, newest first",
  request: { query: ListQuery },
  responses: {
    200: {
      description: "One page",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(ItemSchema),
            nextBefore: z.string().nullable().openapi({
              description: "Pass as `before` for the next page; null when this was the last.",
            }),
          }),
        },
      },
    },
    400: errorResponse("A cursor that is not one this route issued"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const countRoute = createRoute({
  method: "get",
  path: "/api/v1/notifications/unread-count",
  tags: ["notifications"],
  summary: "How many of your notifications are unread",
  description: "Unread and not resolved, counted up to 100. The bell shows 99+ past 99.",
  responses: {
    200: {
      description: "The count",
      content: { "application/json": { schema: z.object({ count: z.number().int() }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const markRoute = createRoute({
  method: "post",
  path: "/api/v1/notifications/{notificationId}/read",
  tags: ["notifications"],
  summary: "Mark one of your notifications read",
  description: "Marking one already read is not an error; it answers with when it was read.",
  request: { params: z.object({ notificationId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Read",
      content: { "application/json": { schema: z.object({ readAt: z.string() }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Not one of your notifications"),
  },
});

const markAllRoute = createRoute({
  method: "post",
  path: "/api/v1/notifications/read-all",
  tags: ["notifications"],
  summary: "Mark all your notifications read",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            upTo: z.string().datetime().optional().openapi({
              description:
                "The `createdAt` of the newest notification the reader saw. Anything newer stays unread, " +
                "so one that arrived while the list was open is not marked unseen.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Marked",
      content: { "application/json": { schema: z.object({ marked: z.number().int() }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const ChannelViewSchema = z
  .object({
    enabled: z.boolean().openapi({ description: "What reaches this reader now." }),
    firmEnabled: z.boolean().openapi({ description: "The firm's setting, before the reader's own choice." }),
    overridden: z.boolean().openapi({
      description: "On the reader's settings: they chose differently from the firm. On the firm's: the firm changed the product default.",
    }),
    locked: z.boolean().openapi({ description: "Nobody may switch it off: the bell for a mandatory category." }),
  })
  .openapi("NotificationChannelSetting");

const CategoryViewSchema = z
  .object({
    category: Category,
    label: z.string(),
    group: z.enum(["work", "clients", "billing", "deadlines"]),
    channels: z.object({ in_app: ChannelViewSchema, email: ChannelViewSchema, push: ChannelViewSchema }),
  })
  .openapi("NotificationCategorySettings");

const SettingsBody = z
  .object({
    settings: z
      .array(z.object({ category: Category, channel: Channel, enabled: z.boolean() }))
      .min(1)
      .max(NOTIFY_CATEGORY_KEYS.length * NOTIFY_CHANNELS.length),
  })
  .openapi("NotificationSettingsChange");

const SettingsResponse = {
  description: "Every category and channel, after the change",
  content: { "application/json": { schema: z.object({ categories: z.array(CategoryViewSchema) }) } },
};

const myPrefsRoute = createRoute({
  method: "get",
  path: "/api/v1/notifications/preferences",
  tags: ["notifications"],
  summary: "What reaches you, per category and channel",
  responses: {
    200: SettingsResponse,
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const setMyPrefsRoute = createRoute({
  method: "put",
  path: "/api/v1/notifications/preferences",
  tags: ["notifications"],
  summary: "Change what reaches you",
  description: "Only the rows sent change. The bell for a mandatory category cannot be switched off (409).",
  request: { body: { required: true, content: { "application/json": { schema: SettingsBody } } } },
  responses: {
    200: SettingsResponse,
    400: errorResponse("Nothing to change, or a category or channel that does not exist"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    409: errorResponse("A mandatory bell cannot be switched off"),
  },
});

const firmDefaultsRoute = createRoute({
  method: "get",
  path: "/api/v1/notifications/firm-defaults",
  tags: ["notifications"],
  summary: "What reaches everybody at the firm unless they choose otherwise",
  responses: {
    200: SettingsResponse,
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const setFirmDefaultsRoute = createRoute({
  method: "put",
  path: "/api/v1/notifications/firm-defaults",
  tags: ["notifications"],
  summary: "Change the firm's defaults",
  description:
    "Only the rows sent change, for everybody who has not chosen otherwise. Recorded in the audit trail " +
    "(`tenant.notification_defaults_set`). The bell for a mandatory category cannot be switched off (409).",
  request: { body: { required: true, content: { "application/json": { schema: SettingsBody } } } },
  responses: {
    200: SettingsResponse,
    400: errorResponse("Nothing to change, or a category or channel that does not exist"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or may not administer the firm"),
    409: errorResponse("A mandatory bell cannot be switched off"),
  },
});

/** The page cursor: the last row's instant and id, opaque to the client. */
function encodeCursor(item: InboxItem): string {
  return Buffer.from(`${item.createdAt}|${item.id}`, "utf8").toString("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  const [createdAt, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (createdAt === undefined || id === undefined || !ISO.test(createdAt) || !UUID.test(id)) return null;
  return { createdAt, id };
}

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>, deps: NotificationDeps): void {
  app.openapi(listRoute, async (c) => {
    const principal = c.get("principal");
    const s = scopeOf(principal);
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const before = q.before === undefined ? null : decodeCursor(q.before);
    if (q.before !== undefined && before === null) {
      return c.json(
        toEnvelope({ status: 400, code: "VALIDATION", message: "That page link is not valid. Open the list again." }),
        400,
      );
    }
    const limit = q.limit ?? 30;
    const rows = await deps.service.list(s.tenantId, s.userId, principal !== null && deps.authz.seesFees(principal), {
      unreadOnly: q.status === "unread",
      category: q.category ?? null,
      before,
      limit,
    });
    const last = rows.at(-1);
    return c.json(
      {
        rows: rows.map(toWire),
        nextBefore: rows.length === limit && last !== undefined ? encodeCursor(last) : null,
      },
      200,
    );
  });

  app.openapi(countRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json({ count: await deps.service.unreadCount(s.tenantId, s.userId) }, 200);
  });

  app.openapi(markRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { notificationId } = c.req.valid("param");
    const marked = await deps.service.markRead(s.tenantId, s.userId, notificationId);
    return c.json({ readAt: marked.readAt }, 200);
  });

  app.openapi(markAllRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    // The body is optional, and an absent one means "everything".
    const body = (c.req.valid("json") as { upTo?: string } | undefined) ?? {};
    const marked = await deps.service.markAllRead(s.tenantId, s.userId, body.upTo ?? null);
    return c.json({ marked }, 200);
  });

  app.openapi(myPrefsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const categories = await deps.service.preferences(s.tenantId, s.userId);
    return c.json({ categories: categories.map(viewToWire) }, 200);
  });

  app.openapi(setMyPrefsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { settings } = c.req.valid("json");
    const categories = await deps.service.setPreferences(s.tenantId, s.userId, settings);
    return c.json({ categories: categories.map(viewToWire) }, 200);
  });

  app.openapi(firmDefaultsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const categories = await deps.service.firmDefaults(s.tenantId);
    return c.json({ categories: categories.map(viewToWire) }, 200);
  });

  app.openapi(setFirmDefaultsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { settings } = c.req.valid("json");
    const categories = await deps.service.setFirmDefaults(
      s.tenantId,
      { type: "human", id: s.userId },
      settings,
    );
    return c.json({ categories: categories.map(viewToWire) }, 200);
  });
}

function toWire(i: InboxItem): z.infer<typeof ItemSchema> {
  return {
    id: i.id,
    category: i.category,
    title: i.title,
    detail: i.detail,
    href: i.href,
    sourceType: i.sourceType,
    sourceId: i.sourceId,
    createdAt: i.createdAt,
    readAt: i.readAt,
    resolvedAt: i.resolvedAt,
  };
}

function viewToWire(v: CategoryView): z.infer<typeof CategoryViewSchema> {
  const ch = (k: NotifyChannel): z.infer<typeof ChannelViewSchema> => ({
    enabled: v.channels[k].enabled,
    firmEnabled: v.channels[k].firmEnabled,
    overridden: v.channels[k].overridden,
    locked: v.channels[k].locked,
  });
  return {
    category: v.category,
    label: v.label,
    group: v.group as "work" | "clients" | "billing" | "deadlines",
    channels: { in_app: ch("in_app"), email: ch("email"), push: ch("push") },
  };
}
