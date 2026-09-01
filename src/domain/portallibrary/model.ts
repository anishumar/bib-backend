// The client portal's self-serve library (T6.7) — what a client can find on
// their own, without emailing anybody. Pure: stdlib only, no internal imports.
//
// ── THE ACCEPTANCE LINE IS THE WHOLE SPECIFICATION ────────────────────────
//
// *"A client finds last year's challan without emailing anyone."* Every choice
// below comes out of reading that sentence carefully:
//
//   · LAST YEAR'S — so this reader is not the status home's ninety-day window.
//     The home answers "what is happening now"; this answers "where is the
//     thing you filed for me in March". A window would make the second question
//     unanswerable and the feature pointless.
//   · CHALLAN — so it is the BYTES, not a filename. T6.6 stopped at the
//     filename deliberately and said so; a library that lists documents and
//     cannot open them sends the same email it was built to stop.
//   · WITHOUT EMAILING ANYONE — so it is a list they can search, not a request
//     form.
//
// ── AND WHAT IS IN IT IS NOT DERIVED ─────────────────────────────────────
//
// A document is in this library because it is the client's (`party_id`) AND the
// firm marked it visible (`is_client_visible`, migration 0066). Both are
// RESTRICTIVE policies. No join widens either — reaching a subsidiary's
// documents through `crm.engagement` is the nullable derivation this schema has
// refused three times, and a contact who should see both companies gets two
// grants.

import type { DocumentKind } from "../filestore/model";

/**
 * One document in the library.
 *
 * Deliberately narrower than the firm's own `DocumentRecord`. Absent here, each
 * for a reason rather than because it was not needed:
 *
 *   · the UPLOADER's name — T6.5's rule. Whose desk something sits on is the
 *     firm's business, and a name invites a client to chase a junior directly.
 *   · the storage key — it is not on the wire anywhere and never will be
 *     (T3.6: bytes leave by one route and there is no pre-signed URL).
 *   · `isClientVisible` — every row here IS visible; the flag is how the
 *     database decided that, and echoing it back would invite a screen to
 *     re-filter on something the wall has already decided.
 */
export interface PortalDocumentRow {
  readonly documentId: string;
  readonly title: string;
  /** What it IS, and it is on this surface deliberately — unlike
   *  `PortalAskRow.documentKind`, which is the firm's filing decision about a
   *  file that does not exist yet. Here it is what the reader is looking for:
   *  "the challan", "the letter we signed". */
  readonly kind: DocumentKind;
  /** Which of the client's companies it belongs to. Never null on this surface:
   *  a document with no party is the FIRM's own, and 0063's policy denies it by
   *  arithmetic. */
  readonly companyName: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly mediaType: string;
  /** Lower-case hex SHA-256 of the bytes. On this surface because it is what
   *  makes "is the copy I hold the one you gave me" a comparison rather than a
   *  matter of trust — the same reason it is on the firm's side. */
  readonly contentHash: string;
  /** When the firm added it. The document's own date, not the version's: a
   *  superseded document keeps the day it entered the client's world. */
  readonly addedOn: string;
  /** What it is attached to, in words — "GSTR-3B — Aug 2026". Null when it is
   *  attached to nothing, which is a real state: a firm may file a document
   *  against a client and no particular job. */
  readonly aboutWhat: string | null;
}

/**
 * One invoice, as the client reads it.
 *
 * ── MONEY IS A DECIMAL STRING, ON THE WIRE AND IN THIS TYPE ──────────────
 *
 * `numeric` in the database, a string here, never a JS number on either side.
 * This is the one type in the portal that carries money and the rule does not
 * bend for it being a read — 0.1 + 0.2 is the same on a client's screen as on a
 * partner's, and a rounding error a client can see is worse.
 */
export interface PortalInvoiceRow {
  readonly invoiceId: string;
  /** The human-facing number, frozen the moment the row existed. */
  readonly number: string;
  /** Which of the FIRM's companies charged them. On this surface because it is
   *  printed on the invoice they already hold, and a client operating with two
   *  of the firm's entities needs to tell the two series apart. */
  readonly issuedBy: string;
  /** Which of the CLIENT's companies was billed. */
  readonly billedTo: string;
  readonly status: "issued" | "cancelled";
  readonly currency: string;
  /** What was demanded, net of discount and including tax. */
  readonly total: string;
  readonly paid: string;
  readonly credited: string;
  /** total − paid − credited. Derived by `crm.invoice_balance`, never stored:
   *  a `paid` flag is a cache of this subtraction and drifts the first time a
   *  payment is corrected. */
  readonly outstanding: string;
  readonly issuedOn: string | null;
  /**
   * The date the FIRM asked to be paid by.
   *
   * ── AND IT IS THE ONE INVENTED DATE THE PORTAL LETS THROUGH ────────────
   *
   * The standing rule is that no due date this product invented reaches a
   * client: `internal_target_on` never leaves, and a work item answers with the
   * day it opened. This one is different in the only way that matters — it is
   * printed on the invoice the client is already holding. Hiding it here would
   * mean the portal disagreeing with a document the firm has already sent, and a
   * client cannot pay to a date the portal will not show them.
   */
  readonly dueOn: string | null;
}

/** What the month view answers. Every list is bounded by ONE MONTH — see
 *  `PortalDigest` for why that is not a window over a stream. */
export interface PortalDigestRow {
  readonly label: string;
  readonly companyName: string | null;
  /** YYYY-MM-DD — the day this happened, whatever "happened" means for the
   *  line. Kept as a day and not an instant: none of these is a fact about a
   *  time of day, and an instant would print the day before west of Greenwich. */
  readonly on: string;
}

/**
 * A month of the firm's work for this client, in four lists.
 *
 * ── WHY A MONTH AND WHY IT IS A SCREEN ───────────────────────────────────
 *
 * The board asks for a "monthly digest". A digest is an EMAIL, and there is no
 * transport — P10 is Phase 7 — so this ships as the thing behind the email
 * rather than as the email. That is the chaser's own arrangement (`ChaserService`
 * has no mailer injected) and for the chaser's own reason: a logging stub that
 * announced a client had been emailed would be a lie in an operator's log.
 *
 * What it is NOT is a second copy of the status home. The home answers "what is
 * outstanding today" and is bounded by a rolling ninety days; this answers "what
 * did you do for me in March", is bounded by a calendar month, and reaches back
 * as far as a client cares to look. A client hunting for last year's challan
 * finds it here or in the library, and both were the point.
 */
export interface PortalDigest {
  /** YYYY-MM, echoed back. */
  readonly month: string;
  readonly filed: readonly PortalDigestRow[];
  readonly documentsAdded: readonly PortalDigestRow[];
  readonly invoiced: readonly PortalDigestRow[];
  readonly asksAnswered: readonly PortalDigestRow[];
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** A YYYY-MM is a month. Nothing else is, and a bad one is refused rather than
 *  coerced: `2026-13` silently read as January 2027 would answer a question
 *  nobody asked with data that looks right. */
export function isMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

/**
 * The half-open day range a month covers — `[first, firstOfNext)`.
 *
 * Half-open like every other range in this schema (`portal_access`,
 * `client_freeze`, `party_relationship`), and computed by STRING arithmetic on
 * the year and month rather than by `Date`. A `Date` built from a day string is
 * UTC midnight, and on this function that would move the boundary of a month by
 * a day for anybody west of Greenwich — which puts the 1st of April's filing in
 * March's digest.
 */
export function monthRange(month: string): { readonly from: string; readonly to: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const nextYear = index === 12 ? year + 1 : year;
  const nextIndex = index === 12 ? 1 : index + 1;
  return {
    from: `${String(year)}-${String(index).padStart(2, "0")}-01`,
    to: `${String(nextYear)}-${String(nextIndex).padStart(2, "0")}-01`,
  };
}
