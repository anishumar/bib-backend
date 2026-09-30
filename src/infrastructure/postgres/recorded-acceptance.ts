// `crm.recorded_acceptance` (0317): a client's yes given outside bib, recorded
// by a colleague. Written by the proposal and the letter adapters INSIDE the
// transaction that moves the document, so a status never stands without the
// evidence behind it, nor the evidence without the status.

import type { Db } from "../../db/pool";
import type { NewRecordedAcceptance, RecordedAcceptance } from "../../domain/acceptance/model";
import { EvidenceNotFiledHere } from "../../domain/acceptance/errors";
import { toDay } from "./day";
import { isoInstant } from "./instant";

export type AcceptanceSubject =
  | { readonly kind: "proposal"; readonly id: string }
  | { readonly kind: "engagement_letter"; readonly id: string };

/**
 * Insert the evidence row. The file, when there is one, must be LIVE-linked to
 * the same document: the table's foreign key proves only that it is this
 * firm's, and a client's email filed against another client would otherwise
 * stand as this one's evidence.
 */
export async function insertRecordedAcceptance(
  db: Db,
  subject: AcceptanceSubject,
  row: NewRecordedAcceptance,
): Promise<void> {
  if (row.evidenceDocumentId !== null) {
    const [linked] = await db<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM files.document_link
        WHERE document_id = ${row.evidenceDocumentId}
          AND subject_kind = ${subject.kind}
          AND subject_ref = ${subject.id}
          AND withdrawn_at IS NULL
      ) AS ok
    `;
    if (linked?.ok !== true) throw new EvidenceNotFiledHere(row.evidenceDocumentId);
  }
  await db`
    INSERT INTO crm.recorded_acceptance
      (id, tenant_id, proposal_id, engagement_letter_id, channel, accepted_on,
       accepted_by_name, accepted_by_title, note, evidence_document_id, recorded_by_user_id)
    VALUES
      (${row.id}, ${row.tenantId},
       ${subject.kind === "proposal" ? subject.id : null},
       ${subject.kind === "engagement_letter" ? subject.id : null},
       ${row.channel}, ${row.acceptedOn}::date, ${row.acceptedByName}, ${row.acceptedByTitle},
       ${row.note}, ${row.evidenceDocumentId}, ${row.recordedByUserId})
  `;
}

/** The recorded acceptance of one document, with its file's title and who recorded it. */
export async function readRecordedAcceptance(
  db: Db,
  subject: AcceptanceSubject,
): Promise<RecordedAcceptance | null> {
  const column = subject.kind === "proposal" ? db`a.proposal_id` : db`a.engagement_letter_id`;
  const [r] = await db<
    {
      id: string;
      channel: RecordedAcceptance["channel"];
      accepted_on: Date;
      accepted_by_name: string;
      accepted_by_title: string | null;
      note: string;
      evidence_document_id: string | null;
      evidence_title: string | null;
      recorded_by_user_id: string;
      recorder_display_name: string | null;
      recorder_email: string | null;
      recorded_at: string;
    }[]
  >`
    SELECT a.id, a.channel, a.accepted_on, a.accepted_by_name, a.accepted_by_title, a.note,
           a.evidence_document_id, d.title AS evidence_title,
           a.recorded_by_user_id, u.display_name AS recorder_display_name,
           u.email::text AS recorder_email,
           ${db.unsafe(isoInstant("a.recorded_at", "recorded_at"))}
    FROM crm.recorded_acceptance a
    LEFT JOIN files.document d ON d.id = a.evidence_document_id
    LEFT JOIN tenancy.user_account u ON u.id = a.recorded_by_user_id
    WHERE ${column} = ${subject.id}
  `;
  if (!r) return null;
  return {
    id: r.id,
    channel: r.channel,
    acceptedOn: toDay(r.accepted_on),
    acceptedByName: r.accepted_by_name,
    acceptedByTitle: r.accepted_by_title,
    note: r.note,
    evidenceDocumentId: r.evidence_document_id,
    evidenceTitle: r.evidence_title,
    recordedBy:
      r.recorder_email === null
        ? null
        : { userId: r.recorded_by_user_id, displayName: r.recorder_display_name, email: r.recorder_email },
    recordedAt: r.recorded_at,
  };
}
