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
import type { AskRepository, NewAsk } from "../../usecase/clientask/ports";

interface AskRow {
  id: string;
  tenant_id: string;
  work_item_id: string;
  client_party_id: string;
  ask_kind: string;
  prompt: string;
  document_kind: string | null;
  status: string;
  raised_by: string;
  raised_at: string;
  first_answered_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
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
          (id, tenant_id, work_item_id, client_party_id, ask_kind, prompt, document_kind, raised_by)
        SELECT ${ask.id},
               ${ask.tenantId},
               wi.id,
               -- THE WALL COLUMN, TAKEN FROM THE WORK ITEM. See the header.
               wi.client_party_id,
               ${ask.askKind},
               ${ask.prompt},
               ${ask.documentKind},
               ${ask.raisedBy}
          FROM delivery.work_item wi
         WHERE wi.id = ${ask.workItemId}
           AND wi.tenant_id = ${ask.tenantId}
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, ask.tenantId, ask.id);
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
             a.raised_at::text  AS raised_at,
             a.first_answered_at::text AS first_answered_at,
             a.closed_by,
             a.closed_at::text  AS closed_at,
             cp.display_name    AS client_name,
             -- LEFT joins, and null is a real answer: an erased account stops
             -- resolving and the ask survives, exactly as the ledger's actor
             -- join does.
             raiser.display_name AS raised_by_name,
             closer.display_name AS closed_by_name,
             (
               SELECT coalesce(
                        jsonb_agg(r ORDER BY r.responded_at),
                        '[]'::jsonb
                      )
                 FROM (
                   SELECT resp.id,
                          resp.response_kind,
                          resp.answer_text,
                          resp.document_id,
                          resp.decision,
                          resp.responded_at::text AS responded_at,
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
                          c.chased_at::text AS chased_at
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
