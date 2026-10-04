// A company's bank accounts and LUTs, in Postgres (Q056, S5, 0369).
//
// Both tables are written once: a correction RETIRES the live row and inserts
// another, in one transaction, so an issued invoice that points at the old row
// still prints what it printed. The partial unique indexes (one live account
// per currency, one live LUT per year) are what make "retire, then insert" the
// only way to replace one.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { toDayOrNull } from "./day";
import type {
  CompanyInvoicing,
  CompanyInvoicingRepository,
  NewBankAccount,
} from "../../usecase/invoice/company";

interface BankRow {
  id: string;
  entity_party_id: string;
  account_name: string;
  account_number: string;
  bank_name: string;
  branch: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  currency: string | null;
}

export class PostgresCompanyInvoicingRepository implements CompanyInvoicingRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly CompanyInvoicing[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The firm's live companies (0313's membership), each with its GSTIN in
      // force today on the firm's calendar.
      const companies = await db<{ party_id: string; name: string; country: string | null; gstin: string | null }[]>`
        SELECT p.id AS party_id, p.display_name AS name, le.jurisdiction AS country,
               (SELECT i.value::text FROM core.party_identifier i
                 WHERE i.party_id = p.id AND i.type = 'gstin' AND i.voided_at IS NULL
                   AND i.valid_from <= (now() AT TIME ZONE crm.issuer_zone(p.tenant_id, p.id))::date
                   AND (i.valid_to IS NULL OR i.valid_to >= (now() AT TIME ZONE crm.issuer_zone(p.tenant_id, p.id))::date)
                 ORDER BY i.is_primary DESC, i.valid_from DESC, i.created_at DESC LIMIT 1) AS gstin
          FROM core.party p
          JOIN core.organization o ON o.party_id = p.id AND o.tenant_id = p.tenant_id
          LEFT JOIN core.legal_entity le ON le.party_id = p.id AND le.tenant_id = p.tenant_id
         WHERE p.archived_at IS NULL
           AND (o.is_firm_self
                OR EXISTS (SELECT 1 FROM crm.firm_entity m
                            WHERE m.party_id = p.id AND m.tenant_id = p.tenant_id AND m.retired_at IS NULL))
         ORDER BY o.is_firm_self DESC, p.display_name
      `;
      const banks = await db<BankRow[]>`
        SELECT id, entity_party_id, account_name, account_number, bank_name, branch, ifsc, swift, iban, currency
          FROM crm.firm_entity_bank_account
         WHERE retired_at IS NULL
         ORDER BY currency NULLS FIRST, created_at
      `;
      const luts = await db<{ id: string; entity_party_id: string; financial_year: number; reference: string; filed_on: Date | null }[]>`
        SELECT id, entity_party_id, financial_year, reference, filed_on
          FROM crm.firm_entity_lut
         WHERE retired_at IS NULL
         ORDER BY financial_year DESC
      `;
      return companies.map((c) => ({
        entityPartyId: c.party_id,
        name: c.name,
        country: c.country,
        gstin: c.gstin,
        bankAccounts: banks
          .filter((b) => b.entity_party_id === c.party_id)
          .map((b) => ({
            id: b.id,
            accountName: b.account_name,
            accountNumber: b.account_number,
            bankName: b.bank_name,
            branch: b.branch,
            ifsc: b.ifsc,
            swift: b.swift,
            iban: b.iban,
            currency: b.currency,
          })),
        luts: luts
          .filter((l) => l.entity_party_id === c.party_id)
          .map((l) => ({
            id: l.id,
            financialYear: l.financial_year,
            reference: l.reference,
            filedOn: toDayOrNull(l.filed_on),
          })),
      }));
    });
  }

  async addBankAccount(
    tenantId: string,
    entityPartyId: string,
    id: string,
    a: NewBankAccount,
  ): Promise<{ readonly replaced: string | null }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [old] = await db<{ id: string }[]>`
        UPDATE crm.firm_entity_bank_account SET retired_at = now()
         WHERE entity_party_id = ${entityPartyId}
           AND retired_at IS NULL
           AND coalesce(currency, '') = ${a.currency ?? ""}
        RETURNING id
      `;
      await db`
        INSERT INTO crm.firm_entity_bank_account
          (id, tenant_id, entity_party_id, account_name, account_number, bank_name, branch, ifsc, swift, iban, currency)
        VALUES (${id}, ${tenantId}, ${entityPartyId}, ${a.accountName}, ${a.accountNumber}, ${a.bankName},
                ${a.branch}, ${a.ifsc}, ${a.swift}, ${a.iban}, ${a.currency})
      `;
      return { replaced: old?.id ?? null };
    });
  }

  async retireBankAccount(tenantId: string, entityPartyId: string, accountId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        UPDATE crm.firm_entity_bank_account SET retired_at = now()
         WHERE id = ${accountId} AND entity_party_id = ${entityPartyId} AND retired_at IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async addLut(
    tenantId: string,
    entityPartyId: string,
    lut: { readonly id: string; readonly financialYear: number; readonly reference: string; readonly filedOn: string | null },
  ): Promise<{ readonly replaced: string | null }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [old] = await db<{ id: string }[]>`
        UPDATE crm.firm_entity_lut SET retired_at = now()
         WHERE entity_party_id = ${entityPartyId}
           AND retired_at IS NULL
           AND financial_year = ${lut.financialYear}
        RETURNING id
      `;
      await db`
        INSERT INTO crm.firm_entity_lut (id, tenant_id, entity_party_id, financial_year, reference, filed_on)
        VALUES (${lut.id}, ${tenantId}, ${entityPartyId}, ${lut.financialYear}, ${lut.reference}, ${lut.filedOn}::date)
      `;
      return { replaced: old?.id ?? null };
    });
  }

  async retireLut(tenantId: string, entityPartyId: string, lutId: string): Promise<number | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ financial_year: number }[]>`
        UPDATE crm.firm_entity_lut SET retired_at = now()
         WHERE id = ${lutId} AND entity_party_id = ${entityPartyId} AND retired_at IS NULL
        RETURNING financial_year
      `;
      return row?.financial_year ?? null;
    });
  }
}
