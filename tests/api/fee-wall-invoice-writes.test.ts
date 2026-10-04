// B27 (audit 2026-10-03): logins that cannot see money could write it. Gate 3
// let any party:write login add an invoice line at any price, raise a manual
// invoice, or record a -50,000 "payment" that re-opens a balance, while the
// billing desk already refused the same person a changed price
// (PRICE_NOT_VISIBLE).
//
// Every route that WRITES an amount on an invoice now refuses a login that
// cannot see fees, before the use case is asked: raising one by hand, adding
// or removing a line, recording a payment, issuing a credit note and giving an
// advance back. For a login that sees fees the gate is not there (the use case
// answers, here 404 for an invoice the fake does not hold).
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerInvoiceRoutes } from "../../src/api/handler/invoice";
import { registerBillingRoutes } from "../../src/api/handler/billing";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { DunningService } from "../../src/usecase/dunning/service";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { WorkBillingService } from "../../src/usecase/billing/work-vs-billing";
import { AdvanceDesk } from "../../src/usecase/billing/advance";
import { FinalBiller } from "../../src/usecase/billing/final";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
import { FakeFirmEntities, makeInvoiceFakes, makeCompanyInvoicing } from "../../src/testfakes/invoice";
import { FakeDunningLadder, FakeDunningRepo } from "../../src/testfakes/dunning";
import { FakeTenantDirectory } from "../../src/testfakes/scheduler";
import {
  FakeAdvancePolicy,
  FakeAdvanceReminderFacts,
  FakeAutoBillingFirms,
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeBillingSchedules,
  FakeFinalBillFacts,
  FakeFiscalYearSource,
  FakeWorkBillingFacts,
  FakeInvoiceDrafter,
  FakeIssuerTaxDefaults,
} from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const TENANT = "00000000-0000-4000-8000-0000000006a1";
const USER = "00000000-0000-4000-8000-0000000006a2";
const INVOICE = "00000000-0000-4000-8000-0000000006a3";
const PARTY = "00000000-0000-4000-8000-0000000006a4";
const LINE = "00000000-0000-4000-8000-0000000006a6";

function world() {
  const authz = new AuthzService({ permissions: withDefaultRoles(TENANT) });
  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  const as = { fees: true };
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000006a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerInvoiceRoutes(app, {
    authz,
    service: new InvoiceService(makeInvoiceFakes()),
    companies: makeCompanyInvoicing(),
    dunning: new DunningService({
      timeZones: new FakeFirmTimeZone(),
      dunning: new FakeDunningRepo(),
      ladders: new FakeDunningLadder(),
      invoices: makeInvoiceFakes().invoices,
      tenants: new FakeTenantDirectory(),
      ids: new FakeIds(),
      clock: new FakeClock(new Date("2026-10-03T09:00:00Z")),
      events: new RecordingEventSink(),
    }),
  });
  registerBillingRoutes(app, {
    authz,
    service: new BillingDeskService({
      desk: new FakeBillingDueDesk(),
      invoices: new FakeInvoiceDrafter(),
      schedules: new FakeBillingSchedules(),
      setting: new FakeAutoBillingSetting(),
      fiscalYears: new FakeFiscalYearSource(),
      timeZones: new FakeFirmTimeZone(),
      clock: new FakeClock(),
      events: new RecordingEventSink(),
      taxDefaults: new FakeIssuerTaxDefaults(),
      policy: new FakeAdvancePolicy(),
      firmEntities: new FakeFirmEntities(),
    }),
    advances: new AdvanceDesk({
      desk: new FakeBillingDueDesk(),
      policy: new FakeAdvancePolicy(),
      people: new FakeAdvanceReminderFacts(),
      taxDefaults: new FakeIssuerTaxDefaults(),
      timeZones: new FakeFirmTimeZone(),
      clock: new FakeClock(),
    }),
    workBilling: new WorkBillingService({
      facts: new FakeWorkBillingFacts(),
      fiscalYears: new FakeFiscalYearSource(),
      timeZones: new FakeFirmTimeZone(),
      clock: new FakeClock(),
    }),
    finals: new FinalBiller({
      facts: new FakeFinalBillFacts(),
      dues: new FakeBillingDueWriter(),
      managers: new FakeBillingManagerFacts(),
      setting: new FakeAutoBillingSetting(),
      firms: new FakeAutoBillingFirms(),
      timeZones: new FakeFirmTimeZone(),
      clock: new FakeClock(),
      ids: new FakeIds(),
      events: new RecordingEventSink(),
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
  };
  return { as, call };
}

const WRITES: { what: string; method: string; path: string; body?: unknown; sentence: string }[] = [
  {
    what: "raising an invoice by hand",
    method: "POST",
    path: "/api/v1/invoices",
    body: { partyId: PARTY, entityPartyId: PARTY, currency: "INR", fxRate: "1", fxRateDate: "2026-10-03" },
    sentence: "raise an invoice by hand",
  },
  {
    what: "adding a line",
    method: "POST",
    path: `/api/v1/invoices/${INVOICE}/lines`,
    body: { description: "Bookkeeping", quantity: "1", unitAmount: "25000" },
    sentence: "change the lines on an invoice",
  },
  {
    what: "removing a line",
    method: "DELETE",
    path: `/api/v1/invoices/${INVOICE}/lines/${LINE}`,
    sentence: "change the lines on an invoice",
  },
  {
    what: "recording a payment",
    method: "POST",
    path: `/api/v1/invoices/${INVOICE}/payments`,
    body: { amount: "-50000", receivedOn: "2026-10-03", method: "bank_transfer" },
    sentence: "record a payment",
  },
  {
    what: "issuing a credit note",
    method: "POST",
    path: `/api/v1/invoices/${INVOICE}/credit-notes`,
    body: { amount: "1000", reason: "goodwill" },
    sentence: "issue a credit note",
  },
  {
    what: "giving an advance back",
    method: "POST",
    path: `/api/v1/billing/refunds/${INVOICE}/credit-note`,
    sentence: "give an advance back",
  },
];

describe("writing money on an invoice, for a login that cannot see fees", () => {
  for (const w of WRITES) {
    it(`refuses ${w.what} in plain words`, async () => {
      const world_ = world();
      world_.as.fees = false;
      const r = await world_.call(w.method, w.path, w.body);
      expect(r.status).toBe(403);
      expect(r.json["error"]).toMatchObject({
        code: "FORBIDDEN",
        reason: "FEES_NOT_VISIBLE",
        message: `Your login is not set to see fees, so it cannot ${w.sentence}. Ask somebody who can see fees.`,
      });
    });

    it(`does not stand in the way of ${w.what} for a login that sees fees`, async () => {
      const world_ = world();
      const r = await world_.call(w.method, w.path, w.body);
      expect((r.json["error"] as { reason?: string } | undefined)?.reason).not.toBe("FEES_NOT_VISIBLE");
    });
  }
});
