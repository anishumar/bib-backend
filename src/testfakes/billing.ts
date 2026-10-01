// In-memory fakes for the billing use case (auto-invoice, phase 1).
//
// The writer models the two things the database guarantees and a test must
// not be able to forget: a subject's `duePeriodStarts` is READ from the dues
// already written (the anti-join), and a second due for the same subject and
// period is refused (the partial unique indexes), answering no id for it.
import type { SpocWithManager } from "../domain/billing/model";
import type {
  AutoBillingFirms,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSubject,
  FiscalYearSource,
  NewBillingDue,
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
