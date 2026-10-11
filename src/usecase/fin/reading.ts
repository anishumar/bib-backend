// The seams of reading a file (docs/FIN_BUILD_PLAN.md F2.3–F2.7). Adapters live
// in `infrastructure/fin/`; no vendor type crosses these interfaces.
//
// The read sweep holds an ordered list of `DocumentReader`s and offers each
// intake item to them in turn; the first that does not answer `not_mine` decides
// it. Adding a reader (a new bank's PDF layout, the AI reader) is a line in
// `setup/fin.ts`, never a branch in the sweep.
import type { IntakeRoute } from "../../domain/fin/intake";
import type { PdfText, ReadDraft, ReadProblem, Reader } from "../../domain/fin/lines";

/** One intake item, with its bytes, as a reader is given it. */
export interface ReadInput {
  readonly tenantId: string;
  readonly intakeItemId: string;
  readonly documentVersionId: string;
  readonly clientPartyId: string | null;
  readonly route: IntakeRoute;
  readonly mediaType: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export type ReadOutcome =
  /** The reader read it; the draft goes to staging. */
  | { readonly kind: "read"; readonly draft: ReadDraft }
  /** Not a file this reader handles; offer it to the next one. */
  | { readonly kind: "not_mine" }
  /** This reader is the right one and could not read it: a person must. */
  | { readonly kind: "needs_person"; readonly reader: Reader; readonly problem: ReadProblem };

export interface DocumentReader {
  readonly name: Reader;
  read(input: ReadInput): Promise<ReadOutcome>;
}

/** A PDF's text layer with positions. Throws `PdfUnreadable` (domain error,
 *  F2.3) for a file that is not a PDF, is damaged or is encrypted. */
export interface PdfTextReader {
  read(bytes: Uint8Array): Promise<PdfText>;
}

/** An image made small enough to send to the AI reader. */
export interface NormalisedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

export interface ImageNormaliser {
  /** Re-encodes and shrinks so the longest edge is at most `maxEdge`, keeping
   *  the aspect ratio and applying the EXIF rotation (a phone photo is often
   *  stored sideways). Throws `ImageUnreadable` for bytes that are no image. */
  normalise(bytes: Uint8Array, maxEdge: number): Promise<NormalisedImage>;
}

/** Limits on unpacking an archive (F2.7). Every one is enforced while reading,
 *  before the bytes are inflated, so a zip bomb never reaches memory. */
export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;
  /** An archive inside an archive is depth 2. */
  readonly maxDepth: number;
  /** Uncompressed size over compressed size, per entry. */
  readonly maxRatio: number;
}

export type ArchiveRefusal =
  | "too_many_entries"
  | "too_large"
  | "too_deep"
  | "suspicious_ratio"
  | "executable"
  | "encrypted"
  | "corrupt";

export interface ArchiveEntry {
  /** The path inside the archive, `/`-separated, never absolute and never
   *  climbing out (`..` is refused as `corrupt`). */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly depth: number;
}

export type ArchiveResult =
  | { readonly ok: true; readonly entries: readonly ArchiveEntry[] }
  | { readonly ok: false; readonly refusal: ArchiveRefusal; readonly entryPath: string | null };

export interface ArchiveReader {
  unpack(bytes: Uint8Array, limits: ArchiveLimits): ArchiveResult;
}
