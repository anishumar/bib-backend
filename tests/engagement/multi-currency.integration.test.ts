// Q006 · a letter and a proposal in two currencies (0344), against real
// Postgres.
//
// What only the database can prove: that the per-currency totals are the old
// arithmetic grouped by currency (the list and the page agree); that a fee in
// a currency with no rate is refused AT COMMIT by the deferred invariant, and a
// rate for the main currency is refused too; that a section moves with its
// services in one statement; that MRR prices each engagement at ITS
// currency's rate; that an engagement bills in its own currency at the
// letter's rate for that currency; and that the PDF prints each fee in its own
// currency, with one total per currency and none of them added together.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/engagement/multi-currency.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { EngagementService } from "../../src/usecase/engagement/service";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresBillingDueDesk } from "../../src/infrastructure/postgres/billing-desk";
import { PostgresBillingDueWriter } from "../../src/infrastructure/postgres/billing-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { FakeFirmSignatory } from "../../src/testfakes/engagement";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { withTenant } from "../../src/db/tenant";
import { composeProposals } from "../proposal/compose-postgres";

const c = composeProposals();
const repository = new PostgresEngagementRepository(c.app);
const letters = new EngagementService({
  letters: repository,
  library: new PostgresConfigRepository(c.app),
  documents: c.documents,
  firm: new FakeFirmSignatory(),
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(c.app),
  quotes: c.proposals,
  structure: new PostgresRelationshipRepository(c.app),
  timeZones: new PostgresFirmTimeZone(c.app),
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  signatures: new PostgresSignatureRequestRepository(c.app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: c.ledger,
});
const render = new PostgresRenderSource(c.app, () => Promise.resolve(null));

const stamp = String(Date.now());
let tenant = "";
let self = "";
let client = "";
let gst = "";
let vat = "";
let scope = "";

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`multi-currency-${stamp}`}, 'Multi Currency Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  self = await c.documentRepository.seedFirmEntity(tenant, "Multi Currency Test Pvt Ltd");
  client = (await c.party.createOrganization({ tenantId: tenant, legalName: "Dune Traders" }, SYSTEM_ACTOR)).partyId;
  await c.documents.addStandardBlock(
    { tenantId: tenant, kind: "cover", body: "Thank you for choosing us.", sortOrder: 1, issuingEntityPartyId: null },
    SYSTEM_ACTOR,
  );
  for (const [kind, key, body] of [
    ["service", "gst", { name: "GST returns", billingBasis: "fixed", recurrence: "monthly" }],
    ["service", "vat", { name: "UAE VAT return", billingBasis: "fixed", recurrence: "monthly" }],
    ["clause", "scope", { title: "Scope", text: "The firm will do the work above.", jurisdictions: [] }],
  ] as const) {
    const defined = await c.config.define({ tenantId: tenant, kind, key, body }, SYSTEM_ACTOR);
    await c.config.publish({ tenantId: tenant, kind, key, version: 1 }, SYSTEM_ACTOR);
    if (key === "gst") gst = defined.draft.id;
    else if (key === "vat") vat = defined.draft.id;
    else scope = defined.draft.id;
  }
});

afterAll(() => c.end());

async function draft(): Promise<string> {
  const letter = await letters.draft(
    {
      tenantId: tenant,
      partyId: client,
      jurisdiction: "IN",
      title: "Engagement Letter for Dune Traders",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-10-01",
      advanceRequired: false,
    },
    SYSTEM_ACTOR,
  );
  return letter.id;
}

const addLine = (letterId: string, serviceVersionId: string, unitAmount: string, currency?: string) =>
  letters.addLine({
    tenantId: tenant,
    letterId,
    entityPartyId: client,
    serviceVersionId,
    description: serviceVersionId === gst ? "GST returns" : "UAE VAT return",
    quantity: "1",
    unitAmount,
    discountPercent: "0",
    ...(currency === undefined ? {} : { currency }),
  });

/** INR 5,000 a month and AED 4,000 a month, the AED rate 22.75. */
async function twoCurrencyLetter(): Promise<string> {
  const id = await draft();
  await letters.setRate(
    { tenantId: tenant, letterId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-10-01" },
    SYSTEM_ACTOR,
  );
  await addLine(id, gst, "5000");
  await addLine(id, vat, "4000", "AED");
  return id;
}

describe("a letter in two currencies, in SQL (0344)", () => {
  it("totals each currency on its own, on the page and in the list alike", async () => {
    const id = await twoCurrencyLetter();
    const view = await letters.describe(tenant, id);
    expect(view.totals.map((t) => [t.currency, t.gross, t.net, t.unpricedLineCount])).toEqual([
      ["INR", "5000.0000", "5000.0000", 0],
      ["AED", "4000.0000", "4000.0000", 0],
    ]);
    expect(view.totalsByFrequency.map((t) => [t.currency, t.frequency, t.net])).toEqual([
      ["INR", "monthly", "5000.0000"],
      ["AED", "monthly", "4000.0000"],
    ]);
    expect(view.letter.rates).toEqual([{ currency: "AED", fxRate: "22.7500000000", fxRateDate: "2026-10-01", source: "typed" }]);
    const listed = (await letters.list(tenant, { partyId: client })).find((s) => s.letter.id === id);
    expect(listed?.totals).toEqual(view.totals);
    expect(await repository.pricesIn(tenant, id, "AED")).toBe(1);
  });

  it("reads an empty letter as one zero row in its main currency, as before", async () => {
    const id = await draft();
    const view = await letters.describe(tenant, id);
    expect(view.totals).toEqual([{ gross: "0", discount: "0", net: "0", currency: "INR", unpricedLineCount: 0 }]);
  });

  it("refuses at commit a fee in a currency with no rate, and a rate for the main currency", async () => {
    const id = await draft();
    // Past the service: the deferred invariant is the last word.
    await expect(
      withTenant(c.app, tenant, (db) => db`
        INSERT INTO crm.engagement_letter_line
          (tenant_id, engagement_letter_id, entity_party_id, service_version_id, description, position,
           quantity, unit_amount, currency, discount_percent)
        VALUES (${tenant}, ${id}, ${client}, ${gst}, 'GST', 1, 1, 100, 'USD', 0)`),
    ).rejects.toThrow(/USD/);
    await expect(
      withTenant(c.app, tenant, (db) => db`
        INSERT INTO crm.engagement_letter_fx_rate (tenant_id, engagement_letter_id, currency, fx_rate, fx_rate_date)
        VALUES (${tenant}, ${id}, 'INR', 1, '2026-10-01')`),
    ).rejects.toThrow(/INR/);
  });

  it("moves a section's fee and its services to another currency in one statement", async () => {
    const id = await draft();
    for (const currency of ["AED", "USD"]) {
      await letters.setRate(
        { tenantId: tenant, letterId: id, currency, fxRate: currency === "AED" ? "22.75" : "84.1", fxRateDate: "2026-10-01" },
        SYSTEM_ACTOR,
      );
    }
    const group = await letters.addFeeGroup(tenant, id, {
      title: "Gulf compliance",
      billingFrequency: "monthly",
      amount: "9000",
      currency: "AED",
    });
    const line = await addLine(id, vat, "1");
    await letters.setLinePricing({ tenantId: tenant, letterId: id, lineId: line.id, feeGroupId: group.id });
    await letters.editFeeGroup(tenant, id, group.id, { currency: "USD" });
    const [moved] = await repository.listLines(tenant, id);
    expect(moved?.currency).toBe("USD");
    const view = await letters.describe(tenant, id);
    // Only USD is priced now, so it is the one row; the main currency has none.
    expect(view.totals.map((t) => [t.currency, t.net])).toEqual([["USD", "9000.0000"]]);
  });

  it("changes the main currency over a pulled line, and takes over the new one's rate", async () => {
    const id = await twoCurrencyLetter();
    const inr = (await repository.listLines(tenant, id)).find((l) => l.currency === "INR");
    await expect(
      letters.revise({ tenantId: tenant, letterId: id, currency: "AED", fxRate: "22.8", fxRateDate: "2026-10-02" }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "CURRENCY_LOCKED_BY_LINES" });
    await letters.removeLine(tenant, id, inr?.id ?? "");
    const moved = await letters.revise(
      { tenantId: tenant, letterId: id, currency: "AED", fxRate: "22.8", fxRateDate: "2026-10-02" },
      SYSTEM_ACTOR,
    );
    expect([moved.currency, moved.fxRate, moved.rates]).toEqual(["AED", "22.8000000000", []]);
  });
});

describe("a signed letter in two currencies", () => {
  async function signed(): Promise<string> {
    const id = await twoCurrencyLetter();
    await letters.addClause(tenant, id, scope);
    await letters.send(tenant, id, SYSTEM_ACTOR);
    await letters.sign({ tenantId: tenant, letterId: id, signedByName: "Rania Haddad", reference: `mc-${id}` }, SYSTEM_ACTOR);
    return id;
  }

  it("prices each engagement's MRR at its own currency's rate", async () => {
    const id = await signed();
    const rows = await c.owner<{ currency: string; monthly_amount: string; monthly_reporting: string; fx_rate: string }[]>`
      SELECT m.currency, m.monthly_amount::text, m.monthly_reporting::text, m.fx_rate::text
        FROM crm.engagement_mrr m
        JOIN crm.engagement e ON e.id = m.engagement_id
       WHERE e.engagement_letter_id = ${id}
       ORDER BY m.currency
    `;
    expect(rows).toEqual([
      { currency: "AED", monthly_amount: "4000.0000", monthly_reporting: "91000.0000", fx_rate: "22.7500000000" },
      { currency: "INR", monthly_amount: "5000.0000", monthly_reporting: "5000.0000", fx_rate: "1.0000000000" },
    ]);
  });

  it("freezes its rates with the rest of the letter", async () => {
    const id = await signed();
    await expect(
      c.owner`UPDATE crm.engagement_letter_fx_rate SET fx_rate = 1 WHERE engagement_letter_id = ${id}`,
    ).rejects.toThrow(/signed/);
  });

  it("bills each engagement in its own currency, at the letter's rate for that currency", async () => {
    const id = await signed();
    const engagements = await letters.listEngagements(tenant, id);
    const invoices = new PostgresInvoiceRepository(c.app);
    const currencies = await Promise.all(
      engagements.map(async (e) => (await invoices.engagementOf(tenant, e.engagement.id))?.currency),
    );
    expect(currencies.sort()).toEqual(["AED", "INR"]);

    const aedEngagement = engagements.find((_, i) => currencies[i] === "AED")?.engagement;
    const dueId = systemIds.newId();
    await new PostgresBillingDueWriter(c.app).insert(tenant, [
      {
        id: dueId,
        partyId: client,
        issuingEntityPartyId: self,
        currency: "AED",
        engagementId: aedEngagement?.id ?? null,
        feeGroupId: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        periodLabel: "Oct 2026",
        billOn: "2026-11-01",
        fullAmount: "4000",
        servedDays: 31,
        periodDays: 31,
        managerUserId: null,
        managerHow: "none",
        managerNote: "No SPOC on this test client.",
      },
    ]);
    const [due] = await new PostgresBillingDueDesk(c.app).findMany(tenant, [dueId]);
    expect([due?.currency, due?.letter.fxRate, due?.letter.fxRateDate]).toEqual(["AED", "22.7500000000", "2026-10-01"]);
  });
});

describe("the PDF of a letter in two currencies", () => {
  it("prints each fee in its own currency and one total per currency, never a sum of both", async () => {
    const id = await twoCurrencyLetter();
    const drawn = await render.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: id });
    const flow = drawn?.document.annexureLetter?.annexures[0]?.flow ?? [];
    const table = flow.find((f) => f.kind === "table");
    const fees = table?.kind === "table" ? table.table.rows.map((r) => r[3]) : [];
    expect(fees.some((f) => f?.startsWith("₹"))).toBe(true);
    expect(fees.some((f) => f?.startsWith("AED"))).toBe(true);
    const total = flow.find((f) => f.kind === "paragraph" && f.lead === "Total");
    expect(total?.kind === "paragraph" ? total.text : "").toMatch(/^₹5,000(\.00)? per month \+ AED 4,000(\.00)? per month$/);
  });

  it("prints no total on a letter in one currency, as it never did", async () => {
    const id = await draft();
    await addLine(id, gst, "5000");
    const drawn = await render.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: id });
    const flow = drawn?.document.annexureLetter?.annexures[0]?.flow ?? [];
    expect(flow.some((f) => f.kind === "paragraph" && f.lead === "Total")).toBe(false);
  });
});

describe("a proposal in two currencies, in SQL (0344)", () => {
  it("totals, values and prints each currency on its own", async () => {
    const p = await c.proposals.draft(
      { tenantId: tenant, partyId: client, title: "FY27", currency: "INR", fxRate: "1", fxRateDate: "2026-10-01" },
      SYSTEM_ACTOR,
    );
    await c.proposals.setRate(
      { tenantId: tenant, proposalId: p.id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-10-01" },
      SYSTEM_ACTOR,
    );
    for (const [serviceVersionId, unitAmount, currency] of [
      [gst, "5000", undefined],
      [vat, "4000", "AED"],
    ] as const) {
      await c.proposals.addLine(
        {
          tenantId: tenant,
          proposalId: p.id,
          serviceVersionId,
          description: "Service",
          quantity: "1",
          unitAmount,
          discountPercent: "0",
          ...(currency === undefined ? {} : { currency }),
        },
        SYSTEM_ACTOR,
      );
    }
    const view = await c.proposals.describe(tenant, p.id);
    expect(view.totals.map((t) => [t.currency, t.net])).toEqual([
      ["INR", "5000.0000"],
      ["AED", "4000.0000"],
    ]);
    expect(view.annualValue).toEqual([
      { amount: "60000.0000", currency: "INR" },
      { amount: "48000.0000", currency: "AED" },
    ]);
    const drawn = await render.describe({ tenantId: tenant, kind: "proposal", subjectRef: p.id });
    const total = drawn?.document.proposal?.flow.find((f) => f.kind === "paragraph" && f.lead === "Total");
    expect(total?.kind === "paragraph" ? total.text : "").toBe("₹5,000 Monthly + AED 4,000 Monthly");
  });
});
