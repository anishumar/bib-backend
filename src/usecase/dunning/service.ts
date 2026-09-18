// The dunning ladder (T3.5) — chasing a receivable, and the one rung a machine
// may not climb.
//
// A SEPARATE USE CASE from invoicing, and the seam is worth naming: invoicing
// answers "what does this client owe", which is arithmetic over rows. This
// answers "what are we going to do about it", which is policy, runs on a
// WORKER rather than in a request, and reads a ladder the firm publishes. They
// meet at `outstanding()` — one query — and nowhere else.
//
// THE SWEEP IS AT-LEAST-ONCE, like everything the engine touches. It re-reads
// invoices it has seen, pg-boss redelivers on a crash, and a restart leaves a
// message unacknowledged. None of that may chase a client twice: the rung is
// taken by an insert that conflicts on `UNIQUE (tenant, invoice, step)`, and
// the event is written only when a row was actually created. Structural rather
// than careful — the same shape `delivery.job` uses.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { FirmTimeZone } from "./ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { dueDunningSteps, needsApproval } from "../../domain/config/model";
import {
  DunningActionNotFound,
  DunningAlreadyDecided,
  DunningNotAwaitingApproval,
} from "../../domain/invoice/errors";
import type {
  DunningActionRecord,
  DunningLadderSource,
  DunningRepository,
  InvoiceRepository,
  PendingDunningRecord,
  TenantDirectory,
} from "../invoice/ports";

export interface Deps {
  readonly dunning: DunningRepository;
  readonly ladders: DunningLadderSource;
  readonly invoices: InvoiceRepository;
  readonly tenants: TenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface DunningSweepReport {
  readonly tenantId: string;
  /** Rungs climbed this pass. */
  readonly escalated: number;
  /**
   * Rungs the unique key refused — a rung that was climbed between this sweep
   * reading `taken()` and writing.
   *
   * NORMALLY ZERO, and that is worth stating precisely because the scheduler's
   * equivalent counter is normally NOT: `dueDunningSteps` already filters out
   * rungs this invoice has had, so an ordinary second sweep does no work and
   * reports nothing here. What this counts is the genuine race — two workers,
   * or a redelivery overlapping the run it duplicates — which is exactly the
   * case the unique key exists for and the only case where the pre-filter is
   * too late. A non-zero value here is idempotency doing its job, not a fault.
   */
  readonly alreadyTaken: number;
  /** Terminal rungs reached and left for a partner. Counted separately because
   *  it is the number somebody has to act on. */
  readonly awaitingApproval: number;
}

export class DunningService {
  constructor(private readonly deps: Deps) {}

  /**
   * One pass over every firm: climb whatever rungs are due.
   *
   * The outer loop is the tenant list because a worker has no session, and
   * every read below it is tenant-scoped by RLS — so it asks the global
   * registry and then does each firm's work under that firm's context. Never a
   * bypass; always a scope chosen deliberately.
   */
  async sweep(): Promise<readonly DunningSweepReport[]> {
    const reports: DunningSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      reports.push(await this.sweepTenant(tenantId));
    }
    return reports;
  }

  async sweepTenant(tenantId: string): Promise<DunningSweepReport> {
    const ladder = await this.deps.ladders.ladderFor(tenantId);
    // A firm with no published ladder chases nobody, and that is the safe
    // direction rather than a gap: the alternative is this product inventing an
    // escalation policy and sending a client a letter the firm never approved.
    if (ladder === null || ladder.steps.length === 0) {
      return { tenantId, escalated: 0, alreadyTaken: 0, awaitingApproval: 0 };
    }

    const today = await this.firmDay(tenantId);
    let escalated = 0;
    let alreadyTaken = 0;
    let awaitingApproval = 0;

    for (const receivable of await this.deps.invoices.outstanding(tenantId)) {
      // The sweep needs only the arithmetic; the names on this record are for
      // the SCREEN that works the queue. One query serves both rather than two
      // that could disagree about which invoices are outstanding.
      const balance = receivable.balance;
      // No due date is not overdue. A firm that raised an invoice without one
      // has not told anybody when to pay, and chasing on that basis would be
      // the product deciding a payment term nobody agreed.
      if (balance.dueOn === null) continue;
      const overdue = daysBetween(balance.dueOn, today);
      if (overdue < 0) continue;

      const taken = new Set(await this.deps.dunning.taken(tenantId, balance.invoiceId));
      // EVERY due rung, not only the next one: a firm whose worker was down for
      // a week should not need seven sweeps to catch up, and each rung is
      // idempotent by its own key so replaying is safe.
      for (const step of dueDunningSteps(ladder, overdue, taken)) {
        const gated = needsApproval(step.action);
        const row = await this.deps.dunning.take({
          id: this.deps.ids.newId(),
          tenantId,
          invoiceId: balance.invoiceId,
          step: step.key,
          // SNAPSHOTTED from the ladder in force at the moment it fired, so a
          // later edit cannot make a reminder that went out on time look late.
          afterDays: step.afterDays,
          action: step.action,
          // The worker may CLIMB to a terminal rung and may not APPLY it.
          state: gated ? "pending_approval" : "taken",
        });

        // Null means the rung was already taken — a redelivery, not a fault.
        // No row, no event: the log must not say a client was chased twice.
        if (row === null) {
          alreadyTaken += 1;
          continue;
        }
        escalated += 1;
        if (gated) awaitingApproval += 1;

        await this.deps.events.recordEvent({
          tenantId,
          verb: "dunning.escalated",
          // The INVOICE is the object, not the action row: "what happened to
          // this receivable" is the timeline anybody reads, and it is the
          // object_type the verb registry already declares.
          objectId: balance.invoiceId,
          actor: SYSTEM_ACTOR,
          payload: {
            step: row.step,
            action: row.action,
            afterDays: row.afterDays,
            daysOverdue: overdue,
            outstanding: balance.outstanding,
            currency: balance.currency,
            awaitingApproval: gated,
          },
        });
      }
    }
    return { tenantId, escalated, alreadyTaken, awaitingApproval };
  }

  /** The terminal rungs waiting for a person — the queue a partner works. */
  pending(tenantId: string): Promise<readonly PendingDunningRecord[]> {
    return this.deps.dunning.pending(tenantId);
  }

  listFor(tenantId: string, invoiceId: string): Promise<readonly DunningActionRecord[]> {
    return this.deps.dunning.listFor(tenantId, invoiceId);
  }

  /**
   * A partner decides on a terminal rung — the acceptance line.
   *
   * Approving is what actually puts a client on credit hold or sends the matter
   * to lawyers; rejecting says the firm looked and chose not to. BOTH are
   * recorded, because "we considered legal action and decided against it" is a
   * fact somebody wants three months later, and a rejected row that vanished
   * would leave the ladder looking as though it never got there.
   *
   * A decision is FINAL — the database refuses to change one — which is
   * deliberate for an action a firm cannot take back with an apology.
   */
  async decide(
    input: {
      readonly tenantId: string;
      readonly actionId: string;
      readonly approve: boolean;
      readonly note?: string | undefined;
    },
    actor: Actor,
  ): Promise<DunningActionRecord> {
    const existing = await this.deps.dunning.find(input.tenantId, input.actionId);
    if (existing === null) throw new DunningActionNotFound(input.actionId);
    if (existing.state === "taken") {
      throw new DunningNotAwaitingApproval(input.actionId, existing.action);
    }
    if (existing.state !== "pending_approval") {
      throw new DunningAlreadyDecided(input.actionId, existing.state);
    }
    // Only a PERSON decides this. A `system` or `agent` actor reaching here
    // would mean the gate had been routed around, and the whole point of the
    // rung is that a human answered for it.
    // `id` is null only for `system`, and the type narrowing is the check:
    // a decision with no decider is exactly what the schema's
    // `dunning_action_decided_chk` refuses, and it should never get that far.
    if (actor.type !== "human" || actor.id === null) {
      throw new DunningNotAwaitingApproval(input.actionId, existing.action);
    }

    const decided = await this.deps.dunning.decide(
      input.tenantId,
      input.actionId,
      input.approve ? "approved" : "rejected",
      actor.id,
      this.deps.clock.now().toISOString(),
      input.note ?? null,
    );
    // The guarded UPDATE found no row: somebody decided it between the read and
    // the write. The transition is the lock, exactly as `recordAdvance` and
    // `signAndFanOut` use it, so two partners cannot both approve one hold.
    if (decided === null) throw new DunningAlreadyDecided(input.actionId, "decided");

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "dunning.decided",
      objectId: decided.invoiceId,
      actor,
      payload: {
        actionId: decided.id,
        step: decided.step,
        action: decided.action,
        decision: decided.state,
      },
    });
    return decided;
  }

  /** Today for THIS firm (0071). A due date is a calendar fact, not an
   *  instant, and "days overdue" cut on Greenwich's day sent an Indian
   *  client's reminder a day late for five and a half hours every night. */
  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/**
 * Whole days from `from` to `to`, both ISO dates.
 *
 * NO `Date` ARITHMETIC ACROSS A TIMEZONE: both are parsed as UTC midnights and
 * subtracted, so the answer is a count of calendar days rather than 6.96 days
 * because one side was in IST. The same care `domain/scheduler/model.ts` takes,
 * and it matters here for the same reason — D+3 firing on day 2 sends a client
 * a chaser they will correctly argue about.
 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
