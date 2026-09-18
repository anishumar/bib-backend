// The proactive nudge (T6.7) — the ladder that counts DOWN to a date the law
// set.
//
// ── IT SENDS NOTHING, AND THAT LIMIT IS STRUCTURAL AGAIN ──────────────────
//
// Transport is P10 (Phase 7). So a nudge RAISES a reminder and the client's own
// filings list shows it. `ChaserService` met the same limit the same way and
// said why: an honest logging stub would put a line in an operator's log saying
// a client was emailed, which is the same class of lie as a `scan()` returning
// clean. `Deps` below holds a tenant list, a ladder, a candidate read and one
// insert. `tests/nudge/service.test.ts` asserts that list STRUCTURALLY, so a
// mailer appearing in it turns the build red and somebody has to argue for it on
// the board first.
//
// ── AND IT NEVER TOUCHES THE CALENDAR ────────────────────────────────────
//
// T4.5's rule, T4.4's restatement, and it is loudest here: this sweep reads
// `delivery.obligation_instance` and cannot write to it. A nudge sweep that
// could move a filing's state would be a machine deciding something about a
// statutory return at 2am because a number in a config row said seven. There is
// no seam through which it could.
//
// ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ────────────────────
//
// pg-boss redelivers, a worker restarts mid-pass, and the filing is still due
// tomorrow morning. None of that may tell a client twice: the rung is taken by
// an insert that conflicts on `obligation_nudge_once`, and the event is written
// only for the rows actually created.
import type { Clock } from "../../platform/clock";
import type { EventSink } from "../ledger/ports";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { NudgeSweepReport } from "../../domain/nudge/model";
import { dueRungs, horizonDays } from "../../domain/nudge/model";
import type {
  FirmTimeZone,
  IsoDate,
  NudgeCandidateSource,
  NudgeLadderSource,
  NudgeRepository,
  NudgeTenantDirectory,
} from "./ports";
import { dayInZone } from "../../domain/scheduler/zone";

export interface Deps {
  readonly tenants: NudgeTenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly ladders: NudgeLadderSource;
  readonly candidates: NudgeCandidateSource;
  readonly nudges: NudgeRepository;
  readonly clock: Clock;
  readonly events: EventSink;
}

export class NudgeService {
  constructor(private readonly deps: Deps) {}

  /** One pass over every firm. The outer loop is the tenant list because a
   *  worker holds no session; every read below it is tenant-scoped by RLS. */
  async sweep(asOf?: IsoDate): Promise<readonly NudgeSweepReport[]> {
    // No single day for the pass: each firm's day is its own (0071).
    const reports: NudgeSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        reports.push(await this.sweepTenant(tenantId, asOf));
      } catch (err) {
        // ONE FIRM'S BAD DATA NEVER STOPS THE OTHERS — T3.1's lesson, where one
        // firm with no work states stopped the calendar for every firm after it
        // in the list. Reported rather than swallowed: a firm silently skipped
        // forever is worse than a sweep that stops.
        reports.push({
          tenantId,
          sent: 0,
          alreadySent: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string, asOf?: IsoDate): Promise<NudgeSweepReport> {
    const day = asOf ?? (await this.firmDay(tenantId));

    // NO LADDER MEANS TELL NOBODY, and it is the shipped state. Returned before
    // the candidate read, so a firm that has published nothing costs one config
    // lookup per sweep rather than a scan of its whole calendar — which on this
    // sweep is the expensive read, not a handful of open asks.
    const ladder = await this.deps.ladders.ladderFor(tenantId);
    if (ladder.length === 0) {
      return { tenantId, sent: 0, alreadySent: 0 };
    }

    // THE WINDOW COMES FROM THE LADDER. A firm that adds a 30-day rung must get
    // rows 30 days out; a constant here would hand it a rung that is due and a
    // query that never offers the row, which fails as silence.
    const candidates = await this.deps.candidates.upcomingFilings(
      tenantId,
      day,
      horizonDays(ladder),
    );

    const wanted = candidates.flatMap((candidate) => dueRungs(candidate, ladder));
    const created = await this.deps.nudges.record(tenantId, wanted);

    for (const nudge of created) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.nudged",
        objectId: nudge.obligationId,
        // THE SYSTEM, honestly — a cron sent this one and nobody at the firm
        // decided to. Who wrote the ladder is a config event. Naming a person
        // here would credit them with a decision they did not take, which is
        // also why there is no "nudge now" route.
        actor: SYSTEM_ACTOR,
        payload: {
          rungKey: nudge.rungKey,
          beforeDays: nudge.beforeDays,
          daysUntil: nudge.daysUntil,
          dueOn: nudge.dueOn,
          entityPartyId: nudge.entityPartyId,
        },
      });
    }

    return {
      tenantId,
      sent: created.length,
      // The gap is the unique index refusing — a redelivery, or two workers
      // overlapping. Normally zero, and a non-zero value is idempotency working
      // rather than a fault.
      alreadySent: wanted.length - created.length,
    };
  }

  /** Today for THIS firm (0071) — the fallback for a caller that did not say
   *  which day it is on, and never the answer when one did. A nudge counts
   *  down to a deadline in days, and "D-1" cut on Greenwich's day reached an
   *  Indian client a day early for five and a half hours every night. */
  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}
