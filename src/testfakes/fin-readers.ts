// In-memory fakes for fin's file-reading ports (`usecase/fin/reading.ts`):
// the PDF text, the image and the archive readers. `implements` is the
// compile-time assertion that they stay in step with the adapters
// (`infrastructure/fin/{pdf-text,image-normaliser,zip-archive}.ts`).
//
// Each answers what it was told to for the bytes it is handed, keyed by the
// bytes' text, and refuses the way its adapter does for anything else: a PDF
// it does not know is `PdfUnreadable("damaged")`, an image is
// `ImageUnreadable("damaged")`, an archive is `corrupt`. They reproduce the
// one rule a caller may depend on and nothing of the vendors': the image fake
// does the shrink arithmetic (longest edge to `maxEdge`, aspect kept, never
// enlarged), because a use case sizing a request to the AI reader reads it.
import { ImageUnreadable, PdfUnreadable } from "../domain/fin/errors";
import type { PdfText } from "../domain/fin/lines";
import type {
  ArchiveLimits,
  ArchiveReader,
  ArchiveResult,
  ImageNormaliser,
  NormalisedImage,
  PdfTextReader,
} from "../usecase/fin/reading";

function keyOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

export class FakePdfTextReader implements PdfTextReader {
  private readonly answers = new Map<string, PdfText | PdfUnreadable>();
  /** How many reads were asked for, to prove a reader that should not touch
   *  the bytes did not. */
  calls = 0;

  /** Answer `text` (or throw `error`) when handed these bytes. */
  set(bytes: Uint8Array | string, answer: PdfText | PdfUnreadable): void {
    this.answers.set(typeof bytes === "string" ? bytes : keyOf(bytes), answer);
  }

  read(bytes: Uint8Array): Promise<PdfText> {
    this.calls += 1;
    const answer = this.answers.get(keyOf(bytes));
    if (answer === undefined) return Promise.reject(new PdfUnreadable("damaged", "the fake was not told about these bytes"));
    if (answer instanceof PdfUnreadable) return Promise.reject(answer);
    return Promise.resolve(answer);
  }
}

/** An image the fake knows: what it decodes to before shrinking. */
export interface FakeImage {
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/jpeg" | "image/png";
}

export class FakeImageNormaliser implements ImageNormaliser {
  private readonly images = new Map<string, FakeImage | ImageUnreadable>();
  /** The `maxEdge` of every call, in order. */
  readonly edges: number[] = [];

  set(bytes: Uint8Array | string, image: FakeImage | ImageUnreadable): void {
    this.images.set(typeof bytes === "string" ? bytes : keyOf(bytes), image);
  }

  normalise(bytes: Uint8Array, maxEdge: number): Promise<NormalisedImage> {
    this.edges.push(maxEdge);
    const image = this.images.get(keyOf(bytes));
    if (image === undefined) return Promise.reject(new ImageUnreadable("damaged", "the fake was not told about these bytes"));
    if (image instanceof ImageUnreadable) return Promise.reject(image);
    const longest = Math.max(image.width, image.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    return Promise.resolve({
      bytes,
      mediaType: image.mediaType,
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
    });
  }
}

export class FakeArchiveReader implements ArchiveReader {
  private readonly results = new Map<string, ArchiveResult>();
  /** The limits of every call, in order, to prove a caller passed the
   *  product's. */
  readonly limitsSeen: ArchiveLimits[] = [];

  set(bytes: Uint8Array | string, result: ArchiveResult): void {
    this.results.set(typeof bytes === "string" ? bytes : keyOf(bytes), result);
  }

  unpack(bytes: Uint8Array, limits: ArchiveLimits): ArchiveResult {
    this.limitsSeen.push(limits);
    return this.results.get(keyOf(bytes)) ?? { ok: false, refusal: "corrupt", entryPath: null };
  }
}
