// What may come out of an archive a client uploads (docs/FIN_BUILD_PLAN.md
// F2.7). Pure: the rules the ZIP adapter (`infrastructure/fin/zip-archive.ts`)
// applies to every entry, kept here so they read as the product's decisions and
// not as a parser's details.
//
// ── WHY AN ARCHIVE IS HANDLED AS HOSTILE ─────────────────────────────────────
//
// A ZIP is the one file a client sends that says how big its contents are and
// is not made to tell the truth: a few kilobytes can inflate to gigabytes (a
// "zip bomb"), a path can climb out of the folder it names (`../../x`), and an
// entry can be a program dressed as a statement. Fin never writes an entry to
// disk and never runs one, so most of those are harmless HERE; they are refused
// anyway, because the entries become intake items a person downloads and opens,
// and an archive that carries a program is not a client's books.
//
// So an archive is refused WHOLE for any one of these, with the entry named.
// Taking the good half of an archive and silently dropping the rest is how a
// statement goes missing and nobody can say where.

/** The product's limits on unpacking one archive. Structurally the
 *  `ArchiveLimits` of `usecase/fin/reading.ts` (the domain cannot import it). */
export interface DefaultArchiveLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;
  readonly maxDepth: number;
  readonly maxRatio: number;
}

const MIB = 1024 * 1024;

/**
 * The defaults, and what each is measured against.
 *
 *   maxEntries 500       a month's books for one company is tens of files; a
 *                        year of receipts in one ZIP is a few hundred.
 *   maxEntryBytes 25 MiB the upload limit (`BIB_MAX_UPLOAD_BYTES`' default): a
 *                        file inside an archive is no bigger than one sent alone.
 *   maxTotalBytes 100 MiB four of those, and what the fin job's memory is sized
 *                        to hold at once.
 *   maxDepth 2           a ZIP of the month that holds the bank's own ZIP of
 *                        statements; anything deeper is a bomb's shape.
 *   maxRatio 100         a scanned PDF compresses 1.1:1, a CSV 5-15:1, a blank
 *                        spreadsheet 50:1. A thousand to one is a bomb.
 */
export const DEFAULT_ARCHIVE_LIMITS: DefaultArchiveLimits = {
  maxEntries: 500,
  maxTotalBytes: 100 * MIB,
  maxEntryBytes: 25 * MIB,
  maxDepth: 2,
  maxRatio: 100,
};

/**
 * Below this many inflated bytes the ratio is not judged. A ratio means nothing
 * on a small file: 10 KB of a blank CSV compresses two hundred to one and harms
 * nobody, while a bomb is only a bomb because of what it inflates TO. Every
 * entry is still held to `maxEntryBytes` and `maxTotalBytes`, so this lets
 * nothing large through.
 */
export const RATIO_FLOOR_BYTES = 1 * MIB;

/**
 * Extensions refused as programs, on ANY segment of an entry's path (a `.app`
 * is a folder: `Tool.app/Contents/MacOS/Tool` is refused by its first segment).
 * Windows executables and installers, script hosts, shell scripts, Java
 * archives, macOS and Linux packages, Android and iOS apps, and shortcut files
 * that run a program. Office files are NOT here: a macro-enabled workbook is
 * still a workbook, and fin reads its values, never its macros.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows programs, libraries and installers
  "exe", "dll", "com", "scr", "msi", "msp", "msix", "appx", "cpl", "sys", "drv", "ocx", "pif",
  // Windows scripts and script hosts
  "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "reg", "lnk", "gadget",
  // Java
  "jar", "class",
  // Unix shells and binaries
  "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "bin", "elf", "so", "out", "appimage",
  // macOS
  "app", "command", "dylib", "pkg", "mpkg", "dmg",
  // Linux packages
  "deb", "rpm",
  // Phones
  "apk", "aab", "ipa",
]);

/** The extension of one path segment, lower-case, or null when it has none. */
function extensionOf(segment: string): string | null {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0 || dot === segment.length - 1) return null;
  return segment.slice(dot + 1).toLowerCase();
}

/** Whether any segment of an entry's path names a program by its extension. */
export function isExecutableName(path: string): boolean {
  return path.split("/").some((segment) => {
    const ext = extensionOf(segment);
    return ext !== null && EXECUTABLE_EXTENSIONS.has(ext);
  });
}

/**
 * Whether an entry's first bytes are a program's, whatever it is called: a
 * statement renamed `.pdf` that is really `setup.exe` is refused too.
 *
 *   MZ               a Windows (DOS/PE) executable or library
 *   \x7fELF          a Linux or Unix binary
 *   FEEDFACE/CF      a Mach-O binary, 32- and 64-bit, either byte order
 *   CAFEBABE         a universal (fat) Mach-O binary, and a Java class file
 *   #!               a script with an interpreter line
 */
export function isExecutableContent(bytes: Uint8Array): boolean {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x4d && at(1) === 0x5a) return true;
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) return true;
  if (at(0) === 0x23 && at(1) === 0x21) return true;
  const magic = [at(0), at(1), at(2), at(3)].join(",");
  return MACHO_MAGICS.has(magic);
}

const MACHO_MAGICS: ReadonlySet<string> = new Set(
  [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ].map((m) => m.join(",")),
);

/** What an entry's name says about it before a byte of it is read. */
export type EntryNameVerdict =
  /** A file to read, at this `/`-separated relative path. */
  | { readonly kind: "file"; readonly path: string }
  /** A folder, or the litter an operating system leaves in an archive. */
  | { readonly kind: "skip" }
  /** A name no honest archive carries: it climbs out, is absolute, uses a
   *  backslash, holds a NUL, or is empty. */
  | { readonly kind: "unsafe" };

/**
 * Judges an entry's name as the archive stores it.
 *
 * A backslash is refused rather than read as a separator: the ZIP format says
 * `/`, a tool that wrote `\` either is broken or is aiming at a reader that
 * treats it as one, and `..\..\x` is the classic way past a check that only
 * splits on `/`. `__MACOSX/` and `.DS_Store` are what macOS's own "Compress"
 * adds to every archive; they are skipped, never refused, or every ZIP a Mac
 * user makes would bounce.
 */
export function judgeEntryName(name: string): EntryNameVerdict {
  if (name.length === 0 || name.includes("\0") || name.includes("\\")) return { kind: "unsafe" };
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) return { kind: "unsafe" };
  const segments = name.split("/");
  if (segments.some((s) => s === "..")) return { kind: "unsafe" };
  if (name.endsWith("/")) return { kind: "skip" };
  const kept = segments.filter((s) => s !== "" && s !== ".");
  if (kept.length === 0) return { kind: "unsafe" };
  if (kept[0] === "__MACOSX" || kept[kept.length - 1] === ".DS_Store") return { kind: "skip" };
  return { kind: "file", path: kept.join("/") };
}

/** Whether an entry is itself an archive to open, by its name. By NAME and not
 *  by its first bytes: an `.xlsx` is a ZIP too, and is a spreadsheet to read,
 *  never a folder to open. */
export function isNestedArchiveName(path: string): boolean {
  return path.toLowerCase().endsWith(".zip");
}
