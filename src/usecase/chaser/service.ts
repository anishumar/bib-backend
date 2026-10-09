// The chaser (T4.4): the reminder ladder aimed at clients, and the freeze that stops it.
// It never SENDS: "never contacts anybody outside a channel the firm configured", and there is
// no channel yet (transport is P10, Phase 7), so a chase raises a reminder in the client's action
// centre. Held by having no seam to send through; `LoggingMailer` is deliberately not injected
// (a log line saying a client was emailed would be a lie).
// It never acts on the work (T4.5): it cannot close an ask, move a task or change a state.
// At-least-once: a rung is taken by an insert conflicting on `client_ask_chase_once`, and the
// event is written only for rows actually created. See docs/claude/escalation-chaser-nudge.md.
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
  /** Which calendar days are counted on. Read-only, not a send seam; `tests/chaser/service.test.ts` pins this deps list. */
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
  /** The day it stops, in the caller's calendar. Defaults to TODAY (0061): resume means the next sweep chases. */
  readonly on?: IsoDate | undefined;
  readonly actor: Actor;
}

export class ChaserService {
  constructor(private readonly deps: Deps) {}

  // ── the sweep ─────────────────────────────────────────────────────────────

  /** One pass over every firm; a worker holds no session, so each read below is tenant-scoped by RLS. */
  async sweep(asOf?: IsoDate): Promise<readonly ChaseSweepReport[]> {
    const reports: ChaseSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        // Each firm's own day unless a caller named one (T6.14, B41).
        reports.push(await this.sweepTenant(tenantId, asOf));
      } catch (err) {
        // One firm's bad data never stops the others (T3.1); reported, never swallowed.
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
    // No ladder means chase nobody (the shipped state); checked before the candidate read.
    const ladder = await this.deps.ladders.ladderFor(tenantId);
    if (ladder.length === 0) {
      return { tenantId, sent: 0, alreadySent: 0, frozen: 0 };
    }

    // Ages count on the firm's calendar: in the server's zone a request raised after 18:30 UTC
    // fires a D+3 reminder on day 2 east of Greenwich. "Today" must be on the same calendar (B41).
    const timeZone = await this.deps.timeZones.timeZoneFor(tenantId);
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
      // Counted, not filtered in SQL: `frozen` tells a quiet-because-frozen week from a broken sweep.
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
        // The system is the honest actor: a cron decided this, not a person.
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
      // The unique index refusing a race or redelivery: idempotency working, not a fault.
      alreadySent: wanted.length - created.length,
      frozen: frozenCount,
    };
  }

  // ── the freeze ────────────────────────────────────────────────────────────

  /** Stop chasing this client. Lives here because the chaser is its only reader; split it out when a second arrives. */
  async freeze(input: SetFreezeInput): Promise<ClientFreezeRecord> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new FreezeReasonRequired();

    // 0065's CHECK allows `validTo = validFrom` because LIFTING produces it; setting one is a typo.
    if (input.validTo !== null && input.validTo <= input.validFrom) {
      throw new FreezeInvalidDates(input.validFrom, input.validTo);
    }

    // Told in words first; `client_freeze_no_overlap` is the wall under concurrency and imports.
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
      // No reason: free text about a client stays on the erasable row (EVENT-CONTRACT §3.4).
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

    // Today, not tomorrow (0061): the next sweep chases; the ledger carries the exact instant.
    const on = input.on ?? (await this.firmDay(input.tenantId));
    const record = await this.deps.freezes.lift({
      tenantId: input.tenantId,
      freezeId: input.freezeId,
      on: on < existing.validFrom ? existing.validFrom : on,
      liftedBy: this.requireHuman(input.actor),
    });
    // Null: lifted concurrently between read and write.
    if (record === null) throw new FreezeAlreadyLifted(input.freezeId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_freeze.lifted",
      objectId: record.id,
      actor: input.actor,
      // validTo is the first day NOT in force (half-open).
      payload: { clientPartyId: record.clientPartyId, validTo: record.validTo },
    });
    return record;
  }

  history(tenantId: string, clientPartyId: string): Promise<readonly ClientFreezeRecord[]> {
    return this.deps.freezes.listForClient(tenantId, clientPartyId);
  }

  private requireHuman(actor: Actor): string {
    // Unreachable behind the session guard. `set_by` is NOT NULL: a freeze by "the system" cannot be reviewed.
    if (actor.type !== "human" || actor.id === null) throw new FreezeReasonRequired();
    return actor.id;
  }

  /** The firm's calendar day (B41): the fallback only when the caller named no day. */
  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/**
 * Do two half-open `[from, to)` day ranges share a day? Null `to` is open-ended. Compared as
 * `YYYY-MM-DD` strings, never `Date` (UTC midnight compares wrong west of Greenwich).
 */
function overlaps(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  // Empty ranges (set and lifted the same day, allowed by 0065) overlap nothing.
  if (aTo !== null && aTo <= aFrom) return false;
  if (bTo !== null && bTo <= bFrom) return false;
  const startsInside = freezeInForceOn(aFrom, aTo, bFrom);
  const contains = freezeInForceOn(bFrom, bTo, aFrom);
  return startsInside || contains;
}
