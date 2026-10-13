// When a quoted fee is invoiced (0393): chosen with the service, judged by the
// letter's rule (0319), carried to the letter, printed on neither.
import { describe, expect, it } from "vitest";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { InvalidLineBillingTiming } from "../../src/domain/proposal/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const MONTHLY = "00000000-0000-0000-0000-0000000000d1";
const ONE_TIME = "00000000-0000-0000-0000-0000000000d2";

function setup(): ReturnType<typeof makeProposalFakes> & { service: ProposalService } {
  const fakes = makeProposalFakes();
  fakes.catalogue.publishService(MONTHLY, "books", {
    name: "Monthly bookkeeping",
    billingBasis: "fixed",
    recurrence: "monthly",
    listPrice: { amount: "25000.00", currency: "INR" },
  });
  fakes.catalogue.publishService(ONE_TIME, "incorporation", {
    name: "Company incorporation",
    billingBasis: "fixed",
    recurrence: "one_time",
    listPrice: { amount: "40000.00", currency: "INR" },
  });
  return { ...fakes, service: new ProposalService(fakes) };
}

async function draft(s: ReturnType<typeof setup>): Promise<string> {
  const p = await s.service.draft(
    { tenantId: TENANT, partyId: PARTY, title: "Acme", currency: "INR", fxRate: "1", fxRateDate: "2026-10-01" },
    ACTOR,
  );
  return p.id;
}

const line = (proposalId: string, serviceVersionId: string) => ({
  tenantId: TENANT,
  proposalId,
  serviceVersionId,
  description: "x",
  quantity: "1",
  discountPercent: "0",
});

describe("when a quoted fee is invoiced (0393)", () => {
  it("is not chosen until somebody chooses it", async () => {
    const s = setup();
    const added = await s.service.addLine(line(await draft(s), MONTHLY), ACTOR);
    expect(added.billingTiming).toBeNull();
    expect(added.billingOn).toBeNull();
  });

  it("takes the start of the month, or a first invoice date, on a monthly fee", async () => {
    const s = setup();
    const id = await draft(s);
    const start = await s.service.addLine({ ...line(id, MONTHLY), billingTiming: "advance" }, ACTOR);
    expect(start.billingTiming).toBe("advance");
    const dated = await s.service.updateLine(
      { tenantId: TENANT, proposalId: id, lineId: start.id, billingTiming: "on_date", billingOn: "2026-11-05" },
      ACTOR,
    );
    expect(dated).toMatchObject({ billingTiming: "on_date", billingOn: "2026-11-05" });
    const cleared = await s.service.updateLine(
      { tenantId: TENANT, proposalId: id, lineId: start.id, billingTiming: null, billingOn: null },
      ACTOR,
    );
    expect(cleared).toMatchObject({ billingTiming: null, billingOn: null });
  });

  it("refuses a timing for a one-time fee, a date without on_date, and on_date without a date", async () => {
    const s = setup();
    const id = await draft(s);
    await expect(
      s.service.addLine({ ...line(id, ONE_TIME), billingTiming: "advance" }, ACTOR),
    ).rejects.toThrow(InvalidLineBillingTiming);
    await expect(
      s.service.addLine({ ...line(id, MONTHLY), billingTiming: "arrears", billingOn: "2026-11-05" }, ACTOR),
    ).rejects.toThrow(InvalidLineBillingTiming);
    await expect(
      s.service.addLine({ ...line(id, MONTHLY), billingTiming: "on_date" }, ACTOR),
    ).rejects.toThrow(InvalidLineBillingTiming);
  });

  it("drops a kept timing when the line stops being billed per period", async () => {
    const s = setup();
    const id = await draft(s);
    const start = await s.service.addLine({ ...line(id, MONTHLY), billingTiming: "advance" }, ACTOR);
    const once = await s.service.updateLine(
      { tenantId: TENANT, proposalId: id, lineId: start.id, billingFrequency: "one_time" },
      ACTOR,
    );
    expect(once).toMatchObject({ billingFrequency: "one_time", billingTiming: null });
  });

  it("is what the letter reads off the quote", async () => {
    const s = setup();
    const id = await draft(s);
    await s.service.addLine({ ...line(id, MONTHLY), billingTiming: "advance" }, ACTOR);
    const quote = await s.service.findQuote(TENANT, id);
    expect(quote?.lines[0]).toMatchObject({ billingTiming: "advance", billingOn: null });
  });
});
