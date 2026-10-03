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

// ── the fan-out's ports (the worker's side) ─────────────────────────────────

/** A notification to write. `dedupeKey` makes a second write of it a no-op. */
export interface NewNotification {
  readonly tenantId: string;
  readonly recipientUserId: string;
  readonly category: NotifyCategory;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly eventId: string | null;
  readonly actorUserId: string | null;
  readonly dedupeKey: string;
}

/** One ledger event as the outbox reads it, with when it was recorded. */
export interface OutboxEvent {
  readonly id: string;
  readonly verb: string;
  readonly objectId: string;
  readonly actorUserId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO instant, microseconds kept: the cursor must not round. */
  readonly recordedAt: string;
}

/** What one event closes. Only rows CAUSED BEFORE `causedBefore` are touched. */
export interface ResolveCriteria {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly categories: readonly NotifyCategory[];
  readonly stepKey?: string;
  readonly exceptRecipient?: string | null;
  readonly causedBefore: string;
}

/** An open reminder, for the sweep that decides whether it still stands. */
export interface OpenReminder {
  readonly id: string;
  readonly sourceId: string;
  readonly stage: string | null;
}

export interface NotificationOutbox {
  activeTenantIds(): Promise<readonly string[]>;
  /** How far through the firm's ledger the outbox has read; null before the first run. */
  cursor(tenantId: string): Promise<string | null>;
  /**
   * The first run. The cursor starts `aheadMs` AFTER now, one overlap window
   * ahead, so the window every run reads behind the cursor never reaches an
   * event from before the start: a firm's history is not replayed into bells.
   * Until the clock passes it, every new event sits inside that window, which
   * is read whole on every run.
   */
  startCursor(tenantId: string, aheadMs: number): Promise<void>;
  /**
   * Events of these verbs, oldest first: EVERY one recorded in the overlap
   * window (`overlapFrom`, `cursor`], read again in case one committed late,
   * and the first `limit` after the cursor. The limit is on the new ones only,
   * so a busy window can never pin the cursor in place.
   */
  eventsAfter(
    tenantId: string,
    overlapFrom: string,
    cursor: string,
    verbs: readonly string[],
    limit: number,
  ): Promise<readonly OutboxEvent[]>;
  /** Moves the cursor forward, never back. */
  advanceCursor(tenantId: string, to: string): Promise<void>;
  /** How many were new; a duplicate is refused by its dedupe key, silently. */
  insert(rows: readonly NewNotification[]): Promise<number>;
  resolve(tenantId: string, criteria: ResolveCriteria): Promise<number>;
  openReminders(tenantId: string, category: NotifyCategory): Promise<readonly OpenReminder[]>;
  resolveIds(tenantId: string, ids: readonly string[]): Promise<number>;
  /** Retention: this firm's read or resolved rows older than `before` (at least 30 days). */
  prune(tenantId: string, before: string): Promise<number>;
}

export interface StaffMember {
  readonly userId: string;
  readonly role: string;
  readonly gradeRank: number | null;
}

/**
 * The relationships a notification is addressed by, read as they stand now.
 * Every method answers for ONE firm and returns user ids; who is still on the
 * staff is `activeStaff`'s answer, applied by the service.
 */
export interface NotifyDirectory {
  activeStaff(tenantId: string): Promise<readonly StaffMember[]>;
  /** The client's Key Manager in force today, by the firm's own day. */
  keyManagerOf(tenantId: string, clientPartyId: string): Promise<string | null>;
  workItemAssignee(tenantId: string, workItemId: string): Promise<string | null>;
  proposalPreparer(tenantId: string, proposalId: string): Promise<string | null>;
  /** Whoever sent the letter for signature (its `engagement_letter.sent` actor). */
  letterSender(tenantId: string, letterId: string): Promise<string | null>;
  invoiceOwner(tenantId: string, invoiceId: string): Promise<{ readonly managerUserId: string | null; readonly clientPartyId: string } | null>;
  dueOwner(tenantId: string, dueId: string): Promise<{ readonly managerUserId: string | null; readonly clientPartyId: string } | null>;
  requestOwner(tenantId: string, requestId: string): Promise<{ readonly assigneeUserId: string | null; readonly clientPartyId: string } | null>;
  askOwner(
    tenantId: string,
    askId: string,
  ): Promise<{ readonly raisedBy: string | null; readonly assigneeUserId: string | null } | null>;
  /** The open check on one step of a job, if there is one. */
  pendingStepApproval(tenantId: string, jobId: string, stepKey: string): Promise<string | null>;
}

/** Who may decide a check: T2.9's rule, asked of the module that owns it. */
export interface CheckerSource {
  workItemCheckers(tenantId: string, approvalId: string): Promise<readonly string[]>;
  stepCheckers(tenantId: string, approvalId: string): Promise<readonly string[]>;
}
