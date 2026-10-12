// The AI reader's two reads and one write in Postgres (0389, F2.4): the call
// record, the month's spend, and whose books a client's files are.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { TokenUsage } from "../../domain/fin/extraction-usage";
import type {
  BooksOwner,
  BooksOwners,
  ExtractionUsageStore,
  NewUsageRow,
} from "../../usecase/fin/extract-ports";

interface MonthRow {
  input: string;
  output: string;
  cache_write: string;
  cache_read: string;
}

export class PostgresExtractionUsage implements ExtractionUsageStore {
  constructor(private readonly app: Db) {}

  async record(row: NewUsageRow): Promise<void> {
    await withTenant(this.app, row.tenantId, async (db) => {
      await db`
        INSERT INTO fin.extraction_usage
          (id, tenant_id, intake_item_id, model, prompt_version, attempt,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
           outcome, failure, doc_class, provider_request_id)
        VALUES
          (${row.id}, ${row.tenantId}, ${row.intakeItemId}, ${row.model}, ${row.promptVersion},
           ${row.attempt}, ${row.usage.inputTokens}, ${row.usage.outputTokens},
           ${row.usage.cacheWriteTokens}, ${row.usage.cacheReadTokens},
           ${row.outcome}, ${row.failure}, ${row.docClass}, ${row.requestId})
      `;
    });
  }

  async monthToDate(tenantId: string, asOf: string): Promise<TokenUsage> {
    return withTenant(this.app, tenantId, async (db) => {
      // The FIRM's month (T6.11): from midnight on the 1st to midnight on the
      // next 1st, both in the firm's zone, worked out in SQL from the firm's
      // own column, so a call at 00:30 on 1 October in Singapore (still 30
      // September in UTC) counts in October.
      const [row] = await db<MonthRow[]>`
        WITH firm AS (
          SELECT date_trunc('month', ${asOf}::timestamptz AT TIME ZONE time_zone) AS month_start,
                 time_zone
            FROM tenancy.tenant WHERE id = ${tenantId}
        )
        SELECT coalesce(sum(u.input_tokens), 0)::text       AS input,
               coalesce(sum(u.output_tokens), 0)::text      AS output,
               coalesce(sum(u.cache_write_tokens), 0)::text AS cache_write,
               coalesce(sum(u.cache_read_tokens), 0)::text  AS cache_read
          FROM fin.extraction_usage u, firm
         WHERE u.tenant_id = ${tenantId}
           AND u.created_at >= (firm.month_start AT TIME ZONE firm.time_zone)
           AND u.created_at <  ((firm.month_start + interval '1 month') AT TIME ZONE firm.time_zone)
      `;
      return {
        inputTokens: Number(row?.input ?? 0),
        outputTokens: Number(row?.output ?? 0),
        cacheWriteTokens: Number(row?.cache_write ?? 0),
        cacheReadTokens: Number(row?.cache_read ?? 0),
      };
    });
  }

  async refusals(
    tenantId: string,
    intakeItemId: string,
  ): Promise<{ readonly count: number; readonly okSinceFirst: boolean }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ count: number; ok_since_first: boolean }[]>`
        WITH refused AS (
          SELECT count(*)::int AS count, min(created_at) AS first_at
            FROM fin.extraction_usage
           WHERE tenant_id = ${tenantId}
             AND intake_item_id = ${intakeItemId}
             AND failure = 'bad_request'
        )
        SELECT refused.count,
               EXISTS (
                 SELECT 1 FROM fin.extraction_usage ok
                  WHERE ok.tenant_id = ${tenantId}
                    AND ok.outcome = 'ok'
                    AND refused.first_at IS NOT NULL
                    AND ok.created_at > refused.first_at
               ) AS ok_since_first
          FROM refused
      `;
      return { count: row?.count ?? 0, okSinceFirst: row?.ok_since_first ?? false };
    });
  }
}

interface OwnerRow {
  display_name: string;
  legal_name: string | null;
  trade_name: string | null;
  uen: string | null;
  gst_no: string | null;
}

/**
 * Who a client is, for the prompt: its names and the two numbers it prints on
 * every document it RECEIVES, so the model keeps them out of the counterparty
 * fields. Singapore's GST registration number is a party identifier of type
 * `vat` (0334: "a VAT number elsewhere"). Only identifiers in force and not
 * voided (0315); null for a party this firm does not hold.
 */
export class PostgresBooksOwners implements BooksOwners {
  constructor(private readonly app: Db) {}

  async describe(tenantId: string, clientPartyId: string): Promise<BooksOwner | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<OwnerRow[]>`
        SELECT p.display_name,
               o.legal_name,
               o.trade_name,
               (SELECT i.value::text FROM core.party_identifier i
                 WHERE i.party_id = p.id AND i.tenant_id = p.tenant_id AND i.type = 'uen'
                   AND i.voided_at IS NULL AND i.valid_to IS NULL
                 ORDER BY i.is_primary DESC, i.valid_from DESC LIMIT 1) AS uen,
               (SELECT i.value::text FROM core.party_identifier i
                 WHERE i.party_id = p.id AND i.tenant_id = p.tenant_id AND i.type = 'vat'
                   AND i.voided_at IS NULL AND i.valid_to IS NULL
                 ORDER BY i.is_primary DESC, i.valid_from DESC LIMIT 1) AS gst_no
          FROM core.party p
          LEFT JOIN core.organization o ON o.party_id = p.id AND o.tenant_id = p.tenant_id
         WHERE p.id = ${clientPartyId}
      `;
      if (row === undefined) return null;
      const names = [row.display_name, row.legal_name, row.trade_name]
        .filter((n): n is string => n !== null && n.trim() !== "")
        .map((n) => n.trim());
      return { names: [...new Set(names)], uen: row.uen, gstNo: row.gst_no };
    });
  }
}
