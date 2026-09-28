// The seams the document store needs from the world. Interfaces owned by this
// use case, stated in its vocabulary; adapters in infrastructure/ implement
// them.
import type {
  BrandAsset,
  BrandAssetKind,
  DocumentKind,
  DocumentLink,
  DocumentOrigin,
  DocumentVersion,
  StoredDocument,
  SubjectKind,
} from "../../domain/filestore/model";

export interface NewDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly origin: DocumentOrigin;
  readonly kind: DocumentKind;
  readonly partyId: string | null;
  /** Set by the SERVICE from `clientVisibleByDefault(kind)`, never defaulted
   *  here. Required rather than optional so a new caller has to decide — an
   *  optional flag on a disclosure switch is a caller quietly choosing. */
  readonly isClientVisible: boolean;
  readonly createdBy: string | null;
}

export interface NewDocumentVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly filename: string;
  readonly storageKey: string;
  readonly createdBy: string | null;
}

export interface NewDocumentLink {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly subjectKind: SubjectKind;
  readonly subjectRef: string;
  readonly role: string | null;
  readonly createdBy: string | null;
}

/**
 * A document with everything a screen renders it from — the joined read model.
 *
 * The rule CLAUDE.md says has now been learnt five times: a list that made a
 * screen fetch something per row to render it means the join belongs in the
 * query. So this carries the party's NAME and the uploader's NAME, never their
 * uuids alone, and it carries the latest version inline because a document list
 * that could not show a file's size, type or date would be a list of titles.
 */
export interface DocumentRecord {
  readonly document: StoredDocument;
  /** The client's display name, or null for the firm's own documents. */
  readonly partyName: string | null;
  /**
   * Who uploaded it. Null when the system generated it, and null when the
   * person's account has been erased.
   *
   * **The EMAIL is the discriminator, not the id** — the same arrangement
   * `EventRecord.actor` uses, and for the same reason. It carries the email as
   * well as the name because an account may have no display name, and the first
   * version of this field was a single `createdByName: string | null` that
   * collapsed "the system made this" and "a person whose name is unset" into
   * one indistinguishable null. Building the screen is what found it, which is
   * the third time this codebase has learnt that lesson.
   */
  readonly createdBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** Always present: a document is created with its first version in one
   *  transaction, so a document with no version is corruption, not a state. */
  readonly latestVersion: DocumentVersion;
  readonly versionCount: number;
}

/**
 * A document as one subject's file list shows it: the record, and the ROLE of
 * its link to that subject. The role is what tells an invoice's copy of record
 * from a draft copy (`RENDERED_ROLE`), and a document attached to two things
 * can play a different part on each, so it belongs to the listing and not to
 * the document.
 */
export interface SubjectDocument extends DocumentRecord {
  readonly role: string | null;
}

/** A link with the subject resolved to something readable. */
export interface DocumentLinkRecord {
  readonly link: DocumentLink;
  /**
   * What the subject is called — an invoice number, a lead title, a party name.
   *
   * NULL when the subject does not resolve, and that is the case this field
   * exists for. `subject_ref` carries no foreign key (migration 0037 states
   * why), so a dangling link is possible; showing it as unresolved is the
   * difference between a screen that says so and a row that renders blank.
   */
  readonly subjectLabel: string | null;
}

export interface BrandAssetRecord {
  readonly asset: BrandAsset;
  readonly entityName: string;
  readonly version: DocumentVersion;
}

export interface DocumentStoreRepository {
  /**
   * The document and its first version, in ONE transaction.
   *
   * Not two calls, and this is the whole reason the repository takes both: a
   * document row with no version is a file that exists in the list and cannot
   * be opened. `DocumentRecord.latestVersion` is non-optional because of this
   * guarantee, and it is a guarantee only if the write is atomic.
   */
  create(doc: NewDocument, version: NewDocumentVersion): Promise<DocumentRecord>;

  /** A further version of an existing document. Returns the new version. */
  addVersion(version: NewDocumentVersion): Promise<DocumentVersion>;

  findById(tenantId: string, documentId: string): Promise<DocumentRecord | null>;

  /**
   * Share this document with the client it belongs to, or stop sharing it.
   *
   * ── THE HALF THAT KEEPS THE FLAG FROM BEING A WALL NOBODY CAN MOVE ─────
   *
   * `is_client_visible` (0066) gets its first value from the document's KIND
   * and is enforced by a policy. Without this method it would be exactly what
   * T6.5 named on `delivery.work_item`'s copy of the same flag: *"a flag the
   * portal enforces and no screen can change is a wall built against a value
   * nobody can move"* — a firm that wanted to share one working paper, or to
   * un-share a challan filed against the wrong client, would have no way to.
   *
   * The one UPDATE in this repository, and it touches nothing else — a document
   * with no `party_id` is the firm's own and cannot be shared with anybody, so
   * the statement refuses it rather than writing a flag that means nothing.
   * Null is "no such document at this firm", and the use case owns the sentence.
   */
  setClientVisible(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly visible: boolean;
  }): Promise<DocumentRecord | null>;

  /** Newest first. `kind` narrows; absent means every kind. */
  list(input: {
    readonly tenantId: string;
    readonly partyId?: string | undefined;
    readonly kind?: DocumentKind | undefined;
    readonly limit: number;
  }): Promise<readonly DocumentRecord[]>;

  /** Every document attached to one thing, newest first, each with the role
   *  its link to that thing carries. */
  listForSubject(input: {
    readonly tenantId: string;
    readonly subjectKind: SubjectKind;
    readonly subjectRef: string;
  }): Promise<readonly SubjectDocument[]>;

  versions(tenantId: string, documentId: string): Promise<readonly DocumentVersion[]>;

  findVersion(tenantId: string, versionId: string): Promise<DocumentVersion | null>;

  /**
   * An existing version of this firm's holding the same bytes, if any.
   *
   * Per tenant and never global: deduplicating across firms would let one firm
   * learn that another holds a file by observing that its own upload was
   * instant. The index behind it is `(tenant_id, content_hash)` for the same
   * reason.
   */
  findByContentHash(tenantId: string, contentHash: string): Promise<DocumentVersion | null>;

  attach(link: NewDocumentLink): Promise<DocumentLink>;

  /**
   * Take the document off one subject: stamps the LIVE link withdrawn and
   * returns it, or null when there is no live link to withdraw. The row
   * stays, so `linksOf` still lists it, marked; `listForSubject` no longer
   * does. Attaching again afterwards makes a new row (0302).
   */
  withdraw(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly subjectKind: SubjectKind;
    readonly subjectRef: string;
    readonly withdrawnBy: string | null;
  }): Promise<DocumentLink | null>;

  /** Everything this document is attached to, subjects resolved to labels,
   *  withdrawn links included and marked. */
  linksOf(tenantId: string, documentId: string): Promise<readonly DocumentLinkRecord[]>;

  /**
   * Make this version the entity's active asset of this kind, clearing whatever
   * held the slot. One call because it is one decision, and because the partial
   * unique index means doing it in two would fail in between.
   */
  setBrandAsset(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly entityPartyId: string;
    readonly kind: BrandAssetKind;
    readonly documentVersionId: string;
    readonly createdBy: string | null;
  }): Promise<BrandAssetRecord>;

  activeBrandAssets(tenantId: string, entityPartyId: string): Promise<readonly BrandAssetRecord[]>;
}

/**
 * Where the bytes actually live.
 *
 * CONTENT-ADDRESSED: `put` derives the key from the tenant and the content hash,
 * so storing identical bytes twice writes once and returns the same key. The
 * caller does not choose the key — that keeps the scheme in one place, which is
 * what lets it change without a migration.
 *
 * **There is deliberately no `delete`.** `bib_app` holds no DELETE grant on any
 * table in this database, and the blob layer matches it rather than being the
 * one place data can be destroyed. It is load-bearing here in a way it is not
 * elsewhere: because storage is content-addressed, two documents can share one
 * blob, so a delete driven by one document would silently empty the other. If a
 * retention or erasure requirement ever arrives, it is a deliberate feature with
 * reference counting behind it, not a method added to this interface.
 */
export interface BlobStore {
  /** The adapter's name, for the honest registry and for operator logs. */
  readonly kind: string;

  put(input: {
    readonly tenantId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly storageKey: string }>;

  /** Null when the object is absent — which the service reports as a storage
   *  fault, never as a missing document. */
  get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array | null>;
}

/**
 * SHA-256 over BYTES.
 *
 * Its own port rather than a method on `engagement/ports`' `ContentHasher`,
 * which takes a string and hashes it as utf-8. That comment already warns
 * against sharing the two ("same primitive, different contract, and a shared
 * class would eventually tempt somebody to 'improve' one and break the other"),
 * and bytes-vs-string is exactly the improvement that would break it: hashing a
 * PDF as utf-8 silently mangles it.
 */
export interface ContentDigest {
  ofBytes(bytes: Uint8Array): string;
}
