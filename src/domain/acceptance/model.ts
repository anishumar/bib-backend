// A client's acceptance given OUTSIDE bib, recorded by a colleague (0317).
//
// The client said yes by email, on a call or in a meeting, and never pressed
// Accept on the proposal's link or signed the letter in DocuSign. A person
// holding `acceptance:record` states what the client said, and this is the
// evidence that statement carries. Pure: the checks here are the ones a
// database cannot make (which day is "today", which day the document went
// out), and the table's CHECKs repeat the rest as a wall.

import { AcceptanceInvalid, AcceptanceNeedsEvidence } from "./errors";

export const ACCEPTANCE_CHANNELS = ["email", "call", "meeting", "letter", "other"] as const;
export type AcceptanceChannel = (typeof ACCEPTANCE_CHANNELS)[number];

export function isAcceptanceChannel(v: string): v is AcceptanceChannel {
  return (ACCEPTANCE_CHANNELS as readonly string[]).includes(v);
}

/** What the caller says happened, as it arrives. */
export interface AcceptanceStatement {
  readonly channel: string;
  /** The day the CLIENT said yes, `YYYY-MM-DD`. */
  readonly acceptedOn: string;
  /** Who said yes on the client's side. */
  readonly acceptedByName: string;
  readonly acceptedByTitle?: string | undefined;
  readonly note: string;
  /** The client's email or letter, filed against the same document. */
  readonly evidenceDocumentId?: string | undefined;
}

/** The same, checked and trimmed: what is stored. */
export interface AcceptanceEvidence {
  readonly channel: AcceptanceChannel;
  readonly acceptedOn: string;
  readonly acceptedByName: string;
  readonly acceptedByTitle: string | null;
  readonly note: string;
  readonly evidenceDocumentId: string | null;
}

/** The row written: the evidence plus who recorded it. */
export interface NewRecordedAcceptance extends AcceptanceEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly recordedByUserId: string;
}

/** A recorded acceptance as a screen reads it. */
export interface RecordedAcceptance extends AcceptanceEvidence {
  readonly id: string;
  /** The filed evidence's title, when there is a file. */
  readonly evidenceTitle: string | null;
  readonly recordedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  readonly recordedAt: string;
}

export const ACCEPTANCE_NAME_MAX = 200;
export const ACCEPTANCE_NOTE_MAX = 2000;

/**
 * Check a statement against the document it is about.
 *
 * `today` is the firm's (or the caller's) calendar day and `sentOn` the day the
 * document went out: a client cannot have accepted before it was offered, nor
 * tomorrow. `needsEvidence` is true for a letter (decided 2026-09-30): the
 * letter is the contract, so the client's own email must be filed with it.
 */
export function checkAcceptance(
  raw: AcceptanceStatement,
  on: { readonly today: string; readonly sentOn: string | null; readonly needsEvidence: boolean },
): AcceptanceEvidence {
  if (!isAcceptanceChannel(raw.channel)) {
    throw new AcceptanceInvalid(
      "channel",
      `"${raw.channel}" is not how a client can say yes here. Use one of: ${ACCEPTANCE_CHANNELS.join(", ")}`,
    );
  }
  if (!isDay(raw.acceptedOn)) {
    throw new AcceptanceInvalid("acceptedOn", `"${raw.acceptedOn}" is not a calendar day. Use 2026-09-30`);
  }
  if (raw.acceptedOn > on.today) {
    throw new AcceptanceInvalid("acceptedOn", `the client cannot have accepted on ${raw.acceptedOn}, which has not come yet`);
  }
  if (on.sentOn !== null && raw.acceptedOn < on.sentOn) {
    throw new AcceptanceInvalid(
      "acceptedOn",
      `it went out on ${on.sentOn}, so the client cannot have accepted it on ${raw.acceptedOn}`,
    );
  }
  const name = raw.acceptedByName.trim();
  if (name === "") throw new AcceptanceInvalid("acceptedByName", "say who at the client accepted it");
  if (name.length > ACCEPTANCE_NAME_MAX) {
    throw new AcceptanceInvalid("acceptedByName", `the name is longer than ${String(ACCEPTANCE_NAME_MAX)} characters`);
  }
  const title = (raw.acceptedByTitle ?? "").trim();
  if (title.length > ACCEPTANCE_NAME_MAX) {
    throw new AcceptanceInvalid("acceptedByTitle", `the title is longer than ${String(ACCEPTANCE_NAME_MAX)} characters`);
  }
  const note = raw.note.trim();
  if (note === "") {
    throw new AcceptanceInvalid("note", "add a note saying what the client said, and where it can be found");
  }
  if (note.length > ACCEPTANCE_NOTE_MAX) {
    throw new AcceptanceInvalid("note", `the note is longer than ${String(ACCEPTANCE_NOTE_MAX)} characters`);
  }
  const evidence = (raw.evidenceDocumentId ?? "").trim();
  if (on.needsEvidence && evidence === "") throw new AcceptanceNeedsEvidence();
  return {
    channel: raw.channel,
    acceptedOn: raw.acceptedOn,
    acceptedByName: name,
    acceptedByTitle: title === "" ? null : title,
    note,
    evidenceDocumentId: evidence === "" ? null : evidence,
  };
}

/** `YYYY-MM-DD` that names a real day (2026-02-31 does not). */
function isDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= (lengths[mo - 1] ?? 0);
}
