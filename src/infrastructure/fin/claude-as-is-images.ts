// An image sent to the AI reader exactly as it was stored, for the one-file try
// (`npm run fin:extract-one`) only. The fin job uses the real normaliser (the
// sharp adapter, F2.3), which shrinks, re-encodes and turns a sideways photo
// upright; this one does none of that, and so it refuses rather than pretend:
// anything that is not already a JPEG or a PNG within the edge asked for is
// thrown back with a sentence saying why. A page photographed sideways is sent
// sideways, which the model reads; that is the one thing it does not refuse.
import type { ImageNormaliser, NormalisedImage } from "../../usecase/fin/reading";

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The start-of-frame markers, the only segments that carry the size. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 9 < bytes.byteLength) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (SOF.has(marker)) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

export class AsIsImages implements ImageNormaliser {
  normalise(bytes: Uint8Array, maxEdge: number): Promise<NormalisedImage> {
    const png = pngSize(bytes);
    const jpeg = png === null ? jpegSize(bytes) : null;
    const size = png ?? jpeg;
    if (size === null) {
      return Promise.reject(
        new Error("only a JPEG or a PNG can be sent as it is; other images need the image adapter (F2.3)"),
      );
    }
    if (Math.max(size.width, size.height) > maxEdge) {
      return Promise.reject(
        new Error(
          `the image is ${String(size.width)}x${String(size.height)} px and is sent as it is only up to ` +
            `${String(maxEdge)} px on its longest edge; shrinking it needs the image adapter (F2.3)`,
        ),
      );
    }
    return Promise.resolve({
      bytes,
      mediaType: png === null ? "image/jpeg" : "image/png",
      width: size.width,
      height: size.height,
    });
  }
}
