// Postgres adapter for the document store (T3.6, migration 0037).
//
// Every read and write goes through `withTenant`, which opens a transaction and
// sets `app.tenant_id` with SET LOCAL. Two consequences worth stating because
// both are load-bearing here:
//
//   * The tenant wall applies to BYTES, not just to metadata. The version row a
//     download resolves is fetched under RLS, so a storage key from another firm
//     is not reachable to be fetched with. That is what makes the acceptance
//     criterion "no pre-signed URL escape" true rather than merely intended.
//   * `create` gets its atomicity for free. A document row and its first version
//     are two INSERTs inside one `withTenant` call, so they commit together —
//     which is what lets `DocumentRecord.latestVersion` be non-optional.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
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
import type {
  BrandAssetRecord,
  DocumentLinkRecord,
  DocumentRecord,
  DocumentStoreRepository,
  NewDocument,
  NewDocumentLink,
  NewDocumentVersion,
} from "../../usecase/filestore/ports";

interface DocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  origin: string;
  kind: string;
  party_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  party_name: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  version_count: string;
  v_id: string;
  v_document_id: string;
  v_version_no: number;
  v_content_hash: string;
  v_byte_size: string;
  v_media_type: string;
  v_filename: string;
  v_storage_key: string;
  v_created_by: string | null;
  v_created_at: string;
}

interface VersionRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version_no: number;
  content_hash: string;
  byte_size: string;
  media_type: string;
  filename: string;
  storage_key: string;
  created_by: string | null;
  created_at: string;
}

interface LinkRow {
  id: string;
  tenant_id: string;
  document_id: string;
  subject_kind: string;
  subject_ref: string;
  role: string | null;
  created_by: string | null;
  created_at: string;
}

interface BrandAssetRow {
  id: string;
  tenant_id: string;
  entity_party_id: string;
  kind: string;
  document_version_id: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  entity_name: string;
  v_id: string;
  v_document_id: string;
  v_version_no: number;
  v_content_hash: string;
  v_byte_size: string;
  v_media_type: string;
  v_filename: string;
  v_storage_key: string;
  v_created_by: string | null;
  v_created_at: string;
}

function toVersion(r: VersionRow): DocumentVersion {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    documentId: r.document_id,
    versionNo: Number(r.version_no),
    contentHash: r.content_hash,
    // `bigint` comes back from postgres.js as a STRING, because it does not fit
    // a JS number in general. It does here — a file this store accepts is
    // megabytes — but coercing at the door is what stops a size arriving as
    // "1024" and being rendered, sorted or compared as text.
    byteSize: Number(r.byte_size),
    mediaType: r.media_type,
    filename: r.filename,
    storageKey: r.storage_key,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function versionOf(r: DocumentRow | BrandAssetRow, tenantId: string): DocumentVersion {
  return toVersion({
    id: r.v_id,
    tenant_id: tenantId,
    document_id: r.v_document_id,
    version_no: r.v_version_no,
    content_hash: r.v_content_hash,
    byte_size: r.v_byte_size,
    media_type: r.v_media_type,
    filename: r.v_filename,
    storage_key: r.v_storage_key,
    created_by: r.v_created_by,
    created_at: r.v_created_at,
  });
}

function toDocument(r: DocumentRow): StoredDocument {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    // The CHECK in 0037 is what guarantees these two, so this is a widening
    // cast at a door the database already guards, not an unchecked assumption.
    origin: r.origin as DocumentOrigin,
    kind: r.kind as DocumentKind,
    partyId: r.party_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRecord(r: DocumentRow): DocumentRecord {
  return {
    document: toDocument(r),
    partyName: r.party_name,
    // Email, not id, is what says a person was behind this: the system actor
    // has no account, and a human whose account was erased no longer joins.
    createdBy:
      r.created_by === null || r.created_by_email === null
        ? null
        : {
            userId: r.created_by,
            displayName: r.created_by_name,
            email: r.created_by_email,
          },
    latestVersion: versionOf(r, r.tenant_id),
    versionCount: Number(r.version_count),
  };
}

function toLink(r: LinkRow): DocumentLink {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    documentId: r.document_id,
    subjectKind: r.subject_kind as SubjectKind,
    subjectRef: r.subject_ref,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toBrandAsset(r: BrandAssetRow): BrandAsset {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entityPartyId: r.entity_party_id,
    kind: r.kind as BrandAssetKind,
    documentVersionId: r.document_version_id,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export class PostgresDocumentStoreRepository implements DocumentStoreRepository {
  constructor(private readonly app: Db) {}

  async create(doc: NewDocument, version: NewDocumentVersion): Promise<DocumentRecord> {
    return withTenant(this.app, doc.tenantId, async (db) => {
      await db`
        INSERT INTO files.document (id, tenant_id, title, origin, kind, party_id, created_by)
        VALUES (${doc.id}, ${doc.tenantId}, ${doc.title}, ${doc.origin}, ${doc.kind},
                ${doc.partyId}, ${doc.createdBy})
      `;
      await db`
        INSERT INTO files.document_version
          (id, tenant_id, document_id, version_no, content_hash, byte_size,
           media_type, filename, storage_key, created_by)
        VALUES (${version.id}, ${version.tenantId}, ${version.documentId}, 1,
                ${version.contentHash}, ${version.byteSize}, ${version.mediaType},
                ${version.filename}, ${version.storageKey}, ${version.createdBy})
      `;
      const [row] = await db<DocumentRow[]>`
        ${this.recordSelect(db)} WHERE d.id = ${doc.id}
      `;
      // Both INSERTs are in this transaction and neither is conditional, so a
      // miss here is not a race — it means the row cannot be read back under the
      // policy that just wrote it, which is the tenant wall failing open.
      if (!row) {
        throw new Error(
          `document ${doc.id} was inserted for tenant ${doc.tenantId} and could not be read ` +
            `back in the same transaction — the RLS policy on files.document is not matching ` +
            `rows this connection just wrote`,
        );
      }
      return toRecord(row);
    });
  }

  async addVersion(version: NewDocumentVersion): Promise<DocumentVersion> {
    return withTenant(this.app, version.tenantId, async (db) => {
      // The next number is read INSIDE this transaction, and the unique
      // constraint on (document_id, version_no) is what makes it safe: two
      // concurrent uploads both computing 3 means the second INSERT fails
      // rather than two rows both claiming to be version 3. A lost upload is
      // recoverable by retrying; two files both called version 3 is not.
      //
      // Deliberately NOT the invoice's counter-row lock (0027): version numbers
      // may gap, because a gap here means an upload failed and nothing legal
      // depends on the sequence being consecutive.
      const [next] = await db<{ next: string }[]>`
        SELECT COALESCE(MAX(version_no), 0) + 1 AS next
        FROM files.document_version
        WHERE document_id = ${version.documentId}
      `;
      const [row] = await db<VersionRow[]>`
        INSERT INTO files.document_version
          (id, tenant_id, document_id, version_no, content_hash, byte_size,
           media_type, filename, storage_key, created_by)
        VALUES (${version.id}, ${version.tenantId}, ${version.documentId},
                ${Number(next?.next ?? 1)}, ${version.contentHash}, ${version.byteSize},
                ${version.mediaType}, ${version.filename}, ${version.storageKey},
                ${version.createdBy})
        RETURNING id, tenant_id, document_id, version_no, content_hash, byte_size,
                  media_type, filename, storage_key, created_by, created_at
      `;
      if (!row) {
        throw new Error(
          `version insert for document ${version.documentId} returned no row — the RLS policy ` +
            `on files.document_version rejected a write this connection is scoped for`,
        );
      }
      return toVersion(row);
    });
  }

  async findById(tenantId: string, documentId: string): Promise<DocumentRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DocumentRow[]>`
        ${this.recordSelect(db)} WHERE d.id = ${documentId}
      `;
      return row ? toRecord(row) : null;
    });
  }

  async list(input: {
    readonly tenantId: string;
    readonly partyId?: string | undefined;
    readonly kind?: DocumentKind | undefined;
    readonly limit: number;
  }): Promise<readonly DocumentRecord[]> {
    return withTenant(this.app, input.tenantId, async (db) => {
      const rows = await db<DocumentRow[]>`
        ${this.recordSelect(db)}
        WHERE (${input.partyId ?? null}::uuid IS NULL OR d.party_id = ${input.partyId ?? null})
          AND (${input.kind ?? null}::text IS NULL OR d.kind = ${input.kind ?? null})
        ORDER BY d.created_at DESC
        LIMIT ${input.limit}
      `;
      return rows.map(toRecord);
    });
  }

  async listForSubject(input: {
    readonly tenantId: string;
    readonly subjectKind: SubjectKind;
    readonly subjectRef: string;
  }): Promise<readonly DocumentRecord[]> {
    return withTenant(this.app, input.tenantId, async (db) => {
      const rows = await db<DocumentRow[]>`
        ${this.recordSelect(db)}
        WHERE EXISTS (
          SELECT 1 FROM files.document_link l
          WHERE l.document_id = d.id
            AND l.subject_kind = ${input.subjectKind}
            AND l.subject_ref = ${input.subjectRef}
        )
        ORDER BY d.created_at DESC
      `;
      return rows.map(toRecord);
    });
  }

  async versions(tenantId: string, documentId: string): Promise<readonly DocumentVersion[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<VersionRow[]>`
        SELECT id, tenant_id, document_id, version_no, content_hash, byte_size,
               media_type, filename, storage_key, created_by, created_at
        FROM files.document_version
        WHERE document_id = ${documentId}
        ORDER BY version_no DESC
      `;
      return rows.map(toVersion);
    });
  }

  async findVersion(tenantId: string, versionId: string): Promise<DocumentVersion | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<VersionRow[]>`
        SELECT id, tenant_id, document_id, version_no, content_hash, byte_size,
               media_type, filename, storage_key, created_by, created_at
        FROM files.document_version WHERE id = ${versionId}
      `;
      return row ? toVersion(row) : null;
    });
  }

  async findByContentHash(
    tenantId: string,
    contentHash: string,
  ): Promise<DocumentVersion | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<VersionRow[]>`
        SELECT id, tenant_id, document_id, version_no, content_hash, byte_size,
               media_type, filename, storage_key, created_by, created_at
        FROM files.document_version
        WHERE content_hash = ${contentHash}
        ORDER BY created_at
        LIMIT 1
      `;
      return row ? toVersion(row) : null;
    });
  }

  async attach(link: NewDocumentLink): Promise<DocumentLink> {
    return withTenant(this.app, link.tenantId, async (db) => {
      const [row] = await db<LinkRow[]>`
        INSERT INTO files.document_link
          (id, tenant_id, document_id, subject_kind, subject_ref, role, created_by)
        VALUES (${link.id}, ${link.tenantId}, ${link.documentId}, ${link.subjectKind},
                ${link.subjectRef}, ${link.role}, ${link.createdBy})
        RETURNING id, tenant_id, document_id, subject_kind, subject_ref, role,
                  created_by, created_at
      `;
      if (!row) {
        throw new Error(
          `link insert for document ${link.documentId} returned no row — the RLS policy on ` +
            `files.document_link rejected a write this connection is scoped for`,
        );
      }
      return toLink(row);
    });
  }

  async linksOf(tenantId: string, documentId: string): Promise<readonly DocumentLinkRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The subject is resolved to a LABEL here rather than by the caller, per
      // the read-model rule — a screen listing "attached to" must not fetch one
      // row per link to render it.
      //
      // A LEFT JOIN per kind, because `subject_ref` has no foreign key and
      // therefore cannot be joined generically. The nulls are the point: a link
      // whose subject has vanished comes back with a null label, and the screen
      // shows it as unresolved instead of rendering a blank row.
      const rows = await db<(LinkRow & { subject_label: string | null })[]>`
        SELECT l.id, l.tenant_id, l.document_id, l.subject_kind, l.subject_ref,
               l.role, l.created_by, l.created_at,
               COALESCE(p.display_name, ld.title, pr.ref, el.ref,
                        eng_p.display_name, i.number, j.source_kind,
                        wi.title) AS subject_label
        FROM files.document_link l
        LEFT JOIN core.party p
          ON l.subject_kind = 'party' AND p.id = l.subject_ref
        LEFT JOIN crm.lead ld
          ON l.subject_kind = 'lead' AND ld.id = l.subject_ref
        LEFT JOIN crm.proposal pr
          ON l.subject_kind = 'proposal' AND pr.id = l.subject_ref
        LEFT JOIN crm.engagement_letter el
          ON l.subject_kind = 'engagement_letter' AND el.id = l.subject_ref
        LEFT JOIN crm.engagement eng
          ON l.subject_kind = 'engagement' AND eng.id = l.subject_ref
        LEFT JOIN core.party eng_p
          ON eng_p.id = eng.entity_party_id
        LEFT JOIN crm.invoice i
          ON l.subject_kind = 'invoice' AND i.id = l.subject_ref
        LEFT JOIN delivery.job j
          ON l.subject_kind = 'job' AND j.id = l.subject_ref
        -- 0063's addition, and the half it promised beside the CHECK: *"a kind
        -- nothing can resolve is a link nobody can follow"*. A client's uploaded
        -- answer is linked to the WORK ITEM the ask was raised from, so without
        -- this the file arrives on the firm's document list attached to a blank.
        LEFT JOIN delivery.work_item wi
          ON l.subject_kind = 'work_item' AND wi.id = l.subject_ref
        WHERE l.document_id = ${documentId}
        ORDER BY l.created_at
      `;
      return rows.map((r) => ({ link: toLink(r), subjectLabel: r.subject_label }));
    });
  }

  async setBrandAsset(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly entityPartyId: string;
    readonly kind: BrandAssetKind;
    readonly documentVersionId: string;
    readonly createdBy: string | null;
  }): Promise<BrandAssetRecord> {
    return withTenant(this.app, input.tenantId, async (db) => {
      // Clear then insert, in one transaction. The partial unique index
      // (`WHERE is_active`) means the reverse order would fail against itself,
      // and doing it in two transactions would leave a moment with no active
      // asset — which a renderer reading concurrently would see as "this firm
      // has no logo".
      await db`
        UPDATE files.brand_asset SET is_active = false
        WHERE entity_party_id = ${input.entityPartyId}
          AND kind = ${input.kind}
          AND is_active
      `;
      await db`
        INSERT INTO files.brand_asset
          (id, tenant_id, entity_party_id, kind, document_version_id, created_by)
        VALUES (${input.id}, ${input.tenantId}, ${input.entityPartyId}, ${input.kind},
                ${input.documentVersionId}, ${input.createdBy})
      `;
      const [row] = await db<BrandAssetRow[]>`
        ${this.brandAssetSelect(db)} WHERE b.id = ${input.id}
      `;
      if (!row) {
        throw new Error(
          `brand asset ${input.id} was inserted for tenant ${input.tenantId} and could not be ` +
            `read back in the same transaction — the RLS policy on files.brand_asset is not ` +
            `matching rows this connection just wrote`,
        );
      }
      return { asset: toBrandAsset(row), entityName: row.entity_name, version: versionOf(row, input.tenantId) };
    });
  }

  async activeBrandAssets(
    tenantId: string,
    entityPartyId: string,
  ): Promise<readonly BrandAssetRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<BrandAssetRow[]>`
        ${this.brandAssetSelect(db)}
        WHERE b.entity_party_id = ${entityPartyId} AND b.is_active
        ORDER BY b.kind
      `;
      return rows.map((r) => ({
        asset: toBrandAsset(r),
        entityName: r.entity_name,
        version: versionOf(r, tenantId),
      }));
    });
  }

  /**
   * The joined read model, in one place because five queries return it.
   *
   * The lateral is what keeps this one query rather than one-plus-N: the latest
   * version per document, chosen by the index on (document_id, version_no DESC)
   * that 0037 creates for exactly this.
   */
  private recordSelect(db: Db) {
    return db`
      SELECT d.id, d.tenant_id, d.title, d.origin, d.kind, d.party_id,
             d.created_by, d.created_at, d.updated_at,
             p.display_name AS party_name,
             u.display_name AS created_by_name,
             u.email::text  AS created_by_email,
             (SELECT count(*) FROM files.document_version dv WHERE dv.document_id = d.id)
               AS version_count,
             v.id AS v_id, v.document_id AS v_document_id, v.version_no AS v_version_no,
             v.content_hash AS v_content_hash, v.byte_size AS v_byte_size,
             v.media_type AS v_media_type, v.filename AS v_filename,
             v.storage_key AS v_storage_key, v.created_by AS v_created_by,
             v.created_at AS v_created_at
      FROM files.document d
      LEFT JOIN core.party p ON p.id = d.party_id
      LEFT JOIN tenancy.user_account u ON u.id = d.created_by
      JOIN LATERAL (
        SELECT * FROM files.document_version dv
        WHERE dv.document_id = d.id
        ORDER BY dv.version_no DESC
        LIMIT 1
      ) v ON true
    `;
  }

  private brandAssetSelect(db: Db) {
    return db`
      SELECT b.id, b.tenant_id, b.entity_party_id, b.kind, b.document_version_id,
             b.is_active, b.created_by, b.created_at,
             e.display_name AS entity_name,
             v.id AS v_id, v.document_id AS v_document_id, v.version_no AS v_version_no,
             v.content_hash AS v_content_hash, v.byte_size AS v_byte_size,
             v.media_type AS v_media_type, v.filename AS v_filename,
             v.storage_key AS v_storage_key, v.created_by AS v_created_by,
             v.created_at AS v_created_at
      FROM files.brand_asset b
      JOIN core.party e ON e.id = b.entity_party_id
      JOIN files.document_version v ON v.id = b.document_version_id
    `;
  }
}
