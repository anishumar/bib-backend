// An invoice is dated and numbered on its COMPANY's calendar (0337): the
// company's own time zone and financial year, else the firm's. The research
// (bib/reports/Per company fiscal year and timezone.md): a document date is a
// plain date in the issuing entity's zone, and a series' year is picked from
// the invoice's own date in that entity's calendar.
import { describe, expect, it } from "vitest";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import { NotCallersToday } from "../../src/domain/invoice/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CLIENT = "00000000-0000-0000-0000-0000000000bb";
const IN_CO = "00000000-0000-0000-0000-0000000000f1";
const US_CO = "00000000-0000-0000-0000-0000000000f2";
const AE_CO = "00000000-0000-0000-0000-0000000000f3";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

/** A firm on India's clock and an April year; its US company on New York's
 *  clock; its UAE company on Dubai's clock and a calendar year. */
function setup(at: string) {
  const fakes = makeInvoiceFakes();
  fakes.clock.set(at);
  fakes.timeZones.set("Asia/Kolkata");
  fakes.timeZones.setCompany(US_CO, { timeZone: "America/New_York" });
  fakes.timeZones.setCompany(AE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
  fakes.settings.fiscalYearStartMonth = 4;
  fakes.firmEntities.add(IN_CO, US_CO, AE_CO);
  fakes.invoices.partyNames.set(CLIENT, "Meridian Textiles Private Limited");
  return { ...fakes, service: new InvoiceService(fakes) };
}

async function drafted(s: ReturnType<typeof setup>, entityPartyId: string) {
  const invoice = await s.service.raise(
    { tenantId: TENANT, partyId: CLIENT, entityPartyId, currency: "INR", fxRate: "1" },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: "1",
    unitAmount: "1000",
  });
  return invoice;
}

describe("the date on an invoice is its company's day (0337)", () => {
  // 19:30 UTC on 31 October: 01:00 on 1 November in India, 15:30 on
  // 31 October in New York.
  const AT = "2026-10-31T19:30:00Z";

  it("dates the US company's invoice on New York's day", async () => {
    const s = setup(AT);
    const draft = await drafted(s, US_CO);
    const issued = await s.service.issue(TENANT, draft.id, ACTOR);
    expect(issued.issuedOn).toBe("2026-10-31");
  });

  it("dates the Indian company's invoice, at the same instant, on India's day", async () => {
    const s = setup(AT);
    const draft = await drafted(s, IN_CO);
    const issued = await s.service.issue(TENANT, draft.id, ACTOR);
    expect(issued.issuedOn).toBe("2026-11-01");
  });

  it("still lets a caller say its own day, held to the company's day or one either side", async () => {
    const s = setup(AT);
    const one = await drafted(s, US_CO);
    expect((await s.service.issue(TENANT, one.id, ACTOR, "2026-11-01")).issuedOn).toBe("2026-11-01");
    const two = await drafted(s, US_CO);
    await expect(s.service.issue(TENANT, two.id, ACTOR, "2026-11-02")).rejects.toBeInstanceOf(NotCallersToday);
  });

  it("tells the screen the day Issue would date a draft, and nothing once it is issued", async () => {
    const s = setup(AT);
    const us = await drafted(s, US_CO);
    const ind = await drafted(s, IN_CO);
    expect((await s.service.describe(TENANT, us.id)).issuesOn).toBe("2026-10-31");
    expect((await s.service.describe(TENANT, ind.id)).issuesOn).toBe("2026-11-01");
    await s.service.issue(TENANT, us.id, ACTOR);
    expect((await s.service.describe(TENANT, us.id)).issuesOn).toBeNull();
  });
});

describe("an invoice's number is in its company's own year (0337)", () => {
  // 2 January 2027: the UAE company's year 2027 has begun; the Indian
  // company is still in 2026-27.
  const AT = "2027-01-02T06:00:00Z";

  it("numbers the UAE company's invoice in its calendar year", async () => {
    const s = setup(AT);
    const draft = await drafted(s, AE_CO);
    const issued = await s.service.issue(TENANT, draft.id, ACTOR);
    expect(issued.financialYear).toBe(2027);
    expect(issued.number).toBe("INV/2027/0001");
  });

  it("numbers the Indian company's invoice in its April year", async () => {
    const s = setup(AT);
    const draft = await drafted(s, IN_CO);
    const issued = await s.service.issue(TENANT, draft.id, ACTOR);
    expect(issued.financialYear).toBe(2026);
    expect(issued.number).toBe("INV/2026-27/0001");
  });

  it("puts a draft in its company's provisional year", async () => {
    const s = setup(AT);
    const ae = await drafted(s, AE_CO);
    const inr = await drafted(s, IN_CO);
    expect(ae.financialYear).toBe(2027);
    expect(inr.financialYear).toBe(2026);
  });
});

// FINAL REVIEW #1: moving a company's year start LATER must never reopen the
// series that closed before it. Numbers are frozen and gapless, so a wrong
// series cannot be undone: the series in progress carries on (a transition
// period) until the company's own year has caught up with it.
describe("a later year start never reopens a closed series (0337)", () => {
  async function issueAt(s: ReturnType<typeof setup>, at: string, entityPartyId: string) {
    s.clock.set(at);
    return s.service.issue(TENANT, (await drafted(s, entityPartyId)).id, ACTOR);
  }

  it("January to April: carries on the calendar-year series, then starts the new year's", async () => {
    const s = setup("2027-01-10T06:00:00Z");
    expect((await issueAt(s, "2027-01-10T06:00:00Z", AE_CO)).number).toBe("INV/2027/0001");
    s.timeZones.setCompany(AE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 4 });
    // 22 February is in April's 2026-27, whose series closed long ago: not reopened.
    expect((await issueAt(s, "2027-02-22T06:00:00Z", AE_CO)).number).toBe("INV/2027/0002");
    expect((await issueAt(s, "2028-04-03T06:00:00Z", AE_CO)).number).toBe("INV/2028-29/0001");
  });

  it("April to July: carries on 2026-27 rather than reopening 2025-26", async () => {
    const s = setup("2026-05-10T06:00:00Z");
    expect((await issueAt(s, "2026-05-10T06:00:00Z", US_CO)).number).toBe("INV/2026-27/0001");
    s.timeZones.setCompany(US_CO, { timeZone: "America/New_York", fiscalYearStartMonth: 7 });
    expect((await issueAt(s, "2026-05-20T06:00:00Z", US_CO)).number).toBe("INV/2026-27/0002");
  });

  it("a credit note keeps to the same rule", async () => {
    const s = setup("2027-01-10T06:00:00Z");
    const first = await issueAt(s, "2027-01-10T06:00:00Z", AE_CO);
    const one = await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: first.id, amount: "100", reason: "goodwill" },
      ACTOR,
    );
    expect(one.number).toBe("CN/2027/0001");
    s.timeZones.setCompany(AE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 4 });
    s.clock.set("2027-02-22T06:00:00Z");
    const two = await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: first.id, amount: "100", reason: "goodwill" },
      ACTOR,
    );
    expect(two.number).toBe("CN/2027/0002");
  });
});
