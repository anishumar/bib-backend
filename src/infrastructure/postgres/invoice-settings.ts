// What invoicing needs to know about the firm itself (audit 2026-10-03): the
// reporting currency every rate is struck against (B07), the month its
// financial year starts (B03: an invoice's series is its issue date's year) and
// its own payment terms (B20: the due date an invoice issued without one takes).
//
// One read, in the tenant's context. The year start is the PUBLISHED compliance
// policy's, the same value the billing sweep and the dashboard read, so the
// firm sets it once.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { COMPLIANCE_POLICY_KEY, readFiscalYearStartMonth } from "../../domain/config/model";
import type { InvoiceFirmSettings } from "../../usecase/invoice/ports";

export class PostgresInvoiceFirmSettings implements InvoiceFirmSettings {
  constructor(private readonly app: Db) {}

  async invoiceSettingsFor(tenantId: string): Promise<{
    readonly reportingCurrency: string;
    readonly fiscalYearStartMonth: number | null;
    readonly dueInDays: number | null;
  }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [firm] = await db<{ reporting_currency: string; invoice_due_days: number | null }[]>`
        SELECT reporting_currency, invoice_due_days FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (!firm) throw new Error(`no tenant ${tenantId} to read invoice settings for`);
      const [policy] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
          FROM config.entry e
          JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
         WHERE e.kind = 'compliance_policy' AND e.key = ${COMPLIANCE_POLICY_KEY}
      `;
      return {
        reportingCurrency: firm.reporting_currency,
        fiscalYearStartMonth: policy ? readFiscalYearStartMonth(policy.body) : null,
        dueInDays: firm.invoice_due_days,
      };
    });
  }
}
