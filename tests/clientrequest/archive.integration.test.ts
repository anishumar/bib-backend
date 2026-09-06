// The inbox and the archive are COMPLEMENTS, proven against real Postgres.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
//
// `listLive` was the only list this repository had, and it filters
// `status IN ('open','answered')`. So the moment somebody at the firm pressed
// Close, the record of what a client asked and what the firm answered left
// every staff screen — while the CLIENT's own portal went on showing the whole
// thread, because `portal-request-repository`'s query filters on no status at
// all. The two surfaces disagreed about the same conversation and the client
// held the fuller record.
//
// ── WHY A REAL DATABASE ─────────────────────────────────────────────────────
//
// The service test proves the SERVICE picks a list. What only Postgres can
// prove is the predicate the two lists share:
//
//   (${scope} = 'any' OR (${scope} = 'live') = (r.status IN ('open','answered')))
//
// It is a boolean identity written to make `finished` the complement of `live`
// rather than a second hand-listed pair of statuses — so that a status added
// later lands in one of the two lists rather than falling out of both. This
// asserts the partition holds over EVERY status the check constraint allows,
// which is the assertion that keeps that true.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: rows are left behind; the tenant is uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresClientRequestRepository } from "../../src/infrastructure/postgres/client-request-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const requests = new PostgresClientRequestRepository(app);

const stamp = String(Date.now());
let tenantId = "";
let clientParty = "";
let raiser = "";
/** id by status, so each assertion can name the row it expects. */
const made: Record<string, string> = {};

/** Every status the table allows, and the two lists that must partition them. */
const LIVE = ["open", "answered"] as const;
const FINISHED = ["closed", "withdrawn"] as const;

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`cr-archive-${stamp}`}, 'Client Request Archive', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenantId = t.id;

  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${`Archive Client ${stamp}`}) RETURNING id
  `;
  if (!p) throw new Error("could not create the client party");
  clientParty = p.id;

  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`archive-${stamp}@example.test`}, 'Archive Raiser') RETURNING id
  `;
  if (!u) throw new Error("could not create the raiser");
  raiser = u.id;

  // One request in every status the constraint allows. The timestamps travel
  // WITH the status because `client_request_status_agrees` refuses a row where
  // the two disagree — `answered` means somebody replied, and the table will
  // not let a test pretend otherwise.
  // RAISED AN HOUR AGO, not now: `client_request_settled_after_raised` refuses a
  // row settled before it was raised, and `raised_at` defaults to the moment of
  // the INSERT — which is after any timestamp this test could have computed
  // first. The constraint is right and the fixture was wrong.
  const raisedAt = new Date(Date.now() - 3600_000).toISOString();
  const settledAt = new Date().toISOString();
  for (const status of [...LIVE, ...FINISHED]) {
    const settled = FINISHED.includes(status as (typeof FINISHED)[number]);
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.client_request
        (tenant_id, client_party_id, subject, body, status, raised_by, raised_at,
         first_replied_at, settled_by, settled_at)
      VALUES (${tenantId}, ${clientParty}, ${`Subject ${status}`}, 'Body.', ${status},
              ${raiser}, ${raisedAt},
              ${status === "answered" ? settledAt : null},
              ${settled ? raiser : null}, ${settled ? settledAt : null})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create the ${status} request`);
    made[status] = row.id;
  }

  // A thread on the closed one: the archive is read to BE read, and a record of
  // a conversation without the conversation is a row.
  await owner`
    INSERT INTO delivery.client_request_reply
      (tenant_id, request_id, client_party_id, author_side, body, written_by)
    VALUES (${tenantId}, ${made["closed"] ?? ""}, ${clientParty}, 'firm',
            'What we told them.', ${raiser})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the two lists partition every status", () => {
  it("the inbox holds open and answered, and nothing else", async () => {
    const live = await requests.listLive(tenantId);
    expect(live.map((r) => r.request.status).sort()).toEqual([...LIVE].sort());
  });

  it("the archive holds closed and withdrawn, and nothing else", async () => {
    const finished = await requests.listFinished(tenantId);
    expect(finished.map((r) => r.request.status).sort()).toEqual([...FINISHED].sort());
  });

  it("no request is on both lists, and none is on neither", async () => {
    // THE ASSERTION THE PREDICATE EXISTS FOR. A `finished` list that named its
    // own statuses would pass the two above and fail this one the day a fifth
    // status is added to the check constraint.
    const [live, finished] = await Promise.all([
      requests.listLive(tenantId),
      requests.listFinished(tenantId),
    ]);
    const seen = [...live, ...finished].map((r) => r.request.id).sort();
    expect(seen).toEqual(Object.values(made).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("the archive brings the thread with it", async () => {
    const finished = await requests.listFinished(tenantId);
    const closed = finished.find((r) => r.request.id === made["closed"]);
    expect(closed?.replies.map((x) => x.reply.body)).toEqual(["What we told them."]);
  });
});

describe("the archive is inside the tenant wall like everything else", () => {
  it("another firm's archive is empty rather than refused", async () => {
    const [other] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`cr-archive-other-${stamp}`}, 'Archive Other', 'INR') RETURNING id
    `;
    if (!other) throw new Error("could not create the second tenant");
    expect(await requests.listFinished(other.id)).toEqual([]);

    // And the rows are still there for the firm that owns them — the wall is a
    // filter on the reader, never a fact about the row.
    expect(await requests.listFinished(tenantId)).toHaveLength(FINISHED.length);
  });

  it("a raw read as the app role sees the same four rows this firm has", async () => {
    const rows = await withTenant(app, tenantId, (db) => db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.client_request WHERE tenant_id = ${tenantId}
    `);
    expect(rows[0]?.n).toBe(String(LIVE.length + FINISHED.length));
  });
});
