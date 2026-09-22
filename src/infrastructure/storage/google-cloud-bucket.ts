// The only file in this product that knows what Google Cloud Storage is.
//
// `nodemailer-transport.ts`'s split applied to bytes: one file holds the vendor
// and one file holds the judgement. `gcs-blob-store.ts` decides what a key looks
// like, what a 412 means and why there is no delete — none of which has anything
// to do with which SDK is installed — and it says so through the narrow
// `GcsBucket` interface this file fills in. That is what lets the whole of the
// blob store's behaviour be tested without a network, and it is why swapping the
// vendor later would touch this file and no other.
//
// ── THERE ARE NO CREDENTIALS IN HERE, AND THAT IS THE POINT ──────────────────
//
// On Cloud Run the revision runs as a service account attached to the service,
// and the client libraries fetch OAuth tokens for it from the instance metadata
// server through Application Default Credentials. So there is no key file to
// mount, no key file to rotate, and no secret in the image or the environment —
// the credential is the identity of the running revision, and the IAM binding on
// the bucket is what says what that identity may do.
//
// Which also means this file can say nothing useful about permissions. If an
// upload comes back 403, the answer is in the bucket's IAM policy and not here.
//
// ── AND NO PROJECT ID EITHER ─────────────────────────────────────────────────
//
// An object operation is addressed by bucket and object name alone; the Storage
// client declares `projectIdRequired: false` for exactly that reason. Only
// bucket-level and project-level operations (creating a bucket, listing them)
// need one, and this adapter performs none. So the bucket name is the whole
// address, and there is deliberately no `BIB_GCP_PROJECT_ID` to set, get wrong,
// or have to keep in step with the deployment.
import { Storage } from "@google-cloud/storage";
import type { GcsBucket } from "./gcs-blob-store";

/**
 * What this adapter needs to reach a bucket.
 *
 * Mirrors `GcsConfig` in `config/config.ts` and is declared HERE on purpose,
 * the arrangement `SmtpConnection` already has: an adapter never imports the
 * config module, and `setup/` maps one onto the other.
 */
export interface GcsConnection {
  readonly bucket: string;
  /**
   * How long ONE request may take before it is abandoned, in milliseconds.
   *
   * It is set on the CLIENT rather than per request, because the library offers
   * a per-request deadline on a write and none at all on a read — so the
   * client-level value is the only bound a download has, and setting it in two
   * places would be two numbers free to disagree about one deadline.
   *
   * It bounds an ATTEMPT, not the retry budget: the library's own total
   * deadline (600 seconds by default, over three retries with exponential
   * backoff) is what bounds the whole operation. Those defaults are left alone
   * deliberately — they are the ones Google's own retry strategy documents, and
   * this product has no evidence to tune them against yet.
   */
  readonly timeoutMs: number;
}

/**
 * One bucket, addressed and narrowed.
 *
 * ── ONE BUCKET WITH TENANT-PREFIXED KEYS, NOT A BUCKET PER FIRM ──────────────
 *
 * Decided rather than defaulted into, because the tenant wall makes the question
 * a fair one. A bucket is a project-level resource in a GLOBAL namespace with a
 * quota on its creation rate: four hundred firms would be four hundred Terraform
 * resources, four hundred IAM policies, and a tenant-provisioning step that can
 * fail halfway and leave a firm that exists in the database with nowhere to put
 * a file. Against that, one bucket costs a key prefix — and the namespace is
 * flat, so the prefix is free: no directory is created, nothing is listed, and
 * there is no limit on how many objects a bucket holds.
 *
 * What the prefix buys back is the same subtree property the filesystem adapter
 * relied on: one firm's blobs sit under one prefix, which is what makes `get`'s
 * tenant check meaningful and what makes a per-firm export a prefix listing.
 *
 * And the wall it does NOT weaken: nothing in this product reaches a blob
 * without first reading a `files.document_version` row under RLS, so a key is
 * unreachable before it could be used. Separate buckets would move a second
 * copy of the tenant boundary into IAM, where it would have to be kept in step
 * with the database's by hand.
 */
export function googleCloudBucket(connection: GcsConnection): GcsBucket {
  const bucket = new Storage({ timeout: connection.timeoutMs }).bucket(connection.bucket);

  // The vendor's types stop at this door. Returning the `Bucket` itself would
  // typecheck — it is structurally compatible — and would quietly hand the rest
  // of the product every method on it, including the ones the port exists to
  // not have. An explicit two-method object is the narrowing made real.
  return {
    file: (name) => {
      const object = bucket.file(name);
      return {
        save: (data, options) => object.save(data, options),
        download: () => object.download(),
      };
    },
  };
}
