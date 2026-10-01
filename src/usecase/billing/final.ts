// The final bill of a one-time service (auto-invoice, phase 2, 0320). No I/O.
//
// An audit or an incorporation is billed ONCE, when the work is done (the
// user, 2026-10-01: "complete" is its job's last step Done). So a job finishing
// writes the bill, and the daily sweep catches any finish nobody heard. A
// service with no process has a job that never finishes, so a person may "Bill
// it now" instead. The bill is for the letter's price; the advance comes off it
// when it is raised (the desk), so this file knows nothing about advances.
//
// Final bills are automatic billing, so they follow the firm's switch: a firm
// with it off bills its one-time work by hand, as it does today.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { finalBillReady, mayBillNow } from "../../domain/billing/advance";
import { AutoBillingOff, BillingEngagementNotFound, BillNowRefused } from "../../domain/billing/errors";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AutoBillingFirms,
  AutoBillingSetting,
  BillingDueWriter,
  BillingManagerFacts,
  FinalBillFacts,
  FinalBillSubject,
  FirmTimeZone,
  NewBillingDue,
} from "./ports";

export interface FinalBillerDeps {
  readonly facts: FinalBillFacts;
  readonly dues: BillingDueWriter;
  readonly managers: BillingManagerFacts;
  readonly setting: AutoBillingSetting;
  readonly firms: AutoBillingFirms;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly events: EventSink;
}

/** A one-time service a person may bill now, by name, for a screen. */
export interface BillNowCandidate {
  readonly engagementId: string;
  readonly feeGroupId: string | null;
  readonly partyId: string;
  readonly clientName: string;
  readonly serviceName: string;
  readonly letterRef: string;
  readonly currency: string;
  readonly fullAmount: string | null;
}

export class FinalBiller {
  constructor(private readonly deps: FinalBillerDeps) {}

  /** A job finished: the final bill of every one-time service it delivered
   *  that is now complete. Called by the orchestrator, after the fact. */
  async jobDone(input: { readonly tenantId: string; readonly jobId: string }, actor: Actor): Promise<{ readonly created: number }> {
    if (!(await this.deps.setting.isOn(input.tenantId))) return { created: 0 };
    const subjects = await this.deps.facts.oneTimeSubjects(input.tenantId, { jobId: input.jobId });
    return { created: await this.write(input.tenantId, subjects.filter(ready), actor, null) };
  }

  /** The sweep's catch-up for one firm with the switch on: a finish nobody
   *  heard (a worker down, a hook that failed) still gets its bill. */
  async sweepTenant(tenantId: string): Promise<number> {
    const subjects = await this.deps.facts.oneTimeSubjects(tenantId, {});
    return this.write(tenantId, subjects.filter(ready), SYSTEM_ACTOR, null);
  }

  /** One pass over every firm with the switch on. */
  async sweep(): Promise<readonly { readonly tenantId: string; readonly created: number; readonly failure?: string }[]> {
    const reports: { tenantId: string; created: number; failure?: string }[] = [];
    for (const tenantId of await this.deps.firms.firmsWithAutoBilling()) {
      try {
        reports.push({ tenantId, created: await this.sweepTenant(tenantId) });
      } catch (err) {
        reports.push({ tenantId, created: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return reports;
  }

  /**
   * "Bill it now": a one-time service the firm wrote no process for, billed by
   * a person today. Refused where a process will bill it when its job is done,
   * before its advance, or twice.
   */
  async billNow(input: { readonly tenantId: string; readonly engagementId: string }, actor: Actor): Promise<{ readonly dueId: string }> {
    if (!(await this.deps.setting.isOn(input.tenantId))) throw new AutoBillingOff();
    const [subject] = await this.deps.facts.oneTimeSubjects(input.tenantId, { engagementId: input.engagementId });
    if (subject === undefined) throw new BillingEngagementNotFound(input.engagementId);
    const refusal = billNowRefusal(subject);
    if (refusal !== null) throw new BillNowRefused(refusal);
    const today = await this.today(input.tenantId);
    const ids: string[] = [];
    if ((await this.write(input.tenantId, [subject], actor, today, ids)) === 0) {
      throw new BillNowRefused("This service's final bill is already on the list.");
    }
    return { dueId: ids[0] ?? "" };
  }

  /** The one-time services a person may bill now, for a screen. */
  async candidates(tenantId: string, partyId?: string): Promise<readonly BillNowCandidate[]> {
    if (!(await this.deps.setting.isOn(tenantId))) return [];
    const subjects = (await this.deps.facts.oneTimeSubjects(tenantId, { partyId })).filter(
      (s) => billNowRefusal(s) === null,
    );
    const names = await this.deps.facts.describe(tenantId, subjects);
    return subjects.map((s) => {
      const name = names.get(s.feeGroupId ?? s.engagementId ?? "");
      return {
        engagementId: s.engagementId ?? s.engagements[0]?.engagementId ?? "",
        feeGroupId: s.feeGroupId,
        partyId: s.partyId,
        clientName: name?.clientName ?? "",
        serviceName: name?.serviceName ?? "",
        letterRef: name?.letterRef ?? "",
        currency: s.currency,
        fullAmount: s.fullAmount,
      };
    });
  }

  /** Writes the final bills, dated the day the work finished (or `today` for
   *  Bill it now). Answers how many were new; `created` collects their ids. */
  private async write(
    tenantId: string,
    subjects: readonly FinalBillSubject[],
    actor: Actor,
    today: string | null,
    created: string[] = [],
  ): Promise<number> {
    const fresh = subjects.filter((s) => !s.hasFinalBill);
    if (fresh.length === 0) return 0;
    const firmToday = today ?? (await this.today(tenantId));
    const cache: ManagerCache = new Map();
    const planned: NewBillingDue[] = [];
    for (const s of fresh) {
      const doneDays = s.engagements.map((e) => e.job?.doneOn ?? null).filter((d): d is string => d !== null);
      const billOn = today ?? (doneDays.length === 0 ? firmToday : doneDays.sort().at(-1) ?? firmToday);
      const manager = await billingManagerFor(
        this.deps.managers,
        { tenantId, partyId: s.partyId, deptCodes: s.engagements.map((e) => e.deptCode), today: firmToday },
        cache,
      );
      planned.push({
        id: this.deps.ids.newId(),
        kind: "final",
        engagementLetterId: null,
        partyId: s.partyId,
        issuingEntityPartyId: s.issuingEntityPartyId,
        currency: s.currency,
        engagementId: s.feeGroupId === null ? s.engagementId : null,
        feeGroupId: s.feeGroupId,
        // The work's span, counted as one whole day of one so the bill is the
        // letter's price, never pro-rated (0320).
        periodStart: s.effectiveFrom <= billOn ? s.effectiveFrom : billOn,
        periodEnd: billOn,
        periodLabel: "Final",
        billOn,
        fullAmount: s.fullAmount,
        servedDays: 1,
        periodDays: 1,
        managerUserId: manager.userId,
        managerHow: manager.how,
        managerNote: manager.note,
      });
    }
    const inserted = new Set(await this.deps.dues.insert(tenantId, planned));
    for (const due of planned) {
      if (!inserted.has(due.id)) continue;
      created.push(due.id);
      await this.deps.events.recordEvent({
        tenantId,
        verb: "billing_due.created",
        objectId: due.id,
        actor,
        payload: {
          kind: "final",
          partyId: due.partyId,
          engagementId: due.engagementId,
          feeGroupId: due.feeGroupId,
          periodStart: due.periodStart,
          billOn: due.billOn,
          managerHow: due.managerHow,
          how: today === null ? "job_done" : "bill_now",
        },
      });
    }
    return inserted.size;
  }

  private async today(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

function ready(s: FinalBillSubject): boolean {
  return (
    !s.hasFinalBill &&
    finalBillReady({
      billingFrequency: s.billingFrequency,
      jobStatuses: s.engagements.map((e) => e.job?.status ?? "none"),
    })
  );
}

/** Why a subject may not be billed now, or null. A group is judged by its
 *  services: any with a process waits for its job. */
function billNowRefusal(s: FinalBillSubject): string | null {
  const withProcess = s.engagements.find((e) => e.job?.hasProcess === true);
  const status = s.engagements.some((e) => e.status === "pending_advance")
    ? "pending_advance"
    : (s.engagements[0]?.status ?? "active");
  return mayBillNow({
    billingFrequency: s.billingFrequency,
    status,
    job: withProcess === undefined ? null : { hasProcess: true },
    hasFinalBill: s.hasFinalBill,
  });
}
