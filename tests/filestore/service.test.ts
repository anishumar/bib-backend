// The document store's business rules, against in-memory fakes (T3.6).
import { describe, expect, it } from "vitest";
import { FileStoreService } from "../../src/usecase/filestore/service";
import {
  FakeBlobStore,
  FakeContentDigest,
  FakeDocumentStoreRepo,
  FakeRenderSource,
  FakeRenderer,
  aRenderableDocument,
} from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FileStoreError } from "../../src/domain/filestore/errors";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PARTY = "33333333-3333-3333-3333-333333333333";
const ENGAGEMENT = "44444444-4444-4444-4444-444444444444";

const actor = { type: "human" as const, id: USER };

function makeService(maxUploadBytes = 1024 * 1024) {
  const documents = new FakeDocumentStoreRepo();
  const blobs = new FakeBlobStore();
  const events = new RecordingEventSink();
  const renderSource = new FakeRenderSource();
  const service = new FileStoreService({
    documents,
    blobs,
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events,
    maxUploadBytes,
    renderer: new FakeRenderer(),
    renderSource,
  });
  return { service, documents, blobs, events, renderSource };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function upload(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    title: "PAN card",
    kind: "identity_proof" as const,
    partyId: PARTY,
    filename: "pan.pdf",
    mediaType: "application/pdf",
    bytes: bytes("a scanned pan card"),
    actor,
    ...overrides,
  };
}

describe("storing a file", () => {
  it("stores the bytes, the row, and a version numbered 1", async () => {
    const { service, blobs } = makeService();
    const record = await service.store(upload());

    expect(record.document.title).toBe("PAN card");
    expect(record.document.origin).toBe("uploaded");
    expect(record.latestVersion.versionNo).toBe(1);
    expect(record.latestVersion.byteSize).toBe(18);
    expect(record.versionCount).toBe(1);
    // The bytes are actually in the store, under the key the row names.
    expect(blobs.blobs.get(record.latestVersion.storageKey)).toEqual(bytes("a scanned pan card"));
  });

  it("records the fact WITHOUT the filename or the title", async () => {
    // Both routinely name a client ("Kaveri Foods PAN.pdf"). The ledger is
    // append-only and has to stay erasable by row, so this is not a style
    // preference — it is the rule that keeps it erasable.
    const { service, events } = makeService();
    const record = await service.store(upload({ title: "Kaveri Foods PAN" }));

    const stored = events.recorded.find((e) => e.verb === "document.stored");
    expect(stored).toBeDefined();
    expect(stored?.objectId).toBe(record.document.id);
    const payload = JSON.stringify(stored?.payload ?? {});
    expect(payload).not.toContain("Kaveri");
    expect(payload).not.toContain("pan.pdf");
    expect(stored?.payload?.contentHash).toBe(record.latestVersion.contentHash);
    expect(stored?.payload?.origin).toBe("uploaded");
  });

  it("attaches in the same act when a subject is named", async () => {
    const { service, events } = makeService();
    const record = await service.store(
      upload({
        attachTo: { subjectKind: "engagement", subjectRef: ENGAGEMENT, role: "evidence" },
      }),
    );

    const links = await service.linksOf(TENANT, record.document.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.link.subjectKind).toBe("engagement");
    expect(links[0]?.link.role).toBe("evidence");
    expect(events.recorded.map((e) => e.verb)).toContain("document.attached");
  });

  it("refuses an unknown subject kind BEFORE storing anything", async () => {
    // The order is the point. A refusal after the write would leave a stored
    // document nobody asked for on its own, orphaned from the thing it was
    // meant to be evidence for.
    const { service, documents, blobs } = makeService();
    await expect(
      service.store(
        upload({ attachTo: { subjectKind: "obligation", subjectRef: ENGAGEMENT, role: null } }),
      ),
    ).rejects.toThrow(FileStoreError);

    expect(documents.documents).toHaveLength(0);
    expect(blobs.blobs.size).toBe(0);
  });

  it("refuses an empty file", async () => {
    const { service } = makeService();
    await expect(service.store(upload({ bytes: new Uint8Array(0) }))).rejects.toThrow(
      /zero bytes/,
    );
  });

  it("refuses a file over the limit, and the limit is the configured one", async () => {
    const { service } = makeService(10);
    await expect(service.store(upload({ bytes: bytes("more than ten bytes") }))).rejects.toThrow(
      /limit is 10/,
    );
  });

  it("refuses a blank title rather than defaulting to the filename", async () => {
    const { service } = makeService();
    await expect(service.store(upload({ title: "   " }))).rejects.toThrow(/needs a title/);
  });

  it("refuses an unusable media type", async () => {
    const { service } = makeService();
    await expect(service.store(upload({ mediaType: "" }))).rejects.toThrow(/media type/);
  });

  it("normalises the media type and the filename on the way in", async () => {
    const { service } = makeService();
    const record = await service.store(
      upload({ mediaType: "Application/PDF; charset=x", filename: "C:\\scans\\pan.pdf" }),
    );
    expect(record.latestVersion.mediaType).toBe("application/pdf");
    expect(record.latestVersion.filename).toBe("pan.pdf");
  });
});

describe("content addressing", () => {
  it("stores identical bytes once, under one key", async () => {
    const { service, blobs } = makeService();
    const a = await service.store(upload({ title: "PAN, first copy" }));
    const b = await service.store(upload({ title: "PAN, sent again" }));

    // Two documents — they are different facts about the firm's filing.
    expect(a.document.id).not.toBe(b.document.id);
    // One blob. A client re-sending the file they already sent is the ordinary
    // case, not an edge one.
    expect(a.latestVersion.contentHash).toBe(b.latestVersion.contentHash);
    expect(blobs.blobs.size).toBe(1);
  });
});

describe("versions", () => {
  it("supersedes without losing what came before", async () => {
    const { service } = makeService();
    const record = await service.store(upload());
    const v2 = await service.addVersion({
      tenantId: TENANT,
      documentId: record.document.id,
      filename: "pan-rescanned.pdf",
      mediaType: "application/pdf",
      bytes: bytes("a better scan"),
      actor,
    });

    expect(v2.versionNo).toBe(2);
    const all = await service.versions(TENANT, record.document.id);
    expect(all.map((v) => v.versionNo)).toEqual([2, 1]);

    // The OLD bytes are still fetchable by naming the version — "which version
    // did the client sign" has an answer.
    const first = await service.fetchBytes({
      tenantId: TENANT,
      documentId: record.document.id,
      versionId: record.latestVersion.id,
    });
    expect(first.bytes).toEqual(bytes("a scanned pan card"));
  });

  it("refuses a version of a document that does not exist", async () => {
    const { service } = makeService();
    await expect(
      service.addVersion({
        tenantId: TENANT,
        documentId: "55555555-5555-5555-5555-555555555555",
        filename: "x.pdf",
        mediaType: "application/pdf",
        bytes: bytes("x"),
        actor,
      }),
    ).rejects.toThrow(/no document/);
  });
});

describe("fetching bytes", () => {
  it("returns the latest version by default", async () => {
    const { service } = makeService();
    const record = await service.store(upload());
    await service.addVersion({
      tenantId: TENANT,
      documentId: record.document.id,
      filename: "pan2.pdf",
      mediaType: "application/pdf",
      bytes: bytes("newer"),
      actor,
    });

    const fetched = await service.fetchBytes({ tenantId: TENANT, documentId: record.document.id });
    expect(fetched.version.versionNo).toBe(2);
    expect(fetched.bytes).toEqual(bytes("newer"));
  });

  it("refuses a version id belonging to a DIFFERENT document", async () => {
    // Without the ownership check, a version id from another document would
    // serve its bytes under this document's permission check.
    const { service } = makeService();
    const a = await service.store(upload({ title: "A" }));
    const b = await service.store(upload({ title: "B", bytes: bytes("different bytes") }));

    await expect(
      service.fetchBytes({
        tenantId: TENANT,
        documentId: a.document.id,
        versionId: b.latestVersion.id,
      }),
    ).rejects.toThrow(/no version/);
  });

  it("reports lost bytes as a STORAGE fault, not a missing document", async () => {
    // The distinction matters to whoever is woken up: the metadata is intact,
    // so "not found" would send them looking for a deleted document.
    const { service, blobs } = makeService();
    const record = await service.store(upload());
    blobs.loseEverything = true;

    await expect(
      service.fetchBytes({ tenantId: TENANT, documentId: record.document.id }),
    ).rejects.toThrow(/storage fault/);
  });
});

describe("attaching", () => {
  it("refuses to attach the same document to the same subject twice", async () => {
    const { service } = makeService();
    const record = await service.store(upload());
    const link = {
      tenantId: TENANT,
      documentId: record.document.id,
      subjectKind: "engagement",
      subjectRef: ENGAGEMENT,
      role: null,
      actor,
    };
    await service.attach(link);
    await expect(service.attach(link)).rejects.toThrow(/already attached/);
  });

  it("allows the same document on two different subjects", async () => {
    // A PAN card belongs to the party AND is evidence on the engagement that
    // needed it. A column on the document would have forced a choice.
    const { service } = makeService();
    const record = await service.store(upload());
    await service.attach({
      tenantId: TENANT,
      documentId: record.document.id,
      subjectKind: "party",
      subjectRef: PARTY,
      role: null,
      actor,
    });
    await service.attach({
      tenantId: TENANT,
      documentId: record.document.id,
      subjectKind: "engagement",
      subjectRef: ENGAGEMENT,
      role: "evidence",
      actor,
    });

    expect(await service.linksOf(TENANT, record.document.id)).toHaveLength(2);
  });

  it("names the valid set when the subject kind is unknown", async () => {
    const { service } = makeService();
    const record = await service.store(upload());
    await expect(
      service.attach({
        tenantId: TENANT,
        documentId: record.document.id,
        subjectKind: "invoce",
        subjectRef: ENGAGEMENT,
        role: null,
        actor,
      }),
    ).rejects.toThrow(/Known: party, lead, proposal/);
  });
});

describe("brand assets", () => {
  it("puts a mark in force and supersedes the previous one", async () => {
    const { service, events } = makeService();
    const first = await service.store(upload({ title: "Logo 2025", kind: "brand_asset" }));
    const second = await service.store(
      upload({ title: "Logo 2026", kind: "brand_asset", bytes: bytes("a newer logo") }),
    );

    await service.setBrandAsset({
      tenantId: TENANT,
      entityPartyId: PARTY,
      kind: "logo",
      documentVersionId: first.latestVersion.id,
      actor,
    });
    await service.setBrandAsset({
      tenantId: TENANT,
      entityPartyId: PARTY,
      kind: "logo",
      documentVersionId: second.latestVersion.id,
      actor,
    });

    const active = await service.brandAssets(TENANT, PARTY);
    expect(active).toHaveLength(1);
    expect(active[0]?.asset.documentVersionId).toBe(second.latestVersion.id);
    expect(events.recorded.filter((e) => e.verb === "brand_asset.set")).toHaveLength(2);
  });

  it("refuses a version that does not exist", async () => {
    const { service } = makeService();
    await expect(
      service.setBrandAsset({
        tenantId: TENANT,
        entityPartyId: PARTY,
        kind: "logo",
        documentVersionId: "66666666-6666-6666-6666-666666666666",
        actor,
      }),
    ).rejects.toThrow(/no version/);
  });

  it("says so when a firm's entity has no mark of that kind", async () => {
    const { service } = makeService();
    await expect(service.requireBrandAsset(TENANT, PARTY, "letterhead")).rejects.toThrow(
      /no active letterhead/,
    );
  });
});

describe("rendering one of the product's own records", () => {
  it("stores the result as a GENERATED document and attaches it", async () => {
    const { service, renderSource, events } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0007"));

    const record = await service.render({
      tenantId: TENANT,
      kind: "engagement_letter",
      subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT,
      partyId: PARTY,
      actor,
    });

    expect(record.document.origin).toBe("generated");
    expect(record.document.title).toContain("EL-2026-0007");
    expect(record.latestVersion.filename).toBe("EL-2026-0007.pdf");
    expect(record.latestVersion.mediaType).toBe("application/pdf");

    // Attached in the same act, so the letter's own page shows it.
    const links = await service.linksOf(TENANT, record.document.id);
    expect(links[0]?.link.role).toBe("rendered");
    expect(events.recorded.some((e) => e.verb === "document.stored")).toBe(true);
  });

  it("re-rendering unchanged data produces the SAME bytes", async () => {
    // The property the whole engine choice rests on. Two documents, because
    // rendering twice is two acts — but ONE blob, because the store is
    // content-addressed and the bytes are identical.
    const { service, renderSource, blobs } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0008"));

    const first = await service.render({
      tenantId: TENANT, kind: "engagement_letter", subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT, partyId: PARTY, actor,
    });
    const second = await service.render({
      tenantId: TENANT, kind: "engagement_letter", subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT, partyId: PARTY, actor,
    });

    expect(second.latestVersion.contentHash).toBe(first.latestVersion.contentHash);
    expect(blobs.blobs.size).toBe(1);
  });

  it("refuses a kind nothing knows how to describe, and names what it can", async () => {
    const { service } = makeService();
    await expect(
      service.render({
        tenantId: TENANT, kind: "working_paper", subjectKind: "engagement",
        subjectRef: ENGAGEMENT, partyId: null, actor,
      }),
    ).rejects.toThrow(/Renderable today: engagement_letter, invoice/);
  });

  it("refuses a record that does not exist rather than rendering an empty page", async () => {
    const { service } = makeService();
    await expect(
      service.render({
        tenantId: TENANT, kind: "invoice", subjectKind: "invoice",
        subjectRef: "77777777-7777-7777-7777-777777777777", partyId: null, actor,
      }),
    ).rejects.toThrow(/no invoice/);
  });
});
