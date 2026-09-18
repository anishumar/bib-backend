// The escalation ladder (T4.5) — the sweep that tells somebody, and the one
// thing it is not allowed to do.
//
// ── IT NEVER ACTS. THAT IS THE ACCEPTANCE LINE, NOT A STYLE CHOICE ──────────
//
// A monitor that could reassign work would be a monitor that quietly moves a
// filing off the desk of the person who knows the client, at 2am, because a
// number in a config row said three days. Every port this service holds is a
// read except the notice it writes; there is no seam here through which it
// could change a task, a filing or a person's workload. `alerts + spawns tasks
// only, never acts itself` is enforced by what does not exist.
//
// ── WHY IT IS NOT AN AGENT, WRITTEN DOWN RATHER THAN ASSUMED ────────────────
//
// A9 sits under Phase 4 with the agents, and it deliberately does NOT run
// through T2.8's runtime. That seam is `run({ tenantId, jobId, stepKey })` — it
// is step-scoped, and this has no job and no step: its own line on the board is
// *"no human trigger"*. It also produces no proposal, so there is no confidence
// to score and nothing for a person to accept or correct, which is what the
// tier guardrail governs. Forcing it through would mean inventing a fake job
// and a confidence of 1.0 for arithmetic over two dates — a number that would
// then sit in the accuracy record making the real agents look better than they
// are. The shape it genuinely matches is `usecase/dunning`: a clock, a firm's
// published ladder, and an idempotent write.
//
// ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ───────────────────────
//
// pg-boss redelivers, a worker restarts mid-pass, and the same task is still
// overdue tomorrow morning. None of that may tell somebody twice: the rung is
// taken by an insert that conflicts on the notice table's unique index, and the
// event is written only when a row was actually created.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dueEscalationRungs } from "../../domain/config/model";
import type { EscalationBody, EscalationRung } from "../../domain/config/model";
import { daysBetween, landingFor } from "../../domain/escalation/model";
import type { EscalationStaff } from "../../domain/escalation/model";
import type {
  EscalationLadderSource,
  EscalationNoticeRepository,
  EscalationRecord,
  EscalationStaffDirectory,
  EscalationSubjectSource,
  EscalationTenantDirectory,
  EscalationViewer,
  FirmTimeZone,
  IsoDate,
} from "./ports";
import { dayInZone } from "../../domain/scheduler/zone";

export interface Deps {
  readonly ladders: EscalationLadderSource;
  readonly notices: EscalationNoticeRepository;
  readonly subjects: EscalationSubjectSource;
  readonly staff: EscalationStaffDirectory;
  readonly tenants: EscalationTenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface EscalationSweepReport {
  readonly tenantId: string;
  /** Rungs climbed this pass — notices actually written. */
  readonly raised: number;
  /**
   * Rungs the unique index refused: already climbed on that subject.
   *
   * NORMALLY ZERO on an ordinary second run, because `climbed()` filters them
   * out before the insert. What this counts is the genuine race — two workers,
   * or a redelivery overlapping the run it duplicates — which is the case the
   * unique index exists for. A non-zero value is idempotency working, not a
   * fault.
   */
  readonly alreadyRaised: number;
  /**
   * Notices that reached NOBODY, counted separately because they are the ones
   * somebody has to act on. An escalation with no recipient is not a failure of
   * this sweep — it is the firm's org chart or its grades being incomplete, and
   * the note on the row says which.
   */
  readonly unresolved: number;
  /** Why this firm was skipped, when it was. One firm's bad data never stops
   *  the others: T3.1's lesson, where one firm with no work states stopped the
   *  calendar for every firm after it in the list. */
  readonly failure?: string;
}

export class EscalationService {
  constructor(private readonly deps: Deps) {}

  /** One pass over every firm. The outer loop is the tenant list because a
   *  worker has no session; every read below it is tenant-scoped by RLS. */
  async sweep(): Promise<readonly EscalationSweepReport[]> {
    const reports: EscalationSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        reports.push(await this.sweepTenant(tenantId));
      } catch (err: unknown) {
        reports.push({
          tenantId,
          raised: 0,
          alreadyRaised: 0,
          unresolved: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string, asOf?: IsoDate): Promise<EscalationSweepReport> {
    const ladder = await this.deps.ladders.ladderFor(tenantId);
    // A firm with no published ladder escalates nobody, and that is the safe
    // direction rather than a gap. The alternative is this product inventing a
    // number no firm agreed to — and the wrong number here does not merely
    // annoy, it teaches everybody to ignore the one screen that exists to be
    // believed.
    if (ladder === null || ladder.rungs.length === 0) {
      return { tenantId, raised: 0, alreadyRaised: 0, unresolved: 0 };
    }

    const today = asOf ?? (await this.firmDay(tenantId));
    const staff = await this.deps.staff.activeStaff(tenantId);
    const { byWorkItem, byObligation } = groupClimbed(await this.deps.notices.climbed(tenantId));

    let raised = 0;
    let alreadyRaised = 0;
    let unresolved = 0;

    const tally = (outcome: RaiseOutcome): void => {
      if (outcome === "already") alreadyRaised += 1;
      else {
        raised += 1;
        if (outcome === "nobody") unresolved += 1;
      }
    };

    for (const item of await this.deps.subjects.openWorkItems(tenantId)) {
      const climbed = byWorkItem.get(item.workItemId) ?? EMPTY;
      const ctx = { assigneeUserId: item.assigneeUserId, staff: staff as readonly EscalationStaff[] };

      // ── the SLA the client was promised ──────────────────────────────────
      // No due date is not late. An item created from a service with no
      // `slaDays` has no deadline at all (T3.1 refuses to invent one), and
      // escalating against a date this product made up is the one thing that
      // would make the whole queue arguable.
      if (item.dueOn !== null) {
        const past = daysBetween(item.dueOn, today);
        if (past >= 0) {
          for (const rung of dueEscalationRungs(ladder, "work_item_due", past, climbed)) {
            tally(
              await this.raiseFor(
                { tenantId, workItemId: item.workItemId, obligationInstanceId: null },
                rung,
                past,
                today,
                ctx,
              ),
            );
          }
        }
      }

      // ── and the queue nobody is watching ─────────────────────────────────
      // Five of the seven overdue tasks on the day this was written were on
      // NOBODY's desk. An unassigned item has no due date to be late against
      // when its service carried no SLA, so age is the only honest clock — and
      // it is the number that matters anyway: work sitting in a queue is work
      // the firm believes is being done.
      if (item.assigneeUserId === null) {
        const age = daysBetween(item.createdOn, today);
        if (age >= 0) {
          for (const rung of dueEscalationRungs(ladder, "work_item_unassigned", age, climbed)) {
            tally(
              await this.raiseFor(
                { tenantId, workItemId: item.workItemId, obligationInstanceId: null },
                rung,
                age,
                today,
                ctx,
              ),
            );
          }
        }
      }
    }

    for (const obligation of await this.deps.subjects.openObligations(tenantId)) {
      // ── THE WARNING WINDOW, AND WHERE IT ENDS ────────────────────────────
      //
      // This watch fires between the firm's own target and the statutory date.
      // Once the statutory date passes, T3.3 owns the filing: it is in the
      // partner's decision queue, somebody senior is already looking at it, and
      // a second ladder climbing rungs beside that would be two systems
      // shouting about one filing. The boundary is deliberate and it is the
      // reason these two sweeps stayed separate.
      if (daysBetween(today, obligation.statutoryDueOn) < 0) continue;

      const past = daysBetween(obligation.internalTargetOn, today);
      if (past < 0) continue;
      const climbed = byObligation.get(obligation.obligationId) ?? EMPTY;
      const ctx = {
        assigneeUserId: obligation.assigneeUserId,
        staff: staff as readonly EscalationStaff[],
      };
      for (const rung of dueEscalationRungs(ladder, "obligation_target", past, climbed)) {
        tally(
          await this.raiseFor(
            { tenantId, workItemId: null, obligationInstanceId: obligation.obligationId },
            rung,
            past,
            today,
            ctx,
          ),
        );
      }
    }

    return { tenantId, raised, alreadyRaised, unresolved };
  }

  /** The queue a screen reads. `viewer` null is the whole firm's, which is the
   *  default: see `EscalationNoticeRepository.listFor`. */
  queue(tenantId: string, viewer: EscalationViewer | null): Promise<readonly EscalationRecord[]> {
    return this.deps.notices.listFor(tenantId, viewer);
  }

  /**
   * The firm's ladder as published, for the screen that renders the queue.
   *
   * A read the API needs for two things a list alone cannot say: what the firm
   * CALLS each rung, and whether it has published a ladder at all. The second
   * is the one that matters — an empty queue at a firm with no ladder and an
   * empty queue at a firm where everything is on time look identical, and only
   * one of them means the product is doing anything.
   */
  ladderFor(tenantId: string): Promise<EscalationBody | null> {
    return this.deps.ladders.ladderFor(tenantId);
  }

  /**
   * One reader's own rung, resolved from their membership rather than from the
   * wire. A viewer who is not staff at this firm has no grade, which narrows
   * the Mine filter to notices addressed to them by name — the honest answer
   * rather than an empty list or an error.
   */
  async viewerFor(tenantId: string, userId: string): Promise<EscalationViewer> {
    const staff = await this.deps.staff.activeStaff(tenantId);
    const row = staff.find((s) => s.userId === userId);
    return { userId, gradeRank: row?.gradeRank ?? null };
  }

  private async raiseFor(
    subject: { tenantId: string; workItemId: string | null; obligationInstanceId: string | null },
    rung: EscalationRung,
    daysPast: number,
    today: IsoDate,
    ctx: { assigneeUserId: string | null; staff: readonly EscalationStaff[] },
  ): Promise<RaiseOutcome> {
    const landing = landingFor(rung, ctx);
    const row = await this.deps.notices.raise({
      id: this.deps.ids.newId(),
      tenantId: subject.tenantId,
      workItemId: subject.workItemId,
      obligationInstanceId: subject.obligationInstanceId,
      rungKey: rung.key,
      watch: rung.watch,
      // Snapshotted from the ladder in force at the moment it fired, so a later
      // edit cannot make a notice that went out on time look early.
      afterDays: rung.afterDays,
      target: rung.notify,
      raisedToUserId: landing.kind === "person" ? landing.userId : null,
      minGradeRank: landing.kind === "rank" ? landing.minGradeRank : null,
      note: landing.kind === "nobody" ? landing.note : null,
      raisedOn: today,
      daysPast,
    });

    // Null means the rung was already climbed — a redelivery, not a fault. No
    // row, no event: the log must not say somebody was told twice.
    if (row === null) return "already";

    await this.deps.events.recordEvent({
      tenantId: subject.tenantId,
      verb: subject.workItemId !== null ? "work_item.escalated" : "obligation.escalated",
      // The WORK is the object, never the notice row: "what happened to this
      // task" is the timeline anybody reads, and it is the object_type the verb
      // registry declares.
      objectId: subject.workItemId ?? (subject.obligationInstanceId as string),
      actor: SYSTEM_ACTOR,
      payload: {
        rungKey: rung.key,
        watch: rung.watch,
        afterDays: rung.afterDays,
        daysPast,
        target: rung.notify,
        // WHO it reached, in the three shapes it can take. The note is the
        // product's own sentence about its own routing — never prose a person
        // wrote about a colleague — which is what makes it safe in a log that
        // cannot be erased.
        landedOn: landing.kind,
        ...(landing.kind === "person" ? { raisedToUserId: landing.userId } : {}),
        ...(landing.kind === "rank" ? { minGradeRank: landing.minGradeRank } : {}),
        ...(landing.kind === "nobody" ? { note: landing.note } : {}),
      },
    });
    return landing.kind === "nobody" ? "nobody" : "raised";
  }

  /** Today for THIS firm — the calendar day the clock's instant falls on in
   *  the firm's own zone (0071). A deadline is a calendar fact, not an
   *  instant, and a sweep has no caller to say which day it is: the UTC day
   *  is yesterday in India until 05:30, which fired every rung a day late. */
  private async firmDay(tenantId: string): Promise<IsoDate> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

type RaiseOutcome = "raised" | "nobody" | "already";

const EMPTY: ReadonlySet<string> = new Set<string>();

/** The one query's rows, turned into the two lookups the sweep needs. Grouped
 *  here rather than in SQL so the adapter stays one plain read. */
function groupClimbed(rows: readonly { workItemId: string | null; obligationInstanceId: string | null; rungKey: string }[]): {
  byWorkItem: ReadonlyMap<string, ReadonlySet<string>>;
  byObligation: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const byWorkItem = new Map<string, Set<string>>();
  const byObligation = new Map<string, Set<string>>();
  for (const row of rows) {
    const into = row.workItemId !== null ? byWorkItem : byObligation;
    const key = row.workItemId ?? row.obligationInstanceId;
    if (key === null) continue;
    const set = into.get(key) ?? new Set<string>();
    set.add(row.rungKey);
    into.set(key, set);
  }
  return { byWorkItem, byObligation };
}
