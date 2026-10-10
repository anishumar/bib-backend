// The 10x training pack, as files to upload (docs/FIN_BUILD_PLAN.md F0.10).
// Pure file-system helpers for `cmd/fin-pack-load.ts`; no network, no database.
//
// ── THE ANSWER KEY NEVER ENTERS THE PIPELINE ────────────────────────────────
//
// Each company folder holds `99_Ground_Truth`: what every document contains and
// how it should be booked. It is what the scorecard grades fin against, so a
// file from it reaching fin would let fin "read" the answer. The walk refuses
// any path with a `99_` segment, and a pack root pointed inside one is refused
// outright rather than walked.
import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export interface PackFile {
  /** The company letter, from the folder name: `Company_A_Lumen_Cloudworks` → `A`. */
  readonly company: string;
  readonly companyDir: string;
  /** The pack's own folder, e.g. `01_Purchase_Invoices`. */
  readonly folder: string;
  /** Path inside the company folder, e.g. `03_Bank_Statements/Operating_Account_0967/x.pdf`. */
  readonly relPath: string;
  readonly absPath: string;
  readonly byteSize: number;
}

const COMPANY_DIR = /^Company_([A-Z])_/;

export class AnswerKeyRefused extends Error {
  constructor(path: string) {
    super(
      `${path} is inside the pack's answer key (99_Ground_Truth). It grades fin and must never ` +
        `be uploaded to it; point --pack at the pack's root folder instead.`,
    );
  }
}

function isAnswerKey(segment: string): boolean {
  return segment.startsWith("99_");
}

function isNoise(name: string): boolean {
  return name === ".DS_Store" || name.startsWith("._");
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (isNoise(e.name) || isAnswerKey(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Every uploadable file in the pack, company by company, folder by folder. */
export function packFiles(root: string, companies?: readonly string[]): readonly PackFile[] {
  if (root.split(sep).some(isAnswerKey)) throw new AnswerKeyRefused(root);
  const files: PackFile[] = [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && COMPANY_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of dirs) {
    const company = COMPANY_DIR.exec(name)?.[1] ?? "";
    if (companies !== undefined && !companies.includes(company)) continue;
    const companyDir = join(root, name);
    const found: string[] = [];
    walk(companyDir, found);
    for (const absPath of found.sort()) {
      const relPath = relative(companyDir, absPath);
      files.push({
        company,
        companyDir,
        folder: relPath.split(sep)[0] ?? "",
        relPath,
        absPath,
        byteSize: statSync(absPath).size,
      });
    }
  }
  return files;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  json: "application/json",
  txt: "text/plain",
};

/** What a browser would declare for the file, by its extension — which is all
 *  a browser goes on, too. */
export function mediaTypeFor(filename: string): string {
  const ext = basename(filename).split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}
