// The seams the client portal's library needs. Interfaces owned by this use
// case, stated in its vocabulary; the Postgres adapter implements them.
import type { DocumentVersion } from "../../domain/filestore/model";
import type {
  PortalDigest,
  PortalDocumentRow,
  PortalInvoiceRow,
} from "../../domain/portallibrary/model";

/**
 * Which companies this SESSION may read, today.
 *
 * The THIRD structurally-identical copy of this port (`portalhome` and
 * `clientask` have the other two), satisfied by the same object in `setup/` —
 * `PortalAccessService.scopedClientsForUser`. Declared here rather than imported
 * because "what may this session read" is a question this use case has to ask on
 * its own, and a use case reaching into another's ports for a shape is how two
 * modules end up in one blast radius. TypeScript is structural; one
 * implementation satisfies all three without any of them knowing.
 */
export interface PortalScopeSource {
  scopedCompanies(
    tenantId: string,
    userId: string,
    on: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]>;
}

/**
 * The library's reads. EVERY method is `withPortal`, never `withTenant`.
 *
 * IT TAKES THE PARTY IDS AND HAS NO VARIANT THAT DOES NOT — the shape
 * `PortalHomeRepository` and `PortalAskRepository` both have, for the reason
 * `withPortal` itself has: an EMPTY list is a real answer that must reach the
 * database as one, and "I did not ask the grant table" is not a scope. An
 * implementation that skipped the call because the list was empty would leave
 * `app.portal` unset, which means STAFF, and every read would succeed.
 */
export interface PortalLibraryRepository {
  /** The client's own documents, newest first. Rows carry NAMES — the company,
   *  and what the document is attached to — joined here rather than looked up
   *  per row. */
  documents(
    tenantId: string,
    clientPartyIds: readonly string[],
    filter: { readonly kind?: string | undefined; readonly limit: number },
  ): Promise<readonly PortalDocumentRow[]>;

  /**
   * The version row for one document, if this session may reach it.
   *
   * ── THIS IS WHERE "NO PRE-SIGNED URL" IS ACTUALLY ENFORCED ─────────────
   *
   * It returns the version — which NAMES the storage key — and not the bytes,
   * because the bytes come from a `BlobStore` that knows nothing about RLS. The
   * key is unreachable unless this row is, and this row is behind
   * `document_version_portal_scope`'s EXISTS on a parent that is itself behind
   * `document_portal_scope` (0063, narrowed by 0066). So a client cannot be
   * handed a key, and a key cannot be guessed into bytes.
   *
   * Null is the answer for "no such document" AND for "a document you were not
   * granted" AND for "one the firm has not marked visible", and the three are
   * indistinguishable ON PURPOSE: they are all the policy filtering the row, so
   * there is nothing here that could tell them apart — and a 403 would confirm
   * the document exists.
   */
  findVersion(
    tenantId: string,
    clientPartyIds: readonly string[],
    documentId: string,
  ): Promise<DocumentVersion | null>;

  /** The client's own invoices, newest first, with what is still outstanding.
   *  A DRAFT invoice is not here and cannot be — 0066 puts the status test in
   *  the policy, not in this query. */
  invoices(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalInvoiceRow[]>;

  /** One calendar month of what the firm did. `from` inclusive, `to`
   *  exclusive — half-open, like every other range in this schema. */
  digest(
    tenantId: string,
    clientPartyIds: readonly string[],
    range: { readonly from: string; readonly to: string },
    /** The firm's zone. `range` is a pair of calendar days and this is what
     *  turns them into the instants that bound the month. */
    timeZone: string,
  ): Promise<Omit<PortalDigest, "month">>;
}

/**
 * The firm's own timezone — which calendar DAY or MONTH an instant belongs to.
 *
 * Declared here as well as in `usecase/chaser/ports.ts`, because ports
 * live beside the use case that needs them; ONE adapter satisfies both, which
 * is what stops the chaser counting days in one zone while the digest cuts
 * months in another.
 *
 * NOT how an instant is rendered — that is the reader's own zone (T6.9), and
 * the two rules point in opposite directions.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}


/**
 * The bytes, by storage key.
 *
 * Structurally identical to `usecase/filestore`'s `BlobStore` and declared here
 * rather than imported, for this file's own standing reason. One
 * implementation in `setup/` satisfies both — which matters more than usual
 * here: two blob stores would mean a client's download and the firm's download
 * reading different disks.
 */
export interface PortalBlobStore {
  get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array | null>;
}
