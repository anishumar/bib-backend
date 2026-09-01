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
export type BrandAssetKind = "logo" | "signature" | "letterhead";

export const BRAND_ASSET_KINDS: readonly BrandAssetKind[] = ["logo", "signature", "letterhead"];

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
