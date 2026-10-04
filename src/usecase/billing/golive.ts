// Phase 1b (0319): the engagement letter sets the billing schedule when the
// work goes live. Its own small use case, not a method on the billing desk,
// because the worker settles e-signed letters too and has no invoicing to
// give the desk: this needs the schedule, the firm's switch, its financial
// year and the ledger, and nothing else.
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import { goesLiveFrom, scheduleFor } from "../../domain/billing/model";
import { yearStartOfCompany } from "../../domain/calendar/model";
import type { AutoBillingSetting, BillingSchedules, FirmTimeZone, FiscalYearSource } from "./ports";

export interface GoLiveDeps {
  readonly schedules: BillingSchedules;
  readonly setting: AutoBillingSetting;
  readonly fiscalYears: FiscalYearSource;
  /** The companies that keep their own year (0337): a letter's schedule is
   *  cut on its issuing company's. */
  readonly calendars: Pick<FirmTimeZone, "companyCalendars">;
  readonly events: EventSink;
}

export class GoLiveScheduler {
  constructor(private readonly deps: GoLiveDeps) {}

  /**
   * THE LETTER SETS THE SCHEDULE WHEN THE WORK GOES LIVE (0319, phase 1b).
   *
   * Called for the engagements a letter's signature made active, and for those
   * an advance later activated: `liveOn` is that day, on the firm's calendar.
   * The first period billed is the one containing the later of the
   * engagement's first day and `liveOn`, so a backdated letter does not bill
   * months the firm already billed by hand; the first invoice date follows the
   * letter's timing (arrears when it said nothing). A fee group is set once,
   * for all its engagements.
   *
   * Nothing is set while the firm's switch is off: those engagements wait on
   * "Billing not set up", or turning the switch on later would bill months
   * somebody already billed by hand. Nor for an engagement already scheduled,
   * a one-off or custom fee, or a quarter or year with no financial year set.
   * Each of those stays a decision for a person, which is the safe default.
   */
  async scheduleActivated(
    input: { readonly tenantId: string; readonly engagementIds: readonly string[]; readonly liveOn: string },
    actor: Actor,
  ): Promise<{ readonly scheduled: readonly string[] }> {
    if (input.engagementIds.length === 0 || !(await this.deps.setting.isOn(input.tenantId))) {
      return { scheduled: [] };
    }
    const firmYear = await this.deps.fiscalYears.fiscalYearStartMonth(input.tenantId);
    const calendars = await this.deps.calendars.companyCalendars(input.tenantId);
    const scheduled: string[] = [];
    const groupsDone = new Set<string>();
    for (const engagementId of input.engagementIds) {
      const current = await this.deps.schedules.find(input.tenantId, engagementId);
      if (current === null || current.billingFrom !== null) continue;
      if (current.feeGroup !== null && groupsDone.has(current.feeGroup.id)) continue;
      const recurrence = recurrenceOfService(current.billingFrequency);
      const fiscalYear = yearStartOfCompany(calendars, current.issuingEntityPartyId, firmYear);
      if (recurrence === null || (recurrence !== "monthly" && fiscalYear === null)) continue;
      const [period] = periodsFrom(
        goesLiveFrom(current.effectiveFrom, input.liveOn),
        recurrence,
        1,
        fiscalYear ?? 1,
      );
      if (period === undefined) continue;
      const { billingFrom, firstInvoiceOn } = scheduleFor(period, current.billingTiming, current.billingOn);
      const ids =
        current.feeGroup === null
          ? [engagementId]
          : await this.deps.schedules.groupMembers(input.tenantId, current.feeGroup.id);
      if (current.feeGroup !== null) groupsDone.add(current.feeGroup.id);
      await this.deps.schedules.set(input.tenantId, ids, billingFrom, firstInvoiceOn);
      for (const id of ids) {
        await this.deps.events.recordEvent({
          tenantId: input.tenantId,
          verb: "engagement.billing_scheduled",
          objectId: id,
          actor,
          payload: {
            billingFrom,
            firstInvoiceOn,
            previousBillingFrom: null,
            previousFirstInvoiceOn: null,
            how: "from_letter",
          },
        });
        scheduled.push(id);
      }
    }
    return { scheduled };
  }
}
