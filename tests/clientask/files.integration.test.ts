// Several files on one ask, and a colleague uploading on the client's behalf,
// against real Postgres (docs/FIN_BUILD_PLAN.md F1.6, migration 0390).
//
// What only the database can show, each asserted on the rows themselves:
//
//   · three files sent to one ask store THREE documents, THREE versions, THREE
//     links to the work item and THREE responses, through the portal's own
//     `withPortal` path (F1.6's first check);
//   · a batch lands whole or not at all: a batch that fails on its second file
//     leaves no trace of its first;
//   · an on-behalf upload is recorded with the STAFF actor and marked
//     `on_behalf`, stored otherwise exactly as the client's upload is (F1.6's
//     second check), and the client's read names nobody at the firm;
//   · 0390's policy: a portal session cannot write `on_behalf`, and the firm can
//     (the guard is 0062's shape, and dropping it would lock the firm out);
//   · FinCompliance takes an on-behalf `books_input` upload in: its candidate
//     query and its sweep see it, because it is `origin = 'uploaded'`.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";
import { PostgresClientAskRepository } from "../../src/infrastructure/postgres/client-ask-repository";
import { PostgresPortalAskRepository } from "../../src/infrastructure/postgres/portal-ask-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import {
  PostgresFinFirms,
  PostgresIntakeCandidates,
  PostgresIntakeRepository,
} from "../../src/infrastructure/fin/postgres-intake";
import { ClientAskService } from "../../src/usecase/clientask/service";
import type { UploadFile } from "../../src/usecase/clientask/service";
import { FinIntakeService } from "../../src/usecase/fin/intake";
import { takenKinds } from "../../src/domain/fin/intake";
import { DOCUMENT_KINDS } from "../../src/domain/filestore/model";
import { AskAlreadySettled } from "../../src/domain/clientask/errors";
import { FakeAskScope } from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import { systemIds } from "../../src/platform/ids";
import type { IdGen } from "../../src/platform/ids";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 3 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
let staffUser = "";
let contactUser = "";
let mine = "";
let theirs = "";
let myItem = "";
let theirItem = "";

function service(ids: IdGen = systemIds, events = new RecordingEventSink()) {
  return {
    events,
    service: new ClientAskService({
      asks: new PostgresClientAskRepository(app),
      portal: new PostgresPortalAskRepository(app),
      scope: new FakeAskScope().grant(contactUser, mine),
      blobs: new FakeBlobStore(),
      digest: new FakeContentDigest(),
      ids,
      events,
      clock: new FakeClock(new Date()),
      timeZones: new PostgresFirmTimeZone(app),
      maxUploadBytes: 1_000_000,
    }),
  };
}

const staff = () => ({ type: "human" as const, id: staffUser });
const contact = () => ({ type: "human" as const, id: contactUser });

/** Distinct bytes per file (the store is content-addressed), starting %PDF-. */
function pdf(name: string, seed: string): UploadFile {
  return { filename: name, mediaType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.7 ${seed} ${stamp}`) };
}

async function ask(workItem: string, client: string, prompt: string, kind = "books_input"): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.client_ask
      (tenant_id, work_item_id, client_party_id, ask_kind, prompt, document_kind, raised_by)
    VALUES (${tenantId}, ${workItem}, ${client}, 'document', ${prompt}, ${kind}, ${staffUser})
    RETURNING id
  `;
  if (!row) throw new Error(`could not create the ask "${prompt}"`);
  return row.id;
}

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status, fin_enabled_since)
    VALUES (${`ask-files-${stamp}`}, 'Ask Files Test', 'SGD', 'active', now() - interval '1 minute')
    RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const user = async (who: string, name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name)
      VALUES (${`${who}-${stamp}@example.test`}, ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${who}`);
    return row.id;
  };
  staffUser = await user("files-staff", "Aarav Menon");
  contactUser = await user("files-contact", "Meera Iyer");

  const party = async (name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${name}`);
    return row.id;
  };
  mine = await party(`Lumen Cloudworks ${stamp}`);
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
  theirItem = await item(theirs, "Monthly close · Oct 2026");
});

afterAll(async () => {
  await owner`DELETE FROM fin.intake_item WHERE tenant_id = ${tenantId}`;
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
  await owner`DELETE FROM tenancy.user_account WHERE id IN (${staffUser}, ${contactUser})`;
  await app.end();
  await owner.end();
});

interface StoredRow {
  document_id: string;
  kind: string;
  origin: string;
  party_id: string | null;
  is_client_visible: boolean;
  created_by: string | null;
  versions: number;
  links_to_item: number;
  responded_by: string;
  on_behalf: boolean;
  response_client: string;
}

/** Everything an ask's uploads wrote, one row per response, read as the owner. */
async function stored(askId: string): Promise<StoredRow[]> {
  return owner<StoredRow[]>`
    SELECT d.id AS document_id, d.kind, d.origin, d.party_id, d.is_client_visible, d.created_by,
           (SELECT count(*)::int FROM files.document_version v WHERE v.document_id = d.id) AS versions,
           (SELECT count(*)::int FROM files.document_link l
             WHERE l.document_id = d.id AND l.subject_kind = 'work_item'
               AND l.subject_ref = a.work_item_id) AS links_to_item,
           r.responded_by, r.on_behalf, r.client_party_id AS response_client
      FROM delivery.client_ask_response r
      JOIN delivery.client_ask a ON a.id = r.ask_id
      JOIN files.document d ON d.id = r.document_id
     WHERE r.ask_id = ${askId}
     ORDER BY r.id
  `;
}

describe("several files on one ask, through the portal's own path", () => {
  it("stores 3 versions for 3 files: three documents, versions, links and responses", async () => {
    const askId = await ask(myItem, mine, "October bank statements");
    const { service: s, events } = service();
    const row = await s.upload({
      tenantId,
      userId: contactUser,
      askId,
      files: [pdf("hdfc.pdf", "a"), pdf("icici.pdf", "b"), pdf("amex.pdf", "c")],
      note: "All three accounts.",
      actor: contact(),
    });
    expect(row.status).toBe("answered");
    expect(row.responses).toHaveLength(3);
    // Sent together, so one instant: ordered by filename on every read.
    expect(row.responses.map((r) => r.document?.filename)).toEqual(["amex.pdf", "hdfc.pdf", "icici.pdf"]);

    const rows = await stored(askId);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        kind: "books_input",
        origin: "uploaded",
        party_id: mine,
        is_client_visible: true,
        created_by: contactUser,
        versions: 1,
        links_to_item: 1,
        responded_by: contactUser,
        on_behalf: false,
        response_client: mine,
      });
    }
    const [answered] = await owner<{ status: string; first_answered_at: string | null }[]>`
      SELECT status, first_answered_at::text FROM delivery.client_ask WHERE id = ${askId}
    `;
    expect(answered).toMatchObject({ status: "answered" });
    expect(answered?.first_answered_at).not.toBeNull();
    expect(events.recorded.filter((e) => e.verb === "client_ask.answered")).toHaveLength(3);
  });

  it("lands whole or not at all: a batch that fails on its second file leaves nothing of its first", async () => {
    const askId = await ask(myItem, mine, "October purchase invoices");
    // The second file's document is given the FIRST file's id, so its INSERT
    // is refused by the primary key inside the batch's transaction.
    let n = 0;
    const repeat = "00000000-0000-4000-8000-" + stamp.slice(-12).padStart(12, "0");
    const ids: IdGen = {
      newId: () => {
        n += 1;
        // Calls run per file: response, document, version, link.
        return n === 2 || n === 6 ? repeat : systemIds.newId();
      },
      derivedId: systemIds.derivedId,
    };
    const { service: s } = service(ids);
    await expect(
      s.upload({
        tenantId,
        userId: contactUser,
        askId,
        files: [pdf("one.pdf", "d"), pdf("two.pdf", "e")],
        note: null,
        actor: contact(),
      }),
    ).rejects.toThrow();
    expect(await stored(askId)).toHaveLength(0);
    const [doc] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM files.document WHERE id = ${repeat}`;
    expect(doc?.n).toBe(0);
    const [still] = await owner<{ status: string }[]>`SELECT status FROM delivery.client_ask WHERE id = ${askId}`;
    expect(still?.status).toBe("open");
  });

  it("writes nothing for another client's ask, named by id: the scope is the wall", async () => {
    const theirAsk = await ask(theirItem, theirs, "Their statements");
    const { service: s } = service();
    await expect(
      s.upload({
        tenantId,
        userId: contactUser,
        askId: theirAsk,
        files: [pdf("sneak.pdf", "f")],
        note: null,
        actor: contact(),
      }),
    ).rejects.toThrow();
    // And past the service, straight to the adapter with the wrong scope.
    const direct = await new PostgresPortalAskRepository(app).respondWithDocuments(tenantId, [mine], [
      {
        response: {
          id: systemIds.newId(),
          tenantId,
          askId: theirAsk,
          responseKind: "document",
          answerText: null,
          decision: null,
          respondedBy: contactUser,
        },
        upload: {
          documentId: systemIds.newId(),
          versionId: systemIds.newId(),
          linkId: systemIds.newId(),
          title: "sneak.pdf",
          documentKind: "books_input",
          contentHash: "f".repeat(64),
          byteSize: 3,
          mediaType: "application/pdf",
          filename: "sneak.pdf",
          storageKey: `k/sneak-${stamp}`,
        },
      },
    ]);
    expect(direct).toBeNull();
    expect(await stored(theirAsk)).toHaveLength(0);
  });
});

describe("a colleague uploading on the client's behalf", () => {
  it("is recorded with the STAFF actor and marked on_behalf, stored otherwise as the client's own", async () => {
    const askId = await ask(myItem, mine, "October expense claims");
    const { service: s, events } = service();
    const record = await s.uploadOnBehalf({
      tenantId,
      askId,
      files: [pdf("claims-1.pdf", "g"), pdf("claims-2.pdf", "h")],
      note: "Emailed on 3 Nov.",
      actor: staff(),
    });
    expect(record.ask.status).toBe("answered");
    expect(record.responses.every((r) => r.response.onBehalf)).toBe(true);
    // The FIRM's read names the colleague.
    expect(record.responses.every((r) => r.respondedByName === "Aarav Menon")).toBe(true);

    const rows = await stored(askId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        kind: "books_input",
        origin: "uploaded",
        party_id: mine,
        is_client_visible: true,
        created_by: staffUser,
        versions: 1,
        links_to_item: 1,
        responded_by: staffUser,
        on_behalf: true,
        response_client: mine,
      });
    }
    const answered = events.recorded.filter((e) => e.verb === "client_ask.answered");
    expect(answered).toHaveLength(2);
    expect(answered.every((e) => e.actorId === staffUser && e.payload["onBehalf"] === true)).toBe(true);
  });

  it("reads on the client's side as the firm's, naming nobody at the firm", async () => {
    const askId = await ask(myItem, mine, "October payroll");
    const { service: s } = service();
    await s.uploadOnBehalf({ tenantId, askId, files: [pdf("payroll.pdf", "i")], note: null, actor: staff() });
    const portalRow = await new PostgresPortalAskRepository(app).findById(tenantId, [mine], askId);
    const sent = portalRow?.responses[0];
    expect(sent?.response.onBehalf).toBe(true);
    expect(sent?.respondedByName).toBeNull();
    expect(sent?.document?.filename).toBe("payroll.pdf");
  });

  it("refuses an ask the firm has closed, and writes nothing", async () => {
    const askId = await ask(myItem, mine, "October cash book");
    await owner`
      UPDATE delivery.client_ask SET status = 'closed', closed_by = ${staffUser}, closed_at = now()
       WHERE id = ${askId}
    `;
    const { service: s } = service();
    await expect(
      s.uploadOnBehalf({ tenantId, askId, files: [pdf("late.pdf", "j")], note: null, actor: staff() }),
    ).rejects.toBeInstanceOf(AskAlreadySettled);
    expect(await stored(askId)).toHaveLength(0);
  });
});

/**
 * The firm closes the ask in a transaction held open while an upload starts,
 * and commits once the upload is seen WAITING on the ask's row lock. Without
 * the lock the upload read the ask as open, wrote its documents, and found the
 * ask closed only at the last statement, leaving files filed against an ask
 * that refused them. With it the upload waits, re-reads, and writes nothing.
 */
async function closeWhileUploading(askId: string, upload: () => Promise<unknown>): Promise<{ waited: boolean; outcome: unknown }> {
  let pending: Promise<unknown> = Promise.resolve();
  let waited = false;
  await owner.begin(async (tx) => {
    await tx`
      UPDATE delivery.client_ask SET status = 'closed', closed_by = ${staffUser}, closed_at = now()
       WHERE id = ${askId}
    `;
    pending = upload().then(
      (v) => v,
      (err: unknown) => err,
    );
    for (let i = 0; i < 60 && !waited; i += 1) {
      const [row] = await app<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR NO KEY UPDATE%'
      `;
      waited = (row?.n ?? 0) > 0;
      if (!waited) await new Promise((r) => setTimeout(r, 50));
    }
  });
  return { waited, outcome: await pending };
}

describe("a close that lands while files are being written", () => {
  it("the client's upload waits for it, then writes nothing", async () => {
    const askId = await ask(myItem, mine, "Race: client");
    const { service: s } = service();
    const { waited, outcome } = await closeWhileUploading(askId, () =>
      s.upload({
        tenantId,
        userId: contactUser,
        askId,
        files: [pdf("r1.pdf", "l"), pdf("r2.pdf", "m")],
        note: null,
        actor: contact(),
      }),
    );
    expect(await stored(askId)).toHaveLength(0);
    expect(outcome).toBeInstanceOf(AskAlreadySettled);
    expect(waited).toBe(true);
  });

  it("the colleague's upload waits for it, then writes nothing", async () => {
    const askId = await ask(myItem, mine, "Race: colleague");
    const { service: s } = service();
    const { waited, outcome } = await closeWhileUploading(askId, () =>
      s.uploadOnBehalf({ tenantId, askId, files: [pdf("r3.pdf", "n")], note: null, actor: staff() }),
    );
    expect(await stored(askId)).toHaveLength(0);
    expect(outcome).toBeInstanceOf(AskAlreadySettled);
    expect(waited).toBe(true);
  });
});

describe("0390's policy: on_behalf is the firm's to write", () => {
  it("refuses a portal session writing a response marked on the client's behalf", async () => {
    const askId = await ask(myItem, mine, "Policy check");
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO delivery.client_ask_response
            (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by, on_behalf)
          VALUES (${tenantId}, ${askId}, ${mine}, 'answer', 'pretending to be the firm', ${contactUser}, true)
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets the portal session write its own response, and the FIRM write one on the client's behalf", async () => {
    // The guard's other half: a bare `NOT on_behalf` would refuse the firm too.
    const askId = await ask(myItem, mine, "Policy check, other half");
    await withPortal(app, tenantId, [mine], async (db) => {
      return db`
        INSERT INTO delivery.client_ask_response
          (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by)
        VALUES (${tenantId}, ${askId}, ${mine}, 'answer', 'we hold none', ${contactUser})
      `;
    });
    await withTenant(app, tenantId, async (db) => {
      return db`
        INSERT INTO delivery.client_ask_response
          (tenant_id, ask_id, client_party_id, response_kind, answer_text, responded_by, on_behalf)
        VALUES (${tenantId}, ${askId}, ${mine}, 'answer', 'they said so on the phone', ${staffUser}, true)
      `;
    });
    const rows = await owner<{ on_behalf: boolean }[]>`
      SELECT on_behalf FROM delivery.client_ask_response WHERE ask_id = ${askId} ORDER BY on_behalf
    `;
    expect(rows.map((r) => r.on_behalf)).toEqual([false, true]);
  });

  it("cannot be changed afterwards: responses are append-only by grant", async () => {
    await expect(
      withTenant(app, tenantId, async (db) => {
        return db`UPDATE delivery.client_ask_response SET on_behalf = false WHERE tenant_id = ${tenantId}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("FinCompliance takes an on-behalf upload in", () => {
  it("offers it to the intake sweep as a candidate, and the sweep takes it", async () => {
    const askId = await ask(myItem, mine, "October sales invoices");
    const { service: s } = service();
    const record = await s.uploadOnBehalf({
      tenantId,
      askId,
      files: [pdf("sales-oct.pdf", "k")],
      note: null,
      actor: staff(),
    });
    const documentId = record.responses[0]?.document?.documentId ?? "";
    const [version] = await owner<{ id: string }[]>`
      SELECT id FROM files.document_version WHERE document_id = ${documentId}
    `;
    const versionId = version?.id ?? "";

    const candidates = await new PostgresIntakeCandidates(app).untaken(tenantId, takenKinds(DOCUMENT_KINDS), 500);
    expect(candidates.map((c) => c.documentVersionId)).toContain(versionId);
    expect(candidates.find((c) => c.documentVersionId === versionId)).toMatchObject({ clientPartyId: mine });

    const intake = new FinIntakeService({
      firms: new PostgresFinFirms(app),
      candidates: new PostgresIntakeCandidates(app),
      items: new PostgresIntakeRepository(app),
      events: new RecordingEventSink(),
      ids: systemIds,
    });
    await intake.sweepFirm(tenantId);
    const [taken] = await owner<{ route: string; client_party_id: string | null }[]>`
      SELECT route, client_party_id FROM fin.intake_item
       WHERE tenant_id = ${tenantId} AND document_version_id = ${versionId}
    `;
    expect(taken).toMatchObject({ route: "pdf", client_party_id: mine });
  });
});
