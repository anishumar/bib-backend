// Client portal self-serve library (T6.7). Acceptance: "A client finds last year's challan
// without emailing anyone." So no ninety-day window (that is the status home's "now"), the
// BYTES and not just a filename (T6.6 stopped at the filename), and a searchable list.
// A document is here because it is the client's (`party_id`) AND the firm marked it visible
// (`is_client_visible`, 0066), both RESTRICTIVE policies. No join widens either: reaching a
// subsidiary's documents via `crm.engagement` is refused; two companies need two grants.

import type { DocumentKind } from "../filestore/model";

/**
 * One library document, narrower than `DocumentRecord` on purpose: no uploader name (T6.5: it
 * invites chasing a junior), no storage key (T3.6: bytes leave by one route, no pre-signed
 * URL), no `isClientVisible` (every row is; a screen must not re-filter what the wall decided).
 */
export interface PortalDocumentRow {
  readonly documentId: string;
  readonly title: string;
  /** What it IS ("the challan", "the letter we signed"); unlike `PortalAskRow.documentKind`,
   *  the firm's filing decision about a file that does not exist yet. */
  readonly kind: DocumentKind;
  /** Never null here: a document with no party is the FIRM's own, denied by 0063's policy. */
  readonly companyName: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly mediaType: string;
  /** Lower-case hex SHA-256 of the bytes, so "is my copy the one you gave me" is a comparison. */
  readonly contentHash: string;
  /** When the firm added it: the document's date, not the version's. */
  readonly addedOn: string;
  /** What it is attached to, in words ("GSTR-3B — Aug 2026"). Null when filed against the
   *  client and no particular job, a real state. */
  readonly aboutWhat: string | null;
}

/** One invoice as the client reads it. The portal's only money: decimal strings, `numeric` in
 *  the DB, never a JS number. */
export interface PortalInvoiceRow {
  readonly invoiceId: string;
  /** The human-facing number, frozen the moment the row existed. */
  readonly number: string;
  /** Which of the FIRM's companies charged them; printed on the invoice, and a client of two
   *  of the firm's entities must tell the series apart. */
  readonly issuedBy: string;
  /** Which of the CLIENT's companies was billed. */
  readonly billedTo: string;
  readonly status: "issued" | "cancelled";
  readonly currency: string;
  /** What was demanded, net of discount and including tax. */
  readonly total: string;
  readonly paid: string;
  readonly credited: string;
  /** total − paid − credited, derived by `crm.invoice_balance`, never stored (a `paid` flag
   *  drifts the first time a payment is corrected). */
  readonly outstanding: string;
  readonly issuedOn: string | null;
  /** The FIRM's pay-by date: the one invented date the portal shows, because it is printed
   *  on the invoice the client holds. `internal_target_on` still never leaves. */
  readonly dueOn: string | null;
}

/** One line of the month view; every list is bounded by ONE MONTH (see `PortalDigest`). */
export interface PortalDigestRow {
  readonly label: string;
  readonly companyName: string | null;
  /** YYYY-MM-DD, the day it happened. A day, not an instant: an instant would print the day
   *  before west of Greenwich. */
  readonly on: string;
}

/**
 * A month of the firm's work for this client, in four lists. The board's "monthly digest" is
 * an email and there is no transport (P10 is Phase 7), so this is what stands behind it, as
 * `ChaserService` has no mailer: a logging stub claiming a client was emailed would be a lie.
 * Not the status home ("outstanding today", rolling 90 days): this is "what did you do for me
 * in March", any month back.
 */
export interface PortalDigest {
  /** YYYY-MM, echoed back. */
  readonly month: string;
  readonly filed: readonly PortalDigestRow[];
  readonly documentsAdded: readonly PortalDigestRow[];
  readonly invoiced: readonly PortalDigestRow[];
  readonly asksAnswered: readonly PortalDigestRow[];
}

// Pure rules

/** A YYYY-MM month. A bad one is refused, not coerced: `2026-13` would read as January 2027. */
export function isMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

/**
 * A month's half-open day range `[first, firstOfNext)`, like `portal_access`, `client_freeze`,
 * `party_relationship`. String arithmetic, not `Date`: UTC midnight would move the boundary west
 * of Greenwich and put 1 April's filing in March's digest.
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
