// FinCompliance intake: which stored files fin takes, and which reader each
// one goes to (docs/FIN_BUILD_PLAN.md F2.1, F2.2).
//
// Pure. The sweep that applies these rules is `usecase/fin/intake.ts`; the rows
// they produce are `fin.intake_item` (migration 0381).
//
// ── WHICH FILES ──────────────────────────────────────────────────────────────
//
// A file a PERSON supplied (`origin = uploaded`) of kind `books_input` (0383),
// and nothing else. That kind exists so fin reads exactly what somebody filed
// for the books: not the firm's own fee documents behind the wall (`invoice`,
// `credit_note`, `proposal`, `engagement_letter`), not KYC, and not whatever
// lands in `other`. Settled 2026-10-10 (option B in the plan); before it, fin
// guessed from four general kinds and would have read meeting notes.
//
// ── WHICH READER ─────────────────────────────────────────────────────────────
//
// The declared media type first, because it is what the browser or the client
// said the bytes are. A generic or unrecognised type (`application/octet-stream`
// is what a phone often sends) falls back to the filename's extension. Neither
// recognised means `manual`: the file goes to a person as "not read", and is
// never discarded.
import type { DocumentKind } from "../filestore/model";

export type IntakeRoute = "sheet" | "pdf" | "image" | "archive" | "manual";

export const INTAKE_ROUTES: readonly IntakeRoute[] = ["sheet", "pdf", "image", "archive", "manual"];

/** What decided the route, kept on the row so the decision stays explainable. */
export type RouteBasis = "media_type" | "extension" | "none";

export interface RouteDecision {
  readonly route: IntakeRoute;
  readonly basis: RouteBasis;
}

/** Whether fin takes a stored document of this kind and origin at all. */
export function takesDocument(kind: DocumentKind, origin: "generated" | "uploaded"): boolean {
  return origin === "uploaded" && kind === "books_input";
}

/** The kinds `takesDocument` accepts from an upload — the adapter's WHERE clause
 *  is built from this list, so the SQL and the rule cannot disagree. */
export function takenKinds(all: readonly DocumentKind[]): readonly DocumentKind[] {
  return all.filter((k) => takesDocument(k, "uploaded"));
}

const BY_MEDIA_TYPE: Readonly<Record<string, Exclude<IntakeRoute, "manual">>> = {
  "text/csv": "sheet",
  "text/tab-separated-values": "sheet",
  "application/vnd.ms-excel": "sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12": "sheet",
  "application/pdf": "pdf",
  "image/jpeg": "image",
  "image/png": "image",
  "image/heic": "image",
  "image/heif": "image",
  "image/webp": "image",
  "image/tiff": "image",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
};

const BY_EXTENSION: Readonly<Record<string, Exclude<IntakeRoute, "manual">>> = {
  csv: "sheet",
  tsv: "sheet",
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  pdf: "pdf",
  jpg: "image",
  jpeg: "image",
  png: "image",
  heic: "image",
  heif: "image",
  webp: "image",
  tif: "image",
  tiff: "image",
  zip: "archive",
};

/** `Application/PDF; charset=binary` and `application/pdf` are the same claim. */
function normaliseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

function extensionOf(filename: string): string | null {
  const base = filename.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Which reader a file goes to. Total: every input has an answer. */
export function routeFor(mediaType: string, filename: string): RouteDecision {
  const declared = BY_MEDIA_TYPE[normaliseMediaType(mediaType)];
  if (declared !== undefined) return { route: declared, basis: "media_type" };

  const ext = extensionOf(filename);
  const guessed = ext === null ? undefined : BY_EXTENSION[ext];
  if (guessed !== undefined) return { route: guessed, basis: "extension" };

  return { route: "manual", basis: "none" };
}
