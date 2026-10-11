// The image adapter on sharp (docs/FIN_BUILD_PLAN.md F2.3): upright, shrunk,
// never enlarged, re-encoded, stripped, and every refusal. Images are made here
// with sharp itself; the one committed fixture is `fixtures/iphone-hevc.heic`
// (540 bytes, a 24 x 16 red square saved as HEIC by macOS's `sips`), because no
// library in this repo can WRITE the HEVC an iPhone uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ImageUnreadable } from "../../src/domain/fin/errors";
import { SharpImageNormaliser, sniffImage } from "../../src/infrastructure/fin/image-normaliser";

// libvips decodes and encodes for real: a few hundred milliseconds a test on a
// loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const normaliser = new SharpImageNormaliser();

function solid(width: number, height: number): Sharp {
  return sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 220 } } });
}

async function refusal(bytes: Uint8Array, n = normaliser): Promise<ImageUnreadable> {
  try {
    await n.normalise(bytes, 1600);
  } catch (err) {
    if (err instanceof ImageUnreadable) return err;
    throw err;
  }
  throw new Error("expected ImageUnreadable");
}

describe("making a photo ready for the AI reader", () => {
  it("shrinks so the longest edge is maxEdge, keeping the aspect, as a JPEG", async () => {
    const photo = await solid(4000, 3000).jpeg().toBuffer();
    const out = await normaliser.normalise(photo, 1600);
    expect([out.mediaType, out.width, out.height]).toEqual(["image/jpeg", 1600, 1200]);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1600, 1200]);
  });

  it("never enlarges a small image", async () => {
    const out = await normaliser.normalise(await solid(300, 200).jpeg().toBuffer(), 1600);
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it("applies the EXIF rotation a phone writes instead of turning the pixels", async () => {
    // Stored 400 wide and 200 high, tagged "rotate 90° clockwise to view".
    const sideways = await solid(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(sideways).metadata()).orientation).toBe(6);
    const out = await normaliser.normalise(sideways, 1600);
    expect([out.width, out.height]).toEqual([200, 400]);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([200, 400, undefined]);
  });

  it("writes none of the original's metadata back: no EXIF, so no location", async () => {
    const tagged = await solid(100, 100).jpeg().withExif({ IFD0: { Make: "PhoneCo", Model: "Camera" } }).toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const out = await normaliser.normalise(tagged, 1600);
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
  });

  it("keeps a PNG a PNG (a screenshot is sharp text JPEG would smear)", async () => {
    const out = await normaliser.normalise(await solid(2000, 500).png().toBuffer(), 1000);
    expect([out.mediaType, out.width, out.height]).toEqual(["image/png", 1000, 250]);
    expect((await sharp(out.bytes).metadata()).format).toBe("png");
  });

  it("re-encodes WebP and TIFF as JPEG, laying transparency on white", async () => {
    const webp = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .webp()
      .toBuffer();
    const out = await normaliser.normalise(webp, 1600);
    expect(out.mediaType).toBe("image/jpeg");
    const { data } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
    expect((await normaliser.normalise(await solid(60, 40).tiff().toBuffer(), 1600)).mediaType).toBe("image/jpeg");
  });

  it("refuses a maxEdge that is not a sensible whole number of pixels: a programming mistake", async () => {
    await expect(normaliser.normalise(await solid(10, 10).jpeg().toBuffer(), 0)).rejects.toThrow(RangeError);
    await expect(normaliser.normalise(await solid(10, 10).jpeg().toBuffer(), 1.5)).rejects.toThrow(RangeError);
  });
});

describe("what it refuses", () => {
  it("an iPhone's HEVC HEIC is unsupported in this build, and says so", async () => {
    const heic = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "iphone-hevc.heic")));
    expect(sniffImage(heic)).toBe("heif");
    const err = await refusal(heic);
    expect(err.reason).toBe("unsupported");
    expect(err.code).toBe("FIN_IMAGE_UNREADABLE");
    expect(err.message).toMatch(/HEIC/u);
  });

  it("an AVIF in the same HEIF container decodes: sharp's build reads AV1", async () => {
    const avif = await solid(64, 32).heif({ compression: "av1" }).toBuffer();
    expect(sniffImage(new Uint8Array(avif))).toBe("heif");
    const out = await normaliser.normalise(avif, 1600);
    expect([out.mediaType, out.width, out.height]).toEqual(["image/jpeg", 64, 32]);
  });

  it("bytes that are no image, an SVG and a GIF are unsupported, before the library sees them", async () => {
    expect((await refusal(new TextEncoder().encode("plain text, not a picture"))).reason).toBe("unsupported");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    expect((await refusal(new TextEncoder().encode(svg))).reason).toBe("unsupported");
    expect((await refusal(new Uint8Array(await solid(10, 10).gif().toBuffer()))).reason).toBe("unsupported");
  });

  it("a JPEG cut off part way is damaged", async () => {
    const whole = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } },
    })
      .jpeg()
      .toBuffer();
    expect((await refusal(new Uint8Array(whole.subarray(0, Math.floor(whole.length / 2))))).reason).toBe("damaged");
  });

  it("an image with more pixels than the limit is too large, from its header", async () => {
    const small = new SharpImageNormaliser(10_000);
    expect((await refusal(await solid(200, 200).png().toBuffer(), small)).reason).toBe("too_large");
  });

  it("more bytes than an image may be is too large, before decoding", async () => {
    const tiny = new SharpImageNormaliser(100_000_000, 100);
    expect((await refusal(await solid(100, 100).png().toBuffer(), tiny)).reason).toBe("too_large");
  });
});
