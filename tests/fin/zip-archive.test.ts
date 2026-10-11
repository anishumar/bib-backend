// The ZIP adapter (docs/FIN_BUILD_PLAN.md F2.3, F2.7): every refusal in
// `ArchiveRefusal`, each limit before and during inflation, and the plan's own
// check, a zip bomb and an `.exe`, both refused. Every archive is written here,
// byte by byte, so each can lie in exactly the way the test needs.
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHIVE_LIMITS,
  isExecutableContent,
  isExecutableName,
  judgeEntryName,
} from "../../src/domain/fin/archive";
import { NodeZipArchiveReader } from "../../src/infrastructure/fin/zip-archive";
import type { ArchiveLimits, ArchiveResult } from "../../src/usecase/fin/reading";

const MIB = 1024 * 1024;

interface Entry {
  readonly name: string;
  readonly data?: Uint8Array | string;
  /** 0 stored, 8 deflate; anything else is written as given. */
  readonly method?: number;
  readonly flags?: number;
  /** Lies the central directory tells. */
  readonly declaredSize?: number;
  readonly crc?: number;
  /** A different name in the local header than in the directory. */
  readonly localName?: string;
  /** The upper half of "external attributes": a Unix file mode. */
  readonly unixMode?: number;
  /** Sizes and CRC written as zero in the local header, real ones in a
   *  trailing descriptor, as a streaming writer does. */
  readonly streamed?: boolean;
  /** The directory's sizes moved into a ZIP64 extra field. */
  readonly zip64?: boolean;
  /** This entry's directory record points at entry N's local header. */
  readonly pointAt?: number;
}

function bytesOf(data: Uint8Array | string | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

/** Writes a ZIP: local headers and data, the central directory, the end
 *  record. Everything little-endian, as the format is. */
function zip(entries: readonly Entry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = bytesOf(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.crc ?? crc32(raw);
    const name = Buffer.from(e.name, "utf8");
    const localName = Buffer.from(e.localName ?? e.name, "utf8");
    const flags = (e.flags ?? 0) | 0x0800 | (e.streamed === true ? 0x0008 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.streamed === true ? 0 : crc, 14);
    local.writeUInt32LE(e.streamed === true ? 0 : body.length, 18);
    local.writeUInt32LE(e.streamed === true ? 0 : raw.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const descriptor = Buffer.alloc(e.streamed === true ? 16 : 0);
    if (e.streamed === true) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
    }
    offsets.push(offset);
    parts.push(local, localName, body, descriptor);
    const pointsAt = e.pointAt === undefined ? offset : (offsets[e.pointAt] ?? 0);
    offset += local.length + localName.length + body.length + descriptor.length;

    const size = e.declaredSize ?? raw.length;
    const extra = Buffer.alloc(e.zip64 === true ? 20 : 0);
    if (e.zip64 === true) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(e.zip64 === true ? 0xffffffff : body.length, 20);
    record.writeUInt32LE(e.zip64 === true ? 0xffffffff : size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(pointsAt, 42);
    central.push(record, name, extra);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

const reader = new NodeZipArchiveReader();
const SMALL: ArchiveLimits = { maxEntries: 10, maxTotalBytes: 4 * MIB, maxEntryBytes: 2 * MIB, maxDepth: 2, maxRatio: 100 };

function refusalOf(result: ArchiveResult): readonly [string, string | null] {
  if (result.ok) throw new Error(`expected a refusal, got ${result.entries.length} entries`);
  return [result.refusal, result.entryPath];
}

function entriesOf(result: ArchiveResult): readonly (readonly [string, string, number])[] {
  if (!result.ok) throw new Error(`expected entries, got ${result.refusal} at ${String(result.entryPath)}`);
  return result.entries.map((e) => [e.path, Buffer.from(e.bytes).toString("utf8"), e.depth] as const);
}

describe("unpacking an honest archive", () => {
  it("reads stored and deflated entries, by their paths, at depth 1", () => {
    const result = reader.unpack(
      zip([
        { name: "october/bank.csv", data: "date,amount\n2025-10-01,10.00\n" },
        { name: "october/notes.txt", data: "stored as is", method: 0 },
      ]),
      SMALL,
    );
    expect(entriesOf(result)).toEqual([
      ["october/bank.csv", "date,amount\n2025-10-01,10.00\n", 1],
      ["october/notes.txt", "stored as is", 1],
    ]);
  });

  it("skips folders, macOS's __MACOSX copies and .DS_Store, and a symbolic link", () => {
    const result = reader.unpack(
      zip([
        { name: "october/", data: "" },
        { name: "october/invoice.pdf", data: "%PDF-1.4 invoice" },
        { name: "__MACOSX/october/._invoice.pdf", data: "resource fork" },
        { name: "october/.DS_Store", data: "finder" },
        { name: "october/latest.pdf", data: "invoice.pdf", unixMode: 0o120777 },
      ]),
      SMALL,
    );
    expect(entriesOf(result).map(([path]) => path)).toEqual(["october/invoice.pdf"]);
  });

  it("trusts the directory's sizes over a streaming writer's zeroed local header", () => {
    expect(entriesOf(reader.unpack(zip([{ name: "a.csv", data: "x".repeat(500), streamed: true }]), SMALL))).toEqual([
      ["a.csv", "x".repeat(500), 1],
    ]);
  });

  it("reads sizes moved into a ZIP64 extra field", () => {
    expect(entriesOf(reader.unpack(zip([{ name: "a.csv", data: "zip64", zip64: true }]), SMALL))).toEqual([["a.csv", "zip64", 1]]);
  });

  it("opens a ZIP inside the ZIP, naming its entries under it at depth 2", () => {
    const inner = zip([{ name: "statement.csv", data: "inner" }]);
    const result = reader.unpack(zip([{ name: "outer.csv", data: "outer" }, { name: "bank/october.zip", data: inner }]), SMALL);
    expect(entriesOf(result)).toEqual([
      ["outer.csv", "outer", 1],
      ["bank/october.zip/statement.csv", "inner", 2],
    ]);
  });

  it("leaves an .xlsx closed: it is a ZIP, and a spreadsheet to read", () => {
    const workbook = zip([{ name: "xl/workbook.xml", data: "<workbook/>" }]);
    const result = reader.unpack(zip([{ name: "payroll.xlsx", data: workbook }]), SMALL);
    expect(result.ok && result.entries.map((e) => [e.path, e.depth])).toEqual([["payroll.xlsx", 1]]);
  });

  it("an empty archive is an empty list, not a refusal", () => {
    expect(reader.unpack(zip([]), SMALL)).toEqual({ ok: true, entries: [] });
  });
});

describe("the plan's check (F2.7): a zip bomb and an .exe are both refused under the product's limits", () => {
  it("refuses a bomb: 40 MB of zeros in a few kilobytes", () => {
    const bomb = zip([{ name: "statement.csv", data: new Uint8Array(40 * MIB) }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(refusalOf(reader.unpack(bomb, DEFAULT_ARCHIVE_LIMITS))[0]).toMatch(/^(too_large|suspicious_ratio)$/u);
  });

  it("refuses an .exe", () => {
    expect(refusalOf(reader.unpack(zip([{ name: "setup.exe", data: "MZ\x90\x00" }]), DEFAULT_ARCHIVE_LIMITS))).toEqual([
      "executable",
      "setup.exe",
    ]);
  });
});

describe("each limit, before inflating and while inflating", () => {
  it("too_many_entries: the count is of files, across every level", () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.csv`, data: "x" }));
    expect(refusalOf(reader.unpack(zip(files), { ...SMALL, maxEntries: 3 }))).toEqual(["too_many_entries", "f3.csv"]);
    const nested = zip([{ name: "a.csv", data: "x" }, { name: "inner.zip", data: zip([{ name: "b.csv", data: "y" }, { name: "c.csv", data: "z" }]) }]);
    expect(refusalOf(reader.unpack(nested, { ...SMALL, maxEntries: 3 }))).toEqual(["too_many_entries", "inner.zip/c.csv"]);
  });

  it("too_large: one entry's declared size, before a byte is inflated", () => {
    const big = zip([{ name: "big.csv", data: "a".repeat(3 * MIB) }]);
    expect(refusalOf(reader.unpack(big, { ...SMALL, maxRatio: 10_000 }))).toEqual(["too_large", "big.csv"]);
  });

  it("too_large: the total across entries", () => {
    const three = zip(["a", "b", "c"].map((n) => ({ name: `${n}.csv`, data: n.repeat(1.5 * MIB) })));
    expect(refusalOf(reader.unpack(three, { ...SMALL, maxRatio: 10_000 }))).toEqual(["too_large", "c.csv"]);
  });

  it("too_large: a size the directory understated stops at the limit while inflating", () => {
    const liar = zip([{ name: "small.csv", data: "a".repeat(3 * MIB), declaredSize: 1000 }]);
    expect(refusalOf(reader.unpack(liar, { ...SMALL, maxRatio: 10_000 }))).toEqual(["too_large", "small.csv"]);
  });

  it("suspicious_ratio: declared, and again while inflating when the size was understated", () => {
    const honest = zip([{ name: "zeros.csv", data: new Uint8Array(1.5 * MIB) }]);
    expect(refusalOf(reader.unpack(honest, SMALL))).toEqual(["suspicious_ratio", "zeros.csv"]);
    const liar = zip([{ name: "zeros.csv", data: new Uint8Array(1.5 * MIB), declaredSize: 10 }]);
    expect(refusalOf(reader.unpack(liar, SMALL))).toEqual(["suspicious_ratio", "zeros.csv"]);
  });

  it("a small file that compresses well is no bomb: the ratio is judged only past 1 MiB", () => {
    expect(reader.unpack(zip([{ name: "blank.csv", data: ",".repeat(200_000) }]), SMALL).ok).toBe(true);
  });

  it("too_deep: a ZIP in a ZIP in a ZIP, past maxDepth 2", () => {
    const deepest = zip([{ name: "x.csv", data: "x" }]);
    const middle = zip([{ name: "c.zip", data: deepest }]);
    expect(refusalOf(reader.unpack(zip([{ name: "b.zip", data: middle }]), SMALL))).toEqual(["too_deep", "b.zip/c.zip"]);
    expect(refusalOf(reader.unpack(zip([{ name: "b.zip", data: deepest }]), { ...SMALL, maxDepth: 1 }))).toEqual([
      "too_deep",
      "b.zip",
    ]);
  });

  it("refuses limits that are not whole positive numbers: a programming mistake, loudly", () => {
    expect(() => reader.unpack(zip([]), { ...SMALL, maxDepth: 0 })).toThrow(RangeError);
  });
});

describe("executables, encryption and names that climb out", () => {
  it.each(["tools/setup.EXE", "run.bat", "macro.vbs", "install.msi", "script.ps1", "app.jar", "x.sh", "Tool.app/Contents/Info.plist", "game.apk"])(
    "%s is refused by its name",
    (name) => {
      expect(refusalOf(reader.unpack(zip([{ name, data: "harmless text" }]), SMALL))).toEqual(["executable", name]);
    },
  );

  it.each([
    ["Windows (MZ)", "MZ\x90\x00\x03"],
    ["Linux (ELF)", "\x7fELF\x02\x01"],
    ["a Mach-O binary", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
    ["a universal Mach-O", Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])],
    ["a script with an interpreter line", "#!/bin/sh\nrm -rf ~\n"],
  ])("%s dressed as statement.pdf is refused by its first bytes", (_label, data) => {
    expect(refusalOf(reader.unpack(zip([{ name: "statement.pdf", data: typeof data === "string" ? Buffer.from(data, "latin1") : data }]), SMALL))).toEqual([
      "executable",
      "statement.pdf",
    ]);
  });

  it("an entry flagged encrypted, or written with AES (method 99), is encrypted", () => {
    expect(refusalOf(reader.unpack(zip([{ name: "locked.pdf", data: "x", flags: 0x0001 }]), SMALL))).toEqual([
      "encrypted",
      "locked.pdf",
    ]);
    expect(refusalOf(reader.unpack(zip([{ name: "aes.pdf", data: "x", method: 99 }]), SMALL))[0]).toBe("encrypted");
  });

  it.each(["../escape.csv", "a/../../escape.csv", "/etc/passwd", "a\\..\\escape.csv", "C:/Windows/x.csv", "nul\0.csv"])(
    "%s is corrupt",
    (name) => {
      expect(refusalOf(reader.unpack(zip([{ name, data: "x" }]), SMALL))[0]).toBe("corrupt");
    },
  );
});

describe("archives that do not read cleanly are corrupt", () => {
  it("bytes that are no ZIP, and a ZIP cut short", () => {
    expect(refusalOf(reader.unpack(new TextEncoder().encode("not a zip at all, just text"), SMALL))).toEqual(["corrupt", null]);
    const whole = zip([{ name: "a.csv", data: "x".repeat(2000) }]);
    expect(refusalOf(reader.unpack(whole.subarray(0, whole.length - 30), SMALL))[0]).toBe("corrupt");
  });

  it("a CRC that does not match, a stored size that does not, and a method nobody reads", () => {
    expect(refusalOf(reader.unpack(zip([{ name: "a.csv", data: "abc", crc: 1234 }]), SMALL))).toEqual(["corrupt", "a.csv"]);
    expect(refusalOf(reader.unpack(zip([{ name: "a.csv", data: "abc", method: 0, declaredSize: 4 }]), SMALL))[0]).toBe("corrupt");
    expect(refusalOf(reader.unpack(zip([{ name: "a.csv", data: "abc", method: 12 }]), SMALL))).toEqual(["corrupt", "a.csv"]);
  });

  it("a local header naming a different file than the directory does", () => {
    expect(refusalOf(reader.unpack(zip([{ name: "invoice.pdf", localName: "invoice.exe", data: "x" }]), SMALL))).toEqual([
      "corrupt",
      "invoice.pdf",
    ]);
  });

  it("two entries whose bytes overlap (the overlapping-files bomb)", () => {
    const overlapping = zip([
      { name: "a.csv", data: "kernel" },
      { name: "a.csv", data: "other", pointAt: 0 },
    ]);
    expect(refusalOf(reader.unpack(overlapping, SMALL))[0]).toBe("corrupt");
  });

  it("a nested .zip that is not a ZIP names the nested file", () => {
    expect(refusalOf(reader.unpack(zip([{ name: "inner.zip", data: "not a zip" }]), SMALL))).toEqual(["corrupt", "inner.zip"]);
  });
});

describe("the rules, without an archive", () => {
  it("judges names", () => {
    expect(judgeEntryName("a/./b.csv")).toEqual({ kind: "file", path: "a/b.csv" });
    expect(judgeEntryName("a//b.csv")).toEqual({ kind: "file", path: "a/b.csv" });
    expect(judgeEntryName("folder/")).toEqual({ kind: "skip" });
    expect(judgeEntryName("")).toEqual({ kind: "unsafe" });
    expect(judgeEntryName("./")).toEqual({ kind: "skip" });
  });

  it("tells a program by its name and its first bytes, and a document from neither", () => {
    expect(isExecutableName("statements/october.pdf")).toBe(false);
    expect(isExecutableName("payroll.xlsm")).toBe(false);
    expect(isExecutableName("a/b.DLL")).toBe(true);
    expect(isExecutableContent(new TextEncoder().encode("%PDF-1.7"))).toBe(false);
    expect(isExecutableContent(new Uint8Array([0x4d]))).toBe(false);
  });

  it("the product's limits are the ones the plan names", () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
      maxEntries: 500,
      maxTotalBytes: 100 * MIB,
      maxEntryBytes: 25 * MIB,
      maxDepth: 2,
      maxRatio: 100,
    });
  });
});
