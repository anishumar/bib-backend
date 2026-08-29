// The blob store registered today: files on the local disk.
//
// HONEST REGISTRY (CLAUDE.md): this is the fourth stub in the codebase, after
// the dev auth resolver, the logging mailer and the attested signer, and it gets
// the same treatment — `validateServer` refuses to boot a production-like
// environment with it. The rule is stated in `attested-signer.ts` as "adding a
// fourth without that treatment is not allowed", so here is the fourth, with it.
//
// WHY IT IS A STUB RATHER THAN AN IMPLEMENTATION, stated precisely, because
// "local disk" sounds like it might merely be unambitious:
//
//   * It is per-POD, not per-product. Two replicas do not share a filesystem, so
//     a file uploaded through one is a 500 through the other. That failure is
//     intermittent and load-balancer-dependent, which is the worst shape a bug
//     can have.
//   * A container filesystem does not survive a restart. The metadata would
//     outlive the bytes, and the product would list documents it cannot open —
//     which is exactly the "row with no blob" the service's write order works to
//     avoid, arrived at from the other direction.
//
// It is genuinely correct for single-process local development and for the
// tests, which is why it is a real adapter and not a mock. The replacement is an
// object-store adapter behind the same port; nothing above this file changes.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStore, ContentDigest } from "../../usecase/filestore/ports";

export class FilesystemBlobStore implements BlobStore {
  readonly kind = "filesystem";

  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(input: {
    readonly tenantId: string;
    readonly contentHash: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly storageKey: string }> {
    const storageKey = keyFor(input.tenantId, input.contentHash);
    const path = this.pathOf(storageKey);
    await mkdir(dirname(path), { recursive: true });
    // Content-addressed, so a second write of the same key writes identical
    // bytes. Overwriting is therefore a no-op in effect and simpler than
    // checking first — and checking first would be a race anyway.
    await writeFile(path, input.bytes);
    return { storageKey };
  }

  async get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array | null> {
    // The key is re-derived from the tenant rather than trusted, so a storage
    // key belonging to another firm cannot be read even if one were somehow
    // obtained. Defence in depth: RLS already prevents the row being fetched,
    // and this makes the key itself useless without it.
    if (!input.storageKey.startsWith(`${input.tenantId}/`)) return null;

    const path = this.pathOf(input.storageKey);
    // Belt and braces on top of the shape check above: whatever the key says,
    // the resolved path must still be inside the root. A key is data from the
    // database, and a path traversal that reached this far would read arbitrary
    // files off the disk.
    if (path !== this.root && !path.startsWith(this.root + sep)) return null;

    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private pathOf(storageKey: string): string {
    return resolve(join(this.root, storageKey));
  }
}

/**
 * `<tenant>/<first two hex chars>/<full hash>`.
 *
 * The fan-out directory is not decoration: a single directory holding every
 * blob a busy firm has ever uploaded is slow to list and, on some filesystems,
 * slow to open. Two characters is 256 buckets, which is enough at this scale and
 * cheap to widen later — the key is STORED on the version row, so an old key
 * keeps working when the scheme changes.
 *
 * Tenant-first, so one firm's blobs are a subtree. That is what makes the prefix
 * check in `get` meaningful, and what would make a per-tenant retention or
 * export operation a directory rather than a query.
 */
function keyFor(tenantId: string, contentHash: string): string {
  return `${tenantId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

/**
 * SHA-256 over bytes.
 *
 * Separate from `Sha256ContentHasher` (crypto/random-tokens.ts), which hashes a
 * STRING as utf-8. That file's own comment warns against merging the two, and
 * this is the case it warns about: hashing a PDF as utf-8 mangles it, and the
 * resulting digest would still look like a valid hash.
 */
export class Sha256ByteDigest implements ContentDigest {
  ofBytes(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }
}
