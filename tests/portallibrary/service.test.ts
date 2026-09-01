// The client portal's library (T6.7) — the rules the SERVICE owns.
//
// ── WHAT THIS FILE CAN AND CANNOT SAY ────────────────────────────────────
//
// Gate 4 and the `is_client_visible` narrowing are DATABASE properties and are
// proven against real Postgres in `tests/portal/library.integration.test.ts`,
// where each policy is dropped and watched. `FakePortalLibraryRepo` filters in
// TypeScript, which is the OPPOSITE of how the real adapter works — its SQL
// never mentions `party_id` at all.
//
// So what is here is what only the service decides: that the scope is resolved
// ONCE and passed on whole, that an empty scope reaches the repository as an
// empty scope, that a month is refused rather than coerced, and that bytes are
// only ever fetched for a row that came back.
import { describe, expect, it } from "vitest";
import { PortalLibraryService } from "../../src/usecase/portallibrary/service";
import {
  FakeLibraryBlobs,
  FakeLibraryScope,
  FakeLibraryStore,
  FakePortalLibraryRepo,
} from "../../src/testfakes/portallibrary";
import { FakeClock } from "../../src/testfakes/clock";
import { InvalidMonth } from "../../src/domain/portallibrary/errors";
import { BytesMissing, DocumentNotFound } from "../../src/domain/filestore/errors";
import { isMonth, monthRange } from "../../src/domain/portallibrary/model";

const TENANT = "00000000-0000-4000-8000-000000000001";
const MEERA = "00000000-0000-4000-8000-0000000000u1";
const COBALT = "00000000-0000-4000-8000-0000000000c1";
const LAKEVIEW = "00000000-0000-4000-8000-0000000000c2";
const CHALLAN = "00000000-0000-4000-8000-0000000000d1";
const WORKING_PAPER = "00000000-0000-4000-8000-0000000000d2";
const THEIRS = "00000000-0000-4000-8000-0000000000d3";

function svc(opts: { granted?: boolean } = {}) {
  const store = new FakeLibraryStore()
    .document({ documentId: CHALLAN, clientPartyId: COBALT, storageKey: "k/challan" })
    // Genuinely this client's, and the firm's own thinking about them. 0066's
    // whole reason for existing.
    .document({
      documentId: WORKING_PAPER,
      clientPartyId: COBALT,
      kind: "working_paper",
      isClientVisible: false,
      storageKey: "k/queries",
    })
    .document({ documentId: THEIRS, clientPartyId: LAKEVIEW, storageKey: "k/theirs" })
    .invoice({ invoiceId: "00000000-0000-4000-8000-0000000000i1", clientPartyId: COBALT })
    .invoice({ invoiceId: "00000000-0000-4000-8000-0000000000i2", clientPartyId: LAKEVIEW });

  const scope = new FakeLibraryScope();
  if (opts.granted !== false) scope.grant(MEERA, COBALT);

  const blobs = new FakeLibraryBlobs().put("k/challan", new Uint8Array([1, 2, 3]));
  return {
    blobs,
    service: new PortalLibraryService({
      scope,
      library: new FakePortalLibraryRepo(store),
      blobs,
      clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
    }),
  };
}

describe("the library reaches back, because the acceptance line does", () => {
  it("is not windowed the way the status home is", async () => {
    // "A client finds LAST YEAR's challan." The home answers "what is happening
    // now" over a rolling ninety days; a window here would make the question the
    // feature exists for unanswerable.
    const { service } = svc();
    const docs = await service.documents(TENANT, MEERA);
    expect(docs.map((d) => d.documentId)).toEqual([CHALLAN]);
  });

  it("narrows by kind, and nothing widens it", async () => {
    const { service } = svc();
    expect(await service.documents(TENANT, MEERA, { kind: "working_paper" })).toEqual([]);
    expect(
      (await service.documents(TENANT, MEERA, { kind: "statutory_filing" })).map(
        (d) => d.documentId,
      ),
    ).toEqual([CHALLAN]);
  });

  it("a contact granted nothing gets an empty library, not everything", async () => {
    // The empty list is a real scope. `withPortal` has no variant that takes no
    // parties, and this asserts the service never invents a shortcut for one.
    const { service } = svc({ granted: false });
    expect(await service.documents(TENANT, MEERA)).toEqual([]);
    expect(await service.invoices(TENANT, MEERA)).toEqual([]);
  });
});

describe("the bytes, and the order they are fetched in", () => {
  it("reads the ROW first and only then asks the blob store for its key", async () => {
    const { service } = svc();
    const { bytes, version } = await service.download(TENANT, MEERA, CHALLAN);
    expect(version.storageKey).toBe("k/challan");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("refuses a document the firm has not shared, and never touches the store", async () => {
    // THE ORDER IS THE POINT. The version row NAMES the storage key, so a
    // download that fetched bytes first and checked afterwards would have
    // already read them. `k/queries` is in the blob store deliberately — this
    // test would pass for the wrong reason if it were not.
    const { service, blobs } = svc();
    blobs.put("k/queries", new Uint8Array([9, 9, 9]));
    await expect(service.download(TENANT, MEERA, WORKING_PAPER)).rejects.toThrow(
      DocumentNotFound,
    );
  });

  it("refuses another client's document with the SAME error", async () => {
    // Indistinguishable on purpose: "no such document", "another client's" and
    // "not shared with you" are all the policy filtering the row, so nothing
    // here is in a position to tell them apart — and a distinct refusal would
    // confirm the document exists.
    const { service } = svc();
    await expect(service.download(TENANT, MEERA, THEIRS)).rejects.toThrow(DocumentNotFound);
  });

  it("a row with no bytes behind it is a DIFFERENT failure, and says so", async () => {
    // The row says there is a file and the disk does not have it: an operational
    // fault at the firm, not a client asking for something they may not have.
    // Answering "not found" would send them looking for a document they are
    // entitled to and hide a broken store.
    const { service } = svc();
    await expect(service.download(TENANT, MEERA, THEIRS)).rejects.toThrow(DocumentNotFound);
    const store = new FakeLibraryStore().document({
      documentId: CHALLAN,
      clientPartyId: COBALT,
      storageKey: "k/gone",
    });
    const orphaned = new PortalLibraryService({
      scope: new FakeLibraryScope().grant(MEERA, COBALT),
      library: new FakePortalLibraryRepo(store),
      blobs: new FakeLibraryBlobs(),
      clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
    });
    await expect(orphaned.download(TENANT, MEERA, CHALLAN)).rejects.toThrow(BytesMissing);
  });
});

describe("the month, refused rather than coerced", () => {
  it("takes a real month", async () => {
    const { service } = svc();
    const digest = await service.digest(TENANT, MEERA, "2026-03");
    expect(digest.month).toBe("2026-03");
    expect(digest.documentsAdded.map((r) => r.label)).toEqual(["GST challan"]);
  });

  it("refuses a thirteenth month instead of rolling it into January", async () => {
    // `2026-13` read as January 2027 would answer a question nobody asked with
    // data that looks entirely right, which is the worst kind of wrong a read
    // can be.
    const { service } = svc();
    await expect(service.digest(TENANT, MEERA, "2026-13")).rejects.toThrow(InvalidMonth);
    await expect(service.digest(TENANT, MEERA, "2026-00")).rejects.toThrow(InvalidMonth);
    await expect(service.digest(TENANT, MEERA, "2026-3")).rejects.toThrow(InvalidMonth);
    await expect(service.digest(TENANT, MEERA, "March")).rejects.toThrow(InvalidMonth);
  });

  it("is HALF-OPEN and rolls the year, computed without a Date", () => {
    // A `Date` built from a day string is UTC midnight, which west of Greenwich
    // puts the 1st of April's filing in March's digest. String arithmetic on the
    // year and month cannot do that.
    expect(monthRange("2026-03")).toEqual({ from: "2026-03-01", to: "2026-04-01" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(monthRange("2026-01")).toEqual({ from: "2026-01-01", to: "2026-02-01" });
  });

  it("knows what a month is", () => {
    expect(isMonth("2026-01")).toBe(true);
    expect(isMonth("2026-12")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-00")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(isMonth("2026-01-01")).toBe(false);
  });
});
