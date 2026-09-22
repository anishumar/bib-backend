// The Cloud Storage adapter's behaviour, against a faked bucket.
//
// The fake implements `GcsBucket` — the two-method shape the adapter declares
// for itself — rather than mocking the module. That is not only preference: the
// SDK is a runtime dependency of the deployed image and nothing in the fast test
// path should need it installed to run. It also means every assertion below is
// about the CONTRACT the adapter states, so a vendor upgrade that moves a type
// around cannot quietly rewrite what these tests are checking.
//
// Two of them look redundant and are not, so they are labelled rather than
// tidied: `ifGenerationMatch: 0` is asserted EXPLICITLY because the library's
// retry budget depends on its presence, and removing it would break durability
// while every behavioural test here stayed green.
import { describe, expect, it } from "vitest";
import type { GcsBucket, GcsObject, GcsSaveOptions } from "../../src/infrastructure/storage/gcs-blob-store";
import { GcsBlobStore } from "../../src/infrastructure/storage/gcs-blob-store";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
// A realistic 64-char digest: the first two characters are the fan-out bucket.
const HASH = "ab".concat("c".repeat(62));

/** What the library raises: a plain error carrying the HTTP status as `code`. */
class GcsApiError extends Error {
  readonly code: number;

  constructor(code: number) {
    // The message is deliberately junk. The library overwrites an upload
    // error's message with the raw response body, so the adapter must not be
    // able to recognise a status by reading it.
    super("<html>not the thing to match on</html>");
    this.code = code;
  }
}

interface SaveCall {
  readonly name: string;
  readonly options: GcsSaveOptions;
}

class FakeBucket implements GcsBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly saves: SaveCall[] = [];
  readonly downloads: string[] = [];
  /** Statuses the next save / download rejects with, in order. */
  saveFailures: number[] = [];
  downloadFailures: number[] = [];

  file(name: string): GcsObject {
    return {
      save: (data, options) => {
        this.saves.push({ name, options });
        const failure = this.saveFailures.shift();
        if (failure !== undefined) return Promise.reject(new GcsApiError(failure));
        // `ifGenerationMatch: 0` is the server's job, so the fake does it: a
        // name already taken is refused with 412 rather than overwritten.
        if (options.preconditionOpts.ifGenerationMatch === 0 && this.objects.has(name)) {
          return Promise.reject(new GcsApiError(412));
        }
        this.objects.set(name, data);
        return Promise.resolve();
      },
      download: () => {
        this.downloads.push(name);
        const failure = this.downloadFailures.shift();
        if (failure !== undefined) return Promise.reject(new GcsApiError(failure));
        const bytes = this.objects.get(name);
        if (bytes === undefined) return Promise.reject(new GcsApiError(404));
        return Promise.resolve([bytes] as const);
      },
    };
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("GcsBlobStore", () => {
  it("names itself for the honest registry and for operator logs", () => {
    expect(new GcsBlobStore(new FakeBucket()).kind).toBe("gcs");
  });

  describe("put", () => {
    it("derives the key from the tenant and the hash — the caller never chooses it", async () => {
      const bucket = new FakeBucket();
      const store = new GcsBlobStore(bucket);

      const { storageKey } = await store.put({ tenantId: TENANT, contentHash: HASH, bytes: bytes("a challan") });

      expect(storageKey).toBe(`${TENANT}/ab/${HASH}`);
      expect([...bucket.objects.keys()]).toEqual([`${TENANT}/ab/${HASH}`]);
    });

    it("keeps two firms apart even when their bytes are identical", async () => {
      const bucket = new FakeBucket();
      const store = new GcsBlobStore(bucket);
      const same = bytes("the same PDF");

      const mine = await store.put({ tenantId: TENANT, contentHash: HASH, bytes: same });
      const theirs = await store.put({ tenantId: OTHER_TENANT, contentHash: HASH, bytes: same });

      expect(mine.storageKey).not.toBe(theirs.storageKey);
      expect(bucket.objects.size).toBe(2);
    });

    // ASSERTED EXPLICITLY, not incidentally. Under the library's default
    // RetryConditional strategy an upload with no `ifGenerationMatch` is given
    // a retry budget of zero, so dropping this option would leave every write
    // correct and un-retried — a durability regression invisible to every other
    // test in this file.
    it("writes with the precondition that makes it write-once AND retryable", async () => {
      const bucket = new FakeBucket();

      await new GcsBlobStore(bucket).put({ tenantId: TENANT, contentHash: HASH, bytes: bytes("x") });

      const call = bucket.saves[0];
      expect(call?.options.preconditionOpts.ifGenerationMatch).toBe(0);
      expect(call?.options.resumable).toBe(false);
    });

    it("stores identical bytes once and returns the same key", async () => {
      const bucket = new FakeBucket();
      const store = new GcsBlobStore(bucket);
      const payload = bytes("a client re-sending the same file");

      const first = await store.put({ tenantId: TENANT, contentHash: HASH, bytes: payload });
      const second = await store.put({ tenantId: TENANT, contentHash: HASH, bytes: payload });

      expect(second.storageKey).toBe(first.storageKey);
      // Two attempts, one object: the second was refused 412 by the fake's
      // precondition and the adapter read that as the contract being kept.
      expect(bucket.saves).toHaveLength(2);
      expect(bucket.objects.size).toBe(1);
    });

    it("treats a 412 from a retry whose first attempt landed as success", async () => {
      const bucket = new FakeBucket();
      // The history this covers: the upload actually succeeded, the response
      // was lost, the library retried, and the name is now taken by our own
      // bytes. Indistinguishable from the case above, and it resolves the same
      // way — the key IS the hash of the bytes, so the object present under it
      // cannot be anybody else's.
      bucket.saveFailures = [412];

      const result = await new GcsBlobStore(bucket).put({
        tenantId: TENANT,
        contentHash: HASH,
        bytes: bytes("x"),
      });

      expect(result.storageKey).toBe(`${TENANT}/ab/${HASH}`);
    });

    it("lets a 500 out rather than reporting a phantom write", async () => {
      const bucket = new FakeBucket();
      bucket.saveFailures = [500];

      await expect(
        new GcsBlobStore(bucket).put({ tenantId: TENANT, contentHash: HASH, bytes: bytes("x") }),
      ).rejects.toMatchObject({ code: 500 });
    });

    it("lets an error with no status out — an unclassifiable fault is never swallowed", async () => {
      const bucket: GcsBucket = {
        file: () => ({
          save: () => Promise.reject(new Error("getaddrinfo ENOTFOUND storage.googleapis.com")),
          download: () => Promise.reject(new Error("unreachable in this test")),
        }),
      };

      await expect(
        new GcsBlobStore(bucket).put({ tenantId: TENANT, contentHash: HASH, bytes: bytes("x") }),
      ).rejects.toThrow(/ENOTFOUND/);
    });
  });

  describe("get", () => {
    it("round-trips the bytes", async () => {
      const bucket = new FakeBucket();
      const store = new GcsBlobStore(bucket);
      const payload = bytes("the bytes a partner uploaded");
      const { storageKey } = await store.put({ tenantId: TENANT, contentHash: HASH, bytes: payload });

      expect(await store.get({ tenantId: TENANT, storageKey })).toEqual(payload);
    });

    it("answers null when the object is absent", async () => {
      const bucket = new FakeBucket();

      expect(await new GcsBlobStore(bucket).get({ tenantId: TENANT, storageKey: `${TENANT}/ab/${HASH}` })).toBeNull();
      expect(bucket.downloads).toEqual([`${TENANT}/ab/${HASH}`]);
    });

    // The tenant check is a WALL, not a filter: it refuses before the bucket is
    // touched, so the call count is the assertion that matters.
    it("refuses another firm's key without asking the bucket anything", async () => {
      const bucket = new FakeBucket();
      const store = new GcsBlobStore(bucket);
      const { storageKey } = await store.put({
        tenantId: OTHER_TENANT,
        contentHash: HASH,
        bytes: bytes("another firm's document"),
      });

      expect(await store.get({ tenantId: TENANT, storageKey })).toBeNull();
      expect(bucket.downloads).toEqual([]);
    });

    it("lets a 403 out rather than reporting it as absent", async () => {
      const bucket = new FakeBucket();
      // The service account's binding was changed under a running revision.
      // Flattening this into null would present a permissions incident to a
      // partner as a document whose bytes have vanished.
      bucket.downloadFailures = [403];

      await expect(
        new GcsBlobStore(bucket).get({ tenantId: TENANT, storageKey: `${TENANT}/ab/${HASH}` }),
      ).rejects.toMatchObject({ code: 403 });
    });

    it("lets a 503 out — the service being unwell is not the same as nothing being there", async () => {
      const bucket = new FakeBucket();
      bucket.downloadFailures = [503];

      await expect(
        new GcsBlobStore(bucket).get({ tenantId: TENANT, storageKey: `${TENANT}/ab/${HASH}` }),
      ).rejects.toMatchObject({ code: 503 });
    });
  });
});
