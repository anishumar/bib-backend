// The chaser's database half (T4.4, migration 0065) — the three things only
// real Postgres can say, plus the SQL nothing else runs.
//
//   · the exclusion constraint: one client cannot be frozen twice over the same
//     days, and that is checked over RANGES rather than over open rows
//   · `client_ask_chase_once`: at-least-once, so a redelivery cannot remind a
//     client twice
//   · `REVOKE UPDATE`: a chase is evidence and `bib_app` cannot rewrite it
//
// AND IT RUNS THE ADAPTER'S OWN QUERIES, which is the point of it being here
// rather than in the unit file. `${asOf}::date - a.raised_at::date` typechecks,
// lints and is exercised by no fake at all — that arithmetic surfaced as a 500
// on T6.5's first real request in a different query, and the lesson written at
// the top of `portal-home-repository.ts` is IF YOU ADD SQL, RUN IT.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import {
  PostgresChaseCandidates,
  PostgresChaseRepository,
  PostgresClientFreezeRepository,
} from "../../src/infrastructure/postgres/chaser-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
let client = "";
let otherClient = "";
let staffUser = "";
let visibleItem = "";
let hiddenItem = "";
let openAsk = "";
let answeredAsk = "";
let hiddenAsk = "";

const freezes = new PostgresClientFreezeRepository(app);
const candidates = new PostgresChaseCandidates(app);
const chases = new PostgresChaseRepository(app);

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`chaser-${stamp}`}, 'Chaser Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`chaser-${stamp}@example.test`}, 'Chaser Tester') RETURNING id
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
  client = await party(`Client ${stamp}`);
  otherClient = await party(`Other ${stamp}`);

  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank)
    VALUES (${tenantId}, 'normal', 'Normal', 3) RETURNING id
  `;
  if (!state || !priority) throw new Error("could not seed the work vocabulary");

  const item = async (title: string, clientVisible: boolean): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${tenantId}, ${client}, ${title}, ${state.id}, ${priority.id}, ${clientVisible})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${title}`);
    return row.id;
  };
  visibleItem = await item("GST monthly filing", true);
  hiddenItem = await item("Write-off discussion", false);

  // Raised TEN DAYS AGO, so the day arithmetic below has something to compute.
  const ask = async (
    workItem: string,
    status: string,
    daysAgo: number,
  ): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.client_ask
        (tenant_id, work_item_id, client_party_id, ask_kind, prompt, raised_by, raised_at,
         status, first_answered_at)
      VALUES (${tenantId}, ${workItem}, ${client}, 'question', 'send it', ${staffUser},
              now() - make_interval(days => ${daysAgo}), ${status},
              -- A real instant, not the string "now()": postgres.js sends this as a
              -- PARAMETER, so a SQL function name arriving there is just text
              -- that timestamptz cannot parse.
              ${status === "answered" ? new Date().toISOString() : null})
      RETURNING id
    `;
    if (!row) throw new Error("could not create the ask");
    return row.id;
  };
  openAsk = await ask(visibleItem, "open", 10);
  answeredAsk = await ask(visibleItem, "answered", 10);
  hiddenAsk = await ask(hiddenItem, "open", 10);
});

afterAll(async () => {
  await owner`DELETE FROM delivery.client_ask_chase WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.client_ask WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM crm.client_freeze WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${staffUser}`;
  await app.end();
  await owner.end();
});

describe("which asks the sweep can even see", () => {
  it("runs the day arithmetic in Postgres and gets the elapsed days right", async () => {
    // The thing no fake exercises. `${asOf}::date - a.raised_at::date` is
    // ambiguous to Postgres without the casts — postgres.js sends every
    // parameter untyped — and a `date` read back as a UTC instant would name the
    // day before west of Greenwich, which on a three-day rung is a whole rung.
    const today = new Date().toISOString().slice(0, 10);
    const { candidates: rows } = await candidates.openAsks(tenantId, today, "UTC");
    const row = rows.find((r) => r.askId === openAsk);
    expect(row?.daysOpen).toBe(10);
  });

  it("takes OPEN asks only — never one that is back with the firm", async () => {
    // Reminding somebody about something they have already sent is the single
    // most annoying thing a chaser can do, and it is exactly what a
    // spreadsheet-driven human chaser gets wrong every week.
    const today = new Date().toISOString().slice(0, 10);
    const { candidates: rows } = await candidates.openAsks(tenantId, today, "UTC");
    expect(rows.map((r) => r.askId)).toContain(openAsk);
    expect(rows.map((r) => r.askId)).not.toContain(answeredAsk);
  });

  it("skips an ask about work the client cannot see", async () => {
    // Chasing somebody about something that is not on their page would be the
    // product contradicting itself. `is_client_visible` is the same flag the
    // portal's own read joins through.
    const today = new Date().toISOString().slice(0, 10);
    const { candidates: rows } = await candidates.openAsks(tenantId, today, "UTC");
    expect(rows.map((r) => r.askId)).not.toContain(hiddenAsk);
  });
});

describe("the freeze, and the constraint under it", () => {
  it("stops the client appearing in the sweep's frozen list, half-open", async () => {
    const record = await freezes.set({
      id: crypto.randomUUID(),
      tenantId,
      clientPartyId: client,
      validFrom: "2026-01-01",
      validTo: "2026-01-10",
      reason: "in dispute over the FY26 audit fee",
      setBy: staffUser,
    });
    expect(record?.clientName).toContain(stamp);

    // In force on the first day, and NOT on `valid_to` — the FIRST DAY NOT IN
    // FORCE. Getting this wrong is a client chased on the day a partner froze
    // them, or one silent for a day after it was lifted.
    const on = async (day: string) =>
      (await candidates.openAsks(tenantId, day, "UTC")).frozenClients;
    expect(await on("2026-01-01")).toContain(client);
    expect(await on("2026-01-09")).toContain(client);
    expect(await on("2026-01-10")).not.toContain(client);
    expect(await on("2025-12-31")).not.toContain(client);
  });

  it("refuses a second freeze overlapping the first, AS RANGES", async () => {
    // Ranges compared as ranges and not a partial index over open rows: two
    // CLOSED freezes overlapping in January slip past that, and January is
    // exactly when somebody asks why nothing was sent.
    await expect(
      freezes.set({
        id: crypto.randomUUID(),
        tenantId,
        clientPartyId: client,
        validFrom: "2026-01-05",
        validTo: "2026-01-20",
        reason: "a second, overlapping freeze",
        setBy: staffUser,
      }),
    ).rejects.toThrow(/client_freeze_no_overlap|exclusion|conflicting key/i);
  });

  it("allows a freeze that starts the day the last one ended", async () => {
    // Half-open makes the boundary day unambiguous: `valid_to` is the first day
    // NOT in force, so a new freeze starting there overlaps nothing.
    const record = await freezes.set({
      id: crypto.randomUUID(),
      tenantId,
      clientPartyId: client,
      validFrom: "2026-01-10",
      validTo: null,
      reason: "scope renegotiation",
      setBy: staffUser,
    });
    expect(record).not.toBeNull();

    // ...and lifting it TODAY is what 0065 relaxed the CHECK for: `valid_to >=
    // valid_from`, so "set at 10:00, lifted at 10:01" is representable at all.
    const lifted = await freezes.lift({
      tenantId,
      freezeId: record?.id ?? "",
      on: "2026-01-10",
      liftedBy: staffUser,
    });
    expect(lifted?.validTo).toBe("2026-01-10");
    // An EMPTY range is in force on no day, so the exclusion constraint cannot
    // block the re-freeze after it — 0061's argument, and this proves it holds
    // on the second table to use it.
    const again = await freezes.set({
      id: crypto.randomUUID(),
      tenantId,
      clientPartyId: client,
      validFrom: "2026-01-10",
      validTo: "2026-01-11",
      reason: "and again",
      setBy: staffUser,
    });
    expect(again).not.toBeNull();
  });

  it("does not freeze a client at another firm, and says so as 'no such client'", async () => {
    // Gate 1. The INSERT reads `core.party` under RLS, so a party at another
    // firm is not there to select and the write produces zero rows — which the
    // service reports as "no such client at this firm" rather than a foreign-key
    // message.
    const record = await freezes.set({
      id: crypto.randomUUID(),
      tenantId,
      clientPartyId: "00000000-0000-4000-8000-00000000dead",
      validFrom: "2027-01-01",
      validTo: null,
      reason: "should not happen",
      setBy: staffUser,
    });
    expect(record).toBeNull();
  });

  it("keeps a lifted freeze on the record rather than deleting it", async () => {
    // "Was this client being chased in March" has to be answerable a year later,
    // and a freeze lifted by DELETE answers it with silence.
    const history = await freezes.listForClient(tenantId, client);
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.some((f) => f.validTo !== null)).toBe(true);
    expect(history.every((f) => f.reason.trim().length > 0)).toBe(true);
  });

  it("leaves another client alone", async () => {
    expect(await freezes.listForClient(tenantId, otherClient)).toEqual([]);
  });
});

describe("a chase is written once and cannot be rewritten", () => {
  it("takes the rung once, however many times the sweep asks", async () => {
    // AT-LEAST-ONCE. pg-boss redelivers, a worker restarts mid-pass, and the ask
    // is still open tomorrow. The second call returns NOTHING, which is what
    // keeps the ledger honest: the event is written only for rows created.
    const chase = {
      askId: openAsk,
      clientPartyId: client,
      workItemId: visibleItem,
      rungKey: "first",
      afterDays: 3,
      daysOpen: 10,
    };
    expect(await chases.record(tenantId, [chase])).toHaveLength(1);
    expect(await chases.record(tenantId, [chase])).toHaveLength(0);
  });

  it("takes the client from the ASK, never from the caller", async () => {
    // 0063's arrangement, reused. The statement selects `a.client_party_id`, so
    // a caller naming another client writes that client's row nowhere.
    await chases.record(tenantId, [
      {
        askId: openAsk,
        clientPartyId: otherClient,
        workItemId: visibleItem,
        rungKey: "second",
        afterDays: 7,
        daysOpen: 10,
      },
    ]);
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ client_party_id: string }[]>`
        SELECT client_party_id FROM delivery.client_ask_chase
         WHERE tenant_id = ${tenantId} AND rung_key = 'second'
      `;
    });
    expect(rows.map((r) => r.client_party_id)).toEqual([client]);
  });

  it("cannot be rewritten by the app role — a chase is evidence", async () => {
    // APPEND-ONLY BY GRANT, the arrangement `client_ask_response`,
    // `document_version` and the ledger have. "We reminded you four times" is
    // what a firm says when a filing goes late, and a record it can edit is not
    // evidence.
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`UPDATE delivery.client_ask_chase SET rung_key = 'rewritten'
                   WHERE tenant_id = ${tenantId}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a chase against an ask the firm has already closed", async () => {
    // The sweep only ever offers open asks, but a redelivery can arrive after
    // the firm closed one — and reminding a client about something already
    // settled is the failure this guards.
    await owner`
      UPDATE delivery.client_ask SET status = 'closed', closed_at = now(), closed_by = ${staffUser}
       WHERE id = ${answeredAsk}
    `;
    const created = await chases.record(tenantId, [
      {
        askId: answeredAsk,
        clientPartyId: client,
        workItemId: visibleItem,
        rungKey: "first",
        afterDays: 3,
        daysOpen: 10,
      },
    ]);
    expect(created).toEqual([]);
  });
});
