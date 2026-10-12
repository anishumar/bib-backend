// The reading ports' fakes (`testfakes/fin-readers.ts`) answer as their
// adapters do where a caller can tell: the image fake's shrink arithmetic is
// held to sharp's own answer, and each fake refuses unknown bytes the way its
// adapter refuses bytes it cannot read.
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ImageUnreadable, PdfUnreadable } from "../../src/domain/fin/errors";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/domain/fin/archive";
import { SharpImageNormaliser } from "../../src/infrastructure/fin/image-normaliser";
import { FakeArchiveReader, FakeImageNormaliser, FakePdfTextReader } from "../../src/testfakes/fin-readers";

vi.setConfig({ testTimeout: 30_000 });

describe("the reading fakes", () => {
  it.each([
    [4000, 3000, 1600],
    [3000, 4000, 1568],
    [1001, 333, 1000],
    [300, 200, 1600],
  ])("shrinks %ix%i to a %i edge exactly as sharp does", async (width, height, maxEdge) => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    const real = await new SharpImageNormaliser().normalise(new Uint8Array(bytes), maxEdge);
    const fake = new FakeImageNormaliser();
    fake.set("photo", { width, height, mediaType: "image/jpeg" });
    const faked = await fake.normalise(new TextEncoder().encode("photo"), maxEdge);
    expect([faked.width, faked.height]).toEqual([real.width, real.height]);
    expect(fake.edges).toEqual([maxEdge]);
  });

  it("refuse bytes they were not told about, as their adapters refuse unreadable bytes", async () => {
    await expect(new FakePdfTextReader().read(new Uint8Array([1]))).rejects.toBeInstanceOf(PdfUnreadable);
    await expect(new FakeImageNormaliser().normalise(new Uint8Array([1]), 100)).rejects.toBeInstanceOf(ImageUnreadable);
    const archives = new FakeArchiveReader();
    expect(archives.unpack(new Uint8Array([1]), DEFAULT_ARCHIVE_LIMITS)).toEqual({ ok: false, refusal: "corrupt", entryPath: null });
    expect(archives.limitsSeen).toEqual([DEFAULT_ARCHIVE_LIMITS]);
  });

  it("answer what they were told", async () => {
    const pdf = new FakePdfTextReader();
    pdf.set("x", { pages: [], hasTextLayer: false });
    expect(await pdf.read(new TextEncoder().encode("x"))).toEqual({ pages: [], hasTextLayer: false });
    const archives = new FakeArchiveReader();
    archives.set("z", { ok: true, entries: [{ path: "a.csv", bytes: new Uint8Array([97]), depth: 1 }] });
    expect(archives.unpack(new TextEncoder().encode("z"), DEFAULT_ARCHIVE_LIMITS).ok).toBe(true);
  });
});
