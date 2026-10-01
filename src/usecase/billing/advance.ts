// The advance (auto-invoice, phase 2, 0320): the bill a signed letter owes, and
// the work it holds starting when that bill's invoice is paid. No I/O, no SQL.
//
// ── EVERY ADVANCE IS A TAX INVOICE (Ashish, 2026-10-01) ─────────────────────
//
// Until 0320 the advance was a tick: a person clicked "Record advance" and the
// work started, with no invoice and nothing paid behind it. Now signing writes
// an ADVANCE BILL (one for the letter, or one per service that has its own), a
// person raises its invoice like any other bill, and the work starts when that
// invoice is PAID IN FULL. A part payment starts it only when an admin says so
// (the dunning decision queue's pattern: a machine may notice, a person
// decides). The advance bill is written whatever the firm's billing switch
// says: the tick is gone, so this is the only way such work starts.
//
// ── IDEMPOTENT ──────────────────────────────────────────────────────────────
//
// The partial unique indexes refuse a second advance bill for one letter or
// service, and the release is locked twice over: the engagement's own
// `pending_advance` and the bill's `released_at IS NULL`. Two payments landing
// together release the work once and record it once.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { advanceStartState, advancesOwed, type AdvanceStartState } from "../../domain/billing/advance";
import { AdvanceAlreadyRecorded } from "../../domain/engagement/errors";
import { BillingDueNotFound, StartNotApprovable } from "../../domain/billing/errors";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AdvanceBillFacts,
  AdvanceRecord,
  BillingDueDesk,
  BillingDueWriter,
  BillingManagerFacts,
  NewBillingDue,
  WorkRelease,
} from "./ports";

export interface AdvanceBillerDeps {
  readonly facts: AdvanceBillFacts;
  readonly dues: BillingDueWriter;
  readonly managers: BillingManagerFacts;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export class AdvanceBiller {
  constructor(private readonly deps: AdvanceBillerDeps) {}

  /**
   * The advance bill(s) a signed letter owes, dated the day it was signed. Only
   * for work still waiting: an advance recorded by hand before 0320 already
   * started it, and a bill for it now would ask the client to pay twice.
   */
  async billAdvances(
    input: { readonly tenantId: string; readonly letterId: string },
    actor: Actor,
    cache: ManagerCache = new Map(),
  ): Promise<{ readonly created: number }> {
    const facts = await this.deps.facts.advanceFactsOf(input.tenantId, input.letterId);
    if (facts === null) return { created: 0 };
    if (facts.advanceRequired && facts.advanceRecorded) return { created: 0 };
    const waiting = facts.lines.filter((l) => l.status === "pending_advance");
    if (waiting.length === 0) return { created: 0 };

    const planned: NewBillingDue[] = [];
    for (const advance of advancesOwed({
      advanceRequired: facts.advanceRequired,
      advanceAmount: facts.advanceAmount,
      // The letter's advance covers every service; a service's own only itself.
      lines: facts.advanceRequired ? facts.lines : waiting,
    })) {
      const manager = await billingManagerFor(
        this.deps.managers,
        {
          tenantId: input.tenantId,
          partyId: facts.partyId,
          deptCodes: advance.engagementId === null ? facts.lines.map((l) => l.deptCode) : advance.deptCodes,
          today: facts.signedOn,
        },
        cache,
      );
      planned.push({
        id: this.deps.ids.newId(),
        kind: "advance",
        engagementLetterId: facts.letterId,
        partyId: facts.partyId,
        issuingEntityPartyId: facts.issuingEntityPartyId,
        currency: facts.currency,
        engagementId: advance.engagementId,
        feeGroupId: null,
        // Not a period: the day it fell due, counted as one whole day of one,
        // so the amount is the advance itself (0320).
        periodStart: facts.signedOn,
        periodEnd: facts.signedOn,
        periodLabel: "Advance",
        billOn: facts.signedOn,
        fullAmount: advance.amount,
        servedDays: 1,
        periodDays: 1,
        managerUserId: manager.userId,
        managerHow: manager.how,
        managerNote: manager.note,
      });
    }
    if (planned.length === 0) return { created: 0 };

    const created = new Set(await this.deps.dues.insert(input.tenantId, planned));
    for (const due of planned) {
      if (!created.has(due.id)) continue;
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.created",
        objectId: due.id,
        actor,
        payload: {
          kind: "advance",
          partyId: due.partyId,
          engagementLetterId: facts.letterId,
          engagementId: due.engagementId,
          feeGroupId: null,
          periodStart: due.periodStart,
          billOn: due.billOn,
          managerHow: due.managerHow,
        },
      });
    }
    return { created: created.size };
  }

  /**
   * Every firm's signed letters still owing an advance bill: those signed
   * before 0320 whose advance nobody recorded, and any whose bill could not be
   * written at signing. One firm's failure never stops the others, and it is
   * REPORTED.
   */
  async catchUp(): Promise<readonly { readonly tenantId: string; readonly created: number; readonly failure?: string }[]> {
    const reports: { tenantId: string; created: number; failure?: string }[] = [];
    for (const tenantId of await this.deps.facts.firmsOwingAdvanceBills()) {
      try {
        let created = 0;
        const cache: ManagerCache = new Map();
        for (const letterId of await this.deps.facts.lettersOwingAdvanceBills(tenantId)) {
          created += (await this.billAdvances({ tenantId, letterId }, SYSTEM_ACTOR, cache)).created;
        }
        reports.push({ tenantId, created });
      } catch (err) {
        reports.push({ tenantId, created: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return reports;
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

export interface AdvanceGateDeps {
  readonly desk: BillingDueDesk;
  readonly work: WorkRelease;
  readonly events: EventSink;
}

export interface AdvanceOnDesk extends AdvanceRecord {
  readonly state: AdvanceStartState;
}

export class AdvanceGate {
  constructor(private readonly deps: AdvanceGateDeps) {}

  /** Every advance bill, with where it stands. */
  async list(tenantId: string): Promise<readonly AdvanceOnDesk[]> {
    return (await this.deps.desk.advances(tenantId, {})).map(withState);
  }

  /**
   * Money moved on an invoice: a payment, a credit note, a link, an issue.
   * Every advance bill on it whose invoice is now PAID IN FULL starts its work.
   * Only a person's act: each of those is a person's, and the letter's release
   * names who (`advance_recorded_by`), which a machine cannot be.
   */
  async moneyMoved(tenantId: string, invoiceId: string, actor: Actor): Promise<{ readonly released: readonly string[] }> {
    if (actor.type !== "human" || actor.id === null) return { released: [] };
    const released: string[] = [];
    for (const advance of (await this.deps.desk.advances(tenantId, { invoiceId })).map(withState)) {
      if (advance.state !== "paid") continue;
      if (await this.release(tenantId, advance, "paid", actor.id, actor)) released.push(advance.id);
    }
    return { released };
  }

  /**
   * An admin starts the work on a part payment (Ashish, 2026-10-01). Also on a
   * paid one that did not start by itself, so a failure there is never a dead
   * end. The route holds `tenant:admin`.
   */
  async approveStart(input: { readonly tenantId: string; readonly dueId: string }, actor: Actor): Promise<AdvanceOnDesk> {
    const [found] = await this.deps.desk.advances(input.tenantId, { dueId: input.dueId });
    if (found === undefined) throw new BillingDueNotFound(input.dueId);
    const advance = withState(found);
    if ((advance.state !== "part_paid" && advance.state !== "paid") || actor.type !== "human" || actor.id === null) {
      throw new StartNotApprovable(advance.state);
    }
    if (!(await this.release(input.tenantId, advance, "approved", actor.id, actor))) {
      throw new StartNotApprovable("started");
    }
    const [after] = await this.deps.desk.advances(input.tenantId, { dueId: input.dueId });
    return withState(after ?? found);
  }

  /**
   * The work first, then the bill's mark. Both are locks: the engagements'
   * `pending_advance` and the bill's `released_at IS NULL`, so a second caller
   * releases nothing and records nothing.
   */
  private async release(
    tenantId: string,
    advance: AdvanceRecord,
    how: "paid" | "approved",
    byUserId: string,
    actor: Actor,
  ): Promise<boolean> {
    if (advance.engagementId === null) {
      if (advance.engagementLetterId === null) return false;
      try {
        await this.deps.work.recordAdvance(tenantId, advance.engagementLetterId, byUserId, actor);
      } catch (err) {
        // Somebody released it a moment ago: the mark below decides who records it.
        if (!(err instanceof AdvanceAlreadyRecorded)) throw err;
      }
    } else {
      await this.deps.work.releaseEngagementAdvance(tenantId, advance.engagementId, actor);
    }
    if (!(await this.deps.desk.markReleased(tenantId, advance.id, how, byUserId))) return false;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "billing_due.advance_released",
      objectId: advance.id,
      actor,
      payload: {
        how,
        invoiceId: advance.invoice?.id ?? null,
        engagementLetterId: advance.engagementLetterId ?? advance.letter.id,
        engagementId: advance.engagementId,
      },
    });
    return true;
  }
}

function withState(a: AdvanceRecord): AdvanceOnDesk {
  const status = a.invoice?.status;
  return {
    ...a,
    state: advanceStartState({
      invoiceStatus: status === "draft" || status === "issued" || status === "cancelled" ? status : null,
      paid: a.balance?.paid ?? null,
      outstanding: a.balance?.outstanding ?? null,
      releasedAt: a.released?.at ?? null,
    }),
  };
}
