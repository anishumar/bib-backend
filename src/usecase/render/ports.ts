// The seams rendering needs. Interfaces owned by this use case.
import type { DocumentKind } from "../../domain/filestore/model";
import type { PlacedAnchor, RenderableDocument } from "../../domain/render/model";

/**
 * Bytes from a document description. Knows about fonts and page sizes; knows
 * NOTHING about engagement letters, invoices or Postgres.
 *
 * **The implementation must be a pure function of its input.** That is not a
 * style preference: a rendered document's content hash is what proves the file
 * a client holds is the one the firm issued (T2.3's `signed_content_hash`
 * finally has something to point at), so re-rendering unchanged data has to
 * produce identical bytes. Anything that reaches for a clock, a random number or
 * a machine's locale breaks it — and breaks it silently, because the PDF still
 * opens.
 */
export interface DocumentRenderer {
  /** For the honest registry and for operator logs. */
  readonly kind: string;
  readonly mediaType: string;
  render(document: RenderableDocument): Promise<Uint8Array>;
  /**
   * The same bytes, and where each anchored piece was drawn — the preview's
   * read (2026-09-28). The anchors are a side output of the one drawing pass
   * and never reach the file: these bytes are `render`'s, hash for hash.
   */
  renderWithAnchors(document: RenderableDocument): Promise<RenderedWithAnchors>;
}

export interface RenderedWithAnchors {
  readonly bytes: Uint8Array;
  readonly anchors: readonly PlacedAnchor[];
  readonly pageCount: number;
}

/**
 * Turning one of the product's own records into a document description.
 *
 * Declared here and implemented over Postgres, so the renderer never holds a
 * repository and the modules that own the data never learn what a PDF is.
 */
export interface RenderSource {
  /** True when this source knows how to describe that kind of document — asked
   *  before rendering so a refusal names what is missing rather than failing
   *  somewhere inside an adapter. */
  supports(kind: DocumentKind): boolean;

  /** Null when the record does not exist for this tenant. */
  describe(input: {
    readonly tenantId: string;
    readonly kind: DocumentKind;
    readonly subjectRef: string;
    /**
     * A PREVIEW's day (2026-09-28). Given, and the record an unsent DRAFT, the
     * source describes it as Send would leave it on that day: the proposal's
     * date, and the letter's date and the firm's signature block, which Send
     * stamps; an invoice's date, which Issue stamps (B42, 2026-10-03). Absent,
     * or a record already out, and it describes the record as it stands.
     * Since B42 a draft COPY filed through `render` is described the same way,
     * on the firm's day, so the copy on file is the preview on the screen.
     */
    readonly asIfSentOn?: string | undefined;
  }): Promise<DescribedDocument | null>;
}

/**
 * What a source knows about a record: how to draw it, and WHOSE it is.
 *
 * -- WHY THE PARTY COMES BACK FROM HERE AND NOT FROM THE REQUEST -------------
 *
 * `POST /api/v1/documents/render` used to take `partyId` in its body and file
 * the rendered PDF under whatever the caller named. Two things went wrong with
 * that, and the second is the serious one:
 *
 *   omitted, the invoice was filed under NO client, and since it is
 *   client-visible by default it never appeared in the portal of the client it
 *   was addressed to;
 *
 *   supplied wrongly — a stale id on a screen, or a deliberate one — the PDF
 *   was filed under a DIFFERENT client, where `clientVisibleByDefault("invoice")`
 *   makes it visible in that client's portal library. One firm's invoice, in
 *   another client's document list, through the front door.
 *
 * The record already knows whose it is: an engagement letter has a party_id and
 * so does an invoice. There is no case where a firm wants the PDF of an invoice
 * filed against somebody who is not its addressee, so this is not a parameter —
 * it is a fact, and it is read from the same row the document is drawn from.
 */
export interface DescribedDocument {
  readonly document: RenderableDocument;
  /** The client this record belongs to. Null only where the source genuinely
   *  has no party — no renderable kind is in that state today. */
  readonly partyId: string | null;
  /**
   * Whether the record has gone to the client: an invoice issued, a letter or
   * a proposal sent. For an invoice or a letter it decides what a filed copy
   * is (`hasCopyOfRecord`): a draft copy before, the copy of record after.
   */
  readonly isOut: boolean;
  /** Which of the firm's companies issues it — whose logo and cover the page
   *  carries, so a preview can say which company's brand is missing. */
  readonly issuingEntity?: { readonly partyId: string; readonly name: string } | undefined;
  /** The day a draft was described as sent on (`asIfSentOn` applied), or
   *  absent when the record was described as it stands. */
  readonly datedAsIfSent?: string | undefined;
  /** True for a draft invoice, which has no number until it is issued (0322):
   *  its page prints "Draft" where the number goes, and neither a file nor a
   *  title is named after that (CA#56). */
  readonly unnumbered?: boolean | undefined;
}

/**
 * The firm's time zone — whose calendar "today" is on (T6.11). This use case's
 * own port, as every other that needs one declares its own.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
