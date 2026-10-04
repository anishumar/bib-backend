// Postgres adapter for the daily exchange rates (0345). One table for every
// firm, with no tenant and no RLS: a rate is public data. Only the firm's own
// reporting currency is read behind the tenant wall.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DailyRates, FxQuote } from "../../domain/fx/model";
import type { FxRateStore, ReportingCurrencies } from "../../usecase/fx/ports";

interface QuoteRow {
  fx_rate: string;
  rate_day: string;
  source: string;
}

export class PostgresFxRateStore implements FxRateStore, ReportingCurrencies {
  constructor(private readonly app: Db) {}

  async save(rates: DailyRates): Promise<number> {
    const rows = [...rates.perUsd].map(([currency, perUsd]) => ({
      currency,
      day: rates.day,
      per_usd: perUsd,
      source: rates.source,
    }));
    if (rows.length === 0) return 0;
    // A day already held stays as it was: a report that valued a fee at the
    // rate of that day must say the same thing tomorrow.
    const inserted = await this.app`
      INSERT INTO fx.daily_rate (currency, day, per_usd, source)
      SELECT x.currency, x.day::date, x.per_usd::numeric, x.source
        FROM jsonb_to_recordset(${this.app.json(rows)})
             AS x(currency text, day text, per_usd text, source text)
      ON CONFLICT (currency, day) DO NOTHING
      RETURNING currency
    `;
    return inserted.length;
  }

  async rateOn(currency: string, reporting: string, day: string): Promise<FxQuote | null> {
    const [row] = await this.app<QuoteRow[]>`
      SELECT fx_rate::text, rate_day::text, source FROM fx.rate_on(${currency}, ${reporting}, ${day}::date)
    `;
    return row ? toQuote(currency, reporting, row) : null;
  }

  async rateAfter(currency: string, reporting: string, day: string): Promise<FxQuote | null> {
    const [row] = await this.app<QuoteRow[]>`
      SELECT fx_rate::text, rate_day::text, source FROM fx.rate_after(${currency}, ${reporting}, ${day}::date)
    `;
    return row ? toQuote(currency, reporting, row) : null;
  }

  async reportingCurrency(tenantId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ reporting_currency: string }[]>`
        SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (!row) throw new Error(`tenant ${tenantId} not found`);
      return row.reporting_currency;
    });
  }
}

/** "22.7500000000" read back as "22.75": the rate a person would type. */
function toQuote(currency: string, reporting: string, row: QuoteRow): FxQuote {
  return {
    currency,
    reporting,
    fxRate: row.fx_rate.includes(".") ? row.fx_rate.replace(/0+$/, "").replace(/\.$/, "") : row.fx_rate,
    fxRateDate: row.rate_day,
    source: row.source,
  };
}
