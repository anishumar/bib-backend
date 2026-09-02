// The client's side of an ask, in Postgres (T6.6).
//
// ── THE SECOND ADAPTER IN THE PRODUCT THAT USES `withPortal`, AND THE FIRST
//    THAT WRITES THROUGH IT ──────────────────────────────────────────────────
//
// `PostgresPortalHomeRepository` was the only one, and it only reads. This one
// inserts — a response, and on an upload a document, a version and a link — and
// every statement runs inside `withPortal`.
//
// That is the half 0059 and 0062 were written for and could not exercise. Both
// put `WITH CHECK` on their restrictive policies while saying no portal write
// path existed, *"which is why it will not have to be built with the rule inside
// it"*. This is that path, and the promise holds: not one INSERT below names
// `client_party_id` in a WHERE clause or checks it in TypeScript. A contact
// answering an ask belonging to another of the firm's clients is refused by the
// DATABASE.
//
// ── SO THE QUERIES LOOK LIKE QUERIES THAT FORGOT TO FILTER ───────────────
//
// They do, and that is the point, exactly as it is in the status home's adapter:
//
//   `client_ask_portal_scope`          (0063) — only the granted companies' asks
//   `client_ask_response_portal_scope` (0063) — and only their answers
//   `work_item_portal_scope`           (0059) — the task an ask hangs off
//   `work_item_portal_visible`         (0062) — and only if the firm marked it
//                                                visible
//   `document_portal_scope`            (0063) — the file, and never the firm's own
//   `document_version_portal_scope`    (0063) — its bytes and its filename
//   `document_link_portal_scope`       (0063) — what it is attached to
//   `client_ask_chase_portal_scope`    (0065) — and when they were last reminded
//
// Repeating any of those here would feel safer and would silently disarm the
// negative control: `tests/portal/client-ask.integration.test.ts` drops a policy
// and expects these statements to start leaking. A test that still passes with
// the wall removed proves only that the rows exist.
//
// ── THE JOIN TO `work_item` IS LOAD-BEARING IN A WAY THAT IS NOT OBVIOUS ──
//
// Every read below joins `delivery.work_item` for the task's title and its
// company. That join is also a SECOND wall, inherited rather than written: an
// ask whose work item the firm has marked `is_client_visible = false` is
// filtered by 0062's policy, the join finds nothing, and the ask disappears with
// it. So the firm's own switch on `/work-items/[id]` hides the ask along with
// the task, which is the only coherent behaviour — an ask about work a client
// cannot see is a question about nothing.
import type { Db } from "../../db/pool";
import { withPortal } from "../../db/tenant";
import type { AskKind, AskStatus, PortalAskRow } from "../../domain/clientask/model";
import type { DocumentKind } from "../../domain/filestore/model";
import type {
  NewResponse,
  PortalAskRepository,
  UploadedBytes,
} from "../../usecase/clientask/ports";
import type { RawResponse } from "./client-ask-repository";
import { toResponseRecord } from "./client-ask-repository";
import { isoInstant } from "./instant";

interface Row {
  id: string;
  ask_kind: string;
  prompt: string;
  document_kind: string | null;
  status: string;
  company_name: string | null;
  work_item_title: string;
  raised_at: string;
  last_reminded_at: string | null;
  responses: RawResponse[] | null;
}

export class PostgresPortalAskRepository implements PortalAskRepository {
  constructor(private readonly app: Db) {}

  async list(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalAskRow[]> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await this.select(db, tenantId, null);
      return rows.map(toPortalRow);
    });
  }

  async findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    askId: string,
  ): Promise<PortalAskRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await this.select(db, tenantId, askId);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  async respond(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
  ): Promise<PortalAskRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      if (!(await this.insertResponse(db, tenantId, response))) return null;
      if (!(await this.markAnswered(db, tenantId, response.askId))) return null;
      const rows = await this.select(db, tenantId, response.askId);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  async respondWithDocument(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
    upload: UploadedBytes,
  ): Promise<PortalAskRow | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      // ── the document, and WHOSE it is ───────────────────────────────────
      //
      // `party_id` is taken from the ask, in the statement, exactly as the
      // firm's own `raise` takes `client_party_id` from the work item. A client
      // does not get to say whose document their upload becomes — and because
      // the SELECT reads `delivery.client_ask` under the portal scope, an ask
      // this session may not reach produces no row and the whole thing writes
      // nothing.
      const [doc] = await db<{ id: string }[]>`
        INSERT INTO files.document
          (id, tenant_id, title, origin, kind, party_id, is_client_visible, created_by)
        SELECT ${upload.documentId},
               ${tenantId},
               ${upload.title},
               'uploaded',
               ${upload.documentKind},
               a.client_party_id,
               -- ── TRUE, AND IT IS THE ONE LITERAL IN THIS FILE THAT IS NOT
               --    TAKEN FROM A ROW ─────────────────────────────────────
               --
               -- 0066 narrowed document_portal_scope to require this flag, and
               -- the column defaults FALSE. Leaving it to the default here
               -- would not have leaked anything — it would have made this
               -- INSERT fail the policy's own WITH CHECK, because a portal
               -- session cannot write a row it could not then read. Which is
               -- the wall telling the truth: what a client sends, a client sees.
               --
               -- Hiding a client's own upload from them is not a defensible
               -- state in either direction. The firm's default-by-kind mapping
               -- does not apply, and must not: the kind here was chosen by the
               -- FIRM when it raised the ask, and a client who sent a file
               -- filed as working_paper would lose sight of the thing they
               -- sent because of a filing decision they never saw.
               true,
               ${response.respondedBy}
          FROM delivery.client_ask a
         WHERE a.id = ${response.askId}
           AND a.tenant_id = ${tenantId}
           AND a.status IN ('open', 'answered')
        RETURNING id
      `;
      if (!doc) return null;

      await db`
        INSERT INTO files.document_version
          (id, tenant_id, document_id, version_no, content_hash, byte_size,
           media_type, filename, storage_key, created_by)
        VALUES (${upload.versionId}, ${tenantId}, ${upload.documentId}, 1,
                ${upload.contentHash}, ${upload.byteSize}, ${upload.mediaType},
                ${upload.filename}, ${upload.storageKey}, ${response.respondedBy})
      `;

      // ── AND THE ACCEPTANCE LINE: it files itself against the job ────────
      //
      // `subject_kind = 'work_item'` is 0063's addition to that vocabulary, and
      // this is why it was added: the person who raised the ask is looking at the
      // work item, and a file reachable only through the ask would not arrive
      // where they are looking. The work item comes from the ask rather than
      // from the request, so a client cannot attach a file to a task nobody
      // asked them about.
      await db`
        INSERT INTO files.document_link
          (id, tenant_id, document_id, subject_kind, subject_ref, role, created_by)
        SELECT ${upload.linkId}, ${tenantId}, ${upload.documentId}, 'work_item',
               a.work_item_id, 'client_response', ${response.respondedBy}
          FROM delivery.client_ask a
         WHERE a.id = ${response.askId}
           AND a.tenant_id = ${tenantId}
      `;

      if (!(await this.insertResponse(db, tenantId, response, upload.documentId))) return null;
      if (!(await this.markAnswered(db, tenantId, response.askId))) return null;
      const rows = await this.select(db, tenantId, response.askId);
      const row = rows[0];
      return row ? toPortalRow(row) : null;
    });
  }

  /**
   * The response row, with its client taken from the ask.
   *
   * Same move as everywhere else in this file: `client_party_id` comes from a
   * SELECT over the ask, under the portal scope, so it is neither supplied by
   * the caller nor trusted from one. Zero rows means the ask is unreachable or
   * already settled, and the transaction rolls back around it.
   */
  private async insertResponse(
    db: Db,
    tenantId: string,
    response: NewResponse,
    documentId?: string,
  ): Promise<boolean> {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO delivery.client_ask_response
        (id, tenant_id, ask_id, client_party_id, response_kind, answer_text,
         document_id, decision, responded_by)
      SELECT ${response.id},
             ${tenantId},
             a.id,
             a.client_party_id,
             ${response.responseKind},
             ${response.answerText},
             ${documentId ?? null},
             ${response.decision},
             ${response.respondedBy}
        FROM delivery.client_ask a
       WHERE a.id = ${response.askId}
         AND a.tenant_id = ${tenantId}
         AND a.status IN ('open', 'answered')
      RETURNING id
    `;
    return row !== undefined;
  }

  /**
   * `open → answered`, and never a second time.
   *
   * `coalesce(first_answered_at, now())` is what keeps the FIRST reply the first
   * reply. "They sent the wrong register on the 3rd and the right one on the
   * 9th" has to keep the 3rd — an ask that restated its answer date on every
   * response would credit the client with a week they did not have, and that
   * number is exactly what a firm reaches for when a filing goes late.
   */
  private async markAnswered(db: Db, tenantId: string, askId: string): Promise<boolean> {
    const [row] = await db<{ id: string }[]>`
      UPDATE delivery.client_ask
         SET status = 'answered',
             first_answered_at = coalesce(first_answered_at, now())
       WHERE id = ${askId}
         AND tenant_id = ${tenantId}
         AND status IN ('open', 'answered')
      RETURNING id
    `;
    return row !== undefined;
  }

  /** One query for the list and for the single read — `askId` null means all of
   *  them. Two statements would be two shapes of the same row. */
  private select(db: Db, tenantId: string, askId: string | null): Promise<Row[]> {
    return db<Row[]>`
      SELECT a.id,
             a.ask_kind,
             a.prompt,
             a.document_kind,
             a.status,
             ent.display_name AS company_name,
             wi.title         AS work_item_title,
             ${db.unsafe(isoInstant("a.raised_at", "raised_at"))},
             -- ── WHEN WE LAST REMINDED THEM, AND NOT HOW OFTEN ───────────
             --
             -- delivery.client_ask_chase (0065) carried a portal policy from
             -- the day it was created and had no reader on either side. This is
             -- the client's half of that reader, and it is a MAX rather than a
             -- count on purpose (see PortalAskRow.lastRemindedAt): the tally
             -- is an accusation printed on somebody's own page, the date is
             -- something they can act on. The firm's own screen carries every
             -- rung, which is where the evidence is actually needed.
             --
             -- No WHERE client_party_id = ... here either. The restrictive
             -- policy is under this subquery exactly as it is under the outer
             -- one, and repeating it would disarm the negative control.
             (
               SELECT ${db.unsafe(isoInstant("max(c.chased_at)"))}
                 FROM delivery.client_ask_chase c
                WHERE c.ask_id = a.id
                  AND c.tenant_id = a.tenant_id
             ) AS last_reminded_at,
             (
               SELECT coalesce(jsonb_agg(r ORDER BY r.responded_at), '[]'::jsonb)
                 FROM (
                   SELECT resp.id,
                          resp.response_kind,
                          resp.answer_text,
                          resp.document_id,
                          resp.decision,
                          ${db.unsafe(isoInstant("resp.responded_at", "responded_at"))},
                          -- The client's OWN people, by name. This is their own
                          -- company's side of the conversation, and a household
                          -- with two directors needs to know which of them
                          -- replied. Nobody at the FIRM is named anywhere on
                          -- this read — T6.5's rule.
                          responder.display_name AS responded_by_name,
                          dv.filename,
                          dv.byte_size,
                          dv.media_type
                     FROM delivery.client_ask_response resp
                     LEFT JOIN tenancy.user_account responder
                       ON responder.id = resp.responded_by
                     LEFT JOIN files.document_version dv
                       ON dv.document_id = resp.document_id
                      AND dv.tenant_id = resp.tenant_id
                      AND dv.version_no = 1
                    WHERE resp.ask_id = a.id
                      AND resp.tenant_id = a.tenant_id
                 ) r
             ) AS responses
        FROM delivery.client_ask a
        -- Not a LEFT join, deliberately: an ask whose work item this session
        -- cannot see is an ask about nothing, and 0062's visibility policy is
        -- what decides that. See the header.
        JOIN delivery.work_item wi
          ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
        LEFT JOIN core.party ent
          ON ent.id = wi.entity_party_id AND ent.tenant_id = wi.tenant_id
       WHERE a.tenant_id = ${tenantId}
         AND (${askId}::uuid IS NULL OR a.id = ${askId}::uuid)
         -- A BUSINESS filter, not a security one: a client's action centre is
         -- what still wants something from them and what is back with the firm.
         -- Closed and withdrawn asks are the firm's own history — and a client
         -- who wants to know what they sent in March asks the firm, which is
         -- the same answer this product gives about every other archive.
         AND a.status IN ('open', 'answered')
       ORDER BY a.raised_at ASC
    `;
  }
}

function toPortalRow(r: Row): PortalAskRow {
  return {
    askId: r.id,
    askKind: r.ask_kind as AskKind,
    prompt: r.prompt,
    documentKind: r.document_kind as DocumentKind | null,
    status: r.status as AskStatus,
    companyName: r.company_name,
    workItemTitle: r.work_item_title,
    raisedAt: r.raised_at,
    lastRemindedAt: r.last_reminded_at,
    responses: (r.responses ?? []).map((x) => toResponseRecord(x, r.id)),
  };
}
