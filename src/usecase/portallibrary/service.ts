// The client portal's self-serve library (T6.7) — documents, invoices, and a
// month of what the firm did.
//
// ── WHAT THIS SERVICE ACTUALLY DOES, WHICH IS LESS THAN IT LOOKS ──────────
//
// It resolves the session's grants ONCE and hands them to the repository. Every
// row that comes back was filtered by a RESTRICTIVE policy in Postgres, not
// here: `document_portal_scope` (0063, narrowed by 0066),
// `document_version_portal_scope`, `invoice_portal_scope` and the three EXISTS
// policies under it (0066). There is no `if` in this file that decides what a
// client may see, and there must not be one — a filter written here would be a
// second answer to a question the wall has already answered, and the two would
// eventually disagree.
//
// ── THE ONE JUDGEMENT IT DOES MAKE IS ABOUT BYTES ────────────────────────
//
// `download` reads the VERSION row under the portal scope and only then asks the
// blob store for the key it names. That order is the whole of T3.6's *"no
// pre-signed URL"* claim being true rather than aspirational: the key is behind
// RLS, so it is unreachable before it could be used, and the store itself has no
// method that returns a URL. Adding one is the thing not to do.
import type { Clock } from "../../platform/clock";
import type { DocumentVersion } from "../../domain/filestore/model";
import type {
  PortalDigest,
  PortalDocumentRow,
  PortalInvoiceRow,
} from "../../domain/portallibrary/model";
import { isMonth, monthRange } from "../../domain/portallibrary/model";
import { BytesMissing, DocumentNotFound } from "../../domain/filestore/errors";
import { InvalidMonth } from "../../domain/portallibrary/errors";
import type {
  FirmTimeZone,
  PortalBlobStore,
  PortalLibraryRepository,
  PortalScopeSource,
} from "./ports";

export interface Deps {
  readonly scope: PortalScopeSource;
  readonly library: PortalLibraryRepository;
  /** WHICH CALENDAR a month is cut on. The firm own zone, resolved OUTSIDE
   *  the portal transaction, because tenancy.tenant has no portal policy
   *  and must not grow one. */
  readonly timeZones: FirmTimeZone;
  readonly blobs: PortalBlobStore;
  readonly clock: Clock;
}

/**
 * How many documents one library page carries.
 *
 * A cap and not a window: documents are FEW per client where filings are many —
 * a year of GST is twelve rows per company, a year of documents is a handful —
 * so the library does not need the status home's ninety-day horizon, and having
 * one would break the acceptance line outright ("last year's challan"). This
 * number exists so a firm that files a document a day for a decade does not
 * serve ten thousand rows into a phone.
 */
export const LIBRARY_PAGE = 200;

export class PortalLibraryService {
  constructor(private readonly deps: Deps) {}

  /** The client's own documents. `kind` narrows it; nothing widens it. */
  async documents(
    tenantId: string,
    userId: string,
    filter: { readonly kind?: string | undefined; readonly asOf?: string | undefined } = {},
  ): Promise<readonly PortalDocumentRow[]> {
    const parties = await this.partiesFor(tenantId, userId, filter.asOf);
    return this.deps.library.documents(tenantId, parties, {
      kind: filter.kind,
      limit: LIBRARY_PAGE,
    });
  }

  async invoices(
    tenantId: string,
    userId: string,
    asOf?: string,
  ): Promise<readonly PortalInvoiceRow[]> {
    const parties = await this.partiesFor(tenantId, userId, asOf);
    return this.deps.library.invoices(tenantId, parties);
  }

  /**
   * One calendar month of what the firm did for this client.
   *
   * The month is refused rather than coerced when it is not one: `2026-13` read
   * as January 2027 would answer a question nobody asked with data that looks
   * entirely right, which is the worst kind of wrong a read can be.
   */
  async digest(
    tenantId: string,
    userId: string,
    month: string,
    asOf?: string,
  ): Promise<PortalDigest> {
    if (!isMonth(month)) throw new InvalidMonth(month);
    const parties = await this.partiesFor(tenantId, userId, asOf);
    // The FIRM's zone, not the reader's and not the server's — a digest is a
    // statement by the firm about a month, so the boundary has to be one
    // boundary. Resolved BEFORE the portal transaction opens, because
    // `tenancy.tenant` has no portal policy and must not grow one (T6.9's rule
    // about the Key Manager, applied again).
    const timeZone = await this.deps.timeZones.timeZoneFor(tenantId);
    const rows = await this.deps.library.digest(
      tenantId,
      parties,
      monthRange(month),
      timeZone,
    );
    return { month, ...rows };
  }

  /**
   * The bytes of one document, if this session may reach it.
   *
   * ── ROW FIRST, BYTES SECOND, AND NEVER THE OTHER WAY ROUND ─────────────
   *
   * `findVersion` runs inside `withPortal` and returns null for a document this
   * session may not reach — which is also the answer for one that does not
   * exist and one the firm has not marked visible, indistinguishably and on
   * purpose. Only then is the storage key it names handed to the blob store.
   *
   * `BytesMissing` is a different failure and gets a different error: the row
   * says there is a file and the disk does not have it. That is an operational
   * fault at the firm, not a client asking for something they may not have, and
   * telling a client "not found" for it would send them looking for a document
   * they are entitled to and hiding a broken store.
   */
  async download(
    tenantId: string,
    userId: string,
    documentId: string,
    asOf?: string,
  ): Promise<{ readonly version: DocumentVersion; readonly bytes: Uint8Array }> {
    const parties = await this.partiesFor(tenantId, userId, asOf);
    const version = await this.deps.library.findVersion(tenantId, parties, documentId);
    if (version === null) throw new DocumentNotFound(documentId);

    const bytes = await this.deps.blobs.get({ tenantId, storageKey: version.storageKey });
    if (bytes === null) throw new BytesMissing(version.storageKey);
    return { version, bytes };
  }

  /**
   * The grants, resolved ONCE per request.
   *
   * Never per query: two resolutions could disagree across a day boundary, and
   * the second one is the wall. `PortalHomeService` takes the same care and says
   * the same thing.
   */
  private async partiesFor(
    tenantId: string,
    userId: string,
    asOf?: string,
  ): Promise<readonly string[]> {
    const day = asOf ?? this.today();
    const companies = await this.deps.scope.scopedCompanies(tenantId, userId, day);
    // An EMPTY list is passed on as an empty list. See `PortalLibraryRepository`
    // — skipping the call because there is nothing to scope by would leave
    // `app.portal` unset, which means STAFF.
    return companies.map((c) => c.clientPartyId);
  }

  /** The server's calendar day — the honest fallback for a caller that did not
   *  say which day it is on, and never the answer when one did. */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}
