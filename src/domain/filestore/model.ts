// The document store's nouns. Pure — stdlib only, no imports from anywhere
// internal, per the layering rule.
//
// NAMING, because there are now two things called "document" in this codebase
// and the distinction is worth stating once here rather than being rediscovered:
//
//   `domain/document`  — the PROSE a proposal or letter carries (G1.7): blocks,
//                        clauses, the reference series. Words inside a document.
//   `domain/filestore` — this one. BYTES: a file, its versions, and what it is
//                        attached to. It is what `crm.engagement_letter`'s
//                        content hash finally has something to point at.
//
// They meet in exactly one place — a rendered letter is prose turned into bytes
// — and nowhere else.

/**
 * Whether the product made this file or a person supplied it.
 *
 * The difference is not cosmetic. A `generated` document can be produced again
 * from the rows it was rendered from; an `uploaded` one is the only copy that
 * exists anywhere. That decides what a re-render means, what a failed storage
 * write costs, and whether "regenerate" is an offer the UI may make.
 */
export type DocumentOrigin = "generated" | "uploaded";

export const DOCUMENT_ORIGINS: readonly DocumentOrigin[] = ["generated", "uploaded"];

/**
 * What the document is. A closed set, mirrored by the CHECK in migration 0037 —
 * the two must agree, and `tests/filestore/model.test.ts` holds the build red if
 * they drift.
 *
 * Deliberately NOT a configuration registry kind. These are the product's own
 * document types, which the renderer and the portal both switch on; a firm's own
 * filing categories are a different axis and would be a registry kind if asked
 * for. The rule from CLAUDE.md is "something a firm changes without a deploy" —
 * a firm does not invent a new kind of engagement letter.
 */
export type DocumentKind =
  | "proposal"
  | "engagement_letter"
  | "invoice"
  | "credit_note"
  | "identity_proof"
  | "statutory_filing"
  | "working_paper"
  | "correspondence"
  | "brand_asset"
  | "other";

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "proposal",
  "engagement_letter",
  "invoice",
  "credit_note",
  "identity_proof",
  "statutory_filing",
  "working_paper",
  "correspondence",
  "brand_asset",
  "other",
];

/**
 * What a document can be attached to.
 *
 * Closed, and the closure is the containment for the one thing this design
 * cannot have: `subject_ref` has no foreign key, because it points at a
 * different table depending on this value (migration 0037 states the whole
 * trade). An unknown kind is refused at the write, so a bad link is a dangling
 * reference within a known vocabulary rather than a pointer to anything at all.
 *
 * Adding a member is a migration AND a case in whatever resolves a subject to a
 * name — a kind nothing can resolve is a link nobody can follow.
 */
export type SubjectKind =
  | "party"
  | "lead"
  | "proposal"
  | "engagement_letter"
  | "engagement"
  | "invoice"
  | "job"
  /** The row on somebody's desk (0051), and NOT the same thing as `job`: a job
   *  is the engine's run of a process, a work item is the task. Added by 0063
   *  because a client's uploaded answer files itself against the task the ask
   *  was raised from — which is where the person who asked for it is looking. */
  | "work_item";

export const SUBJECT_KINDS: readonly SubjectKind[] = [
  "party",
  "lead",
  "proposal",
  "engagement_letter",
  "engagement",
  "invoice",
  "job",
  "work_item",
];

/** The firm's own marks, per issuing entity (G1.2 applied to paper). */
/**
 * What a firm's company may put in force as its own mark. `proposal_cover`
 * (0084) is the full-page artwork a proposal's first page is drawn from — the
 * firm's design, with its logo and "Proposal For Services" in it.
 */
export type BrandAssetKind = "logo" | "signature" | "letterhead" | "proposal_cover";

export const BRAND_ASSET_KINDS: readonly BrandAssetKind[] = [
  "logo",
  "signature",
  "letterhead",
  "proposal_cover",
];

/** A document's identity — the thing that outlives any particular set of bytes. */
export interface StoredDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly origin: DocumentOrigin;
  readonly kind: DocumentKind;
  /** The client this belongs to, or null for the firm's own. */
  readonly partyId: string | null;
  /**
   * Whether this appears in the client portal's LIBRARY (T6.7, migration 0066).
   *
   * `delivery.work_item.is_client_visible` for the second time, and the second
   * time is the interesting one — the first sat unread from 0051 to 0062 and
   * then T6.5's walk found the portal showing a client *"Decide the credit hold
   * on INV/2026-27/0003"*, because that flag defaulted TRUE and nothing had ever
   * set it false.
   *
   * So: the DATABASE default is FALSE, and the first sensible value comes from
   * `clientVisibleByDefault(kind)` at the moment the service creates the row.
   * Those are two different mechanisms on purpose. The default is what an
   * import, an agent or a future INSERT that has never heard of this column
   * lands on, and it must be the safe direction; the kind mapping is a judgement
   * about a firm's business, which is why it lives where a firm's own screen can
   * override it in both directions.
   *
   * IT IS ENFORCED AS A POLICY, NEVER AS A `WHERE`. A portal read that forgets a
   * filter returns an internal working paper with a 200.
   */
  readonly isClientVisible: boolean;
  /** Null when the system generated it. */
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Whether a document of this KIND should start out visible to the client it
 * belongs to.
 *
 * ── WHY A MAPPING AND NOT A DEFAULT EITHER WAY ──────────────────────────
 *
 * Defaulting everything FALSE makes the library empty until somebody ticks 168
 * boxes, and a self-serve library nobody has stocked does not stop the email it
 * exists to stop. Defaulting everything TRUE is T6.5's bug with the stakes
 * raised from one task title to the firm's working papers.
 *
 * So the split is by what the document IS. A challan, an invoice, a credit note
 * and a signed engagement letter are documents the client is a PARTY to — they
 * either signed it, were billed by it, or it was filed on their behalf and their
 * name is on it. A working paper is the firm's own thinking, and an
 * `identity_proof` is something the client supplied, which they already hold.
 *
 * `correspondence` is FALSE and it is the line worth arguing about: some of it
 * is a letter to the client and some of it is a note to a colleague about the
 * client, and this vocabulary cannot tell those apart. False is the direction to
 * be wrong in, and a firm that wants one shared flips it on the document.
 *
 * NONE OF THIS IS A WALL. It is a first value; the wall is the policy in 0066.
 * A firm may set any of these either way and the product does not argue.
 */
export function clientVisibleByDefault(kind: DocumentKind): boolean {
  switch (kind) {
    case "statutory_filing":
    case "invoice":
    case "credit_note":
    case "engagement_letter":
      return true;
    case "proposal":
    case "identity_proof":
    case "working_paper":
    case "correspondence":
    case "brand_asset":
    case "other":
      return false;
  }
}

/**
 * THE COPY OF RECORD (2026-09-29): the kinds whose PDF is filed ONCE after
 * they go out, and never drawn again.
 *
 * An issued invoice and a sent engagement letter are documents the client
 * holds. The renderer draws from rows as they stand today, and some of those
 * rows move after the document went out: a client's name is corrected (V2.5),
 * the firm uploads a new logo. A second render of an issued invoice after a
 * rename was a second, DIFFERENT PDF under the same invoice number, and both
 * were in the client's portal. So the first copy made once the record is out
 * is the one on file. An issued invoice is corrected the way GST expects: a
 * credit note and a new invoice.
 *
 * A draft of either kind may still be printed, as a DRAFT copy: the firm's
 * own, never shown to the client. Before this, a draft's PDF went to the
 * client's portal like an issued one (both kinds are client-visible by
 * default), before the firm had issued anything.
 *
 * A proposal is not here. Its PDF of record is pinned when it is sent
 * (`sent_pdf_version_id`), and a copy made from its page is a working copy
 * the client does not see.
 */
export type CopyOfRecordKind = "invoice" | "engagement_letter";

export function hasCopyOfRecord(kind: DocumentKind): kind is CopyOfRecordKind {
  return kind === "invoice" || kind === "engagement_letter";
}

/**
 * THE KINDS THAT PRINT THE FIRM'S FEES (audit 2026-10-03, B01): a proposal, an
 * engagement letter, an invoice and a credit note. Their bytes open, and they
 * are drawn, only for a login that sees fees.
 *
 * The fee axis redacted the JSON of all four and handed the PDF to anybody: an
 * associate read "Hidden" on an invoice and downloaded its issued copy. A
 * redacted PDF was weighed and refused: a figure prints in a table cell, a
 * total, a "Fees H3: INR 50,000 Yearly" lead, a fee group's sentence and a
 * Summary of Fees, and a redaction that misses one cannot be taken back. So
 * the document is refused whole, by its KIND.
 *
 * By kind and not by what the bytes say, which nothing here reads: a kind is
 * what the firm filed it as. An invoice uploaded as `other` opens for anybody,
 * as any `other` does; the four are what the product draws itself.
 *
 * Exhaustive, so a kind added later is decided here, not defaulted.
 */
export function showsFees(kind: DocumentKind): boolean {
  switch (kind) {
    case "proposal":
    case "engagement_letter":
    case "invoice":
    case "credit_note":
      return true;
    case "identity_proof":
    case "statutory_filing":
    case "working_paper":
    case "correspondence":
    case "brand_asset":
    case "other":
      return false;
  }
}

/**
 * How a rendered file hangs off the record it was drawn from: the `role` on
 * its `files.document_link` row. The column is free text (0037); these are
 * the values the renderer writes.
 */
export const RENDERED_ROLE = {
  /** A working copy of a draft invoice or letter. The firm's only. */
  draftCopy: "draft_copy",
  /** The copy of record: made once, after the invoice was issued or the
   *  letter was sent. */
  copyOfRecord: "copy_of_record",
  /** Everything else rendered: a proposal's copies, and every copy of an
   *  invoice or a letter made before 2026-09-29. */
  rendered: "rendered",
} as const;

/** One immutable set of bytes. */
export interface DocumentVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  /** Lower-case hex SHA-256 — the same value an engagement letter commits to. */
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly filename: string;
  readonly storageKey: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface DocumentLink {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly subjectKind: SubjectKind;
  readonly subjectRef: string;
  readonly role: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  /** When this document was taken OFF the subject, or null while it is still
   *  attached (0302). A withdrawn link stays readable as history: "what was
   *  filed against this engagement" has to be able to say "this, for a
   *  fortnight, in error". Attaching again is a NEW link. */
  readonly withdrawnAt: string | null;
  readonly withdrawnBy: string | null;
}

export interface BrandAsset {
  readonly id: string;
  readonly tenantId: string;
  readonly entityPartyId: string;
  readonly kind: BrandAssetKind;
  readonly documentVersionId: string;
  readonly isActive: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

// ── Validation ─────────────────────────────────────────────────────────────
//
// These are the rules the DATABASE also holds. Both, deliberately: the CHECK is
// what an import or an agent cannot walk past, and this is what turns a
// constraint violation into an error naming the field and the valid set, which
// is what CLAUDE.md means by "actionable errors only". Neither is redundant —
// dropping the CHECK would trust every future caller, dropping this would
// answer a bad media type with a Postgres error string.

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function isContentHash(value: string): boolean {
  return HEX_SHA256.test(value);
}

/**
 * A media type this store will accept, normalised to lower case with any
 * parameters (`; charset=utf-8`) stripped.
 *
 * Returns null for anything unusable, which the service turns into a refusal.
 * The parameter is dropped rather than preserved because it is a property of a
 * transfer, not of stored bytes, and keeping it would make two uploads of the
 * same file compare unequal on a field nobody looks at.
 */
export function normaliseMediaType(raw: string): string | null {
  const base = raw.split(";")[0];
  if (base === undefined) return null;
  const trimmed = base.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // type/subtype, per RFC 9110's token grammar, narrowed to what is actually
  // seen in this product. A media type is echoed back in a Content-Type header
  // on download, so anything that could carry a header separator is refused
  // here rather than being escaped at the door.
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * What a CLIENT may upload — an allowlist, and only on the portal route.
 *
 * -- WHY THE TWO SURFACES GET DIFFERENT RULES --------------------------------
 *
 * The staff route stays open on purpose. A firm uploads whatever its own work
 * produces: a .msg from Outlook, a CSV a bank exported, a zip a registry sent
 * back. Refusing those would be the product telling a firm what its own filing
 * cabinet may hold, and the person uploading is inside the firm and accountable
 * for it.
 *
 * The portal route is the opposite case. The uploader is outside the firm, the
 * download echoes the media type they chose, and the person who opens the file
 * is a colleague who trusted the product to hand them what a client sent. There
 * is no scanner in this product — the route description says so out loud — so
 * the only control available is what may arrive at all.
 *
 * -- WHAT IS ON IT, AND WHAT IS DELIBERATELY NOT -----------------------------
 *
 * What a client actually sends: a scanned PDF, a photograph of a challan, a
 * spreadsheet of transactions, a Word document, a plain CSV or text file.
 *
 * NOT `text/html` or `image/svg+xml`, which are documents that carry script;
 * `attachment` and `nosniff` already stop a browser running one, and this means
 * it is never stored to be re-served in the first place. NOT
 * `application/zip` — an archive is a container whose contents nothing here can
 * see, and the case for one on this route has not come up. NOT
 * `application/octet-stream`, which is not a type so much as the absence of
 * one: a client whose browser cannot name the file needs to be told, not to
 * have it filed as bytes nobody can open safely.
 *
 * A firm that needs something else asks the client to send it another way and
 * uploads it themselves, which puts a member of the firm behind the decision.
 * That is the right shape for the exception.
 */
export const PORTAL_UPLOAD_MEDIA_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
];

// ── The bytes are what they say they are (F-14-1, S7) ──────────────────────
//
// The media type of an upload is whatever the sender's browser named, usually
// from the file's extension: an executable renamed "statement.pdf" arrives as
// application/pdf. The store kept that word and served the bytes back under
// it. Now, for every type with a reliable signature, the first bytes must be
// that signature, and a text type must not carry the NUL bytes of a binary.
// A type with no signature (rare, and staff-only off the portal) is taken at
// its word, as before. Malware scanning is the storage layer's job and is on
// the infrastructure list; this is the part the code can do.

const sig = (...b: number[]): readonly number[] => b;
const ZIP = sig(0x50, 0x4b, 0x03, 0x04); // OOXML and OpenDocument are zip files
const OLE = sig(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // legacy .doc / .xls

const SIGNATURES: Readonly<Record<string, readonly (readonly number[])[]>> = {
  "image/png": [sig(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  "image/jpeg": [sig(0xff, 0xd8, 0xff)],
  "image/gif": [sig(0x47, 0x49, 0x46, 0x38)],
  "image/tiff": [sig(0x49, 0x49, 0x2a, 0x00), sig(0x4d, 0x4d, 0x00, 0x2a)],
  "application/msword": [OLE],
  "application/vnd.ms-excel": [OLE],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [ZIP],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [ZIP],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [ZIP],
  "application/vnd.oasis.opendocument.text": [ZIP],
  "application/vnd.oasis.opendocument.spreadsheet": [ZIP],
  "application/zip": [ZIP],
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.byteLength < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/**
 * Whether `bytes` can be the NORMALISED `mediaType` they were sent as. False
 * only when the type has a signature and the bytes do not carry it.
 */
export function contentMatchesType(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === "application/pdf") {
    // The header may follow up to 1 KB of junk (ISO 32000-1, 7.5.2).
    const head = bytes.subarray(0, 1024);
    const marker = ascii("%PDF-");
    for (let i = 0; i + marker.length <= head.byteLength; i += 1) if (startsWith(head, marker, i)) return true;
    return false;
  }
  if (mediaType === "image/webp") return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
  if (mediaType === "image/heic" || mediaType === "image/heif") return startsWith(bytes, ascii("ftyp"), 4);
  if (mediaType.startsWith("text/")) return !bytes.subarray(0, 8192).includes(0);
  const signatures = SIGNATURES[mediaType];
  if (signatures === undefined) return true;
  return signatures.some((s) => startsWith(bytes, s));
}

/** Whether a NORMALISED media type may be uploaded through the client portal.
 *  Call `normaliseMediaType` first; this compares the bare type/subtype. */
export function isPortalUploadable(mediaType: string): boolean {
  return PORTAL_UPLOAD_MEDIA_TYPES.includes(mediaType);
}

/**
 * The filename, kept as a LABEL and never as a path.
 *
 * Directory separators and `..` are stripped rather than refused, because a
 * browser on Windows genuinely sends `C:\Users\x\pan.pdf` for an ordinary
 * upload and refusing it would reject a correct file. What must not survive is
 * anything that could be read as a path by whatever handles this later —
 * nothing in this product resolves a filename against a filesystem today, and
 * this function is what keeps that from mattering if something ever does.
 */
export function safeFilename(raw: string): string | null {
  const lastSeparator = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const base = lastSeparator >= 0 ? raw.slice(lastSeparator + 1) : raw;
  // Control characters would land in a Content-Disposition header.
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (cleaned.length === 0) return null;
  if (cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 255);
}

/** What a person calls each kind of document the product draws itself. */
const RENDERED_KIND_WORDS: Partial<Record<DocumentKind, string>> = {
  proposal: "Proposal",
  engagement_letter: "Engagement letter",
  invoice: "Invoice",
  credit_note: "Credit note",
};

/** Longest file name a rendered PDF gets, extension included. */
const RENDERED_FILENAME_MAX = 150;

/**
 * The name a PDF the product draws is SAVED under (CA#56, audit 2026-10-03):
 * what it is, its number, "draft" when it is one, and whose it is, so a
 * download folder of them can be read. "Invoice draft - Deccan Agro Foods
 * Private Limited.pdf", "Invoice INV-2026-27-0001 - Deccan Agro Foods Private
 * Limited.pdf". It was the reference alone, so a draft invoice (no number
 * until it is issued, 0322) downloaded as "Draft-draft.pdf".
 *
 * A file name, not a path: the characters Windows refuses in one (`\ / : * ?
 * " < > |`, and an invoice number has slashes) become dashes, and it is cut
 * short before the extension.
 */
export function renderedFilename(input: {
  readonly kind: DocumentKind;
  /** The document's number, or null when it has none yet (a draft invoice). */
  readonly reference: string | null;
  readonly clientName: string;
  readonly draft: boolean;
}): string {
  const clean = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  const what = RENDERED_KIND_WORDS[input.kind] ?? "Document";
  const head = [what, input.reference === null ? null : clean(input.reference), input.draft ? "draft" : null]
    .filter((p): p is string => p !== null && p !== "")
    .join(" ");
  const client = clean(input.clientName);
  const stem = client === "" ? head : `${head} - ${client}`;
  const room = RENDERED_FILENAME_MAX - ".pdf".length;
  return `${stem.length > room ? stem.slice(0, room).trimEnd() : stem}.pdf`;
}

/**
 * The `Content-Disposition` header value that names a stored file.
 *
 * -- THE BUG THIS EXISTS TO END ----------------------------------------------
 *
 * Both byte routes spliced the filename straight into
 * `attachment; filename="..."` with only the quote character removed. An HTTP
 * header value is a ByteString -- every code point must be under 256 -- so the
 * moment a file was named in an Indian language the header could not be built
 * and the DOWNLOAD answered 500. Upload accepted it; the bytes were stored
 * correctly; only fetching them failed, and the message said "internal error".
 * `जीएसटी चालान.txt` is not an edge case at a firm in this market, it is
 * Tuesday.
 *
 * -- WHAT RFC 5987 / RFC 6266 SAY TO DO --------------------------------------
 *
 * Send BOTH forms. `filename=` carries an ASCII fallback for anything that
 * cannot read the other one, and `filename*=UTF-8''...` carries the real name
 * percent-encoded, which every browser released this decade prefers. So a name
 * that is already ASCII travels exactly as before -- no behaviour change for
 * the files that worked -- and one that is not finally arrives intact instead
 * of crashing the route.
 *
 * The ASCII fallback replaces each non-ASCII character with `_` rather than
 * dropping it, so `चालान.txt` falls back to something with an extension rather
 * than to `.txt` or to nothing. Characters that would end the quoted string or
 * escape it (`"` and `\`) are removed outright.
 */
export function contentDispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const fallback = ascii.trim().length === 0 ? "download" : ascii;
  // encodeURIComponent leaves ! ' ( ) * alone, and RFC 5987's grammar does not
  // allow them raw in ext-value, so they are encoded here too.
  const encoded = encodeURIComponent(filename).replace(
    /['()!*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isSubjectKind(value: string): value is SubjectKind {
  return (SUBJECT_KINDS as readonly string[]).includes(value);
}

export function isBrandAssetKind(value: string): value is BrandAssetKind {
  return (BRAND_ASSET_KINDS as readonly string[]).includes(value);
}

export function isDocumentOrigin(value: string): value is DocumentOrigin {
  return (DOCUMENT_ORIGINS as readonly string[]).includes(value);
}
