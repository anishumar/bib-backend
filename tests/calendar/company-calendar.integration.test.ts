// Each of the firm's companies may keep its own time zone and financial year
// (0337, bib/prompts/company-calendar/SPEC.md). What only Postgres can prove:
// the zone is checked against the database's own list by a trigger, the SQL
// that dates a company's documents reads the company's zone else the firm's,
// and a number series remembers the month its year started.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/calendar/company-calendar.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenant = "";
let company = "";
let plainCompany = "";
let bareParty = "";

async function party(tenantId: string, name: string, withEntity: boolean): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!row) throw new Error(`could not create the party ${name}`);
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${row.id}, ${tenantId}, ${name})
  `;
  if (withEntity) {
    await owner`
      INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
      VALUES (${row.id}, ${tenantId}, 'AE', 'FZE')
    `;
  }
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`cal-${stamp}`}, ${`cal-${stamp}`}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("no tenant");
  tenant = t.id;
  company = await party(tenant, "Gulf Company FZE", true);
  plainCompany = await party(tenant, "Plain Company FZE", true);
  bareParty = await party(tenant, "Not Registered Yet", false);
  // All three are the firm's own companies (0313): only those have a series.
  await owner`
    INSERT INTO crm.firm_entity (tenant_id, party_id)
    VALUES (${tenant}, ${company}), (${tenant}, ${plainCompany}), (${tenant}, ${bareParty})
  `;
});

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("a company's own time zone (0337)", () => {
  it("takes a zone the database knows", async () => {
    await owner`UPDATE core.legal_entity SET time_zone = 'Asia/Dubai' WHERE party_id = ${company}`;
    const [row] = await owner<{ time_zone: string | null }[]>`
      SELECT time_zone FROM core.legal_entity WHERE party_id = ${company}
    `;
    expect(row?.time_zone).toBe("Asia/Dubai");
  });

  it("refuses an offset and an invented zone", async () => {
    for (const bad of ["+05:30", "Mars/Olympus"]) {
      await expect(
        owner`UPDATE core.legal_entity SET time_zone = ${bad} WHERE party_id = ${plainCompany}`,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("leaves a company with no zone of its own on the firm's", async () => {
    const [row] = await owner<{ time_zone: string | null }[]>`
      SELECT time_zone FROM core.legal_entity WHERE party_id = ${plainCompany}
    `;
    expect(row?.time_zone).toBeNull();
  });
});

describe("crm.issuer_zone: the zone a company's documents are dated in", () => {
  it("is the company's own", async () => {
    const [row] = await owner<{ zone: string }[]>`SELECT crm.issuer_zone(${tenant}, ${company}) AS zone`;
    expect(row?.zone).toBe("Asia/Dubai");
  });

  it("is the firm's when the company has none, or no registration at all", async () => {
    const [plain] = await owner<{ zone: string }[]>`SELECT crm.issuer_zone(${tenant}, ${plainCompany}) AS zone`;
    const [bare] = await owner<{ zone: string }[]>`SELECT crm.issuer_zone(${tenant}, ${bareParty}) AS zone`;
    expect(plain?.zone).toBe("Asia/Kolkata");
    expect(bare?.zone).toBe("Asia/Kolkata");
  });
});

describe("a number series remembers the month its year started (0337)", () => {
  it("has a start month on every row, April where nobody said", async () => {
    await owner`
      INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix)
      VALUES (${tenant}, ${company}, 2026, 'invoice', 'INV')
    `;
    const [row] = await owner<{ start_month: number }[]>`
      SELECT start_month FROM crm.invoice_series
       WHERE tenant_id = ${tenant} AND entity_party_id = ${company} AND financial_year = 2026
    `;
    expect(row?.start_month).toBe(4);
  });

  it("refuses a month that is not one", async () => {
    await expect(
      owner`
        INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix, start_month)
        VALUES (${tenant}, ${company}, 2027, 'invoice', 'INV', 13)
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
