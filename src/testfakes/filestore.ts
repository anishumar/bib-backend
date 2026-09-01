// In-memory port fakes for the document store (T3.6). `implements` every port
// the real adapters carry, so a compile error here is the same compile error
// production would get.
import { createHash } from "node:crypto";
import type {
  BrandAsset,
  BrandAssetKind,
  DocumentKind,
  DocumentLink,
  DocumentVersion,
  StoredDocument,
  SubjectKind,
} from "../domain/filestore/model";
import type {
  BlobStore,
  BrandAssetRecord,
  ContentDigest,
  DocumentLinkRecord,
  DocumentRecord,
  DocumentStoreRepository,
  NewDocument,
  NewDocumentLink,
  NewDocumentVersion,
} from "../usecase/filestore/ports";
import type { DocumentRenderer, RenderSource } from "../usecase/render/ports";
import type { RenderableDocument } from "../domain/render/model";

export class FakeDocumentStoreRepo implements DocumentStoreRepository {
  readonly documents: StoredDocument[] = [];
  readonly versionRows: DocumentVersion[] = [];
  readonly links: DocumentLink[] = [];
  readonly assets: BrandAsset[] = [];

  /** Names the fake resolves for the read model. Tests that care about the
   *  joined names set these; tests that do not get nulls, which is a state the
   *  real query genuinely produces (a document with no party). */
  readonly partyNames = new Map<string, string>();
  readonly userNames = new Map<string, string>();
  readonly userEmails = new Map<string, string>();
  readonly subjectLabels = new Map<string, string>();

  private now(): string {
    return new Date().toISOString();
  }

  private recordOf(doc: StoredDocument): DocumentRecord {
    const versions = this.versionRows
      .filter((v) => v.documentId === doc.id)
      .sort((a, b) => b.versionNo - a.versionNo);
    const latest = versions[0];
    if (!latest) {
      // The real repository guarantees this by writing both rows in one
      // transaction. A fake that returned a document with no version would let
      // a test pass against a shape production cannot produce.
      throw new Error(
        `fake invariant broken: document ${doc.id} has no versions. The repository creates a ` +
          `document and its first version together, so tests must too.`,
      );
    }
    return {
      document: doc,
      partyName: doc.partyId === null ? null : (this.partyNames.get(doc.partyId) ?? null),
      createdBy:
        doc.createdBy === null
          ? null
          : {
              userId: doc.createdBy,
              displayName: this.userNames.get(doc.createdBy) ?? null,
              // The fake defaults an email in rather than allowing null: a
              // person with no email is not a state the database can produce
              // (`user_account.email` is NOT NULL), and a fake that produced it
              // would let a test pass against a shape production cannot reach.
              email: this.userEmails.get(doc.createdBy) ?? `${doc.createdBy}@example.test`,
            },
      latestVersion: latest,
      versionCount: versions.length,
    };
  }

  create(doc: NewDocument, version: NewDocumentVersion): Promise<DocumentRecord> {
    const stored: StoredDocument = { ...doc, createdAt: this.now(), updatedAt: this.now() };
    this.documents.push(stored);
    this.versionRows.push({ ...version, versionNo: 1, createdAt: this.now() });
    return Promise.resolve(this.recordOf(stored));
  }

  addVersion(version: NewDocumentVersion): Promise<DocumentVersion> {
    const highest = this.versionRows
      .filter((v) => v.documentId === version.documentId)
      .reduce((max, v) => Math.max(max, v.versionNo), 0);
    const row: DocumentVersion = {
      ...version,
      versionNo: highest + 1,
      createdAt: this.now(),
    };
    this.versionRows.push(row);
    return Promise.resolve(row);
  }

  findById(tenantId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.documents.find((d) => d.tenantId === tenantId && d.id === documentId);
    return Promise.resolve(doc ? this.recordOf(doc) : null);
  }

  setClientVisible(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly visible: boolean;
  }): Promise<DocumentRecord | null> {
    const i = this.documents.findIndex(
      (d) => d.tenantId === input.tenantId && d.id === input.documentId,
    );
    const doc = this.documents[i];
    // `party_id IS NOT NULL` is in the real adapter's WHERE, so it is here: a
    // fake that accepted a write the database refuses is a fixture that can
    // describe an impossible state.
    if (i === -1 || doc === undefined || doc.partyId === null) return Promise.resolve(null);
    const next = { ...doc, isClientVisible: input.visible };
    this.documents[i] = next;
    return Promise.resolve(this.recordOf(next));
  }

  list(input: {
    readonly tenantId: string;
    readonly partyId?: string | undefined;
    readonly kind?: DocumentKind | undefined;
    readonly limit: number;
  }): Promise<readonly DocumentRecord[]> {
    const rows = this.documents
      .filter((d) => d.tenantId === input.tenantId)
      .filter((d) => input.partyId === undefined || d.partyId === input.partyId)
      .filter((d) => input.kind === undefined || d.kind === input.kind)
      .slice(0, input.limit);
    return Promise.resolve(rows.map((d) => this.recordOf(d)));
  }

  listForSubject(input: {
    readonly tenantId: string;
    readonly subjectKind: SubjectKind;
    readonly subjectRef: string;
  }): Promise<readonly DocumentRecord[]> {
    const ids = new Set(
      this.links
        .filter(
          (l) =>
            l.tenantId === input.tenantId &&
            l.subjectKind === input.subjectKind &&
            l.subjectRef === input.subjectRef,
        )
        .map((l) => l.documentId),
    );
    return Promise.resolve(
      this.documents
        .filter((d) => d.tenantId === input.tenantId && ids.has(d.id))
        .map((d) => this.recordOf(d)),
    );
  }

  versions(tenantId: string, documentId: string): Promise<readonly DocumentVersion[]> {
    return Promise.resolve(
      this.versionRows
        .filter((v) => v.tenantId === tenantId && v.documentId === documentId)
        .sort((a, b) => b.versionNo - a.versionNo),
    );
  }

  findVersion(tenantId: string, versionId: string): Promise<DocumentVersion | null> {
    return Promise.resolve(
      this.versionRows.find((v) => v.tenantId === tenantId && v.id === versionId) ?? null,
    );
  }

  findByContentHash(tenantId: string, contentHash: string): Promise<DocumentVersion | null> {
    return Promise.resolve(
      this.versionRows.find((v) => v.tenantId === tenantId && v.contentHash === contentHash) ??
        null,
    );
  }

  attach(link: NewDocumentLink): Promise<DocumentLink> {
    const row: DocumentLink = { ...link, createdAt: this.now() };
    this.links.push(row);
    return Promise.resolve(row);
  }

  linksOf(tenantId: string, documentId: string): Promise<readonly DocumentLinkRecord[]> {
    return Promise.resolve(
      this.links
        .filter((l) => l.tenantId === tenantId && l.documentId === documentId)
        .map((link) => ({
          link,
          subjectLabel: this.subjectLabels.get(link.subjectRef) ?? null,
        })),
    );
  }

  setBrandAsset(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly entityPartyId: string;
    readonly kind: BrandAssetKind;
    readonly documentVersionId: string;
    readonly createdBy: string | null;
  }): Promise<BrandAssetRecord> {
    for (const a of this.assets) {
      if (
        a.tenantId === input.tenantId &&
        a.entityPartyId === input.entityPartyId &&
        a.kind === input.kind
      ) {
        // Mirrors the UPDATE the adapter runs before its INSERT. Without it the
        // fake would let two assets of one kind be active at once, which the
        // partial unique index makes impossible in production.
        this.assets[this.assets.indexOf(a)] = { ...a, isActive: false };
      }
    }
    const asset: BrandAsset = { ...input, isActive: true, createdAt: this.now() };
    this.assets.push(asset);
    return Promise.resolve(this.assetRecord(asset));
  }

  activeBrandAssets(tenantId: string, entityPartyId: string): Promise<readonly BrandAssetRecord[]> {
    return Promise.resolve(
      this.assets
        .filter((a) => a.tenantId === tenantId && a.entityPartyId === entityPartyId && a.isActive)
        .map((a) => this.assetRecord(a)),
    );
  }

  private assetRecord(asset: BrandAsset): BrandAssetRecord {
    const version = this.versionRows.find((v) => v.id === asset.documentVersionId);
    if (!version) {
      throw new Error(
        `fake invariant broken: brand asset ${asset.id} names version ${asset.documentVersionId}, ` +
          `which does not exist. The real table has a foreign key that makes this impossible.`,
      );
    }
    return {
      asset,
      entityName: this.partyNames.get(asset.entityPartyId) ?? "The Firm",
      version,
    };
  }
}

/**
 * Blobs in a Map, keyed exactly as the filesystem adapter keys them.
 *
 * The key derivation is duplicated rather than shared, deliberately: this fake
 * exists to prove the SERVICE stores and retrieves through the port, and if it
 * imported the real adapter's key function then a change to that function would
 * pass here for the wrong reason.
 */
export class FakeBlobStore implements BlobStore {
  readonly kind = "memory";
  readonly blobs = new Map<string, Uint8Array>();

  /** Set to make `get` report the object as missing — the storage-fault path,
   *  which is otherwise unreachable in a test. */
  loseEverything = false;

  put(input: {
    readonly tenantId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly storageKey: string }> {
    const storageKey = `${input.tenantId}/${input.contentHash.slice(0, 2)}/${input.contentHash}`;
    this.blobs.set(storageKey, input.bytes);
    return Promise.resolve({ storageKey });
  }

  get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array | null> {
    if (this.loseEverything) return Promise.resolve(null);
    if (!input.storageKey.startsWith(`${input.tenantId}/`)) return Promise.resolve(null);
    return Promise.resolve(this.blobs.get(input.storageKey) ?? null);
  }
}

/**
 * A renderer that produces bytes from the description, deterministically.
 *
 * Not a PDF — a stable serialisation of what it was ASKED to draw. That is the
 * right fake for a service test: it proves the service passed the right
 * description through and stored the result, and it proves nothing about
 * typography, which is what the real renderer is for. The determinism is real
 * though, because the service's whole contract is that re-rendering unchanged
 * data yields the same hash.
 */
export class FakeRenderer implements DocumentRenderer {
  readonly kind = "fake";
  readonly mediaType = "application/pdf";

  render(document: RenderableDocument): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(JSON.stringify(document)));
  }
}

/** Describes whatever it was told to describe. `documents` maps a subjectRef to
 *  its description; anything absent resolves to null, which is the "no such
 *  record" path the service turns into a refusal. */
export class FakeRenderSource implements RenderSource {
  readonly documents = new Map<string, RenderableDocument>();
  renderable: string[] = ["engagement_letter", "invoice"];

  supports(kind: string): boolean {
    return this.renderable.includes(kind);
  }

  describe(input: { subjectRef: string }): Promise<RenderableDocument | null> {
    return Promise.resolve(this.documents.get(input.subjectRef) ?? null);
  }
}

/** A minimal description, for tests that only care that rendering happened. */
export function aRenderableDocument(reference = "EL-2026-0001"): RenderableDocument {
  return {
    documentTitle: "Engagement Letter",
    reference,
    issuer: { name: "The Firm LLP", lines: [] },
    recipient: { name: "Kaveri Foods", lines: [] },
    recipientLabel: "To",
    meta: [],
    sections: [],
    table: null,
    totals: [],
    footer: null,
    logo: null,
    issuedOn: "2026-08-30",
  };
}

/** The real digest. Not a stub — a fake hash would make every dedupe and
 *  integrity assertion in the tests vacuous. */
export class FakeContentDigest implements ContentDigest {
  ofBytes(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }
}
