// The notification inbox and its settings (0323).
//
// Reads and marks ONE person's notifications, and reads and writes who hears
// what. Writing notifications is the fan-out's job, not this service's: nothing
// a person does through these routes creates one.
//
// ── THE RECIPIENT IS ALWAYS THE CALLER ─────────────────────────────────────
//
// Every method takes the user id the handler resolved from the SESSION. There
// is no parameter through which one colleague could name another, and an
// administrator reads no inbox but their own: a bell is a person's, and a firm
// that wants to know who was told what asks the ledger, which records the act
// that caused the notification.
import type { Actor } from "../../domain/ledger/model";
import type { NotifyCategory, NotifyChannel, Rendered } from "../../domain/notify/model";
import {
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_KEYS,
  NOTIFY_CHANNELS,
  channelEnabled,
  isLocked,
  notificationPath,
  renderNotification,
} from "../../domain/notify/model";
import { NotificationLocked, NotificationNotFound, NotificationSettingsEmpty } from "../../domain/notify/errors";
import type { EventSink } from "../ledger/ports";
import type {
  ChannelSetting,
  InboxQuery,
  NotificationInbox,
  NotificationRecord,
  NotificationSettingsStore,
} from "./ports";

export interface NotificationDeps {
  readonly inbox: NotificationInbox;
  readonly settings: NotificationSettingsStore;
  readonly events: EventSink;
}

/** The most the bell counts before it says "99+". */
export const UNREAD_CAP = 100;

/** A notification as it leaves for the screen: words, a link, and its state. */
export interface InboxItem extends Rendered {
  readonly id: string;
  readonly category: NotifyCategory;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly href: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly resolvedAt: string | null;
}

/** One channel of one category, as a settings screen needs it. */
export interface ChannelView {
  /** What reaches this person now. */
  readonly enabled: boolean;
  /** What the firm says, before this person's own choice. */
  readonly firmEnabled: boolean;
  /** Whether this person has chosen something different from the firm. */
  readonly overridden: boolean;
  /** Nobody may switch it off (a mandatory bell). */
  readonly locked: boolean;
}

export interface CategoryView {
  readonly category: NotifyCategory;
  readonly label: string;
  readonly group: string;
  readonly channels: Readonly<Record<NotifyChannel, ChannelView>>;
}

export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  /** One page of the caller's own notifications, rendered for them. */
  async list(
    tenantId: string,
    userId: string,
    seesFees: boolean,
    query: InboxQuery,
  ): Promise<readonly InboxItem[]> {
    const rows = await this.deps.inbox.list(tenantId, userId, query);
    return rows.map((r) => toItem(r, seesFees));
  }

  unreadCount(tenantId: string, userId: string): Promise<number> {
    return this.deps.inbox.unreadCount(tenantId, userId, UNREAD_CAP);
  }

  /** Marking a row already read is not an error; it answers with when it was. */
  async markRead(tenantId: string, userId: string, id: string): Promise<{ readonly readAt: string }> {
    const marked = await this.deps.inbox.markRead(tenantId, userId, id);
    if (marked === null) throw new NotificationNotFound();
    return marked;
  }

  markAllRead(tenantId: string, userId: string, upTo: string | null): Promise<number> {
    return this.deps.inbox.markAllRead(tenantId, userId, upTo);
  }

  /** Every category, with what reaches the caller on each channel and why. */
  async preferences(tenantId: string, userId: string): Promise<readonly CategoryView[]> {
    const [firm, mine] = await Promise.all([
      this.deps.settings.firmDefaults(tenantId),
      this.deps.settings.userPreferences(tenantId, userId),
    ]);
    const firmMap = settingMap(firm);
    const mineMap = settingMap(mine);
    return NOTIFY_CATEGORY_KEYS.map((category) => {
      const channels = {} as Record<NotifyChannel, ChannelView>;
      for (const channel of NOTIFY_CHANNELS) {
        const firmValue = firmMap.get(key(category, channel));
        const own = mineMap.get(key(category, channel));
        const firmEnabled = channelEnabled(category, channel, firmValue, undefined);
        const enabled = channelEnabled(category, channel, firmValue, own);
        channels[channel] = {
          enabled,
          firmEnabled,
          overridden: own !== undefined && own !== firmEnabled,
          locked: isLocked(category, channel),
        };
      }
      const spec = NOTIFY_CATEGORIES[category];
      return { category, label: spec.label, group: spec.group, channels };
    });
  }

  /** The caller's own choices. A locked bell is refused rather than ignored. */
  async setPreferences(
    tenantId: string,
    userId: string,
    rows: readonly ChannelSetting[],
  ): Promise<readonly CategoryView[]> {
    refuseEmptyOrLocked(rows);
    await this.deps.settings.setUserPreferences(tenantId, userId, rows);
    return this.preferences(tenantId, userId);
  }

  /** The firm's defaults per category and channel, as everybody starts. */
  async firmDefaults(tenantId: string): Promise<readonly CategoryView[]> {
    const firmMap = settingMap(await this.deps.settings.firmDefaults(tenantId));
    return NOTIFY_CATEGORY_KEYS.map((category) => {
      const channels = {} as Record<NotifyChannel, ChannelView>;
      for (const channel of NOTIFY_CHANNELS) {
        const firmValue = firmMap.get(key(category, channel));
        const enabled = channelEnabled(category, channel, firmValue, undefined);
        const productDefault = channelEnabled(category, channel, undefined, undefined);
        channels[channel] = {
          enabled,
          firmEnabled: enabled,
          overridden: firmValue !== undefined && firmValue !== productDefault,
          locked: isLocked(category, channel),
        };
      }
      const spec = NOTIFY_CATEGORIES[category];
      return { category, label: spec.label, group: spec.group, channels };
    });
  }

  /**
   * The firm's defaults. A firm deciding who hears what is a decision about its
   * people, so it is recorded (`tenant.notification_defaults_set`, both sides of
   * every value that moved); a person's own preference is not.
   */
  async setFirmDefaults(
    tenantId: string,
    actor: Actor & { readonly id: string },
    rows: readonly ChannelSetting[],
  ): Promise<readonly CategoryView[]> {
    refuseEmptyOrLocked(rows);
    const changed = await this.deps.settings.setFirmDefaults(tenantId, actor.id, rows);
    if (changed.length > 0) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "tenant.notification_defaults_set",
        objectId: tenantId,
        actor,
        payload: { changes: changed.map((c) => ({ category: c.category, channel: c.channel, from: c.from, to: c.to })) },
      });
    }
    return this.firmDefaults(tenantId);
  }
}

function toItem(r: NotificationRecord, seesFees: boolean): InboxItem {
  const words = renderNotification(
    {
      category: r.category,
      payload: r.payload,
      actorName: r.actorName,
      clientName: r.clientName,
      subjectLabel: r.subjectLabel,
    },
    seesFees,
  );
  return {
    id: r.id,
    category: r.category,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    title: words.title,
    detail: words.detail,
    href: notificationPath(r.category, r.sourceType, r.sourceId, r.payload),
    createdAt: r.createdAt,
    readAt: r.readAt,
    resolvedAt: r.resolvedAt,
  };
}

function refuseEmptyOrLocked(rows: readonly ChannelSetting[]): void {
  if (rows.length === 0) throw new NotificationSettingsEmpty();
  for (const r of rows) {
    if (!r.enabled && isLocked(r.category, r.channel)) {
      throw new NotificationLocked(NOTIFY_CATEGORIES[r.category].label);
    }
  }
}

function key(category: NotifyCategory, channel: NotifyChannel): string {
  return `${category}/${channel}`;
}

function settingMap(rows: readonly ChannelSetting[]): Map<string, boolean> {
  return new Map(rows.map((r) => [key(r.category, r.channel), r.enabled]));
}
