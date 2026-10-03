// The chaser (T4.4) — the reminder ladder aimed OUTWARD, and the freeze that
// stops it.
//
// ── IT NEVER SENDS ANYTHING, AND THAT IS THE BOARD'S OWN HARD LIMIT ────────
//
// *"It never contacts anybody outside a channel the firm configured"* — and
// there is no channel at all yet, because transport is P10 (Phase 7). So a chase
// RAISES a reminder and the client's own action centre shows it. That limit is
// met by there being no seam to send through rather than by a check somebody
// could delete: this service holds a tenant list, a ladder, a candidate read and
// one insert, and nothing else. `LoggingMailer` is deliberately not injected
// here — an honest stub that logged "sent" would put a line in an operator's log
// saying a client was emailed, which is the same class of lie as a `scan()`
// returning clean.
//
// ── AND IT NEVER ACTS ON THE WORK ─────────────────────────────────────────
//
// T4.5's rule, restated because it is easier to break here: this sweep cannot
// close an ask, move a task or change a state. A chaser that could mark an ask
// abandoned after the last rung would be a machine deciding a client is not
// going to reply, at 2am, because a number in a config row said fifteen.
//
// ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ─────────────────────
//
// pg-boss redelivers, a worker restarts mid-pass, and the ask is still open
// tomorrow morning. None of that may remind a client twice: the rung is taken by
// an insert that conflicts on `client_ask_chase_once`, and the event is written
// only for the rows that were actually created.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { ChaseSweepReport } from "../../domain/chaser/model";
import { dayInZone } from "../../domain/scheduler/zone";
import { dueRungs, freezeInForceOn, mayChase } from "../../domain/chaser/model";
import {
  FreezeAlreadyInForce,
  FreezeAlreadyLifted,
  FreezeClientNotFound,
  FreezeInvalidDates,
  FreezeNotFound,
  FreezeReasonRequired,
} from "../../domain/chaser/errors";
import type {
  ChaseCandidateSource,
  ChaseRepository,
  ChaserLadderSource,
  ChaserTenantDirectory,
  ClientFreezeRecord,
  ClientFreezeRepository,
  FirmTimeZone,
  IsoDate,
} from "./ports";

export interface Deps {
  readonly tenants: ChaserTenantDirectory;
  readonly ladders: ChaserLadderSource;
  readonly candidates: ChaseCandidateSource;
  readonly chases: ChaseRepository;
  readonly freezes: ClientFreezeRepository;
  /** WHICH CALENDAR the days are counted on. Not a channel and not a seam that
   *  could send anything — it is read-only and answers one question — but it is
   *  a new name in this list, so `tests/chaser/service.test.ts` had to be
   *  changed deliberately, which is what that test is for. */
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface SetFreezeInput {
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly reason: string;
  readonly actor: Actor;
}

export interface LiftFreezeInput {
  readonly tenantId: string;
  readonly freezeId: string;
  /** The day it stops, in the CALLER's calendar. Defaults to TODAY, which is
   *  0061's decision applied a second time: a partner pressing "resume" expects
   *  chasing to resume on the next sweep, not at midnight. */
  readonly on?: IsoDate | undefined;
  readonly actor: Actor;
}

export class ChaserService {
  constructor(private readonly deps: Deps) {}

  // ── the sweep ─────────────────────────────────────────────────────────────

  /** One pass over every firm. The outer loop is the tenant list because a
   *  worker holds no session; every read below it is tenant-scoped by RLS. */
  async sweep(asOf?: IsoDate): Promise<readonly ChaseSweepReport[]> {
    const reports: ChaseSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        // Each firm's own day unless a caller named one (T6.14, audit
        // 2026-10-03 B41): resolved inside `sweepTenant`, per firm.
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
          frozen: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string, asOf?: IsoDate): Promise<ChaseSweepReport> {
    // NO LADDER MEANS CHASE NOBODY, and it is the shipped state. Returned before
    // the candidate read, so a firm that has published nothing costs one config
    // lookup per sweep rather than a scan of its open asks.
    const ladder = await this.deps.ladders.ladderFor(tenantId);
    if (ladder.length === 0) {
      return { tenantId, sent: 0, alreadySent: 0, frozen: 0 };
    }

    // The firm's own calendar, resolved once for the sweep. `(asOf - raised_at)`
    // counted in the SERVER's zone fires a D+3 reminder on day 2 for a firm east
    // of Greenwich, because a request raised after 18:30 UTC has already "aged"
    // by the time the row is read.
    const timeZone = await this.deps.timeZones.timeZoneFor(tenantId);
    // TODAY ON THE SAME CALENDAR (audit 2026-10-03, B41). The ask's age was
    // already counted in the firm's zone, and "today" was still the server's
    // UTC day, so the two ends of the subtraction were cut on different
    // calendars. Harmless only because the cron runs at 06:15 UTC.
    const day = asOf ?? dayInZone(this.deps.clock.now().toISOString(), timeZone);
    const { candidates, frozenClients } = await this.deps.candidates.openAsks(
      tenantId,
      day,
      timeZone,
    );
    const frozen = new Set(frozenClients);

    const wanted = [];
    let frozenCount = 0;
    for (const candidate of candidates) {
      // THE ACCEPTANCE LINE'S OTHER HALF. Counted rather than filtered in SQL,
      // because `frozen` in the report is what explains a quiet week — a sweep
      // that sent nothing because everybody is frozen and one that sent nothing
      // because it is broken look identical from the outside.
      if (!mayChase(candidate.clientPartyId, frozen)) {
        frozenCount += 1;
        continue;
      }
      wanted.push(...dueRungs(candidate, ladder));
    }

    const created = await this.deps.chases.record(tenantId, wanted);

    for (const chase of created) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "client_ask.chased",
        objectId: chase.askId,
        // THE SYSTEM, and it is the honest actor: nobody at the firm decided to
        // send this one. Who wrote the ladder is a config event; who raised the
        // ask is `client_ask.raised`. Naming a person here would credit them
        // with a decision a cron made.
        actor: SYSTEM_ACTOR,
        payload: {
          rungKey: chase.rungKey,
          afterDays: chase.afterDays,
          daysOpen: chase.daysOpen,
          workItemId: chase.workItemId,
          clientPartyId: chase.clientPartyId,
        },
      });
    }

    return {
      tenantId,
      sent: created.length,
      // The gap is the unique index refusing — a genuine race, two workers or a
      // redelivery overlapping the run it duplicates. Normally zero, and a
      // non-zero value is idempotency working rather than a fault.
      alreadySent: wanted.length - created.length,
      frozen: frozenCount,
    };
  }

  // ── the freeze ────────────────────────────────────────────────────────────

  /**
   * Stop chasing this client.
   *
   * It lives in THIS module and not a `usecase/clientfreeze` of its own, because
   * the chaser is its only reader — and this codebase's rule is that a thing
   * with no consumer should not exist yet. If a second reader ever arrives (a
   * dunning pause, say, which is a different decision about the same client),
   * that is the moment to split it, not now.
   */
  async freeze(input: SetFreezeInput): Promise<ClientFreezeRecord> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new FreezeReasonRequired();

    // SETTING a freeze in force on no day is a typo at the moment of freezing.
    // 0065's CHECK allows `validTo = validFrom` because LIFTING produces exactly
    // that shape twenty seconds later; the service allows only the act.
    if (input.validTo !== null && input.validTo <= input.validFrom) {
      throw new FreezeInvalidDates(input.validFrom, input.validTo);
    }

    // ASKED IN WORDS BEFORE THE EXCLUSION CONSTRAINT ANSWERS IT AS A 500.
    // `client_freeze_no_overlap` is still the thing that holds under concurrency
    // and against an import — this is what a PERSON is told, and it names the
    // client rather than a constraint. `PortalAccessService.grant` has exactly
    // this arrangement for exactly this reason.
    const held = await this.deps.freezes.listForClient(input.tenantId, input.clientPartyId);
    if (held.some((f) => overlaps(f.validFrom, f.validTo, input.validFrom, input.validTo))) {
      throw new FreezeAlreadyInForce(held[0]?.clientName ?? "this client");
    }

    const setBy = this.requireHuman(input.actor);
    const record = await this.deps.freezes.set({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      clientPartyId: input.clientPartyId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason,
      setBy,
    });
    if (record === null) throw new FreezeClientNotFound(input.clientPartyId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_freeze.set",
      objectId: record.id,
      actor: input.actor,
      // THE REASON IS NOT HERE. It is a partner's free text about a client —
      // *"in dispute over the FY26 audit fee"* — and this log cannot be erased.
      // It lives on the row, which can be. §3.4, and the same split
      // `obligation.resolved` makes.
      payload: {
        clientPartyId: record.clientPartyId,
        validFrom: record.validFrom,
        ...(record.validTo === null ? {} : { validTo: record.validTo }),
      },
    });
    return record;
  }

  /** Start chasing again. */
  async lift(input: LiftFreezeInput): Promise<ClientFreezeRecord> {
    const existing = await this.deps.freezes.findById(input.tenantId, input.freezeId);
    if (existing === null) throw new FreezeNotFound(input.freezeId);
    if (existing.validTo !== null) throw new FreezeAlreadyLifted(input.freezeId);

    // TODAY, NOT TOMORROW — 0061's call, made once and applied here again. A
    // partner pressing resume expects the next sweep to chase, and a row dated
    // tomorrow means one more silent day. The row then understates the freeze by
    // part of a day and nothing is lost, because the ledger carries the instant.
    const on = input.on ?? (await this.firmDay(input.tenantId));
    const record = await this.deps.freezes.lift({
      tenantId: input.tenantId,
      freezeId: input.freezeId,
      on: on < existing.validFrom ? existing.validFrom : on,
      liftedBy: this.requireHuman(input.actor),
    });
    // Null means somebody lifted it between the read and the write. The same
    // refusal, because the caller's situation is the same.
    if (record === null) throw new FreezeAlreadyLifted(input.freezeId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_freeze.lifted",
      objectId: record.id,
      actor: input.actor,
      // The FIRST DAY NOT IN FORCE, carried explicitly, because "when did we
      // start chasing them again" is the question and a half-open bound is the
      // half people get wrong.
      payload: { clientPartyId: record.clientPartyId, validTo: record.validTo },
    });
    return record;
  }

  history(tenantId: string, clientPartyId: string): Promise<readonly ClientFreezeRecord[]> {
    return this.deps.freezes.listForClient(tenantId, clientPartyId);
  }

  private requireHuman(actor: Actor): string {
    // Unreachable behind the session guard, which is what produces the actor.
    // Refusing rather than writing null is the safe reading: `set_by` is NOT
    // NULL because a freeze granted by "the system" cannot be reviewed, and this
    // is the one table where that question is asked after something has gone
    // wrong.
    if (actor.type !== "human" || actor.id === null) throw new FreezeReasonRequired();
    return actor.id;
  }

  /** The FIRM's calendar day: the fallback for a caller that did not say which
   *  day it is on, and never the answer when one did. It was the server's UTC
   *  day until 2026-10-03 (B41). */
  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/**
 * Do two half-open day ranges share a day?
 *
 * `[from, to)` on both sides — `to` is the FIRST DAY NOT IN FORCE, and null
 * means open-ended. String comparison on `YYYY-MM-DD` is a date comparison and
 * no `Date` is constructed: one built from a day string is UTC midnight and
 * compares wrong for anybody west of Greenwich, which here would refuse a freeze
 * that does not actually overlap.
 */
function overlaps(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  // Empty ranges — a freeze set and lifted the same day (0065 allows the shape)
  // — overlap nothing, and `freezeInForceOn` is what says so.
  if (aTo !== null && aTo <= aFrom) return false;
  if (bTo !== null && bTo <= bFrom) return false;
  const startsInside = freezeInForceOn(aFrom, aTo, bFrom);
  const contains = freezeInForceOn(bFrom, bTo, aFrom);
  return startsInside || contains;
}
