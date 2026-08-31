// What the escalation ladder needs from the world (T4.5).
//
// Every port here is a READ except one — the notice the sweep writes. That
// asymmetry is the acceptance line made structural: *"alerts + spawns tasks
// only, never acts itself"*. There is deliberately no port through which this
// module could reassign a task, move a filing's state, or send a client
// anything. A capability that does not exist cannot be reached by a later
// change that seemed reasonable at the time.
import type { EscalationBody } from "../../domain/config/model";

/** An ISO calendar day, `YYYY-MM-DD`. Named for the same reason the compliance
 *  module names it: half the bugs in this area are an instant used as a day. */
export type IsoDate = string;

/**
 * The firm's published ladder, live rather than pinned.
 *
 * LIVE, and the difference from a job's pinned template is worth stating: a
 * firm that shortens its ladder this afternoon expects tonight's sweep to use
 * the new one. Nothing here is retrospective — a notice already raised keeps the
 * `after_days` it fired with, snapshotted on the row, so changing the ladder
 * cannot rewrite what already happened.
 *
 * Null when the firm has published none, which is the ORDINARY state and not a
 * failure: nothing is seeded, and a firm with no ladder escalates nobody.
 */
export interface EscalationLadderSource {
  ladderFor(tenantId: string): Promise<EscalationBody | null>;
}

/** A task the ladder may have something to say about: open, at this firm. */
export interface EscalatableWorkItem {
  readonly workItemId: string;
  readonly assigneeUserId: string | null;
  /** `work_item.due_on` — null when the service carried no SLA, in which case
   *  the item has no deadline to be late against and the `work_item_due` watch
   *  skips it rather than inventing one. */
  readonly dueOn: IsoDate | null;
  /** The day the item was created, as a calendar day. What the
   *  `work_item_unassigned` watch counts from — an item nobody has picked up
   *  has no other clock. */
  readonly createdOn: IsoDate;
}

/** A filing past — or approaching — the firm's own internal target. */
export interface EscalatableObligation {
  readonly obligationId: string;
  readonly internalTargetOn: IsoDate;
  readonly statutoryDueOn: IsoDate;
  /** The task raised for it at T-X, and whoever holds that task. Null before
   *  `raise` has run, which is itself worth escalating: a filing past its
   *  internal target with no task is work nobody has been asked to do. */
  readonly workItemId: string | null;
  readonly assigneeUserId: string | null;
}

/**
 * The two feeds the sweep walks.
 *
 * OPEN WORK ONLY, filtered in SQL by the state's own `is_terminal` flag and by
 * `filed_on IS NULL` — never by a state CODE. A firm renames its vocabulary and
 * every rule that compared a code stops working silently, which T3.3 proved
 * end to end by renaming "Missed" and watching the sweep keep working.
 */
export interface EscalationSubjectSource {
  openWorkItems(tenantId: string): Promise<readonly EscalatableWorkItem[]>;
  openObligations(tenantId: string): Promise<readonly EscalatableObligation[]>;
}

/** Everybody who might be told. The same read `usecase/workitem` calls
 *  `ReviewerDirectory` — one notion of who works here, so eligibility to be
 *  escalated to cannot disagree with eligibility to check work. */
export interface EscalationStaffRow {
  readonly userId: string;
  readonly gradeRank: number | null;
  readonly reportsToUserId: string | null;
}

export interface EscalationStaffDirectory {
  activeStaff(tenantId: string): Promise<readonly EscalationStaffRow[]>;
}

/** A rung already climbed on a subject. Read for the whole firm in ONE query
 *  and grouped in the service: the per-row lookup is the shape this codebase
 *  has been caught by five times, and here it would be one round trip per
 *  overdue task per night. */
export interface ClimbedRung {
  readonly workItemId: string | null;
  readonly obligationInstanceId: string | null;
  readonly rungKey: string;
}

export interface NewEscalationNotice {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string | null;
  readonly obligationInstanceId: string | null;
  readonly rungKey: string;
  readonly watch: string;
  readonly afterDays: number;
  readonly target: string;
  readonly raisedToUserId: string | null;
  readonly minGradeRank: number | null;
  readonly note: string | null;
  readonly raisedOn: IsoDate;
  readonly daysPast: number;
}

export interface EscalationNoticeRow {
  readonly id: string;
  readonly workItemId: string | null;
  readonly obligationInstanceId: string | null;
  readonly rungKey: string;
  readonly watch: string;
  readonly afterDays: number;
  readonly target: string;
  readonly raisedToUserId: string | null;
  readonly minGradeRank: number | null;
  readonly note: string | null;
  readonly raisedOn: IsoDate;
  readonly daysPast: number;
}

/**
 * The queue as a screen reads it — names joined, never uuids.
 *
 * `subjectTitle` is the task's own title or the filing's rule name, and it is
 * the one field here that can be prose about a client. That is fine on a ROW
 * and is exactly why it is absent from the ledger event: the row is erasable
 * and the log is not.
 */
/**
 * A person on the queue, resolved at READ time.
 *
 * The shape `EventRecord.actor` already has, and it is here for the reason the
 * audit trail learnt it: **the email is the discriminator, not the id.** A
 * display name is optional on `user_account` and is genuinely empty at real
 * firms — found by running this sweep, where every notice named a person and
 * the queue rendered a blank space next to "told". A row saying somebody was
 * told without saying who is worse than one saying nobody was.
 */
export interface EscalationPerson {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

export interface EscalationRecord extends EscalationNoticeRow {
  readonly subjectTitle: string;
  /** Who is BILLED for the work. Null on a filing: an obligation is owed by the
   *  ENTITY and `delivery.obligation_instance` holds no client at all. */
  readonly clientName: string | null;
  /**
   * WHICH of the client's companies, when that is not the client itself.
   *
   * G0.1: a group of four companies files four sets of returns, so a row naming
   * only "Lakeview Foods Group" is four identical rows. The board already shows
   * this beneath the client for exactly that reason, and the escalation queue
   * looked WRONG without it — a row titled "TDS deposit — Lakeview Logistics"
   * against a client cell reading "Lakeview Foods" reads as a mismatch until
   * you know one is who pays and the other is who files.
   */
  readonly entityName: string | null;
  /**
   * Who was told, or null.
   *
   * Null has TWO meanings and `note` is what tells them apart: a notice that
   * reached nobody always carries one (the schema's CHECK guarantees it), and a
   * notice whose account no longer resolves carries none. The ledger's `actor`
   * makes the same distinction the same way.
   */
  readonly raisedTo: EscalationPerson | null;
  /** Who holds the underlying work TODAY, which may not be who the notice was
   *  raised to — somebody may have picked it up since. The difference is the
   *  useful part of the row: it is how a reader sees the escalation worked. */
  readonly holder: EscalationPerson | null;
  readonly dueOn: IsoDate | null;
  readonly stateName: string | null;
}

/**
 * Who is looking, for the queue's **Mine** filter only.
 *
 * THE UNFILTERED QUEUE IS THE DEFAULT, and that is T3.3's decision applied
 * again for its own reason: a list showing only what you personally may act on
 * would hide that six tasks have been escalated for a week because nobody
 * senior enough looked — which is the failure the ladder exists to surface.
 * "Mine" is a convenience on top, never the whole view.
 *
 * Resolved by the use case from the caller's own membership, never from the
 * wire, where a reader could name a rank they do not hold.
 */
export interface EscalationViewer {
  readonly userId: string;
  readonly gradeRank: number | null;
}

export interface EscalationNoticeRepository {
  /** Every rung already climbed at this firm. One query; the service groups. */
  climbed(tenantId: string): Promise<readonly ClimbedRung[]>;

  /**
   * Write one notice, or null when the unique index refused it.
   *
   * NULL IS NOT AN ERROR — it is a rung already climbed, which happens on every
   * redelivered sweep. The caller reads it as "already done" and writes no
   * event, exactly as the dunning ladder does: the log must not say somebody
   * was told twice.
   */
  raise(notice: NewEscalationNotice): Promise<EscalationNoticeRow | null>;

  /**
   * The queue: notices whose underlying work is still OPEN, newest first.
   *
   * Open is a join and not a column — an escalation about a task is live
   * exactly while that task is not in a terminal state, and one about an
   * unassigned task is live exactly while nobody holds it. Migration 0058 says
   * why there is no `cleared_at` to read instead.
   *
   * `viewer` null is the whole firm's queue, which is the default view. When
   * given, the list narrows to what that person was addressed by — their own
   * name, or a rank they actually hold.
   */
  listFor(
    tenantId: string,
    viewer: EscalationViewer | null,
  ): Promise<readonly EscalationRecord[]>;
}

/** The global tenant list. The one read in the worker that is not inside a
 *  tenant context, because `tenancy.tenant` is global; every read below it is
 *  scoped to one of the ids it returns. */
export interface EscalationTenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}
