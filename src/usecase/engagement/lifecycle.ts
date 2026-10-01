// An engagement's life after signature (V2.3): end, pause, resume.
//
// Until 0314 an engagement could only ever be `active` (or waiting on its
// advance), so a client who left kept getting a job and a task every month,
// its filings kept coming, and it stayed in MRR. Three decisions from the user
// (2026-09-28) shape what follows, and none is to be re-made here:
//
//   1. ENDING changes the status AT ONCE (`completed`, or `cancelled` when the
//      end falls before the work began), so MRR drops the day it is recorded.
//      The work up to the last day still happens: the recurring spawn and the
//      compliance generator both read an ended engagement for periods that
//      start on or before `endsOn`.
//   2. Its filings for periods up to the end STAY (the firm served September,
//      so it files September); only untouched upcoming ones for later periods
//      are withdrawn, through T6.16's withdrawal.
//   3. PAUSING stops new jobs and new filings; what is on the calendar stays.
//      Resuming records the day: a period that ended inside the pause gets no
//      job, and the generator brings back any filing that fell due meanwhile.
//
// A separate service from `EngagementService` because it is a separate act on
// a separate row: the letter is frozen once signed and none of this touches
// it. The reason for an end is prose about a client, so it lives on the row
// and never in the ledger.
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import {
  END_REASON_MAX,
  endStatusFor,
  engagementState,
  isCalendarDay,
  isLive,
} from "../../domain/engagement/model";
import type { Engagement } from "../../domain/engagement/model";
import {
  EndReasonRequired,
  EngagementEnded,
  EngagementNotActive,
  EngagementNotFound,
  EngagementNotPaused,
  InvalidEndDate,
} from "../../domain/engagement/errors";
import type { EndOutcome, EngagementLifecycle, EngagementRecord, FirmTimeZone } from "./ports";

export interface LifecycleDeps {
  readonly lifecycle: EngagementLifecycle;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
  readonly events: EventSink;
}

export class EngagementLifecycleService {
  constructor(private readonly deps: LifecycleDeps) {}

  /**
   * End an engagement on `endsOn`, its LAST day of service. Allowed while it is
   * live (waiting on its advance, active or paused). A past day records an end
   * that already happened; a future one records notice given, and the work up
   * to that day goes on.
   */
  async end(
    input: {
      readonly tenantId: string;
      readonly engagementId: string;
      readonly endsOn: string;
      readonly reason: string;
    },
    actor: Actor,
  ): Promise<EndOutcome & { readonly record: EngagementRecord }> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > END_REASON_MAX) {
      throw new EndReasonRequired(END_REASON_MAX);
    }
    if (!isCalendarDay(input.endsOn)) throw new InvalidEndDate(input.endsOn);

    const current = await this.live(input.tenantId, input.engagementId);
    const status = endStatusFor(current, input.endsOn);
    const today = await this.firmToday(input.tenantId);
    const out = await this.deps.lifecycle.end(input.tenantId, {
      engagementId: current.id,
      expect: current.status,
      status,
      endsOn: input.endsOn,
      reason,
      byUserId: actor.type === "human" ? actor.id : null,
      firmToday: today,
    });
    if (!out) throw await this.moved(input.tenantId, current.id);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement.ended",
      objectId: current.id,
      actor,
      payload: {
        from: current.status,
        to: status,
        endsOn: input.endsOn,
        effectiveFrom: current.effectiveFrom,
        filingsWithdrawn: out.filings.withdrawn,
        filingsKept: out.filings.kept,
        filingsRepointed: out.filings.repointed,
        openJobsAfterEnd: out.openJobsAfterEnd.length,
      },
    });
    return { ...out, record: { engagement: out.engagement, state: engagementState(out.engagement, today) } };
  }

  /** Pause running work: no new jobs, no new filings, nothing withdrawn. */
  async pause(input: { readonly tenantId: string; readonly engagementId: string }, actor: Actor): Promise<EngagementRecord> {
    const current = await this.live(input.tenantId, input.engagementId);
    if (current.status !== "active") throw new EngagementNotActive(current.status);
    const today = await this.firmToday(input.tenantId);
    const paused = await this.deps.lifecycle.pause(input.tenantId, {
      engagementId: current.id,
      byUserId: actor.type === "human" ? actor.id : null,
      // The pause's first day, on the firm's calendar, kept after the resume
      // so billing can pro-rate a period half served before it (0318).
      pausedOn: today,
    });
    if (!paused) throw await this.moved(input.tenantId, current.id);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement.paused",
      objectId: current.id,
      actor,
      payload: { from: current.status },
    });
    return { engagement: paused, state: engagementState(paused, today) };
  }

  /** Resume a paused engagement from the firm's today. */
  async resume(input: { readonly tenantId: string; readonly engagementId: string }, actor: Actor): Promise<EngagementRecord> {
    const current = await this.live(input.tenantId, input.engagementId);
    if (current.status !== "paused") throw new EngagementNotPaused();
    const resumedOn = await this.firmToday(input.tenantId);
    const resumed = await this.deps.lifecycle.resume(input.tenantId, {
      engagementId: current.id,
      resumedOn,
    });
    if (!resumed) throw await this.moved(input.tenantId, current.id);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement.resumed",
      objectId: current.id,
      actor,
      payload: { resumedOn, pausedAt: current.pausedAt },
    });
    return { engagement: resumed, state: engagementState(resumed, resumedOn) };
  }

  /** The engagement, refused when it does not exist or has already ended. */
  private async live(tenantId: string, engagementId: string): Promise<Engagement> {
    const e = await this.deps.lifecycle.find(tenantId, engagementId);
    if (!e) throw new EngagementNotFound(engagementId);
    if (!isLive(e.status)) throw new EngagementEnded(e.endsOn);
    return e;
  }

  /** A guarded write found the status changed underneath it: say what it is now. */
  private async moved(tenantId: string, engagementId: string): Promise<Error> {
    const now = await this.deps.lifecycle.find(tenantId, engagementId);
    if (!now) return new EngagementNotFound(engagementId);
    if (!isLive(now.status)) return new EngagementEnded(now.endsOn);
    return now.status === "paused" ? new EngagementNotActive("paused") : new EngagementNotPaused();
  }

  private async firmToday(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}
