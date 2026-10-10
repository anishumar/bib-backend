// 0385 against real Postgres: the due day, and an ask a request template raises.
//
// What a fake cannot show, each one asserted by attempting the thing that must
// NOT happen rather than by being pleased the happy row arrives:
//
//   · the partial UNIQUE index refuses a second ask for one (task, template,
//     item) — by hand, through the adapter's ON CONFLICT, and with two sweeps
//     racing — while a hand-raised ask stays repeatable;
//   · the three template columns are all set or all null, and `raised_by` is
//     null ONLY beside a template;
//   · the template's version is referenced WITH ITS TENANT: another firm's
//     version, named by id, is refused by the composite foreign key;
//   · `due_on` comes back as the same `YYYY-MM-DD` it went in as, through a
//     session whose TimeZone is eleven hours west of Greenwich, on a day where
//     any shift moves the year;
//   · a portal session reads `dueOn` on its own ask under gate 4, and still not
//     another client's;
//   · an ask written the 0063 way, before any of this existed, still reads.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";
import { PostgresClientAskRepository } from "../../src/infrastructure/postgres/client-ask-repository";
import { PostgresPortalAskRepository } from "../../src/infrastructure/postgres/portal-ask-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { ClientAskService } from "../../src/usecase/clientask/service";
import { InvalidAskDueDate } from "../../src/domain/clientask/errors";
import { FakeAskScope } from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import { systemIds } from "../../src/platform/ids";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 3 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
// A session ELEVEN HOURS WEST of Greenwich. A date that went through any
// instant on the way out would come back a day early here.
const west = postgres(cfg.db.appUrl, { max: 1, connection: { TimeZone: "Pacific/Pago_Pago" } });

const stamp = String(Date.now());
let tenantId = "";
let otherTenantId = "";
let staffUser = "";
let mine = "";
let theirs = "";
let myItem = "";
let mySecondItem = "";
let theirItem = "";
let versionId = "";
let otherFirmVersionId = "";
const entryIds: string[] = [];

function service(events = new RecordingEventSink(), now = "2026-10-10T06:00:00.000Z") {
  return {
    events,
    service: new ClientAskService({
      asks: new PostgresClientAskRepository(app),
      portal: new PostgresPortalAskRepository(app),
      scope: new FakeAskScope(),
      blobs: new FakeBlobStore(),
      digest: new FakeContentDigest(),
      ids: systemIds,
      events,
      clock: new FakeClock(new Date(now)),
      timeZones: new PostgresFirmTimeZone(app),
      maxUploadBytes: 1_000_000,
    }),
  };
}

const monthlyClose = (itemKey: string) => ({
  versionId,
  templateKey: `monthly-close-${stamp}`,
  itemKey,
});

beforeAll(async () => {
  const firm = async (slug: string, zone: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
      VALUES (${slug}, 'Template Ask Test', 'INR', ${zone}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${slug}`);
    return row.id;
  };
  tenantId = await firm(`template-ask-${stamp}`, "Asia/Kolkata");
  otherTenantId = await firm(`template-ask-other-${stamp}`, "UTC");

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`template-ask-${stamp}@example.test`}, 'Template Ask Tester') RETURNING id
  `;
  if (!user) throw new Error("could not create the test user");
  staffUser = user.id;

  const party = async (name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${name}`);
    return row.id;
  };
  mine = await party(`Mine ${stamp}`);
  theirs = await party(`Theirs ${stamp}`);

  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank)
    VALUES (${tenantId}, 'normal', 'Normal', 3) RETURNING id
  `;
  if (!state || !priority) throw new Error("could not seed the work vocabulary");
  const item = async (client: string, title: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${tenantId}, ${client}, ${title}, ${state.id}, ${priority.id}, true)
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${title}`);
    return row.id;
  };
  myItem = await item(mine, "Monthly close · Oct 2026");
  mySecondItem = await item(mine, "Monthly close · Nov 2026");
  theirItem = await item(theirs, "Monthly close · Oct 2026");

  // A config version per firm, as a DRAFT so the cleanup may delete it. The
  // KIND is not what 0385's key checks (it names `config.version (id,
  // tenant_id)` and nothing else — see its header); `request_template` is
  // added by 0384 on another branch, so a kind every database has stands in.
  const version = async (tenant: string, key: string): Promise<string> => {
    const [entry] = await owner<{ id: string }[]>`
      INSERT INTO config.entry (tenant_id, kind, key)
      VALUES (${tenant}, 'policy', ${key}) RETURNING id
    `;
    if (!entry) throw new Error(`could not create entry ${key}`);
    entryIds.push(entry.id);
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO config.version (tenant_id, entry_id, version, body)
      VALUES (${tenant}, ${entry.id}, 1, '{}'::jsonb) RETURNING id
    `;
    if (!row) throw new Error(`could not create version ${key}`);
    return row.id;
  };
  versionId = await version(tenantId, `monthly-close-${stamp}`);
  otherFirmVersionId = await version(otherTenantId, `monthly-close-${stamp}`);
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId]) {
    await owner`DELETE FROM delivery.client_ask WHERE tenant_id = ${t}`;
  }
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM config.version WHERE entry_id = ANY(${entryIds})`;
  await owner`DELETE FROM config.entry WHERE id = ANY(${entryIds})`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ANY(${[tenantId, otherTenantId]})`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${staffUser}`;
  await app.end();
  await owner.end();
  await west.end();
});

/** An ask written straight into the table, as the firm's app role. */
function insertAsk(fields: {
  workItem: string;
  client: string;
  raisedBy: string | null;
  versionId?: string | null;
  templateKey?: string | null;
  itemKey?: string | null;
  dueOn?: string | null;
  tenant?: string;
}) {
  const tenant = fields.tenant ?? tenantId;
  return withTenant(app, tenant, (db) => db`
    INSERT INTO delivery.client_ask
      (tenant_id, work_item_id, client_party_id, ask_kind, prompt, raised_by, due_on,
       request_template_version_id, request_template_key, request_item_key)
    VALUES (${tenant}, ${fields.workItem}, ${fields.client}, 'question', 'a test ask',
            ${fields.raisedBy}, ${fields.dueOn ?? null}::date, ${fields.versionId ?? null}::uuid,
            ${fields.templateKey ?? null}, ${fields.itemKey ?? null})
  `);
}

describe("the partial unique index: one ask per task, template and item", () => {
  it("refuses a second row for the same (work item, template, item), written by hand", async () => {
    const t = monthlyClose("idx-by-hand");
    await insertAsk({ workItem: myItem, client: mine, raisedBy: null, ...t });
    await expect(
      insertAsk({ workItem: myItem, client: mine, raisedBy: null, ...t }),
    ).rejects.toThrow(/client_ask_template_item_once|duplicate key/i);
  });

  it("allows the same item on ANOTHER task — November is not October", async () => {
    const t = monthlyClose("idx-other-task");
    await insertAsk({ workItem: myItem, client: mine, raisedBy: null, ...t });
    await insertAsk({ workItem: mySecondItem, client: mine, raisedBy: null, ...t });
  });

  it("is PARTIAL: two hand-raised asks on one task are two deliberate acts", async () => {
    await insertAsk({ workItem: myItem, client: mine, raisedBy: staffUser });
    await insertAsk({ workItem: myItem, client: mine, raisedBy: staffUser });
  });

  it("through the service: created once, then created:false, and ONE event", async () => {
    const { service: svc, events } = service();
    const input = {
      tenantId,
      workItemId: myItem,
      prompt: "Bank statements for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-05",
      template: monthlyClose("svc-bank"),
    };
    const first = await svc.raiseFromTemplate(input);
    expect(first.created).toBe(true);
    expect(first.ask?.ask.raisedBy).toBeNull();
    expect(first.ask?.ask.fromTemplate).toEqual(monthlyClose("svc-bank"));
    expect(first.ask?.ask.clientPartyId).toBe(mine);

    const second = await svc.raiseFromTemplate(input);
    expect(second).toEqual({ created: false, ask: null });

    const rows = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.client_ask
       WHERE tenant_id = ${tenantId} AND work_item_id = ${myItem}
         AND request_item_key = 'svc-bank'
    `;
    expect(rows[0]?.n).toBe("1");
    expect(events.verbs().filter((v) => v === "client_ask.raised")).toHaveLength(1);
  });

  it("two sweeps RACING the same item leave one row and one event", async () => {
    // The ON CONFLICT is what makes this hold: the second INSERT waits on the
    // first's uncommitted row and then skips it. A read-then-write would have
    // let both through.
    const events = new RecordingEventSink();
    const a = service(events).service;
    const b = service(events).service;
    const input = {
      tenantId,
      workItemId: myItem,
      prompt: "Purchase invoices for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-05",
      template: monthlyClose("race-purchases"),
    };
    const results = await Promise.all([a.raiseFromTemplate(input), b.raiseFromTemplate(input)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(events.verbs().filter((v) => v === "client_ask.raised")).toHaveLength(1);
  });

  it("refuses a work item at another firm as not found, writing nothing", async () => {
    const { service: svc } = service();
    await expect(
      svc.raiseFromTemplate({
        tenantId: otherTenantId,
        workItemId: myItem,
        prompt: "Bank statements",
        askKind: "question",
        documentKind: null,
        dueOn: "2026-11-05",
        template: { versionId: otherFirmVersionId, templateKey: "t", itemKey: "i" },
      }),
    ).rejects.toMatchObject({ code: "ASK_WORK_ITEM_NOT_FOUND" });
  });
});

describe("the CHECKs: all three template columns or none, and a person or a template", () => {
  it("refuses a version with no keys", async () => {
    await expect(
      insertAsk({ workItem: myItem, client: mine, raisedBy: staffUser, versionId }),
    ).rejects.toThrow(/client_ask_template_all_or_none/);
  });

  it("refuses keys with no version", async () => {
    await expect(
      insertAsk({
        workItem: myItem,
        client: mine,
        raisedBy: staffUser,
        templateKey: "monthly-close",
        itemKey: "bank",
      }),
    ).rejects.toThrow(/client_ask_template_all_or_none/);
  });

  it("refuses a template and an item with no item key", async () => {
    await expect(
      insertAsk({
        workItem: myItem,
        client: mine,
        raisedBy: staffUser,
        versionId,
        templateKey: "monthly-close",
      }),
    ).rejects.toThrow(/client_ask_template_all_or_none/);
  });

  it("refuses an ask with NO person and no template", async () => {
    // 0063's NOT NULL was relaxed for a template's ask only. A hand-raised ask
    // with nobody behind it is still unwritable.
    await expect(
      insertAsk({ workItem: myItem, client: mine, raisedBy: null }),
    ).rejects.toThrow(/client_ask_raised_by_person_or_template/);
  });
});

describe("the template's version is referenced WITH its tenant", () => {
  it("refuses another firm's version, named by id, from this firm's ask", async () => {
    // A foreign-key check runs as a system operation RLS does not filter, so an
    // id-only key would accept this. The composite (id, tenant_id) is what
    // refuses it.
    await expect(
      insertAsk({
        workItem: myItem,
        client: mine,
        raisedBy: null,
        versionId: otherFirmVersionId,
        templateKey: "monthly-close",
        itemKey: "cross-firm",
      }),
    ).rejects.toThrow(/client_ask_template_version_fkey|foreign key/i);
  });

  it("and the constraint is the composite one, by the catalogue", async () => {
    const [row] = await owner<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'client_ask_template_version_fkey'
         AND conrelid = 'delivery.client_ask'::regclass
    `;
    expect(row?.def).toBe(
      "FOREIGN KEY (request_template_version_id, tenant_id) REFERENCES config.version(id, tenant_id)",
    );
  });
});

describe("due_on is a DAY, and comes back as the day it went in as", () => {
  it("round-trips 1 January through a session eleven hours west of Greenwich", async () => {
    // Any read that turned the day into an instant would name 31 December 2026
    // here — a different day, month AND year.
    const { service: svc } = service();
    const raised = await svc.raiseFromTemplate({
      tenantId,
      workItemId: myItem,
      prompt: "Payroll register for December 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2027-01-01",
      template: monthlyClose("new-year"),
    });
    const askId = raised.ask?.ask.id ?? "";
    expect(raised.ask?.ask.dueOn).toBe("2027-01-01");

    const viaWest = await new PostgresClientAskRepository(west).findById(tenantId, askId);
    expect(viaWest?.ask.dueOn).toBe("2027-01-01");
    expect(typeof viaWest?.ask.dueOn).toBe("string");

    const portal = await new PostgresPortalAskRepository(west).findById(tenantId, [mine], askId);
    expect(portal?.dueOn).toBe("2027-01-01");
  });

  it("a person's day is held to the FIRM's today, in the firm's zone", async () => {
    // 20:00 UTC on 10 October is 01:30 on the 11th in Kolkata, this firm's zone
    // (read from tenancy.tenant through the real adapter).
    const { service: svc } = service(new RecordingEventSink(), "2026-10-10T20:00:00.000Z");
    const raise = (dueOn: string) =>
      svc.raise({
        tenantId,
        workItemId: myItem,
        askKind: "question",
        prompt: "Which bank is the term loan with?",
        documentKind: null,
        dueOn,
        actor: { type: "human", id: staffUser },
      });
    await expect(raise("2026-10-10")).rejects.toBeInstanceOf(InvalidAskDueDate);
    const ok = await raise("2026-10-11");
    expect(ok.ask.dueOn).toBe("2026-10-11");
    expect(ok.ask.raisedBy).toBe(staffUser);
    expect(ok.ask.fromTemplate).toBeNull();
  });

  it("an ask written the 0063 way — no due day, no template — still reads", async () => {
    // The FIN plan's own check on F1.3: the old asks still read correctly.
    const [row] = await withTenant(app, tenantId, (db) => db<{ id: string }[]>`
      INSERT INTO delivery.client_ask
        (tenant_id, work_item_id, client_party_id, ask_kind, prompt, raised_by)
      VALUES (${tenantId}, ${mySecondItem}, ${mine}, 'question', 'old shape', ${staffUser})
      RETURNING id
    `);
    const read = await new PostgresClientAskRepository(app).findById(tenantId, row?.id ?? "");
    expect(read?.ask.dueOn).toBeNull();
    expect(read?.ask.fromTemplate).toBeNull();
    expect(read?.ask.raisedBy).toBe(staffUser);
  });
});

describe("a portal session reads dueOn under gate 4", () => {
  it("sees the day on its own client's ask and not the other client's ask at all", async () => {
    const { service: svc } = service();
    const ours = await svc.raiseFromTemplate({
      tenantId,
      workItemId: myItem,
      prompt: "Expense claims for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-05",
      template: monthlyClose("portal-expenses"),
    });
    const other = await svc.raiseFromTemplate({
      tenantId,
      workItemId: theirItem,
      prompt: "Expense claims for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-06",
      template: monthlyClose("portal-expenses"),
    });
    const rows = await new PostgresPortalAskRepository(app).list(tenantId, [mine]);
    const mineRow = rows.find((r) => r.askId === ours.ask?.ask.id);
    expect(mineRow?.dueOn).toBe("2026-11-05");
    expect(mineRow).not.toHaveProperty("fromTemplate");
    // AND IT TRIES: the other client's ask, by id, under my scope.
    expect(rows.map((r) => r.askId)).not.toContain(other.ask?.ask.id);
    const byId = await new PostgresPortalAskRepository(app).findById(
      tenantId,
      [mine],
      other.ask?.ask.id ?? "",
    );
    expect(byId).toBeNull();
  });

  it("the column itself is readable to the portal session only on granted rows", async () => {
    const rows = await withPortal(app, tenantId, [mine], (db) => db<{ client_party_id: string }[]>`
      SELECT client_party_id FROM delivery.client_ask
       WHERE tenant_id = ${tenantId} AND due_on IS NOT NULL
    `);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.client_party_id === mine)).toBe(true);
  });
});
