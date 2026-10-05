// The ad-hoc advance's rules (0363, Q044-Q048): the pure arithmetic of a map,
// and the use case's refusals, on fakes. The SQL (the derived balances, the
// lock, the walls) is proven in adhoc-advance.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  addAmounts,
  adhocAdvanceLineText,
  adhocAdvanceStatus,
  allocationProblem,
  endAllocation,
  isUnmappedReminderDay,
  letterMapAmount,
  sumAmounts,
  unmappedReminderDue,
} from "../../src/domain/billing/adhoc-advance";
import {
  AdvanceFeesNotVisible,
  AdvanceInAnotherCurrency,
  AdvanceJobNotOfService,
  AdvanceNotIssued,
  AdvanceOfAnotherClient,
  AdvanceOfAnotherIssuer,
  AdvanceOverMapped,
  AdvanceTargetNotLive,
  AllocationEnded,
  AllocationUsedUp,
  InvalidBillingInput,
} from "../../src/domain/billing/errors";
import { FakeAdhocAdvanceStore } from "../../src/testfakes/adhoc";
import { FakeBillingManagerFacts, FakeInvoiceDrafter, FakeIssuerTaxDefaults } from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { AdhocAdvanceService } from "../../src/usecase/billing/adhoc";
import type { ClientServiceForAdvance } from "../../src/usecase/billing/ports";
import type { Actor } from "../../src/domain/ledger/model";

const T = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const FIRM = "00000000-0000-4000-8000-0000000000f1";
const me: Actor = { type: "human", id: "00000000-0000-4000-8000-0000000000e1" };

describe("the arithmetic of a map", () => {
  it("adds exactly, on the digits", () => {
    expect(addAmounts("0.1", "0.2")).toBe("0.3");
    expect(sumAmounts(["30000", "20000.50", "0.5"])).toBe("50001.00");
    expect(sumAmounts([])).toBe("0");
  });

  it("refuses more than is left, a non-amount, zero, and one target twice", () => {
    const t = (key: string, amount: string) => ({ key, amount });
    expect(allocationProblem({ unmapped: "50000", targets: [t("a", "30000"), t("b", "20000")] })).toEqual({ kind: "none" });
    expect(allocationProblem({ unmapped: "50000", targets: [t("a", "30000"), t("b", "20000.01")] })).toEqual({
      kind: "over",
      asked: "50000.01",
      unmapped: "50000",
    });
    expect(allocationProblem({ unmapped: "10", targets: [t("a", "1,000")] }).kind).toBe("not_an_amount");
    expect(allocationProblem({ unmapped: "10", targets: [t("a", "0")] }).kind).toBe("not_above_zero");
    expect(allocationProblem({ unmapped: "10", targets: [t("a", "1"), t("a", "2")] }).kind).toBe("same_target_twice");
  });

  it("ends a mapping by keeping what bills took and freeing the rest; a used-up one cannot move", () => {
    expect(endAllocation({ amount: "25000", taken: "15000" })).toEqual({ kept: "15000", freed: "10000" });
    expect(endAllocation({ amount: "25000", taken: "0" })).toEqual({ kept: "0", freed: "25000" });
    expect(endAllocation({ amount: "25000", taken: "25000" })).toBeNull();
  });

  it("maps for a signed letter the smaller of what it named and what is left", () => {
    expect(letterMapAmount({ named: "12000", unmapped: "50000" })).toBe("12000");
    expect(letterMapAmount({ named: "12000", unmapped: "5000" })).toBe("5000");
    expect(letterMapAmount({ named: "12000", unmapped: "0" })).toBeNull();
  });

  it("says where an advance stands", () => {
    expect(adhocAdvanceStatus({ invoiceStatus: "draft", unmapped: null })).toBe("draft");
    expect(adhocAdvanceStatus({ invoiceStatus: "issued", unmapped: "1" })).toBe("open");
    expect(adhocAdvanceStatus({ invoiceStatus: "issued", unmapped: "0.00" })).toBe("mapped");
    expect(adhocAdvanceStatus({ invoiceStatus: "cancelled", unmapped: null })).toBe("cancelled");
  });

  it("writes no amount in the invoice line's words", () => {
    expect(adhocAdvanceLineText(null)).toBe("Advance, to be adjusted against services");
    expect(adhocAdvanceLineText("  for the audit ")).toBe("Advance, to be adjusted against services: for the audit");
  });
});

describe("the monthly reminder's day (Q047)", () => {
  const due = (now: string, day = 1, hour = 9) => unmappedReminderDue({ now, timeZone: "Asia/Kolkata", day, hour });

  it("is due from the firm's day and hour, in its zone, for the rest of that month", () => {
    // 1 Nov 09:00 IST is 1 Nov 03:30 UTC.
    expect(due("2026-11-01T03:29:00Z")).toBeNull();
    expect(due("2026-11-01T03:30:00Z")).toBe("2026-11");
    // 00:30 IST on 1 Nov is still 31 Oct in Greenwich: the firm's day counts,
    // and it is before its hour.
    expect(due("2026-10-31T19:00:00Z")).toBeNull();
    // Missed on the 1st (the worker was down): still that month's on the 2nd.
    expect(due("2026-11-02T10:00:00Z")).toBe("2026-11");
    // A firm on the 15th.
    expect(due("2026-11-14T10:00:00Z", 15)).toBeNull();
    expect(due("2026-11-15T10:00:00Z", 15)).toBe("2026-11");
  });

  it("is a day every month has", () => {
    expect(isUnmappedReminderDay(1)).toBe(true);
    expect(isUnmappedReminderDay(28)).toBe(true);
    expect(isUnmappedReminderDay(29)).toBe(false);
    expect(isUnmappedReminderDay(0)).toBe(false);
    expect(isUnmappedReminderDay(1.5)).toBe(false);
  });
});

function service(over: Partial<ClientServiceForAdvance> = {}): ClientServiceForAdvance {
  return {
    engagementId: "eng-books",
    partyId: CLIENT,
    issuerId: FIRM,
    issuerName: "The Firm",
    currency: "INR",
    status: "active",
    letterId: "letter-1",
    letterRef: "EL-2026-0001",
    serviceName: "Monthly bookkeeping",
    deptCode: "FRC",
    jobs: [{ id: "job-oct", label: "Oct 2026", status: "done" }],
    ...over,
  };
}

async function setup() {
  const store = new FakeAdhocAdvanceStore();
  const managers = new FakeBillingManagerFacts();
  managers.spocs.set(`${CLIENT}|FRC`, [{ userId: "spoc-1", managerUserId: "manager-frc" } as never]);
  managers.keyManagers.set(CLIENT, { userId: "key-manager", displayName: "KM" });
  const taxDefaults = new FakeIssuerTaxDefaults();
  taxDefaults.rates.set(FIRM, "18");
  const events = new RecordingEventSink();
  const svc = new AdhocAdvanceService({
    store,
    invoices: new FakeInvoiceDrafter(),
    taxDefaults,
    managers,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-12-05T06:00:00Z")),
    events,
  });
  const raised = await svc.raise(
    { tenantId: T, partyId: CLIENT, entityPartyId: FIRM, currency: "INR", amount: "50000", callerSeesFees: true },
    me,
  );
  return { store, svc, events, advanceId: raised.advanceId };
}

describe("raising and mapping (the use case)", () => {
  it("raises with the company's default tax rate; refuses a login that does not see fees, and no rate at all", async () => {
    const { store, svc, events } = await setup();
    expect(store.advances[0]).toMatchObject({ net: "50000", status: "draft" });
    expect(events.verbs()).toContain("adhoc_advance.raised");
    await expect(
      svc.raise({ tenantId: T, partyId: CLIENT, entityPartyId: FIRM, currency: "INR", amount: "1", callerSeesFees: false }, me),
    ).rejects.toBeInstanceOf(AdvanceFeesNotVisible);
    await expect(
      svc.raise({ tenantId: T, partyId: CLIENT, entityPartyId: "firm-2", currency: "INR", amount: "1", callerSeesFees: true }, me),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
    await expect(
      svc.raise({ tenantId: T, partyId: CLIENT, entityPartyId: FIRM, currency: "INR", amount: "0", callerSeesFees: true }, me),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
  });

  it("maps only an issued advance, only a reason given, only by a login that sees fees", async () => {
    const { store, svc, advanceId } = await setup();
    store.services.push(service());
    const map = (over: Partial<Parameters<AdhocAdvanceService["map"]>[0]> = {}) =>
      svc.map(
        { tenantId: T, advanceId, targets: [{ engagementId: "eng-books", amount: "10000" }], reason: "Books", callerSeesFees: true, ...over },
        me,
      );
    await expect(map()).rejects.toBeInstanceOf(AdvanceNotIssued);
    store.issue(advanceId);
    await expect(map({ reason: "  " })).rejects.toBeInstanceOf(InvalidBillingInput);
    await expect(map({ callerSeesFees: false })).rejects.toBeInstanceOf(AdvanceFeesNotVisible);
    const out = await map();
    expect(out.unmapped).toBe("40000");
    // Whose revenue: the service's SPOC's manager.
    expect(out.allocations[0]?.manager?.userId).toBe("manager-frc");
  });

  it("refuses another client's, another company's, another currency's or finished work, and a job not of the service", async () => {
    const { store, svc, advanceId } = await setup();
    store.issue(advanceId);
    store.services.push(
      service({ engagementId: "other-client", partyId: "client-2", jobs: [] }),
      service({ engagementId: "gulf", issuerId: "firm-gulf", issuerName: "The Firm FZE", jobs: [] }),
      service({ engagementId: "aed", currency: "AED", jobs: [] }),
      service({ engagementId: "gone", status: "cancelled", jobs: [] }),
      service({ engagementId: "eng-books" }),
    );
    const map = (engagementId: string, jobId?: string) =>
      svc.map({ tenantId: T, advanceId, targets: [{ engagementId, jobId, amount: "100" }], reason: "x", callerSeesFees: true }, me);
    await expect(map("other-client")).rejects.toBeInstanceOf(AdvanceOfAnotherClient);
    await expect(map("gulf")).rejects.toBeInstanceOf(AdvanceOfAnotherIssuer);
    await expect(map("aed")).rejects.toBeInstanceOf(AdvanceInAnotherCurrency);
    await expect(map("gone")).rejects.toBeInstanceOf(AdvanceTargetNotLive);
    await expect(map("eng-books", "someone-elses-job")).rejects.toBeInstanceOf(AdvanceJobNotOfService);
    expect((await map("eng-books", "job-oct")).unmapped).toBe("49900");
    // The dialog's list says why each cannot be picked, in the same words.
    const offered = await svc.targetsFor(T, advanceId);
    expect(offered.find((s) => s.engagementId === "aed")?.refusal).toMatch(/billed in AED/);
    expect(offered.find((s) => s.engagementId === "eng-books")?.refusal).toBeNull();
  });

  it("never maps more than is left, and ends a mapping once", async () => {
    const { store, svc, advanceId } = await setup();
    store.issue(advanceId);
    store.services.push(service(), service({ engagementId: "eng-incorp", deptCode: "TRC", serviceName: "Incorporation" }));
    await expect(
      svc.map(
        {
          tenantId: T,
          advanceId,
          targets: [
            { engagementId: "eng-books", amount: "30000" },
            { engagementId: "eng-incorp", amount: "20000.01" },
          ],
          reason: "x",
          callerSeesFees: true,
        },
        me,
      ),
    ).rejects.toBeInstanceOf(AdvanceOverMapped);
    const out = await svc.map(
      {
        tenantId: T,
        advanceId,
        targets: [
          { engagementId: "eng-books", amount: "30000" },
          { engagementId: "eng-incorp", amount: "20000" },
        ],
        reason: "Split",
        callerSeesFees: true,
      },
      me,
    );
    expect(out.unmapped).toBe("0");
    const books = out.allocations[0];
    if (books === undefined) throw new Error("no allocation");
    store.take(books.id, "12000");
    const ended = await svc.end({ tenantId: T, advanceId, allocationId: books.id, reason: "Move it" }, me);
    expect(ended.unmapped).toBe("18000");
    await expect(svc.end({ tenantId: T, advanceId, allocationId: books.id, reason: "Again" }, me)).rejects.toBeInstanceOf(
      AllocationEnded,
    );
    const incorp = out.allocations[1];
    if (incorp === undefined) throw new Error("no allocation");
    store.take(incorp.id, "20000");
    await expect(svc.end({ tenantId: T, advanceId, allocationId: incorp.id, reason: "Try" }, me)).rejects.toBeInstanceOf(
      AllocationUsedUp,
    );
  });

  it("maps a signed letter's named advance to the letter, at most what is left, and once", async () => {
    const { store, svc, advanceId } = await setup();
    store.issue(advanceId);
    store.letters.set("letter-9", { partyId: CLIENT, issuerId: FIRM, currency: "INR", status: "draft", ref: "EL-2026-0009" });
    await svc.setNamed({ tenantId: T, letterId: "letter-9", advances: [{ adhocAdvanceId: advanceId, amount: "20000" }], callerSeesFees: true });
    await expect(
      svc.setNamed({ tenantId: T, letterId: "letter-9", advances: [{ adhocAdvanceId: advanceId, amount: "50000.01" }], callerSeesFees: true }),
    ).rejects.toBeInstanceOf(AdvanceOverMapped);
    store.letters.set("letter-9", { partyId: CLIENT, issuerId: FIRM, currency: "INR", status: "signed", ref: "EL-2026-0009" });
    expect(await svc.mapNamedOnSigning({ tenantId: T, letterId: "letter-9" }, me)).toEqual({ mapped: 1 });
    expect(await svc.mapNamedOnSigning({ tenantId: T }, me)).toEqual({ mapped: 0 });
    const a = await svc.get(T, advanceId);
    expect(a.unmapped).toBe("30000");
    expect(a.allocations[0]).toMatchObject({ how: "letter_signed", target: { kind: "letter", letterId: "letter-9" } });
    // A sent letter's terms are fixed.
    store.letters.set("letter-10", { partyId: CLIENT, issuerId: FIRM, currency: "INR", status: "sent", ref: "EL-2026-0010" });
    await expect(
      svc.setNamed({ tenantId: T, letterId: "letter-10", advances: [{ adhocAdvanceId: advanceId, amount: "1" }], callerSeesFees: true }),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
  });
});
