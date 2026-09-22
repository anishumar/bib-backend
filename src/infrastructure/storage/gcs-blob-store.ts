// The blob store that ships: objects in one Google Cloud Storage bucket.
//
// This is the adapter `filesystem-blob-store.ts` predicted in its own header —
// *"the replacement is an object-store adapter behind the same port; nothing
// above this file changes"* — and nothing above it did. It is NOT a fifth entry
// in the honest registry: the stub beside it stays, keeps its gate in
// `validateServer`, and keeps being the right thing for single-process local
// development. What changes is that `BIB_STORAGE_BACKEND` now has somewhere
// real to point.
//
// ── THE ONE OPTION THAT DOES THREE JOBS ──────────────────────────────────────
//
// `preconditionOpts: { ifGenerationMatch: 0 }` means "create this object only if
// no live object of that name exists". It is the load-bearing line in this file,
// and it is worth knowing all three things it buys before anybody trims it:
//
//   1. WRITE-ONCE. The port promises that storing identical bytes twice writes
//      once and returns the same key. Here that promise is kept by the SERVER
//      refusing the second write, rather than by us overwriting politely and
//      hoping the two payloads really were identical.
//   2. RETRIES. Under the library's default `RetryConditional` strategy an
//      upload carrying no `ifGenerationMatch` is given a retry budget of ZERO —
//      it cannot tell a lost response from a lost request, so it declines to
//      guess. With the precondition present it retries the documented set (408,
//      429, 5xx, connection resets). The flag that makes the write safe is the
//      same flag that makes it durable.
//   3. LEAST PRIVILEGE. An upload that can never overwrite needs only
//      `storage.objects.create`, never `storage.objects.delete` or `.update`.
//      That is what lets the service account hold a two-permission custom role,
//      which in turn moves the port's no-delete rule out of our code and into
//      the credential — where an import, a script or an agent also meets it.
//
// ── SO A 412 IS THE SUCCESS PATH, NOT AN ERROR ───────────────────────────────
//
// A name already taken fails with `412 Precondition Failed`, and there are two
// histories behind that, resolving identically:
//
//   * the bytes were already there — a client re-sending the same PDF, or two
//     documents that genuinely share one blob; or
//   * our own retry fired after a first attempt that actually succeeded and
//     whose response was lost.
//
// In both cases the object is present holding exactly these bytes, because the
// key IS the SHA-256 of them. So `put` swallows the 412 and returns the key.
// That is `filesystem-blob-store.ts`'s *"overwriting is therefore a no-op in
// effect"* arrived at from the opposite direction: there the second write is
// harmless, here it never happens.
//
// ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
//
// **No `delete`**, for the port's own reason (`usecase/filestore/ports.ts`):
// content addressing means two documents can share one blob, so a delete driven
// by one of them silently empties the other. Object storage does not soften
// that; it sharpens it, because the bucket is shared by every firm on the
// platform. A retention or erasure requirement is a deliberate feature with
// reference counting behind it.
//
// **No method returning a URL.** T3.6's position, restated here because this is
// exactly the file where somebody would be tempted: a pre-signed URL is a
// capability that outlives the session that minted it and is checked by a
// storage vendor, so it answers to none of the four scoping gates. Bytes leave
// by the one route that reads the version row under RLS first.
//
// **No re-check of `BIB_MAX_UPLOAD_BYTES`.** `FileStoreService` refuses an
// oversized upload before `put` is ever called, and the edge refuses it again
// with a multipart allowance on top. A third answer to one question is a third
// place for the limit to be wrong.
//
// **No boot-time bucket probe.** Considered and rejected rather than forgotten:
// `bucket.exists()` is a `storage.buckets.get`, so a liveness check would widen
// the service account's role from two permissions to three for the life of the
// product, in order to turn one class of misconfiguration from a first-upload
// 500 into a boot failure. `validateServer` already refuses a `gcs` backend with
// no bucket named, which is the misconfiguration anybody actually makes.
import type { BlobStore } from "../../usecase/filestore/ports";

/**
 * The part of the Cloud Storage SDK this adapter uses, declared here rather
 * than imported.
 *
 * `NodemailerTransport`'s `SmtpConnection` arrangement, for its reason and one
 * more. The reason: a driven adapter states what it needs and `setup/` supplies
 * it, so nothing here depends on a vendor's type moving. The extra one: this
 * shape is what the unit tests fake, and a fake written against a narrow
 * hand-written interface is a fake nobody has to keep in step with a 1.7 MB
 * package's type definitions.
 *
 * `google-cloud-bucket.ts` is the only file in the product that knows how to
 * produce one of these.
 */
export interface GcsBucket {
  file(name: string): GcsObject;
}

export interface GcsObject {
  save(data: Uint8Array, options: GcsSaveOptions): Promise<void>;
  download(): Promise<readonly [Uint8Array]>;
}

export interface GcsSaveOptions {
  /** Single-request upload. See `put` for why there is nothing to resume. */
  readonly resumable: boolean;
  readonly contentType: string;
  /** Zero means "only if this name is free". The whole write-once contract. */
  readonly preconditionOpts: { readonly ifGenerationMatch: number };
}

/**
 * What a blob is, as far as the bucket is concerned.
 *
 * A blob is addressed by the hash of its bytes and can be shared by two
 * documents whose declared media types differ — one filed as a PDF challan, one
 * attached to a client's reply — so there is no single honest type to stamp on
 * the object. The type a reader is served comes from the version row, which is
 * per DOCUMENT, and nothing ever fetches this object over HTTP directly. Setting
 * it explicitly rather than letting the library infer one from the name also
 * keeps the stored metadata from depending on the key scheme.
 */
const OPAQUE_MEDIA_TYPE = "application/octet-stream";

export class GcsBlobStore implements BlobStore {
  readonly kind = "gcs";

  constructor(private readonly bucket: GcsBucket) {}

  async put(input: {
    readonly tenantId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly storageKey: string }> {
    const storageKey = keyFor(input.tenantId, input.contentHash);
    try {
      await this.bucket.file(storageKey).save(input.bytes, {
        // The bytes are ALREADY whole in memory — `FileStoreService` hashed
        // them to derive this key before calling us — so there is no stream to
        // resume and no partial state a later session could salvage. A
        // resumable upload would cost an extra round trip to buy a recovery
        // mechanism for a failure that cannot happen here, and the library
        // offers no per-request deadline on one at all.
        resumable: false,
        contentType: OPAQUE_MEDIA_TYPE,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err) {
      // The object is already there holding these exact bytes. See the header:
      // this is the contract being kept, not an error being tolerated.
      if (!isStatusCode(err, 412)) throw err;
    }
    return { storageKey };
  }

  async get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array | null> {
    // Carried over verbatim from the filesystem adapter, and it is not
    // ceremony: the key is re-derived from the tenant rather than trusted, so a
    // storage key belonging to another firm cannot be read even if one were
    // somehow obtained. RLS already prevents the version row being fetched;
    // this makes the key itself useless without it. The check is a WALL and
    // refuses before the bucket is touched at all.
    //
    // Its neighbour there — the resolved path must stay inside the root — has
    // no counterpart here and is not missing. That guard exists because a
    // filesystem RESOLVES `..`; the bucket's namespace is flat, `..` is two
    // ordinary characters in a name, and there is nothing above the bucket to
    // traverse into.
    if (!input.storageKey.startsWith(`${input.tenantId}/`)) return null;

    try {
      const [bytes] = await this.bucket.file(input.storageKey).download();
      return bytes;
    } catch (err) {
      // Absent is NULL and everything else throws. The port is explicit that
      // the service reports a missing object as a storage fault and never as a
      // missing document, so a 403 (the role was changed under us) or a 5xx
      // (the service is unwell) must not be flattened into "no such file" —
      // that is the shape of incident that gets diagnosed as data loss.
      if (isStatusCode(err, 404)) return null;
      throw err;
    }
  }
}

/**
 * `<tenant>/<first two hex chars>/<full hash>`.
 *
 * DELIBERATELY IDENTICAL to `filesystem-blob-store.ts`'s, and deliberately
 * duplicated rather than shared. The key is STORED on `files.document_version`,
 * so a firm that moved from the local disk to a bucket keeps every key it
 * already wrote; sharing one function would make the scheme a thing two
 * adapters agree on, when what it actually is is a thing each adapter promises
 * and the database holds them to. A future adapter with its own scheme is
 * allowed; a future edit that quietly changes both is not.
 *
 * The fan-out earns its place twice over here, for a reason the original could
 * not have had. On a filesystem it bounds how many entries land in one
 * directory. On Cloud Storage there are no directories at all — the slash is a
 * display convention — but the bucket's index auto-scales by key range, and
 * Google's own guidance is that sequential prefixes slow that scaling while
 * random ones spread it. A UUID followed by hash hex is as random as a key
 * gets. Same three lines, two independent justifications.
 *
 * Tenant-first, so one firm's blobs are a subtree: that is what makes the
 * prefix check in `get` meaningful, and what makes a per-firm export or
 * retention operation a prefix listing rather than a scan.
 */
function keyFor(tenantId: string, contentHash: string): string {
  return `${tenantId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

/**
 * Does this rejection carry that HTTP status?
 *
 * The library raises an `ApiError` whose numeric `code` is copied straight from
 * the response status, so 404 and 412 are both recognisable structurally. A
 * hand-written guard over `unknown` rather than an import of the SDK's class:
 * this file does not know the vendor, and `instanceof` across a dual-published
 * ESM/CJS package is a coin toss anyway.
 *
 * Matching on the MESSAGE would not work even if it were acceptable — the
 * library overwrites an upload error's message with the raw response body, so
 * the text is whatever the service happened to return that day.
 *
 * Anything without a numeric `code` — a DNS failure, a socket reset surfacing
 * as a plain `Error` — answers false, which sends it up the stack. That is the
 * safe direction: a fault we cannot classify must never be read as "absent".
 */
function isStatusCode(err: unknown, status: number): boolean {
  if (typeof err !== "object" || err === null) return false;
  if (!("code" in err)) return false;
  return err.code === status;
}
