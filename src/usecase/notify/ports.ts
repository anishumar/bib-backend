// The ports the notification use cases depend on (0323). Adapters in
// `infrastructure/postgres/notification-repository.ts`.
import type { NotifyCategory, NotifyChannel } from "../../domain/notify/model";

/** One notification as its recipient reads it, names joined, nothing rendered. */
export interface NotificationRecord {
  readonly id: string;
  readonly category: NotifyCategory;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Who did it: the name, else the email. Null for the system or an erased account. */
  readonly actorName: string | null;
  readonly clientName: string | null;
  readonly subjectLabel: string | null;
  /** ISO 8601 instants (`instant.ts`). */
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly resolvedAt: string | null;
}

/** Where a page of the list starts: strictly older than this row. */
export interface InboxCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface InboxQuery {
  /** Unread and not resolved, the same rows the bell counts. */
  readonly unreadOnly: boolean;
  readonly category: NotifyCategory | null;
  readonly before: InboxCursor | null;
  readonly limit: number;
}

/**
 * One colleague's inbox. Every method takes the recipient, and the adapter runs
 * each one inside `withRecipient`, so the database refuses another person's rows
 * even if a query forgot to.
 */
export interface NotificationInbox {
  list(tenantId: string, userId: string, query: InboxQuery): Promise<readonly NotificationRecord[]>;
  /** Unread and unresolved, counted up to `cap`: the bell shows "99+" past it. */
  unreadCount(tenantId: string, userId: string, cap: number): Promise<number>;
  /** Null when the row is not this person's, or not there. */
  markRead(tenantId: string, userId: string, id: string): Promise<{ readonly readAt: string } | null>;
  /**
   * Everything unread created at or before `upTo` (all of it when null), so a
   * notification that arrived after the reader looked is not marked unseen.
   */
  markAllRead(tenantId: string, userId: string, upTo: string | null): Promise<number>;
}

/** One override: a firm's or a person's, for one category on one channel. */
export interface ChannelSetting {
  readonly category: NotifyCategory;
  readonly channel: NotifyChannel;
  readonly enabled: boolean;
}

/** A firm default that changed, both sides, for the ledger. */
export interface ChannelChange {
  readonly category: NotifyCategory;
  readonly channel: NotifyChannel;
  /** Null when the firm had never set it (the product default stood). */
  readonly from: boolean | null;
  readonly to: boolean;
}

export interface NotificationSettingsStore {
  firmDefaults(tenantId: string): Promise<readonly ChannelSetting[]>;
  userPreferences(tenantId: string, userId: string): Promise<readonly ChannelSetting[]>;
  /** Upserts each row and returns the ones whose value actually moved. */
  setFirmDefaults(
    tenantId: string,
    byUserId: string,
    rows: readonly ChannelSetting[],
  ): Promise<readonly ChannelChange[]>;
  setUserPreferences(tenantId: string, userId: string, rows: readonly ChannelSetting[]): Promise<void>;
}
