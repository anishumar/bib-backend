// In-memory fakes for the billing use case (auto-invoice, phase 1).
//
// The writer models the two things the database guarantees and a test must
// not be able to forget: a subject's `duePeriodStarts` is READ from the dues
// already written (the anti-join), and a second due for the same subject and
// period is refused (the partial unique indexes), answering no id for it.
import type { SpocWithManager } from "../domain/billing/model";
import type { Actor } from "../domain/ledger/model";
import type {
  AutoBillingFirms,
  AutoBillingSetting,
  BillingDueDesk,
  BillingDueRecord,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSchedules,
  BillingSubject,
  DueFilters,
  FiscalYearSource,
  InvoiceDrafter,
  NewBillingDue,
  ScheduleRecord,
  SpocDuty,
} from "../usecase/billing/ports";

export interface StoredDue extends NewBillingDue {
  readonly tenantId: string;
}

export class FakeBillingDueWriter implements BillingDueWriter {
  /** Subjects by firm; `duePeriodStarts` is ignored and derived from `dues`. */
  readonly subjects = new Map<string, BillingSubject[]>();
  readonly dues: StoredDue[] = [];

  add(tenantId: string, subject: Omit<BillingSubject, "duePeriodStarts">): void {
    const list = this.subjects.get(tenantId) ?? [];
    list.push({ ...subject, duePeriodStarts: [] });
    this.subjects.set(tenantId, list);
  }

  subjectsFor(tenantId: string): Promise<readonly BillingSubject[]> {
    return Promise.resolve(
      (this.subjects.get(tenantId) ?? []).map((s) => ({
        ...s,
        duePeriodStarts: this.dues
          .filter((d) => d.tenantId === tenantId && sameSubject(d, s))
          .map((d) => d.periodStart),
      })),
    );
  }

  insert(tenantId: string, dues: readonly NewBillingDue[]): Promise<readonly string[]> {
    const created: string[] = [];
    for (const due of dues) {
      const clash = this.dues.some(
        (d) => d.tenantId === tenantId && sameSubject(d, due) && d.periodStart === due.periodStart,
      );
      if (clash) continue;
      this.dues.push({ ...due, tenantId });
      created.push(due.id);
    }
    return Promise.resolve(created);
  }
}

function sameSubject(
  a: { readonly engagementId: string | null; readonly feeGroupId: string | null },
  b: { readonly engagementId: string | null; readonly feeGroupId: string | null },
): boolean {
  return a.engagementId !== null ? a.engagementId === b.engagementId : a.feeGroupId === b.feeGroupId;
}

export class FakeBillingManagerFacts implements BillingManagerFacts {
  /** `${client}|${dept}` → SPOCs with their managers. */
  readonly spocs = new Map<string, SpocWithManager[]>();
  /** client → Key Manager. */
  readonly keyManagers = new Map<string, { userId: string; displayName: string | null }>();

  spocsFor(_t: string, clientPartyId: string, deptCode: string): Promise<readonly SpocWithManager[]> {
    return Promise.resolve(this.spocs.get(`${clientPartyId}|${deptCode}`) ?? []);
  }

  keyManagerFor(
    _t: string,
    clientPartyId: string,
  ): Promise<{ readonly userId: string; readonly displayName: string | null } | null> {
    return Promise.resolve(this.keyManagers.get(clientPartyId) ?? null);
  }
}

export class FakeAutoBillingFirms implements AutoBillingFirms {
  constructor(readonly firms: string[] = []) {}

  firmsWithAutoBilling(): Promise<readonly string[]> {
    return Promise.resolve(this.firms);
  }
}

export class FakeFiscalYearSource implements FiscalYearSource {
  constructor(private readonly month: number | null = 4) {}

  fiscalYearStartMonth(): Promise<number | null> {
    return Promise.resolve(this.month);
  }
}

// ── The desk ────────────────────────────────────────────────────────────────

/**
 * Dues as the desk reads them. `status` is DERIVED from what the fake
 * recorded, the way the query derives it: a skip is final, a cancelled
 * invoice reopens, so a test cannot set a status the database could not give.
 */
export class FakeBillingDueDesk implements BillingDueDesk {
  readonly rows: BillingDueRecord[] = [];
  /** Who is SPOC for which client and Dept (the fake ignores the day). */
  readonly spocs: { userId: string; clientPartyId: string; deptCode: string }[] = [];
  /** What `spocDutiesOf` was asked, so a test can see the day it was cut on. */
  readonly spocsAskedOn: { userId: string; onDate: string }[] = [];
  /** invoice id → status, for the derivation. */
  readonly invoiceStatus = new Map<string, string>();

  private derive(r: BillingDueRecord): BillingDueRecord {
    if (r.skipped !== null) return { ...r, status: "skipped" };
    if (r.invoice === null) return { ...r, status: "open" };
    const status = this.invoiceStatus.get(r.invoice.id) ?? r.invoice.status;
    return {
      ...r,
      invoice: { ...r.invoice, status },
      status: status === "cancelled" ? "open" : status === "draft" ? "drafted" : "billed",
    };
  }

  list(_t: string, filters: DueFilters): Promise<readonly BillingDueRecord[]> {
    return Promise.resolve(
      this.rows
        .map((r) => this.derive(r))
        .filter((r) => filters.status === undefined || r.status === filters.status)
        .filter((r) => filters.partyId === undefined || r.party.id === filters.partyId),
    );
  }

  findMany(_t: string, ids: readonly string[]): Promise<readonly BillingDueRecord[]> {
    return Promise.resolve(this.rows.filter((r) => ids.includes(r.id)).map((r) => this.derive(r)));
  }

  spocDutiesOf(_t: string, userId: string, onDate: string): Promise<readonly SpocDuty[]> {
    this.spocsAskedOn.push({ userId, onDate });
    return Promise.resolve(
      this.spocs
        .filter((s) => s.userId === userId)
        .map((s) => ({ clientPartyId: s.clientPartyId, deptCode: s.deptCode })),
    );
  }

  skip(_t: string, dueId: string, byUserId: string | null, reason: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === dueId);
    const row = this.rows[i];
    if (row === undefined || this.derive(row).status !== "open") return Promise.resolve(false);
    this.rows[i] = {
      ...row,
      skipped: {
        at: "2026-12-05T06:00:00.000Z",
        by: byUserId === null ? null : { userId: byUserId, displayName: null, email: "x@example.test" },
        reason,
      },
    };
    return Promise.resolve(true);
  }

  markInvoiced(_t: string, dueId: string, invoiceId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === dueId);
    const row = this.rows[i];
    if (row === undefined || this.derive(row).status !== "open") return Promise.resolve(false);
    this.rows[i] = {
      ...row,
      invoice: { id: invoiceId, number: "?", status: this.invoiceStatus.get(invoiceId) ?? "draft" },
    };
    return Promise.resolve(true);
  }
}

export interface DraftedInvoice {
  readonly id: string;
  readonly number: string;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly dueOn: string | undefined;
  readonly managerUserId: string | undefined;
  status: string;
  readonly lines: {
    readonly id: string;
    readonly engagementId: string | undefined;
    readonly description: string;
    readonly unitAmount: string;
    readonly taxPercent: string | undefined;
  }[];
}

/** Records what the desk asked invoicing for. The rules invoicing applies to
 *  every line are InvoiceService's, and tested there. */
export class FakeInvoiceDrafter implements InvoiceDrafter {
  readonly invoices: DraftedInvoice[] = [];
  private n = 0;

  raise(input: Parameters<InvoiceDrafter["raise"]>[0], _actor: Actor): Promise<{ id: string; number: string }> {
    this.n += 1;
    const id = `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const invoice: DraftedInvoice = {
      id,
      number: `INV/2026-27/${String(this.n).padStart(4, "0")}`,
      partyId: input.partyId,
      entityPartyId: input.entityPartyId,
      currency: input.currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      dueOn: input.dueOn,
      managerUserId: input.managerUserId,
      status: "draft",
      lines: [],
    };
    this.invoices.push(invoice);
    return Promise.resolve({ id, number: invoice.number });
  }

  addLine(input: Parameters<InvoiceDrafter["addLine"]>[0]): Promise<{ id: string }> {
    const invoice = this.invoices.find((i) => i.id === input.invoiceId);
    if (invoice === undefined) return Promise.reject(new Error("no such invoice"));
    const id = `00000000-0000-4000-9000-${String(this.invoices.indexOf(invoice) * 100 + invoice.lines.length + 1).padStart(12, "0")}`;
    invoice.lines.push({
      id,
      engagementId: input.engagementId,
      description: input.description,
      unitAmount: input.unitAmount,
      taxPercent: input.taxPercent,
    });
    return Promise.resolve({ id });
  }

  find(_t: string, invoiceId: string): ReturnType<InvoiceDrafter["find"]> {
    const i = this.invoices.find((x) => x.id === invoiceId);
    return Promise.resolve(
      i === undefined
        ? null
        : { id: i.id, partyId: i.partyId, entityPartyId: i.entityPartyId, currency: i.currency, status: i.status },
    );
  }
}

export class FakeBillingSchedules implements BillingSchedules {
  readonly rows: ScheduleRecord[] = [];
  /** fee group → engagement ids. */
  readonly groups = new Map<string, string[]>();

  unscheduled(): Promise<readonly ScheduleRecord[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.billingFrom === null &&
          ["monthly", "quarterly", "annually"].includes(r.billingFrequency ?? "") &&
          ["active", "paused", "pending_advance"].includes(r.status),
      ),
    );
  }

  find(_t: string, engagementId: string): Promise<ScheduleRecord | null> {
    return Promise.resolve(this.rows.find((r) => r.engagementId === engagementId) ?? null);
  }

  groupMembers(_t: string, feeGroupId: string): Promise<readonly string[]> {
    return Promise.resolve(this.groups.get(feeGroupId) ?? []);
  }

  set(_t: string, ids: readonly string[], billingFrom: string | null, firstInvoiceOn: string | null): Promise<void> {
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i];
      if (row !== undefined && ids.includes(row.engagementId)) {
        this.rows[i] = { ...row, billingFrom, firstInvoiceOn };
      }
    }
    return Promise.resolve();
  }
}

export class FakeAutoBillingSetting implements AutoBillingSetting {
  private readonly on = new Set<string>();

  isOn(tenantId: string): Promise<boolean> {
    return Promise.resolve(this.on.has(tenantId));
  }

  set(tenantId: string, on: boolean): Promise<void> {
    if (on) this.on.add(tenantId);
    else this.on.delete(tenantId);
    return Promise.resolve();
  }
}
