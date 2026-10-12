// A stored version's bytes, for the read sweep (docs/FIN_BUILD_PLAN.md F2.5).
//
// The document store's own way out, reused rather than restated (T3.6, "bytes
// leave by ONE route"): the version row naming the storage key is read under
// the firm's RLS by the filestore repository (`findVersion`, inside
// `withTenant`), and only then is the key handed to the blob store, which
// re-derives the tenant from it besides. So a version id from another firm
// finds no row and fetches nothing, and no storage key ever leaves this file.
import type { BlobStore, DocumentStoreRepository } from "../../usecase/filestore/ports";
import type { VersionBytes } from "../../usecase/fin/read-ports";

export class StoredVersionBytes implements VersionBytes {
  constructor(
    private readonly versions: Pick<DocumentStoreRepository, "findVersion">,
    private readonly blobs: BlobStore,
  ) {}

  async fetch(tenantId: string, documentVersionId: string): Promise<Uint8Array | null> {
    const version = await this.versions.findVersion(tenantId, documentVersionId);
    if (version === null) return null;
    return this.blobs.get({ tenantId, storageKey: version.storageKey });
  }
}
