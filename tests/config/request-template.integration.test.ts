// F1.1 against real Postgres: 0384 widened `entry_kind_check`, so a
// `request_template` is defined, published and read back through the real
// registry, and a pin to version 1 still resolves after version 2. The live
// CHECK is also read out of the catalogue and held to `CONFIG_KINDS`, which is
// the database half of tests/config/kind-check-parity.test.ts.
//
// Run with:  npm run migrate && npm run test:integration
//
// NOTE ON CLEANUP: published versions cannot be deleted by any role, which is
// the registry's point, so the tenant is left behind under a unique slug.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { ConfigService } from "../../src/usecase/config/service";
import { LedgerService } from "../../src/usecase/ledger/service";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { CONFIG_KINDS, readRequestTemplate, readWorkflowTemplate } from "../../src/domain/config/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const service = new ConfigService({
  registry: new PostgresConfigRepository(app),
  holders: new PostgresMembershipRepository(app),
  axes: new PostgresServiceAxisRepository(app),
  ids: systemIds,
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
});

const stamp = String(Date.now());
let tenantId = "";

const item = (key: string, label: string): Record<string, unknown> => ({
  key,
  label,
  askKind: "document",
  documentKind: "books_input",
  sendOffsetDays: 1,
  dueOffsetDays: 5,
});

const MONTHLY_CLOSE = {
  label: "Monthly close",
  items: [
    item("sales", "Sales invoices for the month"),
    item("purchases", "Purchase invoices for the month"),
    item("bank_statements", "Bank statements for every account"),
    {
      key: "no_cash_sales",
      label: "Confirm there were no cash sales this month",
      askKind: "approval",
      documentKind: null,
      sendOffsetDays: 1,
      dueOffsetDays: 5,
    },
  ],
};

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`request-template-${stamp}`}, 'Request Template Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenantId = t.id;
  await service.seedDefaultRoles(tenantId, SYSTEM_ACTOR);
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the live entry_kind_check (0384)", () => {
  it("names exactly the kinds the domain has", async () => {
    const [row] = await owner<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'entry_kind_check' AND conrelid = 'config.entry'::regclass
    `;
    const members = [...(row?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(members.sort()).toEqual([...CONFIG_KINDS].sort());
  });

  it("still refuses a kind nobody defined", async () => {
    const err = await owner`
      INSERT INTO config.entry (tenant_id, kind, key)
      VALUES (${tenantId}, 'request_list', 'monthly-close')
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514"); // check_violation
  });
});

describe("a request template in the real registry", () => {
  let v1Id = "";

  it("is defined, published and read back by key", async () => {
    const { draft } = await service.define(
      { tenantId, kind: "request_template", key: "monthly-close", body: MONTHLY_CLOSE },
      SYSTEM_ACTOR,
    );
    v1Id = draft.id;
    await service.publish(
      { tenantId, kind: "request_template", key: "monthly-close", version: 1 },
      SYSTEM_ACTOR,
    );

    const [listed] = await service.list(tenantId, "request_template");
    expect(listed?.entry.key).toBe("monthly-close");
    expect(listed?.published?.id).toBe(v1Id);
    const read = readRequestTemplate(listed?.published?.body ?? {});
    expect(read?.label).toBe("Monthly close");
    expect(read?.items.map((i) => i.key)).toEqual(["sales", "purchases", "bank_statements", "no_cash_sales"]);
    expect(read?.items[3]?.documentKind).toBeNull();
  });

  it("keeps version 1 by its pin after version 2 adds expense claims", async () => {
    await service.addVersion({
      tenantId,
      kind: "request_template",
      key: "monthly-close",
      body: { ...MONTHLY_CLOSE, items: [...MONTHLY_CLOSE.items, item("expenses", "Expense claims with receipts")] },
    });
    await service.publish(
      { tenantId, kind: "request_template", key: "monthly-close", version: 2 },
      SYSTEM_ACTOR,
    );

    const pinned = await service.readPinned(tenantId, v1Id);
    expect(pinned.status).toBe("archived");
    expect(readRequestTemplate(pinned.body)?.items).toHaveLength(4);

    const [listed] = await service.list(tenantId, "request_template");
    expect(readRequestTemplate(listed?.published?.body ?? {})?.items).toHaveLength(5);
  });

  it("a process step names it by key, and the published process reads the key back", async () => {
    const process = {
      label: "Monthly accounting",
      steps: [
        {
          key: "collect",
          label: "Collect the month's papers",
          executor: "human",
          dependsOn: [],
          condition: null,
          verificationPolicyKey: null,
          requestTemplateKey: "monthly-close",
          performer: null,
        },
      ],
    };
    await service.define(
      { tenantId, kind: "workflow_template", key: "monthly-accounting", body: process },
      SYSTEM_ACTOR,
    );
    const published = await service.publish(
      { tenantId, kind: "workflow_template", key: "monthly-accounting", version: 1 },
      SYSTEM_ACTOR,
    );
    expect(readWorkflowTemplate(published.body)?.steps[0]?.requestTemplateKey).toBe("monthly-close");
  });
});
