// How a firm routes an arriving client request, in Postgres (T6.8, 0070).
//
// A COLUMN ON `tenancy.tenant`, read and written exactly the way
// `work_split_axis` is (`PostgresServiceAxisRepository`) — and this file is
// separate from that one because the two settings belong to different use
// cases. Sharing an adapter would make `usecase/serviceaxis` the home of a
// setting about client requests, and the next firm-wide switch would land there
// too because that is where the last one was.
//
// It is `withTenant`, gate 1 only: this is the firm's own setting about its own
// desks, and no portal session reads it. The one place it is consulted on a
// client's behalf — routing a request as it arrives — happens BEFORE the portal
// transaction opens, deliberately (see `NewRequest`).
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { RequestRouting } from "../../domain/clientrequest/model";
import { isRequestRouting } from "../../domain/clientrequest/model";
import type { RequestRoutingSource } from "../../usecase/clientrequest/ports";

export class PostgresRequestRoutingRepository implements RequestRoutingSource {
  constructor(private readonly app: Db) {}

  async routingFor(tenantId: string): Promise<RequestRouting> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ client_request_routing: string }[]>`
        SELECT client_request_routing FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      // ── A MISSING ROW AND AN UNREADABLE VALUE BOTH ANSWER `none` ────────
      //
      // Not because either is expected — the column is NOT NULL with a DEFAULT
      // and a CHECK, and the tenant is the session's own — but because of what
      // the two possible fallbacks DO. `none` routes nothing, which is what
      // every firm is on until it decides otherwise; the alternative would put
      // a request on somebody's desk on the strength of a value this code could
      // not read. `PostgresServiceAxisRepository` takes the same position for
      // `work_split_axis` and for the same reason.
      if (!row) return "none";
      return isRequestRouting(row.client_request_routing) ? row.client_request_routing : "none";
    });
  }

  async setRouting(tenantId: string, routing: RequestRouting): Promise<RequestRouting> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE tenancy.tenant SET client_request_routing = ${routing} WHERE id = ${tenantId}
      `;
      return routing;
    });
  }
}
