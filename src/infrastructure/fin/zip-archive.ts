// The archive port (`usecase/fin/reading.ts` `ArchiveReader`) on `node:zlib`
// (docs/FIN_BUILD_PLAN.md F2.3, F2.7): a client's ZIP opened into its files,
// with every limit enforced before a byte is inflated and again while it is.
//
// No dependency. A ZIP is a list of compressed entries and a directory at the
// end saying where each is; deflate is in Node. Core's spreadsheet reader
// (`infrastructure/sheet/grid-reader.ts`) reads the same structure for `.xlsx`
// parts and is the model here, with the difference that matters: a workbook
// part is a known file inside a known format, and this is whatever a stranger
// put in a ZIP. So where the grid reader is forgiving (it falls back to walking
// local headers), this refuses: an archive that does not read cleanly is
// `corrupt`, and a person opens it.
//
// ── THE ORDER OF THE CHECKS IS THE DEFENCE ───────────────────────────────────
//
// For each entry, from the CENTRAL DIRECTORY (the record a reader must trust:
// local headers may carry zero sizes and leave the real ones to a trailer):
//
//   1. its name: unsafe (`..`, absolute, a backslash) is `corrupt`; a folder,
//      `__MACOSX/` or `.DS_Store` is skipped (`domain/fin/archive.ts`)
//   2. encrypted (the flag, or AES's method 99): `encrypted`
//   3. a program by its name: `executable`
//   4. one entry too many: `too_many_entries`
//   5. its DECLARED size over the entry or the total limit: `too_large`
//   6. its DECLARED ratio over the limit: `suspicious_ratio`
//   7. its local header, name and bytes where the directory says, and not
//      overlapping another entry's (the "overlapping files" bomb points every
//      entry at one compressed kernel): `corrupt`
//   8. INFLATED with `maxOutputLength` set to the smallest of what the entry,
//      the total and the ratio still allow, so a size the directory lied about
//      stops at the limit instead of filling memory: `too_large` or
//      `suspicious_ratio`, whichever limit it hit
//   9. its inflated size and CRC-32 against the directory's: `corrupt`
//  10. a program by its first bytes: `executable`
//  11. a ZIP inside it opened in turn, deeper than `maxDepth`: `too_deep`
//
// The entry count and the byte total are ONE budget across every level, so a
// ZIP of ZIPs cannot multiply its way past them. Synchronous, as the port is:
// the inflate is bounded, and the job reads one file at a time.
import { crc32, inflateRawSync } from "node:zlib";

import {
  RATIO_FLOOR_BYTES,
  isExecutableContent,
  isExecutableName,
  isNestedArchiveName,
  judgeEntryName,
} from "../../domain/fin/archive";
import type {
  ArchiveEntry,
  ArchiveLimits,
  ArchiveReader,
  ArchiveRefusal,
  ArchiveResult,
} from "../../usecase/fin/reading";

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A refusal, thrown inside the walk and returned as a value at the door. */
class Refused extends Error {
  constructor(
    readonly refusal: ArchiveRefusal,
    readonly entryPath: string | null,
  ) {
    super(refusal);
  }
}

/** One central-directory record, sizes resolved through ZIP64 where used. */
interface CentralRecord {
  readonly rawName: Buffer;
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly unixMode: number;
}

/** What the walk has spent, across every level of nesting. */
interface Budget {
  entries: number;
  bytes: number;
}

function u64(buf: Buffer, at: number, where: string | null): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused("corrupt", where);
  return Number(v);
}

/** The end-of-central-directory record: last in the file, before a comment of
 *  at most 64 KB. */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 65_535);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) return i;
  }
  return -1;
}

/** The central directory, every record in it, bounds-checked. */
function readDirectory(buf: Buffer, where: string | null): readonly CentralRecord[] {
  if (buf.length < 22) throw new Refused("corrupt", where);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Refused("corrupt", where);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    // A multi-volume archive: the rest of it is in another file.
    throw new Refused("corrupt", where);
  }
  let count = buf.readUInt16LE(eocd + 10);
  let size = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Refused("corrupt", where);
    const record = u64(buf, locator + 8, where);
    if (record + 56 > buf.length || buf.readUInt32LE(record) !== ZIP64_EOCD) throw new Refused("corrupt", where);
    count = u64(buf, record + 32, where);
    size = u64(buf, record + 40, where);
    offset = u64(buf, record + 48, where);
  }
  if (offset + size > buf.length) throw new Refused("corrupt", where);

  const records: CentralRecord[] = [];
  let at = offset;
  const end = offset + size;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL) throw new Refused("corrupt", where);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    let compressedSize = buf.readUInt32LE(at + 20);
    let entrySize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    let localOffset = buf.readUInt32LE(at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw new Refused("corrupt", where);
    const rawName = buf.subarray(at + 46, at + 46 + nameLen);
    const name = rawName.toString((flags & FLAG_UTF8) !== 0 ? "utf8" : "latin1");

    if (entrySize === U32_MAX || compressedSize === U32_MAX || localOffset === U32_MAX) {
      // The ZIP64 extra field holds the 8-byte values, in this order, for
      // exactly the fields that overflowed.
      let extra = at + 46 + nameLen;
      const extraEnd = extra + extraLen;
      let found = false;
      while (extra + 4 <= extraEnd) {
        const id = buf.readUInt16LE(extra);
        const len = buf.readUInt16LE(extra + 2);
        if (extra + 4 + len > extraEnd) break;
        if (id === 0x0001) {
          let p = extra + 4;
          const take = (): number => {
            if (p + 8 > extra + 4 + len) throw new Refused("corrupt", name);
            const v = u64(buf, p, name);
            p += 8;
            return v;
          };
          if (entrySize === U32_MAX) entrySize = take();
          if (compressedSize === U32_MAX) compressedSize = take();
          if (localOffset === U32_MAX) localOffset = take();
          found = true;
          break;
        }
        extra += 4 + len;
      }
      if (!found) throw new Refused("corrupt", name);
    }

    records.push({
      rawName,
      name,
      flags,
      method,
      crc,
      compressedSize,
      size: entrySize,
      localOffset,
      unixMode: (external >>> 16) & S_IFMT,
    });
    at = next;
  }
  return records;
}

/** Where an entry's compressed bytes are, from its local header, which must
 *  agree with the directory about its name. */
function dataRange(buf: Buffer, r: CentralRecord, path: string): { start: number; end: number } {
  const at = r.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new Refused("corrupt", path);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const localName = buf.subarray(at + 30, at + 30 + nameLen);
  // Two names for one entry is how an archive shows one file to a scanner and
  // another to the program that opens it.
  if (!localName.equals(r.rawName)) throw new Refused("corrupt", path);
  if ((buf.readUInt16LE(at + 6) & FLAG_ENCRYPTED) !== 0) throw new Refused("encrypted", path);
  const start = at + 30 + nameLen + extraLen;
  const end = start + r.compressedSize;
  if (end > buf.length) throw new Refused("corrupt", path);
  return { start: at, end };
}

function validLimits(limits: ArchiveLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new RangeError(`ArchiveLimits.${key} must be a whole number of at least 1; got ${String(value)}`);
    }
  }
}

export class NodeZipArchiveReader implements ArchiveReader {
  unpack(bytes: Uint8Array, limits: ArchiveLimits): ArchiveResult {
    validLimits(limits);
    const out: ArchiveEntry[] = [];
    try {
      walk(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), limits, 1, "", { entries: 0, bytes: 0 }, out);
      return { ok: true, entries: out };
    } catch (err) {
      if (err instanceof Refused) return { ok: false, refusal: err.refusal, entryPath: err.entryPath };
      throw err;
    }
  }
}

/** Opens one archive (the upload, or one inside it) at `depth`, its entries
 *  named under `prefix`. */
function walk(
  buf: Buffer,
  limits: ArchiveLimits,
  depth: number,
  prefix: string,
  budget: Budget,
  out: ArchiveEntry[],
): void {
  const container = prefix === "" ? null : prefix.slice(0, -1);
  const records = readDirectory(buf, container);
  const taken: { start: number; end: number; path: string }[] = [];

  for (const r of records) {
    const verdict = judgeEntryName(r.name);
    if (verdict.kind === "unsafe") throw new Refused("corrupt", prefix + r.name);
    // A symbolic link is a path, not a file: nothing to read, and following it
    // would read something the archive does not contain.
    if (verdict.kind === "skip" || r.unixMode === S_IFLNK) continue;
    const path = prefix + verdict.path;

    if ((r.flags & FLAG_ENCRYPTED) !== 0 || r.method === METHOD_AES) throw new Refused("encrypted", path);
    if (isExecutableName(path)) throw new Refused("executable", path);
    budget.entries += 1;
    if (budget.entries > limits.maxEntries) throw new Refused("too_many_entries", path);
    if (r.method !== METHOD_STORED && r.method !== METHOD_DEFLATE) throw new Refused("corrupt", path);

    // Declared sizes, before a byte is inflated.
    if (r.size > limits.maxEntryBytes || budget.bytes + r.size > limits.maxTotalBytes) {
      throw new Refused("too_large", path);
    }
    if (r.size >= RATIO_FLOOR_BYTES && r.size > r.compressedSize * limits.maxRatio) {
      throw new Refused("suspicious_ratio", path);
    }

    const range = dataRange(buf, r, path);
    if (taken.some((t) => range.start < t.end && t.start < range.end)) throw new Refused("corrupt", path);
    taken.push({ ...range, path });
    const dataStart = range.end - r.compressedSize;
    const data = buf.subarray(dataStart, range.end);

    // And again while inflating: the directory's sizes are claims.
    const sizeCap = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - budget.bytes);
    const ratioCap = Math.max(RATIO_FLOOR_BYTES, r.compressedSize * limits.maxRatio);
    let inflated: Buffer;
    if (r.method === METHOD_STORED) {
      if (r.compressedSize !== r.size) throw new Refused("corrupt", path);
      inflated = data;
    } else {
      try {
        inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(sizeCap, ratioCap)) });
      } catch (err) {
        if (err instanceof RangeError) throw new Refused(ratioCap < sizeCap ? "suspicious_ratio" : "too_large", path);
        throw new Refused("corrupt", path);
      }
    }
    if (inflated.length !== r.size || crc32(inflated) !== r.crc) throw new Refused("corrupt", path);
    budget.bytes += inflated.length;

    if (isExecutableContent(inflated)) throw new Refused("executable", path);
    if (isNestedArchiveName(path)) {
      // Its entries would sit one level deeper than this archive's.
      if (depth + 1 > limits.maxDepth) throw new Refused("too_deep", path);
      walk(inflated, limits, depth + 1, `${path}/`, budget, out);
      continue;
    }
    out.push({ path, bytes: new Uint8Array(inflated), depth });
  }
}
