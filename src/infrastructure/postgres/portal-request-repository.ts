// The CLIENT's side of their own request, in Postgres (T6.8).
//
// ── THE FOURTH `withPortal` ADAPTER, AND THE FIRST WHOSE INSERT NAMES THE
//    WALL COLUMN ────────────────────────────────────────────────────────────
//
// `PostgresPortalHomeRepository` reads. `PostgresPortalAskRepository` writes,
// and takes its `client_party_id` from the ask it is answering.
// `PostgresPortalLibraryRepository` reads. This one INSERTS A ROW WHOSE WALL
// COLUMN CAME FROM THE BROWSER, because a client's own request hangs off
// nothing there is to read it from.
//
// What refuses a wrong one is `client_request_portal_scope`'s WITH CHECK
// (0068). That arm has been on every gate-4 policy since 0059 and 0062, both of
// which noted no portal write path existed yet and that this is why the rule
// would not have to be built into one. This is the first write where it is the
// ONLY thing standing between a supplied id and the row — so the negative
// control in `tests/portal/client-request.integration.test.ts` drops that
// policy and watches an INSERT for another client's company SUCCEED.
//
// ── SO THE QUERIES LOOK LIKE QUERIES THAT FORGOT TO FILTER ───────────────
//
// They do, and that is the point:
//
//   `client_request_portal_scope`       (0068) — only the granted companies'
//                                                requests, on read AND write
//   `client_request_reply_portal_scope` (0068) — their thread, and a portal
//                                                session may only write
//                                                `author_side = 'client'`
//   `document_portal_scope`             (0063) — the attachment, never the
//                                                firm's own papers
//   `document_version_portal_scope`     (0063) — its filename and its size
//   `document_client_visible`           (0066) — and only once the firm has
//                                                actually sent it
//
// Repeating any of those here would feel safer and would silently disarm the
// negative control. A test that still passes with the wall removed proves only
// that the rows exist.
//
// ── THE ATTACHMENT JOIN IS A SECOND WALL, INHERITED RATHER THAN WRITTEN ───
//
// A reply's document is joined, not looked up. If the firm attached a document
// and something later cleared `is_client_visible`, 0066's policy filters the
// join and the client sees the message with no file on it — which is the only
// coherent answer, and it is one edit rather than two that can drift.
import type { Db } from "../../db/pool";
import { withPortal } from "../../db/tenant";
import type { PortalRequestRow, RequestStatus } from "../../domain/clientrequest/model";
import type {
  NewReply,
  NewRequest,
  PortalRequestRepository,
} from "../../usecase/clientrequest/ports";
import type { RawReply } from "./client-request-repository";
import { toReplyRecord } from "./client-request-repository";

interface Row {
  id: string;
  subject: string;
  body: string;
  status: string;
  company_name: string | null;
  raised_at: string;
  last_replied_at: string | null;
  replies: RawReply[] | null;
}

export class PostgresPortalRequestRepository implements PortalRequestRepository {
  constructor(private readonly app: Db) {}

  async list(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalRequestRow[]> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await this.select(db, tenantId, null);
      return rows.map(toPortalRow);
    });
  }

  async findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    requestId: string,
  ): Promise<PortalRequestRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await this.select(db, tenantId, requestId);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  /**
   * The client asks for something.
   *
   * `client_party_id` is a PARAMETER here, uniquely in this product, and the
   * policy is what makes that safe. A contact who posted another of the firm's
   * clients would have the row refused by the database — `crm.portal_sees`
   * reads the granted parties `withPortal` set from `crm.portal_access`, never
   * anything in the request.
   *
   * That refusal arrives as a Postgres RLS violation rather than as zero rows,
   * which is why the service checks the party against the scope it already
   * holds and refuses first with a sentence. Both are true; only one of them is
   * the wall.
   */
  async raise(
    tenantId: string,
    clientPartyIds: readonly string[],
    request: NewRequest,
  ): Promise<PortalRequestRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      await db`
        INSERT INTO delivery.client_request
          (id, tenant_id, client_party_id, subject, body, raised_by)
        VALUES (${request.id}, ${tenantId}, ${request.clientPartyId},
                ${request.subject}, ${request.body}, ${request.raisedBy})
      `;
      const rows = await this.select(db, tenantId, request.id);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  /**
   * A follow-up from the client.
   *
   * `author_side` is hard-coded 'client' and the policy would refuse anything
   * else from this session anyway (0068) — which is the point of writing it
   * there as well as here: an adapter is code somebody can edit, and a WITH
   * CHECK is not.
   *
   * IT DOES NOT TOUCH THE STATUS. `answered` means the firm has come back at
   * least once, which is the same fact as `first_replied_at IS NOT NULL` and is
   * enforced as such by 0068's CHECK; a client's message walking it back to
   * `open` would break that constraint or force it to be loosened. Who is
   * holding the conversation is `lastWordWith`, on the thread, which the firm's
   * inbox shows beside the status.
   */
  async reply(
    tenantId: string,
    clientPartyIds: readonly string[],
    reply: NewReply,
  ): Promise<PortalRequestRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const [written] = await db<{ id: string }[]>`
        INSERT INTO delivery.client_request_reply
          (id, tenant_id, request_id, client_party_id, author_side, body, written_by)
        SELECT ${reply.id},
               ${tenantId},
               r.id,
               -- The wall column, taken from the request rather than the
               -- caller. 0068's composite FK would refuse a mismatch; this
               -- makes the mismatch unwritable rather than refused.
               r.client_party_id,
               'client',
               ${reply.body},
               ${reply.writtenBy}
          FROM delivery.client_request r
         WHERE r.id = ${reply.requestId}
           AND r.tenant_id = ${tenantId}
           AND r.status IN ('open', 'answered')
        RETURNING id
      `;
      if (!written) return null;
      const rows = await this.select(db, tenantId, reply.requestId);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  /** The client takes it back. `withdrawn` is written here and nowhere else. */
  async withdraw(
    tenantId: string,
    clientPartyIds: readonly string[],
    input: { readonly requestId: string; readonly settledBy: string },
  ): Promise<PortalRequestRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const [row] = await db<{ id: string }[]>`
        UPDATE delivery.client_request
           SET status     = 'withdrawn',
               settled_by = ${input.settledBy},
               settled_at = now()
         WHERE id = ${input.requestId}
           AND tenant_id = ${tenantId}
           AND status IN ('open', 'answered')
        RETURNING id
      `;
      if (!row) return null;
      const rows = await this.select(db, tenantId, input.requestId);
      const found = rows[0];
      return found ? toPortalRow(found) : null;
    });
  }

  /** One query for the list and for the single read — `requestId` null means
   *  all of them. Two statements would be two shapes of the same row. */
  private select(db: Db, tenantId: string, requestId: string | null): Promise<Row[]> {
    return db<Row[]>`
      SELECT r.id,
             r.subject,
             r.body,
             r.status,
             cp.display_name   AS company_name,
             r.raised_at::text AS raised_at,
             -- When the firm last came back. A convenience for the one line the
             -- list shows; the whole thread is below it either way, so this is
             -- not the "date, never a count" decision the chaser's reader had
             -- to take — neither side is being counted here.
             (
               SELECT max(f.written_at)::text
                 FROM delivery.client_request_reply f
                WHERE f.request_id = r.id
                  AND f.tenant_id = r.tenant_id
                  AND f.author_side = 'firm'
             ) AS last_replied_at,
             (
               SELECT coalesce(jsonb_agg(x ORDER BY x.written_at), '[]'::jsonb)
                 FROM (
                   SELECT rep.id,
                          rep.request_id,
                          rep.author_side,
                          rep.body,
                          rep.written_at::text AS written_at,
                          author.display_name  AS author_name,
                          rep.document_id,
                          d.title              AS document_title,
                          dv.filename,
                          dv.byte_size,
                          dv.media_type
                     FROM delivery.client_request_reply rep
                     -- The client's OWN people resolve here; the firm's names
                     -- are dropped by the handler, not by this join. Doing it
                     -- in SQL would leave the firm's own screen reading the
                     -- same adapter and losing them too.
                     LEFT JOIN tenancy.user_account author
                       ON author.id = rep.written_by
                     LEFT JOIN files.document d
                       ON d.id = rep.document_id
                      AND d.tenant_id = rep.tenant_id
                     LEFT JOIN LATERAL (
                       SELECT v.filename, v.byte_size, v.media_type
                         FROM files.document_version v
                        WHERE v.document_id = rep.document_id
                          AND v.tenant_id = rep.tenant_id
                        ORDER BY v.version_no DESC
                        LIMIT 1
                     ) dv ON true
                    WHERE rep.request_id = r.id
                      AND rep.tenant_id = r.tenant_id
                 ) x
             ) AS replies
        FROM delivery.client_request r
        -- core.party has NO portal policy and must not grow one — a name table
        -- is not scoped by what it names (0059). The wall is on the request
        -- above it: an unreachable request produces no row for this join to
        -- resolve a name for.
        JOIN core.party cp
          ON cp.id = r.client_party_id AND cp.tenant_id = r.tenant_id
       WHERE r.tenant_id = ${tenantId}
         AND (${requestId}::uuid IS NULL OR r.id = ${requestId}::uuid)
       ORDER BY r.raised_at DESC
    `;
  }
}

function toPortalRow(row: Row): PortalRequestRow {
  return {
    requestId: row.id,
    companyName: row.company_name,
    subject: row.subject,
    body: row.body,
    status: row.status as RequestStatus,
    raisedAt: row.raised_at,
    lastRepliedAt: row.last_replied_at,
    replies: (row.replies ?? []).map(toReplyRecord),
  };
}
