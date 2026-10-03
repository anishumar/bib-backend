// T3.5's acceptance, the half the task line actually names:
//
//   "worker climbs the ladder; TERMINAL NEEDS PARTNER APPROVAL."
//
// Both halves are here. The sweep's arithmetic and its idempotency are rules
// and are tested against fakes; the row lock under a concurrent approval is a
// property of Postgres and lives in dunning.integration.test.ts.
import { describe, expect, it } from "vitest";
import { DunningService } from "../../src/usecase/dunning/service";
import { FakeDunningLadder, FakeDunningRepo } from "../../src/testfakes/dunning";
import { FakeTenantDirectory } from "../../src/testfakes/scheduler";
import { FakeFirmEntities, FakeInvoiceFirmSettings, FakeInvoiceRepo, FakeIssuedCopies } from "../../src/testfakes/invoice";
import { FakePartyStanding } from "../../src/testfakes/party";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import {
  DunningAlreadyDecided,
  DunningNotAwaitingApproval,
} from "../../src/domain/invoice/errors";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CLIENT = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000f1";
const PARTNER = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

/** The ladder the task names: D+3 a reminder, D+7 a call, D+15 the terminal
 *  rung a machine may reach and may not apply. */
const LADDER = {
  steps: [
    { key: "d3", afterDays: 3, action: "reminder" as const, label: "First reminder" },
    { key: "d7", afterDays: 7, action: "call" as const, label: "Call the client" },
    { key: "d15", afterDays: 15, action: "credit_hold" as const, label: "Credit hold" },
  ],
};

/** The clock is fixed; the DUE DATE is what moves. Days overdue is then a
 *  calendar fact rather than something a test has to wait for. */
const TODAY = new Date("2026-07-20T09:00:00Z");

function setup(): {
  service: DunningService;
  dunning: FakeDunningRepo;
  ladders: FakeDunningLadder;
  invoices: FakeInvoiceRepo;
  billing: InvoiceService;
  events: RecordingEventSink;
  clock: FakeClock;
} {
  const dunning = new FakeDunningRepo();
  const ladders = new FakeDunningLadder();
  const invoices = new FakeInvoiceRepo();
  const events = new RecordingEventSink();
  const clock = new FakeClock(TODAY);
  const billing = new InvoiceService({
    invoices,
    timeZones: new FakeFirmTimeZone(),
    firmEntities: new FakeFirmEntities().add(ENTITY),
    parties: new FakePartyStanding(),
    ids: new FakeIds(),
    clock,
    events,
    issuedCopies: new FakeIssuedCopies(),
    staff: new FakeStaffDirectory(),
    settings: new FakeInvoiceFirmSettings(),
  });
  const service = new DunningService({
    timeZones: new FakeFirmTimeZone(),
    dunning,
    ladders,
    invoices,
    tenants: new FakeTenantDirectory([TENANT]),
    ids: new FakeIds(),
    clock,
    events,
  });
  return { service, dunning, ladders, invoices, billing, events, clock };
}

/** An issued invoice for 10,000 that fell due on `dueOn`: issued ON its due
 *  day (an invoice is not issued already overdue, B21), then the clock is
 *  back at today. */
async function overdueInvoice(s: ReturnType<typeof setup>, dueOn: string): Promise<string> {
  const today = s.clock.now();
  s.clock.set(`${dueOn}T06:00:00Z`);
  const invoice = await s.billing.raise(
    {
      tenantId: TENANT,
      partyId: CLIENT,
      entityPartyId: ENTITY,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      dueOn,
    },
    SYSTEM_ACTOR,
  );
  await s.billing.addLine({
    tenantId: TENANT,
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: "1",
    unitAmount: "10000",
  });
  await s.billing.issue(TENANT, invoice.id, SYSTEM_ACTOR);
  s.clock.set(today);
  return invoice.id;
}

describe("the worker climbs the ladder", () => {
  it("takes every rung that is due, not just the next one", async () => {
    // A firm whose worker was down for a week should not need seven sweeps to
    // catch up. Due 30 June, today 20 July: 20 days overdue, so all three.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    const id = await overdueInvoice(s, "2026-06-30");

    const [report] = await s.service.sweep();
    expect(report?.escalated).toBe(3);
    expect((await s.service.listFor(TENANT, id)).map((a) => a.step)).toEqual(["d3", "d7", "d15"]);
  });

  it("takes only the rungs the calendar has actually reached", async () => {
    // Due 15 July, today 20 July: five days. D+3 fires, D+7 does not — and
    // getting this off by one sends a client a chaser they will argue about.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-07-15");
    const [report] = await s.service.sweep();
    expect(report?.escalated).toBe(1);
    expect(s.dunning.rows.map((r) => r.step)).toEqual(["d3"]);
  });

  it("fires a rung on its exact day and not the day before", async () => {
    // The boundary. `afterDays: 3` means three days overdue, inclusive.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-07-18"); // two days — nothing yet
    expect((await s.service.sweep())[0]?.escalated).toBe(0);

    const s2 = setup();
    s2.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s2, "2026-07-17"); // exactly three
    expect((await s2.service.sweep())[0]?.escalated).toBe(1);
  });

  it("leaves an invoice that is not yet due alone", async () => {
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-08-31");
    expect((await s.service.sweep())[0]?.escalated).toBe(0);
  });

  it("never chases an invoice with no due date", async () => {
    // A firm that raised an invoice without one has not told anybody when to
    // pay, and chasing on that basis would be the product deciding a payment
    // term nobody agreed.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    const invoice = await s.billing.raise(
      { tenantId: TENANT, partyId: CLIENT, entityPartyId: ENTITY, currency: "INR", fxRate: "1", fxRateDate: "2026-06-01" },
      SYSTEM_ACTOR,
    );
    await s.billing.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Advisory",
      quantity: "1",
      unitAmount: "10000",
    });
    await s.billing.issue(TENANT, invoice.id, SYSTEM_ACTOR);
    expect((await s.service.sweep())[0]?.escalated).toBe(0);
  });

  it("stops chasing the moment the invoice is settled", async () => {
    // It falls out of `outstanding()`, which is the one query the two use cases
    // share — so paying is the whole mechanism, not a flag somebody must
    // remember to clear.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    const id = await overdueInvoice(s, "2026-07-15");
    await s.billing.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10000", receivedOn: "2026-07-16", method: "upi" },
      PARTNER,
    );
    expect((await s.service.sweep())[0]?.escalated).toBe(0);
  });

  it("chases nobody at a firm that has published no ladder", async () => {
    // The state every firm is in until a partner writes one, and the safe
    // direction: the alternative is this product inventing an escalation policy
    // and sending a client a letter the firm never approved.
    const s = setup();
    await overdueInvoice(s, "2026-06-30");
    const [report] = await s.service.sweep();
    expect(report?.escalated).toBe(0);
  });
});

describe("running the sweep twice does not chase a client twice", () => {
  it("does no work on the second pass, and writes no second event", async () => {
    // AT-LEAST-ONCE is the whole design: the sweep re-reads invoices it has
    // seen, pg-boss redelivers on a crash, a restart leaves a message
    // unacknowledged. A second reminder to somebody who has already paid is the
    // kind of mistake a firm hears about.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");

    const first = await s.service.sweep();
    const second = await s.service.sweep();
    expect(first[0]?.escalated).toBe(3);
    expect(second[0]?.escalated).toBe(0);
    // `alreadyTaken` is ZERO here, not three, and the distinction is the point:
    // `dueDunningSteps` filters out rungs this invoice has had, so an ordinary
    // second sweep never reaches the insert. That counter records the GENUINE
    // race — two workers, or a redelivery overlapping the run it duplicates —
    // which is the only case where the pre-filter is too late.
    expect(second[0]?.alreadyTaken).toBe(0);

    // The number that matters: three rows, three events, however many sweeps.
    expect(s.dunning.rows).toHaveLength(3);
    expect(s.events.recorded.filter((e) => e.verb === "dunning.escalated")).toHaveLength(3);
  });

  it("refuses the rung when two sweeps genuinely overlap", async () => {
    // The unique key, in the case the pre-filter cannot cover: both passes read
    // `taken()` before either wrote. Exactly one row, exactly one event.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-07-15"); // one rung due

    const [a, b] = await Promise.all([s.service.sweepTenant(TENANT), s.service.sweepTenant(TENANT)]);
    expect((a?.escalated ?? 0) + (b?.escalated ?? 0)).toBe(1);
    expect((a?.alreadyTaken ?? 0) + (b?.alreadyTaken ?? 0)).toBe(1);
    expect(s.dunning.rows).toHaveLength(1);
    expect(s.events.recorded.filter((e) => e.verb === "dunning.escalated")).toHaveLength(1);
  });
});

describe("the terminal rung needs a partner — the acceptance", () => {
  it("is reached by the worker and NOT applied", async () => {
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    const [report] = await s.service.sweep();

    expect(report?.awaitingApproval).toBe(1);
    const pending = await s.service.pending(TENANT);
    expect(pending.map((a) => a.action.action)).toEqual(["credit_hold"]);
    expect(pending[0]?.action.state).toBe("pending_approval");
    // The rungs a machine MAY climb went through unattended, which is the other
    // half of the same sentence.
    const taken = (await s.service.listFor(TENANT, pending[0]?.action.invoiceId ?? "")).filter(
      (a) => a.state === "taken",
    );
    expect(taken.map((a) => a.step)).toEqual(["d3", "d7"]);
  });

  it("is applied only when a partner approves it", async () => {
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const [pending] = await s.service.pending(TENANT);
    if (pending === undefined) throw new Error("nothing pending");

    const decided = await s.service.decide(
      { tenantId: TENANT, actionId: pending.action.id, approve: true, note: "Third quarter, no contact" },
      PARTNER,
    );
    expect(decided.state).toBe("approved");
    expect(decided.approvedBy).toBe(PARTNER.id);
    expect(decided.decidedAt).not.toBeNull();
    expect(await s.service.pending(TENANT)).toHaveLength(0);
  });

  it("records a REJECTION just as loudly", async () => {
    // "We considered legal action and decided against it" is a fact somebody
    // wants three months later, and a rejection that vanished would leave the
    // ladder looking as though it never got there.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const [pending] = await s.service.pending(TENANT);
    if (pending === undefined) throw new Error("nothing pending");

    const decided = await s.service.decide(
      { tenantId: TENANT, actionId: pending.action.id, approve: false, note: "Client is disputing scope" },
      PARTNER,
    );
    expect(decided.state).toBe("rejected");
    const event = s.events.recorded.find((e) => e.verb === "dunning.decided");
    expect(event?.payload).toMatchObject({ decision: "rejected", action: "credit_hold" });
  });

  it("refuses a machine as the decider", async () => {
    // The whole point of the rung. A `system` actor reaching the decision would
    // mean the gate had been routed around.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const [pending] = await s.service.pending(TENANT);
    if (pending === undefined) throw new Error("nothing pending");
    await expect(
      s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: true }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(DunningNotAwaitingApproval);
  });

  it("refuses to decide a rung that was never gated", async () => {
    // A reminder waiting for a partner would be a ladder that never climbs.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const reminder = s.dunning.rows.find((r) => r.step === "d3");
    if (reminder === undefined) throw new Error("no reminder");
    await expect(
      s.service.decide({ tenantId: TENANT, actionId: reminder.id, approve: true }, PARTNER),
    ).rejects.toBeInstanceOf(DunningNotAwaitingApproval);
  });

  it("refuses to reverse a decision", async () => {
    // A decision about a client is final: reversing "we put them on credit
    // hold" by editing the row would leave no trace it ever happened, and the
    // ladder's whole value is that it records what the firm did.
    const s = setup();
    s.ladders.ladders.set(TENANT, LADDER);
    await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const [pending] = await s.service.pending(TENANT);
    if (pending === undefined) throw new Error("nothing pending");
    await s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: true }, PARTNER);
    await expect(
      s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: false }, PARTNER),
    ).rejects.toBeInstanceOf(DunningAlreadyDecided);
  });
});

describe("a credit hold over nothing owed (B22, audit 2026-10-03)", () => {
  // The queue read a CANCELLED invoice's full total as outstanding, and a
  // partner could approve a credit hold over a withdrawn bill.
  async function pendingHold(s: ReturnType<typeof setup>) {
    s.ladders.ladders.set(TENANT, LADDER);
    const id = await overdueInvoice(s, "2026-06-30");
    await s.service.sweep();
    const [pending] = await s.service.pending(TENANT);
    if (pending === undefined) throw new Error("nothing pending");
    return { id, pending };
  }

  it("refuses to approve a hold once the invoice was cancelled, and still lets it be rejected", async () => {
    const s = setup();
    const { id, pending } = await pendingHold(s);
    await s.billing.cancel(TENANT, id, PARTNER);

    await expect(
      s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: true }, PARTNER),
    ).rejects.toMatchObject({ code: "DUNNING_NOTHING_OWED" });
    const rejected = await s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: false }, PARTNER);
    expect(rejected.state).toBe("rejected");
  });

  it("refuses to approve a hold once the invoice is paid in full", async () => {
    const s = setup();
    const { id, pending } = await pendingHold(s);
    await s.billing.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10000", receivedOn: "2026-07-19", method: "upi" },
      PARTNER,
    );
    await expect(
      s.service.decide({ tenantId: TENANT, actionId: pending.action.id, approve: true }, PARTNER),
    ).rejects.toMatchObject({ code: "DUNNING_NOTHING_OWED" });
  });
});
