// The firm's own timezone, in Postgres (0071).
//
// ── ONE ADAPTER, TWO PORTS, AND THAT IS DELIBERATE ──────────────────────────
//
// `usecase/chaser` and `usecase/portallibrary` each declare a `FirmTimeZone` of
// their own, because ports live beside the use case that needs them. They are
// satisfied by this ONE class, which matters more than the duplication costs:
// two implementations would be two answers to *"which day is this instant on
// for this firm"*, and a chaser counting days in one zone while the digest cuts
// months in another is a disagreement nobody would ever look for.
//
// ── IT IS `withTenant`, AND THE PORTAL READS IT FROM OUTSIDE ────────────────
//
// `tenancy.tenant` is a GLOBAL table with no portal policy and must not grow one
// for this — a firm's timezone is the firm's own setting and no client session
// has any business asking for it. So the portal's digest resolves the zone
// BEFORE its `withPortal` transaction opens and passes it in, which is exactly
// what T6.9 did with the Key Manager for the same reason.
//
// ── AND EACH COMPANY'S OWN, WHEN IT KEEPS ONE (0337) ───────────────────────
//
// A firm's companies may keep their own zone and year (Sid, 2026-10-04).
// `companyCalendars` answers only those that do; a company absent from the map
// is on the firm's. It lives HERE, on the one zone adapter, for 0071's reason:
// two adapters would be two answers to "which day is it for this document".
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { startMonthOfYearEnd } from "../../domain/calendar/model";
import type { CompanyCalendars } from "../../domain/calendar/model";
import { DEFAULT_TIME_ZONE } from "../../domain/tenancy/model";
import type { FirmTimeZone as ChaserFirmTimeZone } from "../../usecase/chaser/ports";
import type { FirmTimeZone as LibraryFirmTimeZone } from "../../usecase/portallibrary/ports";
import type { FirmTimeZone as SchedulerFirmTimeZone } from "../../usecase/scheduler/ports";
import type { TimeZoneSetting } from "../../usecase/serviceaxis/ports";

export class PostgresFirmTimeZone
  implements ChaserFirmTimeZone, LibraryFirmTimeZone, SchedulerFirmTimeZone, TimeZoneSetting
{
  constructor(private readonly app: Db) {}

  /** The reading name, for the two sweeps that ask what the calendar is. */
  timeZoneFor(tenantId: string): Promise<string> {
    return this.read(tenantId);
  }

  async read(tenantId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ time_zone: string }[]>`
        SELECT time_zone FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      // ── A MISSING ROW ANSWERS 'UTC', AND THE FALLBACK IS THE POINT ───────
      //
      // Not because it is expected — the column is NOT NULL with a DEFAULT and
      // the tenant is the session's own — but because of what the alternatives
      // DO. 'UTC' is what every firm had before 0071 and is therefore the one
      // value that cannot surprise anybody; throwing here would take a client's
      // whole month page down over a setting, and guessing a regional zone
      // would silently move a boundary on the strength of a value this code
      // could not read. `PostgresRequestRoutingRepository` takes the same
      // position about `none`, for the same reason.
      return row?.time_zone ?? DEFAULT_TIME_ZONE;
    });
  }

  /**
   * The firm's companies that keep their OWN zone or year (0337), keyed by
   * party id. `crm.is_firm_entity` is the filter, so a CLIENT's year end
   * (stored in the same column for its filings) is never read as a company's.
   * A company with neither set, or with no registration yet, is absent: it is
   * on the firm's.
   */
  async companyCalendars(tenantId: string): Promise<CompanyCalendars> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ party_id: string; time_zone: string | null; financial_year_end: string | null }[]>`
        SELECT le.party_id, le.time_zone, le.financial_year_end
          FROM core.legal_entity le
         WHERE (le.time_zone IS NOT NULL OR le.financial_year_end IS NOT NULL)
           AND crm.is_firm_entity(le.tenant_id, le.party_id)
      `;
      return new Map(
        rows.map((r) => [
          r.party_id,
          { timeZone: r.time_zone, fiscalYearStartMonth: startMonthOfYearEnd(r.financial_year_end) },
        ]),
      );
    });
  }

  /** Set it. Refused by `trg_tenant_time_zone_known` if Postgres does not know
   *  the zone — the service checks first so a person gets a sentence, and the
   *  trigger is what an import or a psql session meets. */
  async write(tenantId: string, timeZone: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ time_zone: string }[]>`
        UPDATE tenancy.tenant SET time_zone = ${timeZone}::text
         WHERE id = ${tenantId}
        RETURNING time_zone
      `;
      return row?.time_zone ?? DEFAULT_TIME_ZONE;
    });
  }
}
