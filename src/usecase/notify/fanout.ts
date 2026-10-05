// The writers of notifications (0323): the ledger outbox, the advance
// reminders, and retention. Worker-only; nothing a request does runs these.
//
// ── THE OUTBOX ─────────────────────────────────────────────────────────────
//
// Each firm has a cursor: how far through its ledger the outbox has read. A run
// reads from a window BEHIND the cursor, because two transactions can commit
// in the other order from their `recorded_at` and a cursor alone would step
// over the late one. Whatever is read twice is refused by the dedupe key, and
// a resolve only touches rows caused before the event that resolves them, so a
// re-read is a no-op both ways. The cursor moves only after the writes, so a
// run that dies part way is simply run again: at-least-once, never lost.
//
// ── WHO IS TOLD ────────────────────────────────────────────────────────────
//
// `planFor` (domain) names an audience by relationship; this resolves it to
// people as the firm stands NOW, then keeps only: active staff of this firm,
// not the person who acted, and someone whose bell is on for that category.
import type { NotifyCategory } from "../../domain/notify/model";
import { channelEnabled, eventDedupeKey, stageDedupeKey } from "../../domain/notify/model";
import type { Audience, Plan } from "../../domain/notify/fanout";
import { FANOUT_VERBS, planFor } from "../../domain/notify/fanout";
import { grants } from "../../domain/authz/model";
import type { Permission } from "../../domain/authz/model";
import type { PermissionSource } from "../authz/ports";
import type { AdvanceOnDesk } from "../billing/advance";
import type { AdvancePeople } from "../billing/ports";
import type { Clock } from "../../platform/clock";
import type {
  ChannelSetting,
  CheckerSource,
  NewNotification,
  NotificationOutbox,
  NotificationSettingsStore,
  NotifyDirectory,
  OutboxEvent,
  StaffMember,
} from "./ports";

/** How far behind the cursor each run reads again. */
export const OVERLAP_MS = 10 * 60 * 1000;
/** The most events one firm's run takes; the next run continues from there. */
export const EVENTS_PER_RUN = 2000;
/** Read or resolved notifications older than this are pruned. */
export const RETENTION_DAYS = 90;

export interface FanoutDeps {
  readonly outbox: NotificationOutbox;
  readonly directory: NotifyDirectory;
  readonly checkers: CheckerSource;
  readonly permissions: PermissionSource;
  readonly settings: NotificationSettingsStore;
  readonly clock: Clock;
}

export interface FanoutReport {
  readonly tenantId: string;
  readonly events: number;
  readonly created: number;
  readonly resolved: number;
  readonly failure?: string;
}

/** The firm's roster and settings, read once per run. */
class RunContext {
  private readonly prefs = new Map<string, readonly ChannelSetting[]>();
  private readonly roles = new Map<string, readonly Permission[]>();

  constructor(
    readonly tenantId: string,
    readonly staff: ReadonlyMap<string, StaffMember>,
    private readonly firm: ReadonlyMap<string, boolean>,
    private readonly deps: FanoutDeps,
  ) {}

  /** Whether this person's bell is on for this category. */
  async bellOn(userId: string, category: NotifyCategory): Promise<boolean> {
    let mine = this.prefs.get(userId);
    if (mine === undefined) {
      mine = await this.deps.settings.userPreferences(this.tenantId, userId);
      this.prefs.set(userId, mine);
    }
    const own = mine.find((s) => s.category === category && s.channel === "in_app")?.enabled;
    return channelEnabled(category, "in_app", this.firm.get(category), own);
  }

  /** Everybody on the staff whose role carries a permission. */
  async holding(permission: Permission): Promise<readonly string[]> {
    const out: string[] = [];
    for (const m of this.staff.values()) {
      let held = this.roles.get(m.role);
      if (held === undefined) {
        held = await this.deps.permissions.permissionsFor(this.tenantId, m.role);
        this.roles.set(m.role, held);
      }
      if (grants(held, permission)) out.push(m.userId);
    }
    return out;
  }
}

export class NotificationFanout {
  constructor(private readonly deps: FanoutDeps) {}

  /** One pass over every active firm. One firm's failure never stops the others. */
  async sweep(): Promise<readonly FanoutReport[]> {
    const reports: FanoutReport[] = [];
    for (const tenantId of await this.deps.outbox.activeTenantIds()) {
      try {
        const r = await this.runForTenant(tenantId);
        if (r.events > 0) reports.push(r);
      } catch (err) {
        reports.push({ tenantId, events: 0, created: 0, resolved: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return reports;
  }

  /** One firm: read what is new in its ledger and write what it means. */
  async runForTenant(tenantId: string): Promise<FanoutReport> {
    const cursor = await this.deps.outbox.cursor(tenantId);
    if (cursor === null) {
      await this.deps.outbox.startCursor(tenantId, OVERLAP_MS);
      return { tenantId, events: 0, created: 0, resolved: 0 };
    }
    const overlapFrom = new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString();
    const events = await this.deps.outbox.eventsAfter(tenantId, overlapFrom, cursor, FANOUT_VERBS, EVENTS_PER_RUN);
    if (events.length === 0) return { tenantId, events: 0, created: 0, resolved: 0 };

    const ctx = await this.context(tenantId);
    let created = 0;
    let resolved = 0;
    for (const e of events) {
      const plan = planFor({ id: e.id, verb: e.verb, objectId: e.objectId, actorUserId: e.actorUserId, payload: e.payload });
      const done = await this.apply(ctx, e, plan);
      created += done.created;
      resolved += done.resolved;
    }
    const last = events[events.length - 1];
    if (last !== undefined) await this.deps.outbox.advanceCursor(tenantId, last.recordedAt);
    return { tenantId, events: events.length, created, resolved };
  }

  private async context(tenantId: string): Promise<RunContext> {
    const [staff, firm] = await Promise.all([
      this.deps.directory.activeStaff(tenantId),
      this.deps.settings.firmDefaults(tenantId),
    ]);
    return new RunContext(
      tenantId,
      new Map(staff.map((s) => [s.userId, s])),
      new Map(firm.filter((f) => f.channel === "in_app").map((f) => [f.category, f.enabled])),
      this.deps,
    );
  }

  private async apply(ctx: RunContext, e: OutboxEvent, plan: Plan): Promise<{ created: number; resolved: number }> {
    // Resolve first: an event that hands a task on closes the old holder's
    // notification and opens the new one's, in that order.
    let resolved = 0;
    for (const r of plan.resolve) {
      resolved += await this.deps.outbox.resolve(ctx.tenantId, { ...r, causedBefore: e.recordedAt });
    }
    const rows: NewNotification[] = [];
    for (const a of plan.announce) {
      const people = new Set<string>();
      for (const who of a.to) for (const id of await this.resolveAudience(ctx, who)) people.add(id);
      for (const userId of people) {
        if (!ctx.staff.has(userId)) continue;
        if (userId === e.actorUserId) continue;
        if (a.except?.includes(userId) === true) continue;
        if (!(await ctx.bellOn(userId, a.category))) continue;
        rows.push({
          tenantId: ctx.tenantId,
          recipientUserId: userId,
          category: a.category,
          sourceType: a.sourceType,
          sourceId: a.sourceId,
          payload: a.payload,
          eventId: e.id,
          actorUserId: e.actorUserId,
          dedupeKey: eventDedupeKey(e.id, a.category),
        });
      }
    }
    const created = rows.length === 0 ? 0 : await this.deps.outbox.insert(rows);
    return { created, resolved };
  }

  private async resolveAudience(ctx: RunContext, who: Audience): Promise<readonly string[]> {
    const t = ctx.tenantId;
    const d = this.deps.directory;
    const one = (id: string | null): readonly string[] => (id === null ? [] : [id]);
    switch (who.kind) {
      case "user":
        return [who.userId];
      case "key_manager":
        return one(await d.keyManagerOf(t, who.clientPartyId));
      case "permission":
        return ctx.holding(who.permission as Permission);
      case "grade_at_least":
        return [...ctx.staff.values()].filter((s) => s.gradeRank !== null && s.gradeRank >= who.rank).map((s) => s.userId);
      case "work_item_assignee":
        return one(await d.workItemAssignee(t, who.workItemId));
      case "work_item_checkers":
        return this.managerElseCheckers(
          t,
          who.approvalId,
          "work_item",
          await this.deps.checkers.workItemCheckers(t, who.approvalId),
        );
      case "step_checkers": {
        const approvalId = await d.pendingStepApproval(t, who.jobId, who.stepKey);
        if (approvalId === null) return [];
        return this.managerElseCheckers(t, approvalId, "step", await this.deps.checkers.stepCheckers(t, approvalId));
      }
      case "proposal_preparer":
        return one(await d.proposalPreparer(t, who.proposalId));
      case "letter_sender":
        return one(await d.letterSender(t, who.letterId));
      case "invoice_manager": {
        const inv = await d.invoiceOwner(t, who.invoiceId);
        if (inv === null) return [];
        return one(inv.managerUserId ?? (await d.keyManagerOf(t, inv.clientPartyId)));
      }
      case "due_manager": {
        const due = await d.dueOwner(t, who.dueId);
        if (due === null) return [];
        return one(due.managerUserId ?? (await d.keyManagerOf(t, due.clientPartyId)));
      }
      case "request_owner": {
        const req = await d.requestOwner(t, who.requestId);
        if (req === null) return [];
        if (req.assigneeUserId !== null) return who.onlyUnplaced ? [] : [req.assigneeUserId];
        return one(await d.keyManagerOf(t, req.clientPartyId));
      }
      case "ask_owner": {
        const ask = await d.askOwner(t, who.askId);
        if (ask === null) return [];
        return [...new Set([ask.raisedBy, ask.assigneeUserId].filter((x): x is string => x !== null))];
      }
    }
  }

  /**
   * Who hears that work is waiting to be checked (DESIGN.md §J, Q2): the
   * MANAGER of whoever sent it, when that manager may check it. Everybody else
   * who may still sees it on the Checks list; a firm whose rule lets ten
   * people check must not send ten notifications per check. With no manager,
   * or one who may not check this, every eligible checker hears, so a check
   * is never silent.
   */
  private async managerElseCheckers(
    tenantId: string,
    approvalId: string,
    kind: "work_item" | "step",
    eligible: readonly string[],
  ): Promise<readonly string[]> {
    const manager = await this.deps.directory.checkSendersManager(tenantId, approvalId, kind);
    return manager !== null && eligible.includes(manager) ? [manager] : eligible;
  }

  /** Retention, daily: every firm's read or resolved rows past the window. */
  async prune(): Promise<number> {
    const before = new Date(this.deps.clock.now().getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    let n = 0;
    for (const tenantId of await this.deps.outbox.activeTenantIds()) n += await this.deps.outbox.prune(tenantId, before);
    return n;
  }
}

// ── advance reminders ────────────────────────────────────────────────────────
//
// An advance turning overdue is a day passing, not an act, so no event exists
// for the outbox to read. This sweep asks `AdvanceDesk` — the same reading My
// day shows — where every advance stands, and writes ONE notification per
// stage per person: `draft_overdue` (no invoice, or a draft, past the firm's
// days), `unpaid_overdue` (issued, not paid, past its days), `escalated` (a
// week after signing and still pending). A stage the advance has left, and an
// advance no longer pending, has its open notifications resolved.

export interface AdvanceSource {
  list(tenantId: string): Promise<{ readonly today: string; readonly advances: readonly AdvanceOnDesk[] }>;
}

export interface AdvanceRemindersDeps {
  readonly outbox: NotificationOutbox;
  readonly advances: AdvanceSource;
  readonly directory: NotifyDirectory;
  readonly permissions: PermissionSource;
  readonly settings: NotificationSettingsStore;
}

export interface AdvanceReminderReport {
  readonly tenantId: string;
  readonly created: number;
  readonly resolved: number;
  readonly failure?: string;
}

/** The stages an advance is at today, for the reminders. */
export function advanceStages(a: AdvanceOnDesk): readonly ("draft_overdue" | "unpaid_overdue" | "escalated")[] {
  if (!a.reminder.pending) return [];
  const out: ("draft_overdue" | "unpaid_overdue" | "escalated")[] = [];
  if (a.reminder.overdue) {
    out.push(a.stage === "unpaid" || a.stage === "part_paid" ? "unpaid_overdue" : "draft_overdue");
  }
  if (a.reminder.escalated) out.push("escalated");
  return out;
}

function chasers(people: AdvancePeople): string[] {
  return [
    ...people.spocs.map((p) => p.userId),
    ...(people.keyManager === null ? [] : [people.keyManager.userId]),
    ...(people.partner === null ? [] : [people.partner.userId]),
  ];
}

export class AdvanceReminders {
  constructor(private readonly deps: AdvanceRemindersDeps) {}

  async sweep(): Promise<readonly AdvanceReminderReport[]> {
    const out: AdvanceReminderReport[] = [];
    for (const tenantId of await this.deps.outbox.activeTenantIds()) {
      try {
        const r = await this.runForTenant(tenantId);
        if (r.created > 0 || r.resolved > 0) out.push(r);
      } catch (err) {
        out.push({ tenantId, created: 0, resolved: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  async runForTenant(tenantId: string): Promise<AdvanceReminderReport> {
    const category: NotifyCategory = "advance_reminder";
    const [{ advances }, open] = await Promise.all([
      this.deps.advances.list(tenantId),
      this.deps.outbox.openReminders(tenantId, category),
    ]);

    // What still stands: advance id -> its stages today.
    const standing = new Map<string, readonly string[]>();
    for (const a of advances) {
      const stages = advanceStages(a);
      if (stages.length > 0) standing.set(a.id, stages);
    }
    const stale = open.filter((o) => !(standing.get(o.sourceId) ?? []).includes(o.stage ?? ""));
    const resolved = stale.length === 0 ? 0 : await this.deps.outbox.resolveIds(tenantId, stale.map((o) => o.id));
    if (standing.size === 0) return { tenantId, created: 0, resolved };

    const [staff, firm] = await Promise.all([
      this.deps.directory.activeStaff(tenantId),
      this.deps.settings.firmDefaults(tenantId),
    ]);
    const onStaff = new Map(staff.map((s) => [s.userId, s]));
    const firmBell = firm.find((f) => f.category === category && f.channel === "in_app")?.enabled;
    const admins = await this.holders(tenantId, staff, "tenant:admin");
    const prefCache = new Map<string, boolean>();
    const bellOn = async (userId: string): Promise<boolean> => {
      const cached = prefCache.get(userId);
      if (cached !== undefined) return cached;
      const own = (await this.deps.settings.userPreferences(tenantId, userId)).find(
        (s) => s.category === category && s.channel === "in_app",
      )?.enabled;
      const on = channelEnabled(category, "in_app", firmBell, own);
      prefCache.set(userId, on);
      return on;
    };

    const rows: NewNotification[] = [];
    for (const a of advances) {
      const stages = standing.get(a.id);
      if (stages === undefined) continue;
      for (const stage of stages) {
        // Overdue: whoever chases it on My day, and the administrators while it
        // still waits for an admin to raise or issue it. Escalated: the
        // administrators (Ashish: "escalates to CEO/COO") and the partner.
        const raw =
          stage === "escalated"
            ? [...admins, ...(a.people.partner === null ? [] : [a.people.partner.userId])]
            : [...chasers(a.people), ...(a.stage === "not_raised" || a.stage === "on_draft" ? admins : [])];
        const amount = a.stage === "unpaid" || a.stage === "part_paid" ? (a.balance?.outstanding ?? a.amount) : a.amount;
        for (const userId of new Set(raw)) {
          if (!onStaff.has(userId) || !(await bellOn(userId))) continue;
          rows.push({
            tenantId,
            recipientUserId: userId,
            category,
            sourceType: "billing_due",
            sourceId: a.id,
            payload: {
              stage,
              ...(amount === null ? {} : { amount, currency: a.currency }),
              ...(a.invoice === null || a.invoice.status === "cancelled" ? {} : { invoiceId: a.invoice.id }),
            },
            eventId: null,
            actorUserId: null,
            dedupeKey: stageDedupeKey(category, a.id, stage),
          });
        }
      }
    }
    const created = rows.length === 0 ? 0 : await this.deps.outbox.insert(rows);
    return { tenantId, created, resolved };
  }

  private async holders(tenantId: string, staff: readonly StaffMember[], permission: Permission): Promise<string[]> {
    const roles = new Map<string, readonly Permission[]>();
    const out: string[] = [];
    for (const m of staff) {
      let held = roles.get(m.role);
      if (held === undefined) {
        held = await this.deps.permissions.permissionsFor(tenantId, m.role);
        roles.set(m.role, held);
      }
      if (grants(held, permission)) out.push(m.userId);
    }
    return out;
  }
}
