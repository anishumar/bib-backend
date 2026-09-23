// The blob adapter, chosen once from config — shared by the API and, since the
// signature sweep files signed copies (0080), the worker.
//
// THE THROW IS REACHABLE. `validateServer` refuses `filesystem` in a
// production-like environment but deliberately does not demand a bucket, so
// the bucket is checked at the moment it is needed, by the process that needs
// it.
import type { Config } from "../config/config";
import type { BlobStore } from "../usecase/filestore/ports";
import { FilesystemBlobStore } from "../infrastructure/storage/filesystem-blob-store";
import { GcsBlobStore } from "../infrastructure/storage/gcs-blob-store";
import { googleCloudBucket } from "../infrastructure/storage/google-cloud-bucket";

export function blobStoreFor(cfg: Config): BlobStore {
  if (cfg.storage.backend === "filesystem") return new FilesystemBlobStore(cfg.storage.root);
  if (cfg.storage.bucket === null) {
    throw new Error(
      "BIB_STORAGE_BACKEND=gcs but BIB_GCS_BUCKET is unset, so the Cloud Storage adapter has " +
        "no bucket to write to. Set BIB_GCS_BUCKET to the bucket name, or set " +
        "BIB_STORAGE_BACKEND=filesystem for local development.",
    );
  }
  return new GcsBlobStore(
    googleCloudBucket({ bucket: cfg.storage.bucket, timeoutMs: cfg.storage.timeoutMs }),
  );
}
