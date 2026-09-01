// THE CLIENT'S OWN REQUEST, AND THE FIRST WALL THAT HAS TO STOP A WRITE THE
// CLIENT AIMED (T6.8, migration 0068).
//
// `gate4.integration.test.ts` proved 0059's policy, `portal-reads` proved
// 0062's two, `client-ask` proved 0063's five, `library` proved 0066's. This is
// the same discipline applied to 0068, and one thing here is genuinely new.
//
// ── EVERY WALL COLUMN BEFORE THIS ONE WAS READ FROM A PARENT ──────────────
//
// 0063 takes `client_party_id` from the work item inside the INSERT; its
// response table takes it from the ask. So no caller could name a party at all,
// and `PostgresPortalAskRepository`'s own header says as much. A client's own
// request has NO PARENT — a contact granted three companies must say which one
// they are writing about — so the value arrives from the browser and
// `WITH CHECK (crm.portal_sees(client_party_id))` is the only thing between it
// and the row.
//
// The service also refuses a party outside the session's scope, so the client
// gets a sentence instead of an RLS violation. That check is NOT the wall and
// this file is where the difference is demonstrated: every write below goes
// straight to `withPortal`, past the service, the way an edited adapter or a
// future caller would.
//
// ── AND `author_side` IS ENFORCED BY THE DATABASE, NOT BY THE ADAPTER ─────
//
// The reply policy's WITH CHECK carries a second clause: under a portal session
// the only writable value is 'client'. Written in 0062's shape —
// `NOT crm.is_portal_session() OR ...` — because a bare `author_side =
// 'client'` on a RESTRICTIVE policy applies to STAFF too and the firm would
// find its own replies refused. That is the exact edit that cost T6.7 an hour
// on `files.document` and `crm.invoice`, which is why the FIRST test in this
// file is "a staff session is untouched".
//
// ── HOW THIS FILE WAS CHECKED, WHICH IS THE POINT OF IT ───────────────────
//
// Each assertion was watched go RED with its policy dropped and green with it
// back — a test that only ever passes proves the rows exist, not that the wall
// does. The counts below were MEASURED by running each one, not estimated:
//
//   DROP POLICY client_request_portal_scope ON delivery.client_request;
//   -- 3 fail: the other client's request is listed, it is readable BY ID, and
//   -- a request naming THEIR company is accepted. The thread tests still pass,
//   -- which is the point of the reply table carrying its own policy.
//
//   DROP POLICY client_request_reply_portal_scope ON delivery.client_request_reply;
//   -- 3 fail: the other client's thread is readable, a portal session can post
//   -- a reply signed as the FIRM, and it can write into their thread.
//
//   ALTER POLICY client_request_reply_portal_scope ON delivery.client_request_reply
//     USING (crm.portal_sees(client_party_id))
//     WITH CHECK (crm.portal_sees(client_party_id) AND author_side = 'client');
//   -- the GUARD removed rather than the policy, which is the T6.7 trap
//   -- reproduced exactly: 2 fail, and BOTH are the FIRM being locked out of its
//   -- own table — it can no longer reply to a client, and it can no longer send
//   -- one a document. A narrowing written without the guard narrows the
//   -- workspace.
//
// Restore each before moving on. These are DDL on a shared database and do not
// roll back with a transaction the test's own connection cannot see.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
/** Two clients of ONE firm — gate 1 is not what is under test here. */
let mine = "";
let theirs = "";
let staffUser = "";
let contactUser = "";

let myRequest = "";
let theirRequest = "";
/** A document filed against each client, plus one of the firm's own. */
let myDoc = "";
let theirDoc = "";
let firmDoc = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`request-${stamp}`}, 'Request Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const user = async (label: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name)
      VALUES (${`${label}-${stamp}@example.test`}, ${label}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${label}`);
    return row.id;
  };
  staffUser = await user("Request Staff");
  contactUser = await user("Request Contact");

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

  const document = async (partyId: string | null, title: string): Promise<string> => {
    const [doc] = await owner<{ id: string }[]>`
      INSERT INTO files.document
        (tenant_id, title, origin, kind, party_id, is_client_visible, created_by)
      VALUES (${tenantId}, ${title}, 'uploaded', 'working_paper', ${partyId}, false, ${staffUser})
      RETURNING id
    `;
    if (!doc) throw new Error(`could not create ${title}`);
    return doc.id;
  };
  myDoc = await document(mine, `mine-${stamp}`);
  theirDoc = await document(theirs, `theirs-${stamp}`);
  // `party_id` NULL — the firm's own working paper, which no composite FK over
  // a NOT NULL column can ever match.
  firmDoc = await document(null, `firm-${stamp}`);

  const request = async (partyId: string, subject: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.client_request
        (tenant_id, client_party_id, subject, body, raised_by)
      VALUES (${tenantId}, ${partyId}, ${subject}, 'seeded by the fixture', ${contactUser})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${subject}`);
    return row.id;
  };
  myRequest = await request(mine, "Send me last year's balance sheet");
  theirRequest = await request(theirs, "Not mine to read");

  // One firm reply on each, so the thread is not empty when the wall is asked
  // about it.
  for (const [requestId, partyId] of [
    [myRequest, mine],
    [theirRequest, theirs],
  ] as const) {
    await owner`
      INSERT INTO delivery.client_request_reply
        (tenant_id, request_id, client_party_id, author_side, body, written_by)
      VALUES (${tenantId}, ${requestId}, ${partyId}, 'firm', 'On its way.', ${staffUser})
    `;
  }
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

/** The client's session: granted `mine`, and nothing else. */
const asClient = <T>(fn: (db: postgres.Sql) => Promise<T>): Promise<T> =>
  withPortal(app, tenantId, [mine], fn);

describe("a STAFF session is untouched", () => {
  // THE FIRST TEST TO WRITE WHENEVER A RESTRICTIVE POLICY LANDS, and the one
  // that catches the mistake that has now been made twice: a narrowing written
  // as a bare predicate applies to every session, and the firm loses sight of
  // its own workspace.
  it("reads the whole inbox — both clients", async () => {
    const rows = await withTenant(app, tenantId, (db) => db<{ id: string }[]>`
      SELECT id FROM delivery.client_request WHERE tenant_id = ${tenantId}
    `);
    expect(rows.map((r) => r.id).sort()).toEqual([myRequest, theirRequest].sort());
  });

  it("reads both threads", async () => {
    const rows = await withTenant(app, tenantId, (db) => db<{ id: string }[]>`
      SELECT id FROM delivery.client_request_reply WHERE tenant_id = ${tenantId}
    `);
    expect(rows).toHaveLength(2);
  });

  it("may still write a reply signed as the FIRM", async () => {
    // The half the `NOT crm.is_portal_session() OR ...` guard exists for. With
    // a bare `author_side = 'client'` on the policy this INSERT is refused and
    // the firm cannot answer its own clients.
    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, written_by)
        VALUES (${tenantId}, ${myRequest}, ${mine}, 'firm', 'A second firm reply.',
                ${staffUser})
      `),
    ).resolves.toBeDefined();
  });
});

describe("what a client may READ", () => {
  it("sees their own request and not the other client's", async () => {
    const rows = await asClient((db) => db<{ id: string }[]>`
      SELECT id FROM delivery.client_request WHERE tenant_id = ${tenantId}
    `);
    expect(rows.map((r) => r.id)).toEqual([myRequest]);
  });

  it("cannot reach the other client's request BY ID, which is the version that tries", async () => {
    // Asking for it by id is what an attacker does, and it is the assertion a
    // list-only test misses.
    const rows = await asClient((db) => db<{ id: string }[]>`
      SELECT id FROM delivery.client_request
       WHERE tenant_id = ${tenantId} AND id = ${theirRequest}
    `);
    expect(rows).toEqual([]);
  });

  it("sees their own thread and not the other client's", async () => {
    const rows = await asClient((db) => db<{ request_id: string }[]>`
      SELECT request_id FROM delivery.client_request_reply WHERE tenant_id = ${tenantId}
    `);
    expect(rows.every((r) => r.request_id === myRequest)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("what a client may WRITE — and this is the new part", () => {
  it("raises a request naming their OWN company", async () => {
    const rows = await asClient((db) => db<{ id: string }[]>`
      INSERT INTO delivery.client_request
        (tenant_id, client_party_id, subject, body, raised_by)
      VALUES (${tenantId}, ${mine}, 'A second request', 'body', ${contactUser})
      RETURNING id
    `);
    expect(rows).toHaveLength(1);
  });

  it("CANNOT raise one naming another of the firm's clients", async () => {
    // The whole reason this file exists. The party id came from the caller, and
    // what refuses it is the policy — not the handler, not the zod schema, not
    // the service's scope check, all three of which are also true today and any
    // of which somebody could later "simplify".
    await expect(
      asClient((db) => db`
        INSERT INTO delivery.client_request
          (tenant_id, client_party_id, subject, body, raised_by)
        VALUES (${tenantId}, ${theirs}, 'Send me THEIR balance sheet', 'body',
                ${contactUser})
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("CANNOT post a reply signed as the FIRM", async () => {
    // `author_side` is stored rather than derived (0068 says why), and this is
    // what makes storing it safe.
    await expect(
      asClient((db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, written_by)
        VALUES (${tenantId}, ${myRequest}, ${mine}, 'firm', 'We have sent it.',
                ${contactUser})
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("may post a reply as themselves", async () => {
    await expect(
      asClient((db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, written_by)
        VALUES (${tenantId}, ${myRequest}, ${mine}, 'client', 'That is the wrong year.',
                ${contactUser})
      `),
    ).resolves.toBeDefined();
  });

  it("cannot add to another client's thread even naming their party", async () => {
    await expect(
      asClient((db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, written_by)
        VALUES (${tenantId}, ${theirRequest}, ${theirs}, 'client', 'reading over the fence',
                ${contactUser})
      `),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("what the schema refuses whoever is asking", () => {
  it("is APPEND-ONLY by grant — nobody may edit a reply", async () => {
    // By GRANT and not by trigger, the arrangement `files.document_version`,
    // the ledger and `client_ask_response` all take: a trigger is a rule the
    // table carries, and a missing grant is a permission the role does not
    // hold. An import or an agent walks past the first and not the second.
    await expect(
      withTenant(app, tenantId, (db) => db`
        UPDATE delivery.client_request_reply SET body = 'rewritten'
         WHERE tenant_id = ${tenantId}
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it("holds no DELETE grant on either table", async () => {
    for (const table of ["client_request", "client_request_reply"]) {
      const [row] = await owner<{ has: boolean }[]>`
        SELECT has_table_privilege('bib_app', ${`delivery.${table}`}, 'DELETE') AS has
      `;
      expect(row?.has, `${table} must not be deletable`).toBe(false);
    }
  });

  it("refuses a reply attaching another client's document, or the firm's own", async () => {
    // 0063's composite over `(document_id, client_party_id, tenant_id)`, reused.
    // The second half is the one worth having: `party_id` is NULL on the firm's
    // own papers and no NULL matches a NOT NULL value, so a reply cannot cite
    // the firm's letterhead as something it sent a client.
    for (const documentId of [theirDoc, firmDoc]) {
      await expect(
        withTenant(app, tenantId, (db) => db`
          INSERT INTO delivery.client_request_reply
            (tenant_id, request_id, client_party_id, author_side, body, document_id, written_by)
          VALUES (${tenantId}, ${myRequest}, ${mine}, 'firm', 'here you go', ${documentId},
                  ${staffUser})
        `),
      ).rejects.toThrow(/foreign key|violates/i);
    }
  });

  it("accepts a reply attaching a document filed against THIS client", async () => {
    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, document_id, written_by)
        VALUES (${tenantId}, ${myRequest}, ${mine}, 'firm', 'Your balance sheet.', ${myDoc},
                ${staffUser})
      `),
    ).resolves.toBeDefined();
  });

  it("refuses a CLIENT reply carrying a document at all", async () => {
    // A client with a file to send has an upload route already (T6.6), against
    // an ask on a work item, where it lands in the job's own file. A second,
    // thread-shaped upload path would put it somewhere nobody working the job
    // is looking.
    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, document_id, written_by)
        VALUES (${tenantId}, ${myRequest}, ${mine}, 'client', 'mine', ${myDoc}, ${contactUser})
      `),
    ).rejects.toThrow(/client_request_reply_document_is_the_firms/);
  });

  it("refuses a wall column that disagrees with the request it belongs to", async () => {
    // The composite FK over `(request_id, client_party_id, tenant_id)`: the
    // denormalised column cannot drift from the row it was denormalised out of.
    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO delivery.client_request_reply
          (tenant_id, request_id, client_party_id, author_side, body, written_by)
        VALUES (${tenantId}, ${myRequest}, ${theirs}, 'firm', 'wrong party', ${staffUser})
      `),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("keeps the status and the timestamps saying the same thing", async () => {
    // Two representations of one fact is how a list filtered on `status` and a
    // report joined on `settled_at` come to disagree about the same week.
    await expect(
      withTenant(app, tenantId, (db) => db`
        UPDATE delivery.client_request SET status = 'answered'
         WHERE id = ${myRequest} AND tenant_id = ${tenantId}
      `),
    ).rejects.toThrow(/client_request_status_agrees/);

    await expect(
      withTenant(app, tenantId, (db) => db`
        UPDATE delivery.client_request SET status = 'closed', settled_at = now()
         WHERE id = ${myRequest} AND tenant_id = ${tenantId}
      `),
    ).rejects.toThrow(/client_request_status_agrees/);
  });

  it("refuses a request naming a party of another firm", async () => {
    // A second, different guarantee from the policy above it: that one decides
    // whether the writer may NAME this party, this one whether the party exists
    // at this firm at all.
    const [other] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`request-other-${stamp}`}, 'Another Firm', 'INR') RETURNING id
    `;
    if (!other) throw new Error("could not create the second tenant");
    const [stranger] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${other.id}, 'organization', ${`Stranger ${stamp}`}) RETURNING id
    `;
    if (!stranger) throw new Error("could not create the stranger");

    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO delivery.client_request
          (tenant_id, client_party_id, subject, body, raised_by)
        VALUES (${tenantId}, ${stranger.id}, 'cross-firm', 'body', ${contactUser})
      `),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
