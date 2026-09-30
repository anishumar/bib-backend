// The recorded acceptance (0317) on the wire: one request shape and one read
// shape, shared by the proposal and the engagement-letter routes so a screen
// reads both the same way.

import { z } from "../openapi";

import { ACCEPTANCE_CHANNELS } from "../../domain/acceptance/model";
import type { RecordedAcceptance } from "../../domain/acceptance/model";

export const RecordAcceptanceRequest = z
  .object({
    channel: z.enum(ACCEPTANCE_CHANNELS).openapi({
      description: "How the client said yes: `email`, `call`, `meeting`, `letter` or `other`.",
    }),
    acceptedOn: z.string().openapi({
      description:
        "The day the CLIENT said yes, `YYYY-MM-DD`: not before the document went out, not after today.",
      example: "2026-09-30",
    }),
    acceptedByName: z.string().openapi({ description: "Who at the client said yes." }),
    acceptedByTitle: z.string().optional().openapi({ description: "Their capacity — Director." }),
    note: z.string().openapi({
      description: "What the client said and where it can be found. Required.",
    }),
    evidenceDocumentId: z.string().uuid().optional().openapi({
      description:
        "The client's email or letter, already uploaded and attached to THIS proposal or " +
        "letter. REQUIRED for an engagement letter; optional for a proposal.",
    }),
  })
  .openapi("RecordAcceptanceRequest");

export const RecordedAcceptanceSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.enum(ACCEPTANCE_CHANNELS),
    acceptedOn: z.string(),
    acceptedByName: z.string(),
    acceptedByTitle: z.string().nullable(),
    note: z.string(),
    evidence: z.object({ documentId: z.string().uuid(), title: z.string().nullable() }).nullable(),
    /** The colleague who recorded it. The email is the discriminator: an
     *  account may have no name. Null for an erased account. */
    recordedBy: z
      .object({ userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string() })
      .nullable(),
    recordedAt: z.string(),
  })
  .openapi("RecordedAcceptance");

export function toRecordedAcceptanceBody(
  a: RecordedAcceptance | null,
): z.infer<typeof RecordedAcceptanceSchema> | null {
  if (a === null) return null;
  return {
    id: a.id,
    channel: a.channel,
    acceptedOn: a.acceptedOn,
    acceptedByName: a.acceptedByName,
    acceptedByTitle: a.acceptedByTitle,
    note: a.note,
    evidence:
      a.evidenceDocumentId === null ? null : { documentId: a.evidenceDocumentId, title: a.evidenceTitle },
    recordedBy: a.recordedBy === null ? null : { ...a.recordedBy },
    recordedAt: a.recordedAt,
  };
}
