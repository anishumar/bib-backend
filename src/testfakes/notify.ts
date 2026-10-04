// In-memory notification ports (0323). The SQL — the restrictive policy, the
// joined names, the millisecond paging — is the adapter's, and
// `tests/notify/inbox.integration.test.ts` proves it against a real database.
// These hold what the service's rules need: whose row it is, read or not,
// resolved or not.
import type { NotifyCategory } from "../domain/notify/model";
import { channelEnabled } from "../domain/notify/model";
import type {
  ChannelChange,
  ChannelSetting,
  InboxQuery,
  NotificationInbox,
  NotificationRecord,
  NotificationSettingsStore,
} from "../usecase/notify/ports";

export interface FakeNotificationRow extends NotificationRecord {
  readonly tenantId: string;
  readonly recipientUserId: string;
}

export class FakeNotificationInbox implements NotificationInbox {
  rows: FakeNotificationRow[] = [];
  private tick = 0;

  /** A row for a test, newest last; the clock is a counter so order is exact. */
  add(input: {
    tenantId: string;
    recipientUserId: string;
    category: NotifyCategory;
    sourceType?: string;
    sourceId?: string;
    payload?: Record<string, unknown>;
    actorName?: string | null;
    clientName?: string | null;
    subjectLabel?: string | null;
    readAt?: string | null;
    resolvedAt?: string | null;
  }): FakeNotificationRow {
    this.tick += 1;
    const row: FakeNotificationRow = {
      id: `00000000-0000-4000-8000-${String(this.tick).padStart(12, "0")}`,
      tenantId: input.tenantId,
      recipientUserId: input.recipientUserId,
      category: input.category,
      sourceType: input.sourceType ?? "work_item",
      sourceId: input.sourceId ?? "11111111-1111-4111-8111-111111111111",
      payload: input.payload ?? {},
      actorName: input.actorName ?? null,
      clientName: input.clientName ?? null,
      subjectLabel: input.subjectLabel ?? null,
      createdAt: new Date(Date.UTC(2026, 9, 3, 9, 0, this.tick)).toISOString(),
      readAt: input.readAt ?? null,
      resolvedAt: input.resolvedAt ?? null,
    };
    this.rows.push(row);
    return row;
  }

  private mine(tenantId: string, userId: string): FakeNotificationRow[] {
    return this.rows.filter((r) => r.tenantId === tenantId && r.recipientUserId === userId);
  }

  list(tenantId: string, userId: string, q: InboxQuery): Promise<readonly NotificationRecord[]> {
    const rows = this.mine(tenantId, userId)
      .filter((r) => !q.unreadOnly || (r.readAt === null && r.resolvedAt === null))
      .filter((r) => q.category === null || r.category === q.category)
      .filter(
        (r) =>
          q.before === null ||
          r.createdAt < q.before.createdAt ||
          (r.createdAt === q.before.createdAt && r.id < q.before.id),
      )
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
      .slice(0, q.limit);
    return Promise.resolve(rows);
  }

  unreadCount(tenantId: string, userId: string, cap: number): Promise<number> {
    const n = this.mine(tenantId, userId).filter((r) => r.readAt === null && r.resolvedAt === null).length;
    return Promise.resolve(Math.min(n, cap));
  }

  markRead(tenantId: string, userId: string, id: string): Promise<{ readonly readAt: string } | null> {
    const i = this.rows.findIndex((r) => r.id === id && r.tenantId === tenantId && r.recipientUserId === userId);
    const row = this.rows[i];
    if (row === undefined) return Promise.resolve(null);
    const readAt = row.readAt ?? "2026-10-03T10:00:00.000Z";
    this.rows[i] = { ...row, readAt };
    return Promise.resolve({ readAt });
  }

  markAllRead(tenantId: string, userId: string, upTo: string | null): Promise<number> {
    let n = 0;
    this.rows = this.rows.map((r) => {
      if (r.tenantId !== tenantId || r.recipientUserId !== userId || r.readAt !== null) return r;
      if (upTo !== null && r.createdAt > upTo) return r;
      n += 1;
      return { ...r, readAt: "2026-10-03T10:00:00.000Z" };
    });
    return Promise.resolve(n);
  }
}

export class FakeNotificationSettings implements NotificationSettingsStore {
  readonly firm = new Map<string, Map<string, boolean>>();
  readonly people = new Map<string, Map<string, boolean>>();

  private static k(category: string, channel: string): string {
    return `${category}/${channel}`;
  }

  private static read(map: Map<string, boolean> | undefined): readonly ChannelSetting[] {
    if (map === undefined) return [];
    return [...map.entries()].map(([k, enabled]) => {
      const [category, channel] = k.split("/") as [ChannelSetting["category"], ChannelSetting["channel"]];
      return { category, channel, enabled };
    });
  }

  firmDefaults(tenantId: string): Promise<readonly ChannelSetting[]> {
    return Promise.resolve(FakeNotificationSettings.read(this.firm.get(tenantId)));
  }

  userPreferences(tenantId: string, userId: string): Promise<readonly ChannelSetting[]> {
    return Promise.resolve(FakeNotificationSettings.read(this.people.get(`${tenantId}/${userId}`)));
  }

  setFirmDefaults(tenantId: string, _byUserId: string, rows: readonly ChannelSetting[]): Promise<readonly ChannelChange[]> {
    const map = this.firm.get(tenantId) ?? new Map<string, boolean>();
    const changes: ChannelChange[] = [];
    for (const r of rows) {
      const k = FakeNotificationSettings.k(r.category, r.channel);
      const from = map.get(k) ?? null;
      map.set(k, r.enabled);
      if ((from ?? channelEnabled(r.category, r.channel, undefined, undefined)) !== r.enabled) changes.push({ category: r.category, channel: r.channel, from, to: r.enabled });
    }
    this.firm.set(tenantId, map);
    return Promise.resolve(changes);
  }

  setUserPreferences(tenantId: string, userId: string, rows: readonly ChannelSetting[]): Promise<void> {
    const key = `${tenantId}/${userId}`;
    const map = this.people.get(key) ?? new Map<string, boolean>();
    for (const r of rows) map.set(FakeNotificationSettings.k(r.category, r.channel), r.enabled);
    this.people.set(key, map);
    return Promise.resolve();
  }
}

/** The firm's daily-email hour (0324), in memory. */
export class FakeNotifyFirmSetting {
  readonly hours = new Map<string, number>();

  digestHour(tenantId: string): Promise<number> {
    return Promise.resolve(this.hours.get(tenantId) ?? 9);
  }

  setDigestHour(tenantId: string, _byUserId: string, hour: number): Promise<{ readonly from: number; readonly to: number }> {
    const from = this.hours.get(tenantId) ?? 9;
    this.hours.set(tenantId, hour);
    return Promise.resolve({ from, to: hour });
  }
}
