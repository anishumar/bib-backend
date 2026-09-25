// F-07-1 (security audit 2026-09-23, the one High): a portal session's grants
// are resolved on the FIRM's day, never on a day the caller sends.
//
// Before the fix, `GET /portal/home?asOf=<yesterday>` resolved the grant set on
// yesterday, so a contact removed "now" (0061) read the company again, and a
// grant dated to start next month was readable today with `?asOf=` that day.
// This runs the REAL grant module, the REAL status-home read and Postgres, and
// asks with exactly those dates.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresPortalAccessRepository } from "../../src/infrastructure/postgres/portal-access-repository";
import { PostgresPortalHomeRepository } from "../../src/infrastructure/postgres/portal-home-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PortalAccessService } from "../../src/usecase/portalaccess/service";
import { PortalHomeService } from "../../src/usecase/portalhome/service";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const grants = new PostgresPortalAccessRepository(app);
const access = new PortalAccessService({
  grants,
  memberships: grants,
  clients: grants,
  ids: systemIds,
  clock: systemClock,
  events: new RecordingEventSink(),
  timeZones: new PostgresFirmTimeZone(app),
});
const home = new PortalHomeService({
  scope: { scopedCompanies: (t, u) => access.scopedClientsForUser(t, u) },
  rows: new PostgresPortalHomeRepository(app),
  clock: systemClock,
});

const stamp = String(Date.now());
let tenantId = "";
let client = "";
const users: Record<"removed" | "future" | "live", string> = { removed: "", future: "", live: "" };

/** Days in the FIRM's zone, which is the tenant default, UTC. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`grants-firm-day-${stamp}`}, 'Grants Firm Day', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the firm");
  tenantId = t.id;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${`Cobalt Foods ${stamp}`}) RETURNING id
  `;
  if (!p) throw new Error("could not create the client");
  client = p.id;

  // Who granted them: a partner at the firm.
  const [partner] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`partner-${stamp}@client.example`})
    RETURNING id
  `;
  const granter = partner?.id ?? "";

  // Three portal logins at one company: removed today, starting tomorrow, live.
  for (const [who, from, to] of [
    ["removed", day(-10), day(0)],
    ["future", day(1), null],
    ["live", day(-10), null],
  ] as const) {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email) VALUES (${`${who}-${stamp}@client.example`})
      RETURNING id
    `;
    const [m] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
      VALUES (${tenantId}, ${u?.id ?? ""}, 'CLIENT_PORTAL', 'client_contact') RETURNING id
    `;
    await owner`
      INSERT INTO crm.portal_access
        (tenant_id, membership_id, client_party_id, valid_from, valid_to, granted_by)
      VALUES (${tenantId}, ${m?.id ?? ""}, ${client}, ${from}::date, ${to}::date, ${granter})
    `;
    users[who] = u?.id ?? "";
  }
});

afterAll(async () => {
  await owner`DELETE FROM crm.portal_access WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.user_account WHERE email LIKE ${`%-${stamp}@client.example`}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await Promise.all([app.end(), owner.end()]);
});

describe("a portal session's grants are the FIRM's day's, whatever day it sends (F-07-1)", () => {
  it("a contact removed today sees nothing, even asking as of yesterday", async () => {
    const read = await home.home(tenantId, users.removed, day(-1));
    expect(read.companies).toEqual([]);
  });

  it("a grant that starts tomorrow is not readable today, even asking as of tomorrow", async () => {
    const read = await home.home(tenantId, users.future, day(1));
    expect(read.companies).toEqual([]);
  });

  it("a live grant is still read — the display day is still the caller's", async () => {
    const read = await home.home(tenantId, users.live, day(-1));
    expect(read.companies.map((c) => c.clientPartyId)).toEqual([client]);
    expect(read.asOf).toBe(day(-1));
  });
});
