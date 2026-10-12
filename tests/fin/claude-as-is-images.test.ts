// The one-file try's image "normaliser" (F2.4, infrastructure/fin/
// claude-as-is-images.ts): it sends a JPEG or PNG as it is, and REFUSES what it
// would have to shrink or convert, rather than pretend it did.
import { describe, expect, it } from "vitest";
import { AsIsImages } from "../../src/infrastructure/fin/claude-as-is-images";

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then a baseline start-of-frame.
  const b = new Uint8Array(2 + 18 + 19);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  const v = new DataView(b.buffer);
  v.setUint16(25, height);
  v.setUint16(27, width);
  return b;
}

describe("sending an image as it is", () => {
  const images = new AsIsImages();

  it("sends a PNG or a JPEG within the edge unchanged, with its size", async () => {
    const p = png(1200, 1600);
    expect(await images.normalise(p, 2048)).toEqual({ bytes: p, mediaType: "image/png", width: 1200, height: 1600 });
    const j = jpeg(2048, 1536);
    expect(await images.normalise(j, 2048)).toEqual({ bytes: j, mediaType: "image/jpeg", width: 2048, height: 1536 });
  });

  it("refuses an image it would have to shrink, saying what would", async () => {
    await expect(images.normalise(jpeg(4032, 3024), 2048)).rejects.toThrow(/4032x3024 px.*image adapter/);
  });

  it("refuses what is not a JPEG or a PNG", async () => {
    await expect(images.normalise(new Uint8Array([0x47, 0x49, 0x46, 0x38]), 2048)).rejects.toThrow(/only a JPEG or a PNG/);
    await expect(images.normalise(new Uint8Array([]), 2048)).rejects.toThrow(/only a JPEG or a PNG/);
  });
});
