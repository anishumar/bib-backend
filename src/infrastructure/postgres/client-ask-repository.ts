// The firm's side of a client-directed ask, in Postgres (T6.6). `withTenant` —
// this is the STAFF surface, and the portal's own adapter is the file beside it.
//
// ── THE CLIENT IS READ FROM THE WORK ITEM, NEVER TAKEN FROM THE CALLER ────
//
// `raise` inserts `client_party_id` from a SELECT over `delivery.work_item`. The
// composite foreign key in 0063 would refuse a mismatch anyway, but a value that
// cannot be supplied is one fewer thing that has to hold: the column gate 4
// filters this row on is not something any caller — handler, test or future
// import — is in a position to choose.
//
// Zero rows from that SELECT is "no such work item at this firm", which is the
// one refusal this write can make, and it is why `raise` returns null rather
// than throwing: the refusal belongs to the use case, which owns the sentence.
//
// ── ONE READ SHAPE, USED BY EVERY METHOD ─────────────────────────────────
//
// `raise` and `settle` both end by re-reading the row through the same query the
// list uses, so a caller never sees a half-joined record and the three cannot
// drift into three different shapes of the same thing. It costs a round trip on
// a write, which is not the expensive part of a write.
//
// ── AND THE RESPONSES COME WITH IT ───────────────────────────────────────
//
// Aggregated in SQL rather than fetched per ask — the per-row lookup this
// codebase has been caught by six times. An ask rendered without its answers is
// a list of questions nobody can tell apart.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  AskChaseRecord,
  AskDecision,
  AskKind,
  AskRecord,
  AskResponseRecord,
  AskStatus,
  ResponseKind,
} from "../../domain/clientask/model";
import type { DocumentKind } from "../../domain/filestore/model";
import type {
  AskRepository,
  DocumentResponse,
  NewAsk,
  NewTemplateAsk,
  TemplateAskInsert,
} from "../../usecase/clientask/ports";
import { isoInstant } from "./instant";

interface AskRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  client_party_id: string;
  ask_kind: string;
  prompt: string;
  document_kind: string | null;
  status: string;
  raised_by: string | null;
  raised_at: string;
  first_answered_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  /** `due_on::text` — a DAY as `YYYY-MM-DD`, never a `Date` (see `select`). */
  due_on: string | null;
  request_template_version_id: string | null;
  request_template_key: string | null;
  request_item_key: string | null;
  client_name: string;
  raised_by_name: string | null;
  closed_by_name: string | null;
  responses: RawResponse[] | null;
  chases: RawChase[] | null;
}

/** One row of `delivery.client_ask_chase`, as the aggregate hands it back.
 *  `after_days` and `days_open` are `integer`, so postgres.js gives numbers —
 *  unlike `byte_size`, which is `bigint` and arrives as a string. */
interface RawChase {
  rung_key: string;
  after_days: number;
  days_open: number;
  chased_at: string;
}

export interface RawResponse {
  id: string;
  response_kind: string;
  answer_text: string | null;
  document_id: string | null;
  decision: string | null;
  responded_at: string;
  /** 0390: the firm recorded it for the client. */
  on_behalf: boolean;
  responded_by_name: string | null;
  filename: string | null;
  byte_size: string | number | null;
  media_type: string | null;
}

export class PostgresClientAskRepository implements AskRepository {
  constructor(private readonly app: Db) {}

  async raise(ask: NewAsk): Promise<AskRecord | null> {
    return withTenant(this.app, ask.tenantId, async (db) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO delivery.client_ask
          (id, tenant_id, work_item_id, client_party_id, ask_kind, prompt, document_kind,
           raised_by, due_on)
        SELECT ${ask.id},
               ${ask.tenantId},
               wi.id,
               -- THE WALL COLUMN, TAKEN FROM THE WORK ITEM. See the header.
               wi.client_party_id,
               ${ask.askKind},
               ${ask.prompt},
               ${ask.documentKind},
               ${ask.raisedBy},
               ${ask.dueOn}::date
          FROM delivery.work_item wi
         WHERE wi.id = ${ask.workItemId}
           AND wi.tenant_id = ${ask.tenantId}
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, ask.tenantId, ask.id);
    });
  }

  /**
   * A template's ask, at most once (0385).
   *
   * `ON CONFLICT … DO NOTHING` names 0385's partial unique index by its columns
   * AND its predicate — Postgres infers a partial index only when the WHERE is
   * repeated — so a second sweep over the same item writes nothing and returns
   * no row. Two sweeps racing: the second INSERT waits on the first's
   * uncommitted row, then skips it. No read before the write, so there is no
   * window to lose.
   *
   * Zero rows back is then one of two things, told apart in the same
   * transaction: the item was already raised on this task, or there is no such
   * work item at this firm (the SELECT feeding the INSERT found nothing). The
   * second is a refusal; the first is the sweep's ordinary second pass.
   *
   * `raised_by` is NOT in the column list: NULL is the honest raiser of a
   * template's ask, and 0385's CHECK accepts it only because the template
   * columns are set in the same row.
   */
  async raiseFromTemplate(ask: NewTemplateAsk): Promise<TemplateAskInsert> {
    return withTenant(this.app, ask.tenantId, async (db) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO delivery.client_ask
          (id, tenant_id, work_item_id, client_party_id, ask_kind, prompt, document_kind,
           due_on, request_template_version_id, request_template_key, request_item_key)
        SELECT ${ask.id},
               ${ask.tenantId},
               wi.id,
               -- THE WALL COLUMN, TAKEN FROM THE WORK ITEM. See the header.
               wi.client_party_id,
               ${ask.askKind},
               ${ask.prompt},
               ${ask.documentKind},
               ${ask.dueOn}::date,
               ${ask.template.versionId}::uuid,
               ${ask.template.templateKey},
               ${ask.template.itemKey}
          FROM delivery.work_item wi
         WHERE wi.id = ${ask.workItemId}
           AND wi.tenant_id = ${ask.tenantId}
        ON CONFLICT (tenant_id, work_item_id, request_template_key, request_item_key)
          WHERE request_item_key IS NOT NULL
          DO NOTHING
        RETURNING id
      `;
      if (row) {
        const record = await this.read(db, ask.tenantId, ask.id);
        // Unreachable: the row was inserted in this transaction and is read
        // through the same tenant scope. THROWN, so the transaction rolls the
        // insert back: answering "already raised" would leave a row the ledger
        // never hears about, and "created" with no record cannot be said.
        if (record === null) {
          throw new Error(
            `client_ask ${ask.id} was inserted for work item ${ask.workItemId} and could not be ` +
              `read back in the same transaction; nothing was kept`,
          );
        }
        return { outcome: "created", record };
      }
      const [item] = await db<{ id: string }[]>`
        SELECT id FROM delivery.work_item
         WHERE id = ${ask.workItemId} AND tenant_id = ${ask.tenantId}
      `;
      return item ? { outcome: "already_raised" } : { outcome: "no_work_item" };
    });
  }

  async listForWorkItem(tenantId: string, workItemId: string): Promise<readonly AskRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await this.select(db, tenantId, { workItemId });
      return rows.map(toRecord);
    });
  }

  async findById(tenantId: string, askId: string): Promise<AskRecord | null> {
    return withTenant(this.app, tenantId, (db) => this.read(db, tenantId, askId));
  }

  async settle(input: {
    readonly tenantId: string;
    readonly askId: string;
    readonly status: "closed" | "withdrawn";
    readonly closedBy: string;
  }): Promise<AskRecord | null> {
    return withTenant(this.app, input.tenantId, async (db) => {
      // The status, the closer and the instant move together — 0063's own CHECK
      // says the same thing, and an UPDATE that set two of the three would be
      // refused by it. The WHERE is what makes a double-click a no-op rather
      // than a second closure over the first: it would move the date somebody
      // is answering questions about.
      const [row] = await db<{ id: string }[]>`
        UPDATE delivery.client_ask
           SET status    = ${input.status},
               closed_by = ${input.closedBy},
               closed_at = now()
         WHERE id = ${input.askId}
           AND tenant_id = ${input.tenantId}
           AND status IN ('open', 'answered')
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, input.tenantId, input.askId);
    });
  }

  /**
   * Files the client sent another way, on the ask, on their behalf (0390, F1.6).
   *
   * ── THE ASK IS LOCKED FIRST, SO A BATCH LANDS WHOLE OR NOT AT ALL ──────
   *
   * `FOR NO KEY UPDATE`, the lock the closing UPDATE takes itself, in its own
   * statement before anything is written. Without it a colleague closing the
   * ask between the first file's INSERT and the last file's would leave half a
   * batch filed against an ask that refuses the rest; with it the close waits
   * for this transaction and then finds the ask answered. Any statement that
   * still writes nothing after the lock is a contradiction, and throwing rolls
   * the whole batch back rather than committing part of it.
   *
   * ── STORED AS THE CLIENT'S UPLOAD IS, EXCEPT WHO ────────────────────────
   *
   * The same four rows `PostgresPortalAskRepository.respondWithDocuments`
   * writes, with the same values taken from the ask inside each INSERT (the
   * document's party, the response's client, the work item the link files it
   * against), and `origin = 'uploaded'` so FinCompliance's intake takes a
   * `books_input` file whichever door it came through. Two columns differ:
   * `created_by` / `responded_by` are the colleague, and `on_behalf` is TRUE.
   * Written here rather than through the portal adapter because this is the
   * firm's side, under `withTenant`, and 0390's policy refuses `on_behalf` to a
   * portal session anyway.
   */
  async respondOnBehalf(
    tenantId: string,
    askId: string,
    files: readonly DocumentResponse[],
  ): Promise<AskRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [held] = await db<{ id: string }[]>`
        SELECT id FROM delivery.client_ask
         WHERE id = ${askId} AND tenant_id = ${tenantId} AND status IN ('open', 'answered')
           FOR NO KEY UPDATE
      `;
      if (!held) return null;

      for (const { response, upload } of files) {
        const [doc] = await db<{ id: string }[]>`
          INSERT INTO files.document
            (id, tenant_id, title, origin, kind, party_id, is_client_visible, created_by)
          SELECT ${upload.documentId}, ${tenantId}, ${upload.title}, 'uploaded',
                 ${upload.documentKind}, a.client_party_id,
                 -- CLIENT-VISIBLE, as the portal upload is: the client's own file,
                 -- sent another way (0390's header and the service's comment).
                 true,
                 ${response.respondedBy}
            FROM delivery.client_ask a
           WHERE a.id = ${askId} AND a.tenant_id = ${tenantId}
          RETURNING id
        `;
        if (!doc) throw unwritable(askId, "document");

        await db`
          INSERT INTO files.document_version
            (id, tenant_id, document_id, version_no, content_hash, byte_size,
             media_type, filename, storage_key, created_by)
          VALUES (${upload.versionId}, ${tenantId}, ${upload.documentId}, 1,
                  ${upload.contentHash}, ${upload.byteSize}, ${upload.mediaType},
                  ${upload.filename}, ${upload.storageKey}, ${response.respondedBy})
        `;

        await db`
          INSERT INTO files.document_link
            (id, tenant_id, document_id, subject_kind, subject_ref, role, created_by)
          SELECT ${upload.linkId}, ${tenantId}, ${upload.documentId}, 'work_item',
                 a.work_item_id, 'client_response', ${response.respondedBy}
            FROM delivery.client_ask a
           WHERE a.id = ${askId} AND a.tenant_id = ${tenantId}
        `;

        const [resp] = await db<{ id: string }[]>`
          INSERT INTO delivery.client_ask_response
            (id, tenant_id, ask_id, client_party_id, response_kind, answer_text,
             document_id, decision, responded_by, on_behalf)
          SELECT ${response.id}, ${tenantId}, a.id, a.client_party_id,
                 ${response.responseKind}, ${response.answerText}, ${upload.documentId},
                 ${response.decision}, ${response.respondedBy}, true
            FROM delivery.client_ask a
           WHERE a.id = ${askId} AND a.tenant_id = ${tenantId}
          RETURNING id
        `;
        if (!resp) throw unwritable(askId, "response");
      }

      // `open → answered`, and `first_answered_at` only ever set once: the
      // client did answer, through the firm.
      await db`
        UPDATE delivery.client_ask
           SET status = 'answered',
               first_answered_at = coalesce(first_answered_at, now())
         WHERE id = ${askId} AND tenant_id = ${tenantId}
      `;
      const record = await this.read(db, tenantId, askId);
      if (record === null) throw unwritable(askId, "read back");
      return record;
    });
  }

  private async read(db: Db, tenantId: string, askId: string): Promise<AskRecord | null> {
    const rows = await this.select(db, tenantId, { askId });
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The one query. `askId` and `workItemId` are both optional and exactly one is
   * ever supplied; `IS NULL OR` rather than two statements, so the joins and the
   * response aggregate are written once.
   */
  private select(
    db: Db,
    tenantId: string,
    filter: { askId?: string; workItemId?: string },
  ): Promise<AskRow[]> {
    return db<AskRow[]>`
      SELECT a.id,
             a.tenant_id,
             a.work_item_id,
             a.client_party_id,
             a.ask_kind,
             a.prompt,
             a.document_kind,
             a.status,
             a.raised_by,
             ${db.unsafe(isoInstant("a.raised_at", "raised_at"))},
             ${db.unsafe(isoInstant("a.first_answered_at", "first_answered_at"))},
             a.closed_by,
             ${db.unsafe(isoInstant("a.closed_at", "closed_at"))},
             -- A DAY, AS TEXT. postgres.js would hand a date column back as a JS
             -- Date at UTC midnight, which names the day before anywhere west of
             -- Greenwich; ::text constructs no Date and involves no zone
             -- (CLAUDE.md, "A date column is a DAY").
             a.due_on::text AS due_on,
             a.request_template_version_id,
             a.request_template_key,
             a.request_item_key,
             cp.display_name    AS client_name,
             -- LEFT joins, and null is a real answer: an erased account stops
             -- resolving and the ask survives, exactly as the ledger's actor
             -- join does.
             raiser.display_name AS raised_by_name,
             closer.display_name AS closed_by_name,
             (
               SELECT coalesce(
                        -- Files sent together share one instant (one transaction,
                        -- F1.6), so the filename and then the id order them the
                        -- same way on every read.
                        jsonb_agg(r ORDER BY r.responded_at, r.filename, r.id),
                        '[]'::jsonb
                      )
                 FROM (
                   SELECT resp.id,
                          resp.response_kind,
                          resp.answer_text,
                          resp.document_id,
                          resp.decision,
                          ${db.unsafe(isoInstant("resp.responded_at", "responded_at"))},
                          resp.on_behalf,
                          -- The colleague who added it, when the firm did (0390):
                          -- on the FIRM's screen that is exactly who it should name.
                          responder.display_name  AS responded_by_name,
                          dv.filename,
                          dv.byte_size,
                          dv.media_type
                     FROM delivery.client_ask_response resp
                     LEFT JOIN tenancy.user_account responder
                       ON responder.id = resp.responded_by
                     -- The FIRST version, because a client's upload creates the
                     -- document and its only version in one act. A document that
                     -- later grew versions did so through the firm's own screen,
                     -- and what the client SENT is version 1.
                     LEFT JOIN files.document_version dv
                       ON dv.document_id = resp.document_id
                      AND dv.tenant_id = resp.tenant_id
                      AND dv.version_no = 1
                    WHERE resp.ask_id = a.id
                      AND resp.tenant_id = a.tenant_id
                 ) r
             ) AS responses,
             -- ── THE CHASER'S OWN ROWS, AND THE READER THEY WAITED FOR ───
             --
             -- delivery.client_ask_chase (0065) had a writer, a portal
             -- policy and a ledger event, and NOTHING rendered it. A colleague
             -- opening this task could not see that the sweep had already
             -- reminded this client three times, so the next thing they would
             -- do is chase it a fourth time by hand — which is the work T4.4
             -- exists to remove.
             --
             -- Aggregated here rather than fetched per ask, for the reason the
             -- responses are: the per-row lookup is the mistake this codebase
             -- has been caught by six times. OLDEST FIRST, unlike the asks
             -- themselves, because a ladder is read as a sequence — "first,
             -- then second, then final" — and reversing it makes a cadence
             -- look like it ran backwards.
             (
               SELECT coalesce(jsonb_agg(ch ORDER BY ch.chased_at), '[]'::jsonb)
                 FROM (
                   SELECT c.rung_key,
                          c.after_days,
                          c.days_open,
                          ${db.unsafe(isoInstant("c.chased_at", "chased_at"))}
                     FROM delivery.client_ask_chase c
                    WHERE c.ask_id = a.id
                      AND c.tenant_id = a.tenant_id
                 ) ch
             ) AS chases
        FROM delivery.client_ask a
        JOIN core.party cp
          ON cp.id = a.client_party_id AND cp.tenant_id = a.tenant_id
        LEFT JOIN tenancy.user_account raiser ON raiser.id = a.raised_by
        LEFT JOIN tenancy.user_account closer ON closer.id = a.closed_by
       WHERE a.tenant_id = ${tenantId}
         AND (${filter.askId ?? null}::uuid IS NULL OR a.id = ${filter.askId ?? null}::uuid)
         AND (${filter.workItemId ?? null}::uuid IS NULL
              OR a.work_item_id = ${filter.workItemId ?? null}::uuid)
       ORDER BY a.raised_at DESC
    `;
  }
}

export function toResponseRecord(r: RawResponse, askId: string): AskResponseRecord {
  return {
    response: {
      id: r.id,
      askId,
      responseKind: r.response_kind as ResponseKind,
      answerText: r.answer_text,
      documentId: r.document_id,
      decision: r.decision as AskDecision | null,
      respondedAt: r.responded_at,
      onBehalf: r.on_behalf,
    },
    respondedByName: r.responded_by_name,
    // The filename comes from `files.document_version`, which is where the
    // portal policy added in 0063 gets its reader. A response whose document has
    // somehow lost its version renders as a response with no file rather than as
    // a row that says a file is there and cannot name it.
    document:
      r.document_id !== null && r.filename !== null && r.media_type !== null
        ? {
            documentId: r.document_id,
            filename: r.filename,
            // `bigint` arrives as a string from postgres.js — Number() here and
            // not on the wire, because a byte size is a count and not money.
            byteSize: Number(r.byte_size ?? 0),
            mediaType: r.media_type,
          }
        : null,
  };
}

function toRecord(r: AskRow): AskRecord {
  return {
    ask: {
      id: r.id,
      tenantId: r.tenant_id,
      workItemId: r.work_item_id,
      clientPartyId: r.client_party_id,
      askKind: r.ask_kind as AskKind,
      prompt: r.prompt,
      documentKind: r.document_kind as DocumentKind | null,
      status: r.status as AskStatus,
      raisedBy: r.raised_by,
      raisedAt: r.raised_at,
      firstAnsweredAt: r.first_answered_at,
      closedBy: r.closed_by,
      closedAt: r.closed_at,
      dueOn: r.due_on,
      // 0385's CHECK holds the three together; reading all three keeps the
      // type honest without trusting it.
      fromTemplate:
        r.request_template_version_id !== null &&
        r.request_template_key !== null &&
        r.request_item_key !== null
          ? {
              versionId: r.request_template_version_id,
              templateKey: r.request_template_key,
              itemKey: r.request_item_key,
            }
          : null,
    },
    clientName: r.client_name,
    raisedByName: r.raised_by_name,
    closedByName: r.closed_by_name,
    responses: (r.responses ?? []).map((x) => toResponseRecord(x, r.id)),
    chases: (r.chases ?? []).map(toChaseRecord),
  };
}

/** No `label`: the rung's label is in the firm's published `chaser` config and
 *  a ladder edited in April must not restate what March's chase was called.
 *  0065 put `rung_key` and `after_days` on the row for exactly that. */
function toChaseRecord(c: RawChase): AskChaseRecord {
  return {
    rungKey: c.rung_key,
    afterDays: Number(c.after_days),
    daysOpen: Number(c.days_open),
    chasedAt: c.chased_at,
  };
}

/** A statement after the ask's lock wrote nothing: a contradiction, thrown so
 *  the transaction rolls the whole batch back rather than keep part of it. */
function unwritable(askId: string, what: string): Error {
  return new Error(
    `client_ask ${askId} was locked for an upload and its ${what} could not be written in the ` +
      `same transaction; nothing was kept`,
  );
}
