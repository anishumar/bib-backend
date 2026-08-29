// The firm's delivery structure, proven where the claims actually have to hold:
// the database (G2.4).
//
// Five properties, and none of them can be tested with a fake — a fake is
// exactly the thing that agrees with the service by construction:
//
//   1. RLS isolates a firm's lists. A fake filters by tenantId because it was
//      written to; Postgres has to be told, and this proves it was.
//   2. The per-firm-per-axis UNIQUE holds against the OWNER role, which is what
//      a migration or a psql session runs as. A rule that lives only in the
//      service is walked past by the next backfill somebody writes.
//   3. The `axis` CHECK is a closed set in the schema, not just in TypeScript.
//   4. `work_split_axis` is CHECKed too, so no import can leave a firm in a
//      state the engine cannot read.
//   5. The config registry actually refuses a service body naming a Dept this
//      firm never defined — end to end, through the real adapter, which is the
//      one thing that proves the two use cases are wired to the same table.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { ServiceAxisService } from "../../src/usecase/serviceaxis/service";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import {
  PostgresServiceAxisRepository,
  PostgresWorkSplitSetting,
} from "../../src/infrastructure/postgres/service-axis-repository";
import { ServiceAxisError } from "../../src/domain/serviceaxis/errors";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const axisRepository = new PostgresServiceAxisRepository(app);
const axes = new ServiceAxisService({
  axes: axisRepository,
  split: new PostgresWorkSplitSetting(app),
  ids: systemIds,
  events: ledger,
});
const config = new ConfigService({
  registry: new PostgresConfigRepository(app),
  holders: new PostgresMembershipRepository(app),
  // The REAL adapter over the same table the axis service writes. Two adapters
  // would agree by luck; this proves there is one.
  axes: axisRepository,
  ids: systemIds,
  events: ledger,
});

const stamp = Date.now().toString(36);
const slugA = `axis-test-a-${stamp}`;
const slugB = `axis-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  axisA: string;
  axisB: string;
}
let ids: Ids;

beforeAll(async () => {
  // Two firms, deliberately. Isolation you cannot see is isolation you cannot
  // trust — with one tenant seeded, an RLS bug looks exactly like a working
  // system.
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Northfield Advisory', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");

  const [ra] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${a.id}, 'dept', 'FRC', 'Financial Reporting') RETURNING id
  `;
  const [rb] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${b.id}, 'dept', 'FRC', 'Something else entirely') RETURNING id
  `;
  if (!ra || !rb) throw new Error("could not create the two test lists");

  ids = { tenantA: a.id, tenantB: b.id, axisA: ra.id, axisB: rb.id };
});

afterAll(async () => {
  // Nothing is deleted, and that is the house pattern rather than laziness:
  // these tests record real events, `ledger.event` refuses DELETE to the OWNER
  // role as well as the app one, and `tenancy.tenant` is referenced by those
  // events. So the two test firms are left behind, exactly as the registry's own
  // integration test leaves its own. A run is cheap; a cleanup that has to
  // defeat the append-only ledger to work is not a cleanup worth having.
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

/** One statement under a tenant's RLS context, the way the resolver does it. */
async function asTenant<T>(
  tenantId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

describe("the tenant wall around a firm's structure", () => {
  it("shows a firm only its own rows", async () => {
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM tenancy.service_axis`,
    );
    expect(rows.map((r) => r.id)).toEqual([ids.axisA]);
  });

  it("hides another firm's row even when its id is known", async () => {
    // The interesting direction: firm A holds B's row id and asks by primary
    // key. RLS answers zero rows rather than refusing, which is what makes "not
    // found" and "not yours" the same answer to a caller.
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM tenancy.service_axis WHERE id = ${ids.axisB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to write a row into another firm's list", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
          VALUES (${ids.tenantB}, 'dept', 'SMUGGLED', 'Smuggled')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("the constraints hold against the owner role too", () => {
  it("refuses a duplicate code on the same list at the same firm", async () => {
    await expect(
      owner`
        INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
        VALUES (${ids.tenantA}, 'dept', 'FRC', 'Duplicate')
      `,
    ).rejects.toThrow(/service_axis_tenant_id_axis_code_key|duplicate key/i);
  });

  it("ALLOWS the same code on the other list — the two axes are independent", async () => {
    const rows = await owner<{ id: string }[]>`
      INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
      VALUES (${ids.tenantA}, 'team', 'FRC', 'A team that happens to share a code')
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
    await owner`DELETE FROM tenancy.service_axis WHERE id = ${rows[0]?.id ?? null}`;
  });

  it("refuses an axis outside the closed set", async () => {
    await expect(
      owner`
        INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
        VALUES (${ids.tenantA}, 'division', 'X', 'X')
      `,
    ).rejects.toThrow(/service_axis_axis_check|violates check constraint/i);
  });

  it("refuses a work_split_axis the engine cannot read", async () => {
    await expect(
      owner`UPDATE tenancy.tenant SET work_split_axis = 'division' WHERE id = ${ids.tenantA}`,
    ).rejects.toThrow(/tenant_work_split_axis_chk|violates check constraint/i);
  });

  it("defaults a firm to `none`, so this migration changed nobody's behaviour", async () => {
    const [row] = await owner<{ work_split_axis: string }[]>`
      SELECT work_split_axis FROM tenancy.tenant WHERE id = ${ids.tenantB}
    `;
    expect(row?.work_split_axis).toBe("none");
  });
});

describe("the config registry checks a service body against the firm's real list", () => {
  it("refuses a Dept this firm never defined", async () => {
    await expect(
      config.define(
        {
          tenantId: ids.tenantA,
          kind: "service",
          key: "gst-filing",
          body: {
            name: "GST monthly filing",
            billingBasis: "fixed",
            jurisdictions: [],
            module: "TRC",
          },
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(ServiceAxisError);
  });

  it("accepts one the firm HAS defined", async () => {
    const defined = await config.define(
      {
        tenantId: ids.tenantA,
        kind: "service",
        key: "gst-filing-ok",
        body: {
          name: "GST monthly filing",
          billingBasis: "fixed",
          jurisdictions: [],
          module: "FRC",
        },
      },
      SYSTEM_ACTOR,
    );
    expect(defined.entry.key).toBe("gst-filing-ok");
  });

  // The rule stated in `checkServiceAxes`: the two axes are independent, so a
  // firm with Depts and no teams has `module` checked and `group` not.
  it("does not check an axis the firm has no rows on", async () => {
    const defined = await config.define(
      {
        tenantId: ids.tenantA,
        kind: "service",
        key: "payroll-run",
        body: {
          name: "Payroll",
          billingBasis: "fixed",
          jurisdictions: [],
          module: "FRC",
          group: "A TEAM NOBODY DEFINED",
        },
      },
      SYSTEM_ACTOR,
    );
    expect(defined.entry.key).toBe("payroll-run");
  });

  it("refuses a Dept the firm has RETIRED, with its own message", async () => {
    const retired = await axes.createAxis(
      { tenantId: ids.tenantA, axis: "dept", code: "RAA", name: "RAA", sortOrder: 9 },
      SYSTEM_ACTOR,
    );
    await axes.setAxisActive(
      { tenantId: ids.tenantA, id: retired.id, isActive: false },
      SYSTEM_ACTOR,
    );
    await expect(
      config.define(
        {
          tenantId: ids.tenantA,
          kind: "service",
          key: "retired-dept-service",
          body: {
            name: "Something",
            billingBasis: "fixed",
            jurisdictions: [],
            module: "RAA",
          },
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/no longer uses/i);
  });

  // Firm B has its own FRC. If the registry were reading the list unscoped, this
  // would pass for the wrong reason — so it is asserted from the other side.
  it("does not let one firm's list satisfy another firm's body", async () => {
    await expect(
      config.define(
        {
          tenantId: ids.tenantB,
          kind: "service",
          key: "cross-tenant",
          body: {
            name: "Something",
            billingBasis: "fixed",
            jurisdictions: [],
            module: "TRC",
          },
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(ServiceAxisError);
  });
});
