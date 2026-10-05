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
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FileStoreError } from "../../src/domain/filestore/errors";
import { CopyAlreadyMade } from "../../src/domain/render/errors";

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
  const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
  const clock = new FakeClock(new Date("2026-09-28T20:30:00Z"));
  const service = new FileStoreService({
    documents,
    blobs,
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events,
    maxUploadBytes,
    renderer: new FakeRenderer(),
    renderSource,
timeZones,
clock,
  });
  return { service, documents, blobs, events, renderSource, timeZones, clock };
}

// The store checks an upload's first bytes against the type it was sent as
// (F-14-1), so a fixture carries the signature of the type it claims.
const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
const SIGNATURE: Readonly<Record<string, readonly number[]>> = {
  "application/pdf": ascii("%PDF-1.7\n"),
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")],
};

function bytes(text: string, mediaType = "application/pdf"): Uint8Array {
  const bare = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return new Uint8Array([...(SIGNATURE[bare] ?? []), ...new TextEncoder().encode(text)]);
}

function upload(overrides: Record<string, unknown> = {}) {
  const mediaType = typeof overrides.mediaType === "string" ? overrides.mediaType : "application/pdf";
  return {
    tenantId: TENANT,
    title: "PAN card",
    kind: "identity_proof" as const,
    partyId: PARTY,
    filename: "pan.pdf",
    mediaType,
    bytes: bytes("a scanned pan card", mediaType),
    actor,
    ...overrides,
  };
}

describe("the bytes are what they say they are (F-14-1)", () => {
  it("refuses a file whose contents are not the type it was sent as, before anything is written", async () => {
    const { service, blobs, documents } = makeService();
    // An executable renamed statement.pdf: the browser names it application/pdf.
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new TextEncoder().encode("not a pdf")]);
    await expect(service.store(upload({ filename: "statement.pdf", bytes: exe }))).rejects.toMatchObject({
      code: "CONTENT_NOT_OF_TYPE",
    });
    // A binary sent as text, and a spreadsheet that is not a zip.
    await expect(
      service.store(upload({ filename: "notes.txt", mediaType: "text/plain", bytes: new Uint8Array([0x41, 0, 0x42]) })),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_OF_TYPE" });
    await expect(
      service.store(
        upload({
          filename: "books.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          bytes: new TextEncoder().encode("plain words"),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_OF_TYPE" });
    expect(blobs.blobs.size).toBe(0);
    expect(documents.documents).toHaveLength(0);
  });

  it("takes each type with its own signature, and plain text", async () => {
    const { service } = makeService();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 9]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
    for (const [mediaType, b] of [
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip],
      ["application/vnd.ms-excel", ole],
      ["application/msword", ole],
      ["image/jpeg", jpeg],
      ["text/csv", new TextEncoder().encode("a,b\n1,2\n")],
      ["application/pdf", bytes("x")],
    ] as const) {
      await expect(service.store(upload({ title: mediaType, mediaType, bytes: b }))).resolves.toBeDefined();
    }
  });
});

describe("storing a file", () => {
  it("stores the bytes, the row, and a version numbered 1", async () => {
    const { service, blobs } = makeService();
    const record = await service.store(upload());

    expect(record.document.title).toBe("PAN card");
    expect(record.document.origin).toBe("uploaded");
    expect(record.latestVersion.versionNo).toBe(1);
    expect(record.latestVersion.byteSize).toBe(bytes("a scanned pan card").byteLength);
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
    ).rejects.toThrow(/no document/i);
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

  it("withdraws a link and keeps it as history, off the subject's list", async () => {
    // Decided 2026-09-25: an attachment made in error stays visible as
    // WITHDRAWN rather than vanishing. The row is kept, the subject's file
    // list no longer shows the document, and attaching again is a new link.
    const { service, events } = makeService();
    const record = await service.store(upload());
    const link = {
      tenantId: TENANT,
      documentId: record.document.id,
      subjectKind: "engagement",
      subjectRef: ENGAGEMENT,
      role: "evidence",
      actor,
    };
    await service.attach(link);

    const gone = await service.withdraw(link);
    expect(gone.withdrawnAt).not.toBeNull();
    expect(gone.withdrawnBy).toBe(USER);
    expect(events.recorded.map((e) => e.verb)).toContain("document.link_withdrawn");

    const links = await service.linksOf(TENANT, record.document.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.link.withdrawnAt).not.toBeNull();

    // Nothing live to withdraw a second time.
    await expect(service.withdraw(link)).rejects.toThrow(/not attached/);
    // And it can go back on: a NEW link, beside the withdrawn one.
    await service.attach(link);
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
    // PNG, because a logo is DRAWN and the renderer embeds PNG and JPEG only.
    // This read `application/pdf` while `setBrandAsset` accepted anything, which
    // is the state that let a `.webp` logo store cleanly and then disappear from
    // every document it was supposed to be at the head of.
    const first = await service.store(
      upload({
        title: "Logo 2025",
        kind: "brand_asset",
        filename: "logo-2025.png",
        mediaType: "image/png",
      }),
    );
    const second = await service.store(
      upload({
        title: "Logo 2026",
        kind: "brand_asset",
        filename: "logo-2026.png",
        mediaType: "image/png",
        bytes: bytes("a newer logo", "image/png"),
      }),
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

  it("refuses a logo the renderer cannot draw, at the upload rather than at render time", async () => {
    const { service } = makeService();
    // A `.webp` is exactly what the brand screen's `accept="image/*"` invited
    // and what the render source then dropped in silence, leaving a firm looking
    // at letters with no letterhead and nothing anywhere saying why.
    const webp = await service.store(
      upload({ title: "Logo", kind: "brand_asset", filename: "logo.webp", mediaType: "image/webp" }),
    );
    await expect(
      service.setBrandAsset({
        tenantId: TENANT,
        entityPartyId: PARTY,
        kind: "logo",
        documentVersionId: webp.latestVersion.id,
        actor,
      }),
    ).rejects.toThrow(/can only draw PNG and JPEG/);
  });

  it("refuses a signature the renderer cannot draw", async () => {
    const { service } = makeService();
    const webp = await service.store(
      upload({ title: "Sign", kind: "brand_asset", filename: "sign.webp", mediaType: "image/webp" }),
    );
    await expect(
      service.setBrandAsset({
        tenantId: TENANT,
        entityPartyId: PARTY,
        kind: "signature",
        documentVersionId: webp.latestVersion.id,
        actor,
      }),
    ).rejects.toThrow(/A signature needs a transparent background/);
  });

  it("takes a PDF letterhead, which nothing draws as an image", async () => {
    const { service } = makeService();
    // The exemption, and it is not an oversight: a letterhead is the full
    // stationery a firm prints on, the renderer never embeds it, so the drawable
    // formats are not its rule. Refusing it here would break a real use.
    const pdf = await service.store(upload({ title: "Letterhead", kind: "brand_asset" }));
    const asset = await service.setBrandAsset({
      tenantId: TENANT,
      entityPartyId: PARTY,
      kind: "letterhead",
      documentVersionId: pdf.latestVersion.id,
      actor,
    });
    expect(asset.asset.kind).toBe("letterhead");
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
      actor,
    });

    expect(record.document.origin).toBe("generated");
    expect(record.document.title).toContain("EL-2026-0007");
    // CA#56: what it is, its number and whose.
    expect(record.latestVersion.filename).toBe("Engagement letter EL-2026-0007 - Kaveri Foods.pdf");
    expect(record.latestVersion.mediaType).toBe("application/pdf");

    // Attached in the same act, so the letter's own page shows it. The
    // letter has gone out, so this first copy is its copy of record.
    const links = await service.linksOf(TENANT, record.document.id);
    expect(links[0]?.link.role).toBe("copy_of_record");
    expect(events.recorded.some((e) => e.verb === "document.stored")).toBe(true);
  });

  it("re-rendering unchanged data produces the SAME bytes", async () => {
    // The property the whole engine choice rests on. Two documents, because
    // rendering twice is two acts — but ONE blob, because the store is
    // content-addressed and the bytes are identical. A PROPOSAL, because an
    // invoice or a letter that went out is filed only once (below).
    const { service, renderSource, blobs } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("PR-2026-0008"));

    const first = await service.render({
      tenantId: TENANT, kind: "proposal", subjectKind: "proposal",
      subjectRef: ENGAGEMENT, actor,
    });
    const second = await service.render({
      tenantId: TENANT, kind: "proposal", subjectKind: "proposal",
      subjectRef: ENGAGEMENT, actor,
    });

    expect(second.latestVersion.contentHash).toBe(first.latestVersion.contentHash);
    expect(blobs.blobs.size).toBe(1);
  });

  it("refuses a kind nothing knows how to describe, and names what it can", async () => {
    const { service } = makeService();
    await expect(
      service.render({
        tenantId: TENANT, kind: "working_paper", subjectKind: "engagement",
        subjectRef: ENGAGEMENT, actor,
      }),
    ).rejects.toThrow(/Renderable today: engagement_letter, invoice/);
  });

  it("refuses a record that does not exist rather than rendering an empty page", async () => {
    const { service } = makeService();
    await expect(
      service.render({
        tenantId: TENANT, kind: "invoice", subjectKind: "invoice",
        subjectRef: "77777777-7777-7777-7777-777777777777", actor,
      }),
    ).rejects.toThrow(/no invoice/i);
  });

  it("files the PDF under the party the RECORD names, not one a caller picked", async () => {
    // The route used to take `partyId` in its body. A rendered invoice is
    // client-visible by default, so naming another client filed one firm's
    // invoice in that client's portal library — through the front door, with
    // every gate answering correctly.
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0009"));
    renderSource.parties.set(ENGAGEMENT, PARTY);

    const record = await service.render({
      tenantId: TENANT,
      kind: "engagement_letter",
      subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT,
      actor,
    });

    expect(record.document.partyId).toBe(PARTY);
  });

  it("files it under nobody when the record itself names nobody", async () => {
    // Null is a real answer and must not be papered over: it means the source
    // has no party for this record, which is a fact about the record rather
    // than something the caller may supply.
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0010"));

    const record = await service.render({
      tenantId: TENANT,
      kind: "engagement_letter",
      subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT,
      actor,
    });

    expect(record.document.partyId).toBeNull();
  });
});

describe("the copy of record: an invoice or a letter is filed ONCE after it goes out (2026-09-29)", () => {
  const INVOICE = "88888888-8888-4888-8888-888888888888";

  it("the first copy after Issue is the copy of record, shown to the client", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0004"));
    renderSource.parties.set(INVOICE, PARTY);

    const record = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });

    expect(record.document.isClientVisible).toBe(true);
    expect(record.latestVersion.filename).toBe("Invoice INV-2026-27-0004 - Kaveri Foods.pdf");
    const listed = await service.listForSubject(TENANT, "invoice", INVOICE);
    expect(listed.map((d) => d.role)).toEqual(["copy_of_record"]);
  });

  it("refuses a second copy BEFORE anything is drawn, and says how to correct an invoice", async () => {
    // The bug it closes: rename the client, make the PDF again, and the same
    // invoice number is a second document with a different name on it, in the
    // client's own portal.
    const { service, renderSource, documents, blobs } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0004"));
    await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    renderSource.documents.set(INVOICE, {
      ...aRenderableDocument("INV/2026-27/0004"),
      recipient: { name: "Kaveri Foods Private Limited", lines: [] },
    });

    const second = service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    await expect(second).rejects.toBeInstanceOf(CopyAlreadyMade);
    await expect(second).rejects.toThrow(/already has its issued copy, made on .*credit note/);
    expect(documents.documents).toHaveLength(1);
    expect(blobs.blobs.size).toBe(1);
  });

  it("a letter that went out is filed once too", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0012"));
    await service.render({
      tenantId: TENANT, kind: "engagement_letter", subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT, actor,
    });
    await expect(
      service.render({
        tenantId: TENANT, kind: "engagement_letter", subjectKind: "engagement_letter",
        subjectRef: ENGAGEMENT, actor,
      }),
    ).rejects.toThrow(/already has its copy as sent/);
  });

  it("a DRAFT is printed as the firm's own draft copy, as often as asked, never shown to the client", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0005"));
    renderSource.parties.set(INVOICE, PARTY);
    renderSource.drafts.add(INVOICE);

    const first = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });

    expect(first.document.title).toBe("Draft Engagement Letter INV/2026-27/0005");
    expect(first.document.isClientVisible).toBe(false);
    expect(first.latestVersion.filename).toBe("Invoice INV-2026-27-0005 draft - Kaveri Foods.pdf");
    const listed = await service.listForSubject(TENANT, "invoice", INVOICE);
    expect(listed.map((d) => d.role)).toEqual(["draft_copy", "draft_copy"]);
  });

  it("draft copies do not count: once issued, its copy of record is still made", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0006"));
    renderSource.drafts.add(INVOICE);
    await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    renderSource.drafts.delete(INVOICE);

    const ofRecord = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    expect(ofRecord.document.title).toBe("Engagement Letter INV/2026-27/0006");
    const listed = await service.listForSubject(TENANT, "invoice", INVOICE);
    expect(listed.map((d) => d.role).sort()).toEqual(["copy_of_record", "draft_copy"]);
  });

  it("the copy of record cannot be taken off the invoice; a draft copy can", async () => {
    // Taking it off would let the next render draw today's rows: the rename
    // the copy of record exists to keep out, back through a side door.
    const { service, renderSource } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0007"));
    renderSource.drafts.add(INVOICE);
    const draft = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    renderSource.drafts.delete(INVOICE);
    const ofRecord = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });

    await expect(
      service.withdraw({
        tenantId: TENANT, documentId: ofRecord.document.id, subjectKind: "invoice", subjectRef: INVOICE, actor,
      }),
    ).rejects.toThrow(/is the copy the client was given, so it stays on the record/);
    await service.withdraw({
      tenantId: TENANT, documentId: draft.document.id, subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    const listed = await service.listForSubject(TENANT, "invoice", INVOICE);
    expect(listed.map((d) => d.role)).toEqual(["copy_of_record"]);
  });

  it("a draft copy is never shared with the client, and nothing is recorded (B10)", async () => {
    const { service, renderSource, events } = makeService();
    renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0008"));
    renderSource.parties.set(INVOICE, PARTY);
    renderSource.drafts.add(INVOICE);
    const draft = await service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: INVOICE, actor,
    });
    const before = events.recorded.length;

    const shared = service.setClientVisible({
      tenantId: TENANT, documentId: draft.document.id, visible: true, actor,
    });
    await expect(shared).rejects.toMatchObject({ code: "DRAFT_NOT_SHAREABLE" });
    await expect(shared).rejects.toThrow(/is a draft, and a draft is never shown to the client/);
    expect(events.recorded.length).toBe(before);

    // Taking it off is always allowed.
    const off = await service.setClientVisible({
      tenantId: TENANT, documentId: draft.document.id, visible: false, actor,
    });
    expect(off.document.isClientVisible).toBe(false);
  });

  it("a proposal is untouched: its record is pinned at Send, and its page may copy it again", async () => {
    const { service, renderSource } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("PR-2026-0009"));
    for (let i = 0; i < 2; i += 1) {
      await service.render({
        tenantId: TENANT, kind: "proposal", subjectKind: "proposal", subjectRef: ENGAGEMENT, actor,
      });
    }
    const listed = await service.listForSubject(TENANT, "proposal", ENGAGEMENT);
    expect(listed.map((d) => d.role)).toEqual(["rendered", "rendered"]);
  });
});

describe("previewing a record — drawn, and filed nowhere (2026-09-28)", () => {
  const proposalDoc = () => ({
    ...aRenderableDocument("PR-2026-0003"),
    logo: null,
    proposal: {
      cover: {
        artwork: null,
        title: "Proposal for Services",
        subtitle: "Books and GST",
        preparedFor: [],
        preparedBy: [],
      },
      running: "PR-2026-0003",
      flow: [{ kind: "paragraph" as const, text: "Background.", anchor: "proposal.background" }],
    },
  });

  it("hands back the bytes, their hash and the anchors, and stores, attaches and records NOTHING", async () => {
    const { service, renderSource, documents, blobs, events } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, proposalDoc());

    const preview = await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: ENGAGEMENT });

    expect(preview.reference).toBe("PR-2026-0003");
    expect(preview.bytes.byteLength).toBeGreaterThan(0);
    expect(preview.contentHash).toBe(new FakeContentDigest().ofBytes(preview.bytes));
    expect(preview.anchors.map((a) => a.key)).toEqual(["proposal.background"]);
    expect(documents.documents).toHaveLength(0);
    expect(documents.versionRows).toHaveLength(0);
    expect(documents.links).toHaveLength(0);
    expect(blobs.blobs.size).toBe(0);
    expect(events.recorded).toHaveLength(0);
  });

  it("the same bytes `render` files, for the same description", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("EL-2026-0011"));
    const preview = await service.preview({ tenantId: TENANT, kind: "engagement_letter", subjectRef: ENGAGEMENT });
    const filed = await service.render({
      tenantId: TENANT, kind: "engagement_letter", subjectKind: "engagement_letter",
      subjectRef: ENGAGEMENT, actor,
    });
    expect(preview.contentHash).toBe(filed.latestVersion.contentHash);
  });

  it("dates a draft on the FIRM's day, not the server's", async () => {
    // The clock reads 20:30 UTC on the 28th — already 02:00 on the 29th in Delhi.
    const { service, renderSource } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, proposalDoc());
    const preview = await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: ENGAGEMENT });
    expect(renderSource.asked).toEqual(["2026-09-29"]);
    expect(preview.datedAsIfSent).toBe("2026-09-29");
  });

  it("a letter takes the caller's day, held to the firm's day or one either side", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument());
    await service.preview({ tenantId: TENANT, kind: "engagement_letter", subjectRef: ENGAGEMENT, asOf: "2026-09-28" });
    expect(renderSource.asked).toEqual(["2026-09-28"]);
    await expect(
      service.preview({ tenantId: TENANT, kind: "engagement_letter", subjectRef: ENGAGEMENT, asOf: "2026-09-26" }),
    ).rejects.toThrow(/cannot be today where you are/);
  });

  it("a proposal is dated on the firm's day whatever the caller says, as Send dates it", async () => {
    const { service, renderSource } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, proposalDoc());
    await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: ENGAGEMENT, asOf: "2026-09-28" });
    expect(renderSource.asked).toEqual(["2026-09-29"]);
  });

  it("an invoice is drawn as Issue will date it, on the firm's day (B42)", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(ENGAGEMENT, aRenderableDocument("INV-1"));
    await service.preview({ tenantId: TENANT, kind: "invoice", subjectRef: ENGAGEMENT });
    // 20:30 UTC on 28 September is 29 September in Kolkata.
    expect(renderSource.asked).toEqual(["2026-09-29"]);
  });

  it("says which of the issuer's marks the page wanted and found none of", async () => {
    const { service, renderSource } = makeService();
    renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
    renderSource.documents.set(ENGAGEMENT, proposalDoc());
    const preview = await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: ENGAGEMENT });
    expect(preview.missingBrand).toEqual(["logo", "proposal_cover"]);
    expect(preview.issuingEntity?.name).toBe("The Firm LLP");
  });

  it("refuses a kind nothing can draw, and a record that is not there", async () => {
    const { service } = makeService();
    await expect(
      service.preview({ tenantId: TENANT, kind: "working_paper", subjectRef: ENGAGEMENT }),
    ).rejects.toThrow(/Renderable today/);
    await expect(
      service.preview({ tenantId: TENANT, kind: "invoice", subjectRef: "77777777-7777-7777-7777-777777777777" }),
    ).rejects.toThrow(/no invoice/i);
  });
});
