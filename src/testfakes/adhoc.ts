// An in-memory store for the ad-hoc advance (0363). It models what the
// database guarantees and a test must not be able to forget: the unmapped
// balance is DERIVED (net less credits less every allocation's effective
// amount), a map that no longer fits writes nothing, and an ended mapping keeps
// what bills took and frees the rest.
import { compareAmounts, subtractAmounts } from "../domain/money/model";
import { addAmounts, minAmount, sumAmounts } from "../domain/billing/adhoc-advance";
import { NO_TAX_SNAPSHOT, type Invoice } from "../domain/invoice/model";
import type { NewInvoice, NewInvoiceLine } from "../usecase/invoice/ports";
import type {
  AdhocAdvanceFilters,
  AdhocAdvanceRecord,
  AdhocAdvanceStore,
  AdhocAllocationRecord,
  AllocationTargetFacts,
  ClientServiceForAdvance,
  EndOutcome,
  LetterOwingMaps,
  MapOutcome,
  NewAdhocAdvance,
  NewAllocation,
} from "../usecase/billing/ports";
import { AdhocAdvanceService } from "../usecase/billing/adhoc";
import { FakeBillingManagerFacts, FakeInvoiceDrafter, FakeIssuerTaxDefaults } from "./billing";
import { FakeFirmTimeZone } from "./tenancy";
import { FakeClock } from "./clock";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

interface StoredAdvance {
  readonly id: string;
  readonly invoiceId: string;
  readonly partyId: string;
  readonly issuerId: string;
  readonly currency: string;
  readonly note: string | null;
  readonly raisedBy: string;
  status: "draft" | "issued" | "cancelled";
  number: string | null;
  net: string;
  total: string;
  credited: string;
}

interface StoredAllocation extends NewAllocation {
  readonly advanceId: string;
  taken: string;
  ended: { reason: string; kept: string } | null;
}

export class FakeAdhocAdvanceStore implements AdhocAdvanceStore {
  readonly advances: StoredAdvance[] = [];
  readonly allocations: StoredAllocation[] = [];
  readonly services: ClientServiceForAdvance[] = [];
  readonly named = new Map<string, { adhocAdvanceId: string; amount: string; currency: string }[]>();
  readonly letters = new Map<string, { partyId: string; issuerId: string; currency: string; status: string; ref: string; signedOn?: string }>();

  raiseAtomically(
    _t: string,
    plan: { readonly draft: NewInvoice; readonly line: NewInvoiceLine; readonly advance: NewAdhocAdvance },
  ): Promise<Invoice> {
    const net = plan.line.unitAmount;
    const tax = plan.line.taxPercent ?? "0";
    const total = String((Number(net) * (100 + Number(tax))) / 100);
    this.advances.push({
      id: plan.advance.id,
      invoiceId: plan.draft.id,
      partyId: plan.draft.partyId,
      issuerId: plan.draft.entityPartyId,
      currency: plan.draft.currency,
      note: plan.advance.note,
      raisedBy: plan.advance.raisedByUserId,
      status: "draft",
      number: null,
      net,
      total,
      credited: "0",
    });
    return Promise.resolve({
      id: plan.draft.id,
      tenantId: plan.draft.tenantId,
      partyId: plan.draft.partyId,
      entityPartyId: plan.draft.entityPartyId,
      number: null,
      financialYear: plan.draft.financialYear,
      sequenceNumber: null,
      status: "draft",
      currency: plan.draft.currency,
      fxRate: plan.draft.fxRate,
      fxRateDate: plan.draft.fxRateDate,
      issuedOn: null,
      dueOn: plan.draft.dueOn,
      irn: null,
      irnRegisteredAt: null,
      notes: plan.draft.notes,
      managerUserId: plan.draft.managerUserId,
      tax: NO_TAX_SNAPSHOT,
      createdAt: "2026-10-05T00:00:00.000Z",
    } as Invoice);
  }

  /** A test issues the draft: the money is then mappable. */
  issue(advanceId: string, number = "INV/1"): void {
    const a = this.advances.find((x) => x.id === advanceId);
    if (a !== undefined) {
      a.status = "issued";
      a.number = number;
    }
  }

  /** A test has a bill take part of an allocation. */
  take(allocationId: string, amount: string): void {
    const al = this.allocations.find((x) => x.id === allocationId);
    if (al !== undefined) al.taken = addAmounts(al.taken, amount);
  }

  private effective(al: StoredAllocation): string {
    return al.ended?.kept ?? al.amount;
  }

  private unmapped(a: StoredAdvance): string {
    const left = subtractAmounts(a.net, a.credited);
    return subtractAmounts(left, sumAmounts(this.allocations.filter((x) => x.advanceId === a.id).map((x) => this.effective(x))));
  }

  list(_t: string, filters: AdhocAdvanceFilters): Promise<readonly AdhocAdvanceRecord[]> {
    const status = filters.status ?? "open";
    const rows = this.advances.filter(
      (a) =>
        (filters.advanceId === undefined || a.id === filters.advanceId) &&
        (filters.partyId === undefined || a.partyId === filters.partyId) &&
        (status === "all" || a.status === "draft" || (a.status === "issued" && compareAmounts(this.unmapped(a), "0") > 0)),
    );
    return Promise.resolve(
      rows.map((a) => {
        const allocations = this.allocations.filter((x) => x.advanceId === a.id);
        const unmapped = a.status === "issued" ? this.unmapped(a) : null;
        return {
          id: a.id,
          party: { id: a.partyId, displayName: "Client" },
          issuer: { id: a.issuerId, displayName: "Firm" },
          currency: a.currency,
          note: a.note,
          raisedBy: { userId: a.raisedBy, displayName: null, email: "raiser@firm.test" },
          raisedAt: "2026-10-05T00:00:00.000Z",
          manager: null,
          invoice: { id: a.invoiceId, number: a.number, status: a.status, issuedOn: a.status === "issued" ? "2026-10-05" : null },
          net: a.net,
          total: a.total,
          credited: a.credited,
          mapped: sumAmounts(allocations.map((x) => this.effective(x))),
          unmapped,
          refundAmount: unmapped !== null && compareAmounts(unmapped, "0") > 0 ? unmapped : null,
          paid: "0",
          outstanding: a.total,
          allocations: allocations.map(
            (x): AdhocAllocationRecord => ({
              id: x.id,
              target:
                x.engagementId !== null
                  ? { kind: "service", engagementId: x.engagementId, serviceName: "Service", letterRef: "EL", engagementStatus: "active", job: null }
                  : { kind: "letter", letterId: x.engagementLetterId ?? "", letterRef: "EL" },
              amount: x.amount,
              effective: this.effective(x),
              taken: x.taken,
              left: subtractAmounts(this.effective(x), x.taken),
              manager: x.managerUserId === null ? null : { userId: x.managerUserId, displayName: null, email: "m@firm.test" },
              how: x.how,
              reason: x.reason,
              createdBy: null,
              createdAt: "2026-10-05T00:00:00.000Z",
              ended: x.ended === null ? null : { at: "2026-10-05T00:00:00.000Z", by: null, reason: x.ended.reason, kept: x.ended.kept },
            }),
          ),
          namedOn: [],
        };
      }),
    );
  }

  targets(_t: string, engagementIds: readonly string[]): Promise<readonly AllocationTargetFacts[]> {
    return Promise.resolve(this.services.filter((s) => engagementIds.includes(s.engagementId)));
  }

  servicesOf(_t: string, partyId: string): Promise<readonly ClientServiceForAdvance[]> {
    return Promise.resolve(this.services.filter((s) => s.partyId === partyId));
  }

  jobs(
    _t: string,
    jobIds: readonly string[],
  ): Promise<readonly { readonly jobId: string; readonly engagementId: string | null; readonly label: string | null }[]> {
    return Promise.resolve(
      this.services.flatMap((s) =>
        s.jobs.filter((j) => jobIds.includes(j.id)).map((j) => ({ jobId: j.id, engagementId: s.engagementId, label: j.label })),
      ),
    );
  }

  map(
    _t: string,
    advanceId: string,
    rows: readonly NewAllocation[],
    options: { readonly clip?: boolean | undefined } = {},
  ): Promise<MapOutcome> {
    const a = this.advances.find((x) => x.id === advanceId);
    if (a === undefined || a.status !== "issued") return Promise.resolve({ notIssued: a?.status ?? "missing" });
    const unmapped = this.unmapped(a);
    if (options.clip === true) {
      const [row] = rows;
      if (row === undefined || compareAmounts(unmapped, "0") <= 0) return Promise.resolve({ written: [] });
      const amount = minAmount(row.amount, unmapped);
      this.allocations.push({ ...row, amount, advanceId, taken: "0", ended: null });
      return Promise.resolve({ written: [{ id: row.id, amount }] });
    }
    const asked = sumAmounts(rows.map((r) => r.amount));
    if (compareAmounts(asked, unmapped) > 0) return Promise.resolve({ over: { asked, unmapped } });
    for (const r of rows) this.allocations.push({ ...r, advanceId, taken: "0", ended: null });
    return Promise.resolve({ written: rows.map((r) => ({ id: r.id, amount: r.amount })) });
  }

  end(
    _t: string,
    advanceId: string,
    allocationId: string,
    input: { readonly byUserId: string | null; readonly reason: string },
  ): Promise<EndOutcome | null> {
    const al = this.allocations.find((x) => x.id === allocationId && x.advanceId === advanceId);
    if (al === undefined) return Promise.resolve(null);
    if (al.ended !== null) return Promise.resolve({ alreadyEnded: true });
    const kept = minAmount(al.taken, al.amount);
    const freed = subtractAmounts(al.amount, kept);
    if (compareAmounts(freed, "0") <= 0) return Promise.resolve({ usedUp: true });
    al.ended = { reason: input.reason, kept };
    return Promise.resolve({ ended: { kept, freed } });
  }

  namedOn(
    _t: string,
    letterId: string,
  ): Promise<readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[]> {
    return Promise.resolve(this.named.get(letterId) ?? []);
  }

  setNamed(
    _t: string,
    letterId: string,
    rows: readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[],
  ): Promise<void> {
    this.named.set(letterId, [...rows]);
    return Promise.resolve();
  }

  letterFacts(
    _t: string,
    letterId: string,
  ): Promise<{ readonly partyId: string; readonly issuerId: string; readonly currency: string; readonly status: string; readonly ref: string } | null> {
    return Promise.resolve(this.letters.get(letterId) ?? null);
  }

  lettersOwingMaps(_t: string, letterId?: string): Promise<readonly LetterOwingMaps[]> {
    const out: LetterOwingMaps[] = [];
    for (const [id, l] of this.letters) {
      if (l.status !== "signed" || (letterId !== undefined && id !== letterId)) continue;
      const named = (this.named.get(id) ?? []).filter(
        (n) => !this.allocations.some((a) => a.how === "letter_signed" && a.advanceId === n.adhocAdvanceId && a.engagementLetterId === id),
      );
      if (named.length > 0) {
        out.push({ letterId: id, letterRef: l.ref, partyId: l.partyId, signedOn: l.signedOn ?? "2026-10-05", named: named.map((n) => ({ adhocAdvanceId: n.adhocAdvanceId, amount: n.amount })) });
      }
    }
    return Promise.resolve(out);
  }
}

/** The service on fakes, for a test that only needs the routes to exist. */
export function fakeAdhocService(store: FakeAdhocAdvanceStore = new FakeAdhocAdvanceStore()): AdhocAdvanceService {
  return new AdhocAdvanceService({
    store,
    invoices: new FakeInvoiceDrafter(),
    taxDefaults: new FakeIssuerTaxDefaults(),
    managers: new FakeBillingManagerFacts(),
    timeZones: new FakeFirmTimeZone(),
    ids: new FakeIds(),
    clock: new FakeClock(),
    events: new RecordingEventSink(),
  });
}
