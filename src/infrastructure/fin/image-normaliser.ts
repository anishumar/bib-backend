// The image port (`usecase/fin/reading.ts` `ImageNormaliser`) on sharp
// (docs/FIN_BUILD_PLAN.md F2.3): a phone photo of a receipt made upright, small
// enough to send to the AI reader, and re-encoded. The ONLY file in the product
// that imports `sharp`; nothing of sharp's crosses the port.
//
// ── WHAT IT DOES TO A PHOTO ──────────────────────────────────────────────────
//
//   upright     a phone stores most photos sideways and says so in an EXIF tag
//               ("rotate 90° to view"); a reader handed the raw pixels reads a
//               receipt lying on its side. The tag is applied, then dropped.
//   smaller     the longest edge is at most `maxEdge`, the aspect kept, and an
//               image already smaller is NEVER enlarged (upscaling invents
//               pixels and a model reads them as detail).
//   re-encoded  JPEG at quality 85 for anything photographic; a PNG stays a PNG
//               (a screenshot of an invoice is sharp text that JPEG smears).
//               Transparency in a JPEG-bound image is laid on white.
//   stripped    nothing of the original's metadata is written back: a phone
//               photo's EXIF carries where it was taken, and the AI reader
//               needs the pixels and nothing else.
//
// ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
//
// Only the raster formats a client's camera or scanner makes are opened: JPEG,
// PNG, WebP, TIFF and HEIF. The format is told from the first bytes, BEFORE
// sharp sees them, so an SVG (a document that can reference other files) or
// anything else sharp happens to read is never decoded. Pixels are capped
// (`limitInputPixels`) so a small file that declares a gigapixel image is
// refused from its header, and sharp's strictest failure level (`warning`, its
// advice for input nobody vouches for) refuses a damaged or truncated file.
//
// **An iPhone's HEIC is refused as `unsupported` in this build**, measured and
// not assumed: sharp's prebuilt libvips reads the HEIF container but decodes
// only AV1 (AVIF), and an iPhone encodes HEIC in HEVC, which the prebuilt
// binaries leave out for patent reasons ("Support for this compression format
// has not been built in"). The adapter reads the container's compression first
// and says so in words. `tests/fin/image-normaliser.test.ts` pins it with a
// real HEVC HEIC, so a build that gains HEVC turns the test red and the
// sentence gets rewritten rather than going stale.
//
// ── NATIVE, AND LOADED ON FIRST USE ──────────────────────────────────────────
//
// sharp is native code (libvips) installed per platform: the image that runs
// the fin job must be built on the platform it runs on (`npm ci` inside the
// Linux build stage, never a `node_modules` copied from a Mac). It is imported
// the first time an image is normalised, so the API, which imports
// `setup/fin.ts` and never touches an image, never loads it: a native module
// that failed to load would otherwise take the API down with it (ground rule 4).
import { ImageUnreadable } from "../../domain/fin/errors";
import type { ImageNormaliser, NormalisedImage } from "../../usecase/fin/reading";
// Types only, erased from the build: the module itself is imported on first use.
import type sharpConstructor from "sharp";

type Sharp = typeof sharpConstructor;

/** 100 megapixels: a 48MP phone sensor's full frame twice over. Past this the
 *  image is refused from its header, before a pixel is decoded. */
export const MAX_INPUT_PIXELS = 100_000_000;
/** The upload limit's default, twice: the limit decides, this only stops a
 *  file that reached the job some other way. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const JPEG_QUALITY = 85;

let loading: Promise<Sharp> | null = null;

function sharpLib(): Promise<Sharp> {
  loading ??= import("sharp").then((m) => m.default);
  return loading;
}

/** The raster formats opened, told from their first bytes. */
export type ImageFormat = "jpeg" | "png" | "webp" | "tiff" | "heif";

const HEIF_BRANDS: ReadonlySet<string> = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis",
]);

/** The format a file's first bytes declare, or null for anything else. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const b = (i: number): number => bytes[i] ?? -1;
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpeg";
  if (b(0) === 0x89 && ascii(1, 4) === "PNG" && b(4) === 0x0d && b(5) === 0x0a) return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if ((ascii(0, 2) === "II" && b(2) === 42 && b(3) === 0) || (ascii(0, 2) === "MM" && b(2) === 0 && b(3) === 42)) {
    return "tiff";
  }
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) return "heif";
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a libvips failure means for the client's file. Its errors are
 *  sentences, so they are read as sentences: the pixel limit, a codec the
 *  build left out, and everything else is a damaged file. */
function refusalFor(err: unknown): ImageUnreadable {
  const message = messageOf(err);
  if (/pixel limit/iu.test(message)) return new ImageUnreadable("too_large", message);
  if (/compression format has not been built in|unsupported image format/iu.test(message)) {
    return new ImageUnreadable("unsupported", message);
  }
  return new ImageUnreadable("damaged", message);
}

export class SharpImageNormaliser implements ImageNormaliser {
  constructor(
    private readonly maxInputPixels: number = MAX_INPUT_PIXELS,
    private readonly maxBytes: number = MAX_IMAGE_BYTES,
  ) {}

  async normalise(bytes: Uint8Array, maxEdge: number): Promise<NormalisedImage> {
    if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > 16_384) {
      throw new RangeError(`maxEdge must be a whole number of pixels from 16 to 16384; got ${maxEdge}`);
    }
    if (bytes.length > this.maxBytes) {
      throw new ImageUnreadable("too_large", `${bytes.length} bytes, over the ${this.maxBytes} an image may be`);
    }
    const format = sniffImage(bytes);
    if (format === null) throw new ImageUnreadable("unsupported", "not a JPEG, PNG, WebP, TIFF or HEIF file");

    const sharp = await sharpLib();
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const options = { limitInputPixels: this.maxInputPixels, failOn: "warning" as const, autoOrient: true };

    let meta;
    try {
      meta = await sharp(input, options).metadata();
    } catch (err) {
      throw refusalFor(err);
    }
    if (meta.width * meta.height > this.maxInputPixels) {
      throw new ImageUnreadable("too_large", `${meta.width}x${meta.height}, over ${this.maxInputPixels} pixels`);
    }
    if (format === "heif" && meta.compression === "hevc") {
      throw new ImageUnreadable(
        "unsupported",
        "an HEVC-encoded HEIC (an iPhone's default), which this server's image library does not decode",
      );
    }

    const keepPng = format === "png";
    let pipeline = sharp(input, options).resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });
    pipeline = keepPng
      ? pipeline.png()
      : pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: JPEG_QUALITY });
    try {
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        mediaType: keepPng ? "image/png" : "image/jpeg",
        width: info.width,
        height: info.height,
      };
    } catch (err) {
      throw refusalFor(err);
    }
  }
}
