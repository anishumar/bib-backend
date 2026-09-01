// THE ASK'S OWN WALL (T6.6, migration 0063) — and it TRIES, on the WRITE side
// as well as the read.
//
// `gate4.integration.test.ts` proved 0059's policy on `delivery.work_item`;
// `portal-reads.integration.test.ts` proved 0062's two. This is the same
// discipline applied to what 0063 added, and there is more of it than before,
// because these are the first portal tables a client WRITES to:
//
//   `client_ask_portal_scope`          — whose asks a contact sees
//   `client_ask_response_portal_scope` — and whose answers, on the way in
//   `document_portal_scope`            — the file, and never the firm's own
//   `document_version_portal_scope`    — its bytes and its filename
//   `document_link_portal_scope`       — what it is attached to
//
// Every one is checked by asking for the row that must NOT come back — by id,
// with the correct firm — or by attempting the write that must be refused, never
// by asking for the caller's own rows and being pleased when they arrive.
//
// ── HOW THIS FILE WAS CHECKED, WHICH IS THE POINT OF IT ───────────────────
//
// Each assertion was watched go RED with its policy dropped and green with it
// back:
//
//   BEGIN; DROP POLICY client_ask_portal_scope ON delivery.client_ask;
//   -- run this file: the ask reads and the response WRITE all fail
//   ROLLBACK;
//
//   BEGIN; DROP POLICY client_ask_response_portal_scope ON delivery.client_ask_response;
//   -- run this file: the "cannot answer another client's ask" test fails
//   ROLLBACK;
//
//   BEGIN; DROP POLICY document_portal_scope ON files.document;
//   -- run this file: the three document tests fail
//   ROLLBACK;
//
//   BEGIN; DROP POLICY document_version_portal_scope ON files.document_version;
//   -- run this file: the version test fails
//   ROLLBACK;
//
// A test that passes with the wall removed proves only that the rows exist.
//
// Run with:  npm run test:integration
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
let myItem = "";
let theirItem = "";
let hiddenItem = "";
let myAsk = "";
let theirAsk = "";
let hiddenAsk = "";
let myDocument = "";
let theirDocument = "";
let firmDocument = "";
let myVersion = "";
let theirVersion = "";
let firmVersion = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`client-ask-${stamp}`}, 'Client Ask Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`ask-${stamp}@example.test`}, 'Ask Tester') RETURNING id
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

  const item = async (client: string, title: string, clientVisible: boolean): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${tenantId}, ${client}, ${title}, ${state.id}, ${priority.id}, ${clientVisible})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${title}`);
    return row.id;
  };
  myItem = await item(mine, "GST monthly filing", true);
  theirItem = await item(theirs, "TDS quarterly return", true);
  hiddenItem = await item(mine, "Write-off discussion — internal", false);

  const ask = async (workItem: string, client: string, prompt: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.client_ask
        (tenant_id, work_item_id, client_party_id, ask_kind, prompt, document_kind, raised_by)
      VALUES (${tenantId}, ${workItem}, ${client}, 'document', ${prompt}, 'working_paper',
              ${staffUser})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create the ask "${prompt}"`);
    return row.id;
  };
  myAsk = await ask(myItem, mine, "Send the August purchase register");
  theirAsk = await ask(theirItem, theirs, "Send the Q1 TDS challans");
  hiddenAsk = await ask(hiddenItem, mine, "Confirm the write-off");

  const document = async (party: string | null, title: string): Promise<[string, string]> => {
    const [doc] = await owner<{ id: string }[]>`
      INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
      VALUES (${tenantId}, ${title}, 'uploaded', 'working_paper', ${party}) RETURNING id
    `;
    if (!doc) throw new Error(`could not create ${title}`);
    const [version] = await owner<{ id: string }[]>`
      INSERT INTO files.document_version
        (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename,
         storage_key)
      VALUES (${tenantId}, ${doc.id}, 1,
              ${"a".repeat(64)}, 12, 'application/pdf', ${`${title}.pdf`}, ${`k/${title}`})
      RETURNING id
    `;
    if (!version) throw new Error(`could not version ${title}`);
    return [doc.id, version.id];
  };
  [myDocument, myVersion] = await document(mine, "mine");
  [theirDocument, theirVersion] = await document(theirs, "theirs");
  // The firm's OWN document — `party_id` NULL. It is the case the policy decides
  // by accident and the migration writes down on purpose.
  [firmDocument, firmVersion] = await document(null, "letterhead");
});

afterAll(async () => {
  await owner`DELETE FROM delivery.client_ask_response WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.client_ask WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM files.document_link WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM files.document_version WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM files.document WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${staffUser}`;
  await app.end();
  await owner.end();
});

describe("what a portal session may READ of the asks", () => {
  it("a STAFF session is untouched: all three asks are readable", async () => {
    // The first thing to check whenever a restrictive policy lands. If this
    // fails, gate 4 has narrowed the staff workspace — the opposite mistake, and
    // the one that gets blamed on everything else first.
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.client_ask WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(3);
  });

  it("AND IT TRIES: another client's ask, asked for BY ID, comes back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.client_ask WHERE id = ${theirAsk}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a portal session with NO grants sees no asks at all", async () => {
    // The empty list is a real scope and must reach the database as one. If
    // `withPortal` were skipped for an empty list, `app.portal` would be unset,
    // which means STAFF, and this would return three.
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.client_ask WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("sees its own client's asks, including one on a task the firm marked internal", async () => {
    // BOTH halves matter and they are different walls. `client_ask` is scoped by
    // `client_party_id` alone, so the ask on the hidden work item IS visible on
    // this table — what removes it from the portal is the adapter's JOIN to
    // `delivery.work_item`, which 0062's `work_item_portal_visible` filters. The
    // next test is that half.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.client_ask WHERE tenant_id = ${tenantId} ORDER BY raised_at
      `;
    });
    expect(rows.map((r) => r.id).sort()).toEqual([myAsk, hiddenAsk].sort());
  });

  it("and the JOIN to the work item is what hides an ask about work the client cannot see", async () => {
    // The adapter's read is not a bare select — it joins `delivery.work_item`
    // for the task title, and that join is a second wall inherited rather than
    // written. An ask about work the firm marked internal is an ask about
    // nothing, so it disappears with the task.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT a.id
          FROM delivery.client_ask a
          JOIN delivery.work_item wi
            ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
         WHERE a.tenant_id = ${tenantId}
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([myAsk]);
  });
});

describe("what a portal session may WRITE — the half no policy had exercised before", () => {
  it("cannot answer an ask belonging to another of the firm's clients", async () => {
    // 0059 and 0062 wrote `WITH CHECK` when there was no portal write path,
    // saying so at the time. This is that path, and the promise holds: the
    // statement below names the other client's party explicitly and the DATABASE
    // refuses it.
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO delivery.client_ask_response
            (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by)
          VALUES (${tenantId}, ${theirAsk}, ${theirs}, 'answer', 'sneaking in', ${staffUser})
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot smuggle a response onto its OWN scope naming another client's ask", async () => {
    // The composite foreign key is the other half of the wall here: a response
    // claiming `mine` while pointing at `theirAsk` is a row 0063 cannot store,
    // because `(ask_id, client_party_id, tenant_id)` must match a real ask.
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO delivery.client_ask_response
            (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by)
          VALUES (${tenantId}, ${theirAsk}, ${mine}, 'answer', 'sneaking in', ${staffUser})
        `;
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("can answer its own, and cannot then rewrite it", async () => {
    // APPEND-ONLY BY GRANT, the arrangement `files.document_version` and the
    // ledger have. A client's answer is evidence; "they sent the wrong file,
    // then the right one" is a history rather than an overwrite.
    await withPortal(app, tenantId, [mine], async (db) => {
      return db`
        INSERT INTO delivery.client_ask_response
          (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by)
        VALUES (${tenantId}, ${myAsk}, ${mine}, 'answer', 'we hold none', ${staffUser})
      `;
    });

    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`
          UPDATE delivery.client_ask_response SET answer_text = 'rewritten'
           WHERE tenant_id = ${tenantId}
        `;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a work item whose client does not match the ask's own column", async () => {
    // The composite FK on the ASK, which is what makes the denormalised wall
    // column a guarantee rather than a hope. `theirItem` belongs to `theirs`,
    // so an ask naming `mine` against it is unwritable — even by the firm.
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`
          INSERT INTO delivery.client_ask
            (tenant_id, work_item_id, client_party_id, ask_kind, prompt, raised_by)
          VALUES (${tenantId}, ${theirItem}, ${mine}, 'question', 'whose is this', ${staffUser})
        `;
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("the document store, reached from the portal (0063's other three policies)", () => {
  it("a STAFF session still reads all three documents", async () => {
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(3);
  });

  it("AND IT TRIES: another client's document, asked for BY ID, comes back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE id = ${theirDocument}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("NULL party_id means the FIRM'S OWN, and a client sees none of it", async () => {
    // The case the migration writes down because it does not look deliberate in
    // the SQL: `crm.portal_sees(NULL)` is `NULL = ANY(granted)`, which is NULL,
    // which is not true, which is zero rows. Somebody "tidying" that to
    // `OR party_id IS NULL` would hand every client the firm's stationery
    // cupboard, and this test is what would stop them.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM files.document WHERE tenant_id = ${tenantId} ORDER BY title
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([myDocument]);
    expect(rows.map((r) => r.id)).not.toContain(firmDocument);
  });

  it("the BYTES follow their document, including the firm's own", async () => {
    // `files.document_version` has no party column: its policy is an EXISTS on
    // the parent, and RLS applies to that subquery too, so a version is readable
    // exactly when its document is. One edit decides both, which is the point —
    // two walls to keep in step is how they drift.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM files.document_version WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([myVersion]);
    expect(rows.map((r) => r.id)).not.toContain(theirVersion);
    expect(rows.map((r) => r.id)).not.toContain(firmVersion);
  });

  it("a storage key for another client's file is unreachable, which is what makes 'no pre-signed URL' hold", async () => {
    // T3.6's design position: bytes leave by ONE route and the version row
    // naming the storage key is read under RLS, which makes the key unreachable
    // before it could be used. That claim is only true if the version table is
    // guarded, and until 0063 it was not.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ storage_key: string }[]>`
        SELECT storage_key FROM files.document_version WHERE id = ${theirVersion}
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("cannot attach anything to a document it does not own", async () => {
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO files.document_link (tenant_id, document_id, subject_kind, subject_ref)
          VALUES (${tenantId}, ${theirDocument}, 'work_item', ${theirItem})
        `;
      }),
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  it("accepts `work_item` as a subject kind, which 0063 added for this", async () => {
    // The acceptance line — a client upload files itself against the job that
    // asked for it — needs the vocabulary to contain the job. Adding a kind is a
    // migration AND a case in `linksOf`'s label resolution; this is the first
    // half, asserted.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        INSERT INTO files.document_link (tenant_id, document_id, subject_kind, subject_ref)
        VALUES (${tenantId}, ${myDocument}, 'work_item', ${myItem})
        RETURNING id
      `;
    });
    expect(rows).toHaveLength(1);
  });
});
