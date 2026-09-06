// The FIRM's side of a client's own request, in Postgres (T6.8).
//
// Every method runs inside `withTenant` — gate 1 only. A colleague reads the
// whole inbox, which is what "no routing" means (0068): there is no
// `client_party_id` predicate anywhere in this file and there should not be
// one, because the firm-wide list IS the screen.
//
// ── THE POLICIES UNDER THESE QUERIES, AND WHY THEY COST NOTHING HERE ──────
//
//   `client_request_portal_scope`       (0068) — `crm.portal_sees` is TRUE for
//   `client_request_reply_portal_scope` (0068)   a staff session, so both are
//                                                satisfied and neither filters
//
// That is the shape a restrictive portal policy has to have, and it is the one
// thing about this table worth checking first: a bare narrowing predicate on a
// RESTRICTIVE policy applies to STAFF too, and the firm would lose sight of its
// own inbox. The reply policy carries a second clause for exactly that reason,
// written as `NOT crm.is_portal_session() OR ...` — see 0068.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  ClientRequestRecord,
  RequestReplyRecord,
  RequestStatus,
} from "../../domain/clientrequest/model";
import type {
  FirmReplyOutcome,
  NewFirmReply,
  RequestRepository,
} from "../../usecase/clientrequest/ports";
import { isoInstant } from "./instant";

interface RequestRow {
  id: string;
  tenant_id: string;
  client_party_id: string;
  subject: string;
  body: string;
  status: string;
  raised_by: string;
  raised_at: string;
  first_replied_at: string | null;
  settled_by: string | null;
  settled_at: string | null;
  assignee_user_id: string | null;
  assignment_note: string | null;
  client_name: string;
  raised_by_name: string | null;
  settled_by_name: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  replies: RawReply[] | null;
}

/** One row of `delivery.client_request_reply`, as the aggregate hands it back.
 *  `byte_size` is `bigint`, so postgres.js gives it back as a STRING — the same
 *  trap the ask's responses carry, and the reason `toReplyRecord` is shared
 *  rather than written twice. */
export interface RawReply {
  id: string;
  request_id: string;
  author_side: string;
  body: string;
  written_at: string;
  author_name: string | null;
  document_id: string | null;
  document_title: string | null;
  filename: string | null;
  byte_size: string | number | null;
  media_type: string | null;
}

export class PostgresClientRequestRepository implements RequestRepository {
  constructor(private readonly app: Db) {}

  async listLive(tenantId: string): Promise<readonly ClientRequestRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await this.select(db, tenantId, null, "live");
      return rows.map(toRecord);
    });
  }

  /**
   * What is FINISHED — closed by the firm, or withdrawn by the client.
   *
   * The inbox is a work queue and is right to drop these. Nothing else read
   * them, which meant the record of what a client asked and what the firm
   * answered left every staff screen the moment somebody pressed Close —
   * while the CLIENT's own portal went on showing the whole thread, because
   * that list has no status filter at all. The two surfaces disagreed, and the
   * client held the fuller record.
   */
  async listFinished(tenantId: string): Promise<readonly ClientRequestRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await this.select(db, tenantId, null, "finished");
      return rows.map(toRecord);
    });
  }

  async findById(tenantId: string, requestId: string): Promise<ClientRequestRecord | null> {
    return withTenant(this.app, tenantId, (db) => this.read(db, tenantId, requestId));
  }

  /**
   * The reply, the visibility flip and the status move — one transaction.
   *
   * ── ORDER, AND WHY THE DOCUMENT IS CHECKED RATHER THAN LEFT TO THE FK ───
   *
   * 0068's composite FK over `(document_id, client_party_id, tenant_id)` would
   * refuse a document belonging to another client, or one of the firm's own
   * (whose `party_id` is null and matches no NOT NULL value). But a foreign-key
   * violation reaches the caller as a 500 with a constraint name in it. So the
   * document is resolved first, against the request's own client, and its
   * absence is a REASON the service can turn into a sentence.
   *
   * The FK stays and is not redundant: it is what holds if this SELECT is ever
   * edited into something looser.
   */
  async reply(input: NewFirmReply): Promise<FirmReplyOutcome> {
    return withTenant(this.app, input.tenantId, async (db) => {
      const [live] = await db<{ client_party_id: string }[]>`
        SELECT r.client_party_id
          FROM delivery.client_request r
         WHERE r.id = ${input.requestId}
           AND r.tenant_id = ${input.tenantId}
           AND r.status IN ('open', 'answered')
      `;
      if (!live) return { ok: false, reason: "request" };

      if (input.documentId !== null) {
        const [doc] = await db<{ id: string }[]>`
          SELECT d.id
            FROM files.document d
           WHERE d.id = ${input.documentId}
             AND d.tenant_id = ${input.tenantId}
             AND d.party_id = ${live.client_party_id}
        `;
        if (!doc) return { ok: false, reason: "document" };

        // ── SENDING IT IS THE DECISION TO SHOW IT ────────────────────────
        //
        // 0066 made `is_client_visible` the switch the library reads, defaulted
        // FALSE so a forgetful writer publishes nothing. A reply that named a
        // document the client cannot open would be that default quietly
        // swallowing the answer — the firm would see the attachment on its own
        // screen and the client would see a message about a file that is not
        // there.
        //
        // In the same transaction as the reply, so the two can never disagree.
        await db`
          UPDATE files.document
             SET is_client_visible = true
           WHERE id = ${input.documentId}
             AND tenant_id = ${input.tenantId}
        `;
      }

      await db`
        INSERT INTO delivery.client_request_reply
          (id, tenant_id, request_id, client_party_id, author_side, body, document_id, written_by)
        SELECT ${input.id},
               ${input.tenantId},
               r.id,
               -- The wall column, taken from the request. Never supplied by the
               -- caller on this side either: it is one fewer thing that has to
               -- hold, and 0068's composite FK would refuse a mismatch anyway.
               r.client_party_id,
               'firm',
               ${input.body},
               ${input.documentId},
               ${input.writtenBy}
          FROM delivery.client_request r
         WHERE r.id = ${input.requestId}
           AND r.tenant_id = ${input.tenantId}
           AND r.status IN ('open', 'answered')
      `;

      // `open → answered`, and never a second time.
      //
      // `coalesce(first_replied_at, now())` keeps the FIRST reply the first
      // reply: a request that restated its answer date on every message would
      // credit the firm with a turnaround it did not have, and that number is
      // exactly what a partner reaches for when a client complains about being
      // ignored. `client_ask`'s `first_answered_at` is the mirror of this.
      await db`
        UPDATE delivery.client_request
           SET status           = 'answered',
               first_replied_at = coalesce(first_replied_at, now())
         WHERE id = ${input.requestId}
           AND tenant_id = ${input.tenantId}
           AND status IN ('open', 'answered')
      `;

      const record = await this.read(db, input.tenantId, input.requestId);
      return record === null ? { ok: false, reason: "request" } : { ok: true, record };
    });
  }

  async close(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly settledBy: string;
  }): Promise<ClientRequestRecord | null> {
    return withTenant(this.app, input.tenantId, async (db) => {
      // The status, the settler and the instant move together — 0068's CHECK
      // says the same thing, and an UPDATE that set two of the three would be
      // refused by it. The WHERE makes a double-click a no-op rather than a
      // second closure over the first.
      //
      // 'closed' is hard-coded rather than a parameter. `withdrawn` is the
      // CLIENT's ending and lives on the portal adapter; a status argument here
      // would make the firm able to write it, and "we decided you did not need
      // this" is a refusal wearing the client's word for changing their mind.
      const [row] = await db<{ id: string }[]>`
        UPDATE delivery.client_request
           SET status     = 'closed',
               settled_by = ${input.settledBy},
               settled_at = now()
         WHERE id = ${input.requestId}
           AND tenant_id = ${input.tenantId}
           AND status IN ('open', 'answered')
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, input.tenantId, input.requestId);
    });
  }

  async assign(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly assigneeUserId: string | null;
    readonly note: string | null;
  }): Promise<ClientRequestRecord | null> {
    return withTenant(this.app, input.tenantId, async (db) => {
      // THE NAME AND THE NOTE MOVE TOGETHER, because 0070's CHECK refuses a
      // note beside a name. An UPDATE that set one of the two would be refused
      // by the database — which is the database saying the same thing this
      // method's single signature says.
      //
      // `::uuid` on the assignee: postgres.js sends every parameter untyped, and
      // a NULL with no type is `unknown`, which an UPDATE cannot assign to a
      // uuid column. It typechecks, it lints, and it fails on the first real
      // unassign — T6.5's `date + $n` lesson on a different operator.
      const [row] = await db<{ id: string }[]>`
        UPDATE delivery.client_request
           SET assignee_user_id = ${input.assigneeUserId}::uuid,
               assignment_note  = ${input.note}::text
         WHERE id = ${input.requestId}
           AND tenant_id = ${input.tenantId}
           AND status IN ('open', 'answered')
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, input.tenantId, input.requestId);
    });
  }

  private async read(
    db: Db,
    tenantId: string,
    requestId: string,
  ): Promise<ClientRequestRecord | null> {
    const rows = await this.select(db, tenantId, requestId, "any");
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The one query. `requestId` null means the list; `scope` is what the inbox
   * and the archive filter on, and it is written here rather than in three
   * statements so the joins and the reply aggregate exist once.
   *
   * `finished` is the complement of `live` and is written as one, not as a
   * list of the two finished statuses: a status added later belongs in whatever
   * the inbox does NOT show, and a hard-coded `IN ('closed','withdrawn')` would
   * silently drop it from both screens.
   */
  private select(
    db: Db,
    tenantId: string,
    requestId: string | null,
    scope: "live" | "finished" | "any",
  ): Promise<RequestRow[]> {
    return db<RequestRow[]>`
      SELECT r.id,
             r.tenant_id,
             r.client_party_id,
             r.subject,
             r.body,
             r.status,
             r.raised_by,
             ${db.unsafe(isoInstant("r.raised_at", "raised_at"))},
             ${db.unsafe(isoInstant("r.first_replied_at", "first_replied_at"))},
             r.settled_by,
             ${db.unsafe(isoInstant("r.settled_at", "settled_at"))},
             r.assignee_user_id,
             r.assignment_note,
             cp.display_name         AS client_name,
             -- LEFT joins, and null is a real answer: an erased account stops
             -- resolving and the request survives, exactly as the ledger's
             -- actor join does.
             raiser.display_name  AS raised_by_name,
             settler.display_name AS settled_by_name,
             -- BOTH HALVES OF THE ASSIGNEE, because display_name is nullable
             -- on an account and is genuinely empty at seeded firms. T4.5's
             -- escalation queue rendered a blank space where a name belonged
             -- and collapsed "told somebody we hold no name for" into "told
             -- nobody" — the audit trail's rule, and the EMAIL is the
             -- discriminator.
             holder.display_name  AS assignee_name,
             holder.email         AS assignee_email,
             (
               SELECT coalesce(jsonb_agg(x ORDER BY x.written_at), '[]'::jsonb)
                 FROM (
                   SELECT rep.id,
                          rep.request_id,
                          rep.author_side,
                          rep.body,
                          ${db.unsafe(isoInstant("rep.written_at", "written_at"))},
                          author.display_name  AS author_name,
                          rep.document_id,
                          d.title              AS document_title,
                          dv.filename,
                          dv.byte_size,
                          dv.media_type
                     FROM delivery.client_request_reply rep
                     LEFT JOIN tenancy.user_account author
                       ON author.id = rep.written_by
                     LEFT JOIN files.document d
                       ON d.id = rep.document_id
                      AND d.tenant_id = rep.tenant_id
                     -- The LATEST version, unlike the ask's responses which
                     -- pin version 1. There the client's upload created the
                     -- document and its only version in one act, so version 1
                     -- IS what they sent. Here the firm is attaching a document
                     -- that already existed and may have been revised since —
                     -- and what it is sending is what the library would hand
                     -- over today.
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
        JOIN core.party cp
          ON cp.id = r.client_party_id AND cp.tenant_id = r.tenant_id
        LEFT JOIN tenancy.user_account raiser  ON raiser.id = r.raised_by
        LEFT JOIN tenancy.user_account settler ON settler.id = r.settled_by
        LEFT JOIN tenancy.user_account holder  ON holder.id = r.assignee_user_id
       WHERE r.tenant_id = ${tenantId}
         AND (${requestId}::uuid IS NULL OR r.id = ${requestId}::uuid)
         AND (${scope} = 'any'
              OR (${scope} = 'live')     = (r.status IN ('open', 'answered')))
       ORDER BY r.raised_at DESC
    `;
  }
}

/** Shared with the portal adapter — one shape of a reply, resolved once. A
 *  second copy is how the two surfaces come to disagree about what a byte size
 *  is. */
export function toReplyRecord(raw: RawReply): RequestReplyRecord {
  return {
    reply: {
      id: raw.id,
      requestId: raw.request_id,
      authorSide: raw.author_side === "firm" ? "firm" : "client",
      body: raw.body,
      writtenAt: raw.written_at,
    },
    authorName: raw.author_name,
    document:
      raw.document_id === null
        ? null
        : {
            documentId: raw.document_id,
            title: raw.document_title ?? "",
            filename: raw.filename ?? "",
            // `bigint` arrives as a string from postgres.js. Number() here and
            // nowhere else — a byte size is a count, not money, and the one
            // place it is converted is the place that knows where it came from.
            byteSize: Number(raw.byte_size ?? 0),
            mediaType: raw.media_type ?? "application/octet-stream",
          },
  };
}

function toRecord(row: RequestRow): ClientRequestRecord {
  return {
    request: {
      id: row.id,
      tenantId: row.tenant_id,
      clientPartyId: row.client_party_id,
      subject: row.subject,
      body: row.body,
      status: row.status as RequestStatus,
      raisedBy: row.raised_by,
      raisedAt: row.raised_at,
      firstRepliedAt: row.first_replied_at,
      settledBy: row.settled_by,
      settledAt: row.settled_at,
      assigneeUserId: row.assignee_user_id,
      assignmentNote: row.assignment_note,
    },
    clientName: row.client_name,
    raisedByName: row.raised_by_name,
    settledByName: row.settled_by_name,
    assigneeName: row.assignee_name,
    assigneeEmail: row.assignee_email,
    replies: (row.replies ?? []).map(toReplyRecord),
  };
}
