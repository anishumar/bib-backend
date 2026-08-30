// The seams rendering needs. Interfaces owned by this use case.
import type { DocumentKind } from "../../domain/filestore/model";
import type { RenderableDocument } from "../../domain/render/model";

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
  }): Promise<RenderableDocument | null>;
}
