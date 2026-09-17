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
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
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
