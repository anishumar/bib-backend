// Several files on one ask, and a colleague uploading on the client's behalf
// (docs/FIN_BUILD_PLAN.md F1.6, migration 0390) — the rules a database cannot
// state.
//
// As in `service.test.ts`, the fakes filter the portal scope in TypeScript and
// prove nothing about gate 4; the batch's one transaction, the policy that keeps
// `on_behalf` off a portal session, and fin taking the file in are proven against
// Postgres in `tests/portal/client-ask-files.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { ClientAskService } from "../../src/usecase/clientask/service";
import type { UploadFile } from "../../src/usecase/clientask/service";
import {
  FakeAskRepo,
  FakeAskScope,
  FakeAskStore,
  FakePortalAskRepo,
} from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { AskAlreadySettled, AskAnswerEmpty, AskFileCount, AskNotFound } from "../../src/domain/clientask/errors";
import { MAX_FILES_PER_UPLOAD } from "../../src/domain/clientask/model";
import { EmptyContent, UnsupportedMediaType } from "../../src/domain/filestore/errors";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const TENANT = "00000000-0000-4000-8000-000000000001";
const COBALT = "00000000-0000-4000-8000-0000000000c1";
const WI = "00000000-0000-4000-8000-0000000000a1";
const PARTNER = "00000000-0000-4000-8000-0000000000e1";
const MEERA = "00000000-0000-4000-8000-0000000000d1";

const staff = { type: "human", id: PARTNER } as const;
const client = { type: "human", id: MEERA } as const;

function svc() {
  const store = new FakeAskStore().workItem(WI, COBALT, "Monthly close · Oct 2026");
  const events = new RecordingEventSink();
  const blobs = new FakeBlobStore();
  const service = new ClientAskService({
    asks: new FakeAskRepo(store),
    portal: new FakePortalAskRepo(store),
    scope: new FakeAskScope().grant(MEERA, COBALT),
    blobs,
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events,
    clock: new FakeClock(new Date("2026-11-01T06:00:00.000Z")),
    timeZones: new FakeFirmTimeZone("UTC"),
    maxUploadBytes: 1_000,
  });
  return { service, store, events, blobs };
}

async function booksAsk(service: ClientAskService) {
  return service.raise({
    tenantId: TENANT,
    workItemId: WI,
    askKind: "document",
    prompt: "Bank statements for October 2026",
    documentKind: "books_input",
    actor: staff,
  });
}

/** Distinct bytes per file: the blob store is content-addressed. */
function pdf(name: string, seed: number): UploadFile {
  return { filename: name, mediaType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70, seed]) };
}

describe("several files on one ask", () => {
  it("stores each as its own document and its own response, and turns the ask answered once", async () => {
    const { service, store, blobs } = svc();
    const ask = await booksAsk(service);
    const row = await service.upload({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      files: [pdf("hdfc-oct.pdf", 1), pdf("icici-oct.pdf", 2), pdf("amex-oct.pdf", 3)],
      note: "All three accounts.",
      actor: client,
    });
    expect(row.status).toBe("answered");
    expect(row.responses.map((r) => r.document?.filename)).toEqual(["hdfc-oct.pdf", "icici-oct.pdf", "amex-oct.pdf"]);
    expect(new Set(row.responses.map((r) => r.document?.documentId)).size).toBe(3);
    expect(store.uploads).toHaveLength(3);
    expect(store.uploads.every((u) => u.upload.documentKind === "books_input")).toBe(true);
    expect(blobs.blobs.size).toBe(3);
    // The note is one sentence about the whole upload: on the first file only.
    expect(row.responses.map((r) => r.response.answerText)).toEqual(["All three accounts.", null, null]);
    expect(row.responses.every((r) => !r.response.onBehalf)).toBe(true);
  });

  it("records two events per file, each answered event marked as the client's own", async () => {
    const { service, events } = svc();
    const ask = await booksAsk(service);
    await service.upload({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      files: [pdf("a.pdf", 1), pdf("b.pdf", 2)],
      note: null,
      actor: client,
    });
    const answered = events.recorded.filter((e) => e.verb === "client_ask.answered");
    const stored = events.recorded.filter((e) => e.verb === "document.stored");
    expect(answered).toHaveLength(2);
    expect(stored).toHaveLength(2);
    expect(answered.map((e) => e.payload["onBehalf"])).toEqual([false, false]);
    expect(answered.every((e) => e.actorId === MEERA)).toBe(true);
    // Never a filename in the log: it names the client's affairs.
    expect(JSON.stringify(events.recorded)).not.toMatch(/a\.pdf|b\.pdf/);
  });

  it(`refuses more than ${String(MAX_FILES_PER_UPLOAD)} files before storing any`, async () => {
    const { service, store, blobs } = svc();
    const ask = await booksAsk(service);
    const many = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => pdf(`f${String(i)}.pdf`, i));
    await expect(
      service.upload({ tenantId: TENANT, userId: MEERA, askId: ask.ask.id, files: many, note: null, actor: client }),
    ).rejects.toBeInstanceOf(AskFileCount);
    expect(blobs.blobs.size).toBe(0);
    expect(store.responses).toHaveLength(0);
  });

  it(`takes exactly ${String(MAX_FILES_PER_UPLOAD)}`, async () => {
    const { service, store } = svc();
    const ask = await booksAsk(service);
    const most = Array.from({ length: MAX_FILES_PER_UPLOAD }, (_, i) => pdf(`f${String(i)}.pdf`, i));
    await service.upload({ tenantId: TENANT, userId: MEERA, askId: ask.ask.id, files: most, note: null, actor: client });
    expect(store.responses).toHaveLength(MAX_FILES_PER_UPLOAD);
  });

  it("refuses an upload with no file in it", async () => {
    const { service } = svc();
    const ask = await booksAsk(service);
    await expect(
      service.upload({ tenantId: TENANT, userId: MEERA, askId: ask.ask.id, files: [], note: null, actor: client }),
    ).rejects.toBeInstanceOf(AskFileCount);
  });

  it("refuses the WHOLE batch when one file is bad, and stores none of it", async () => {
    const { service, store, blobs } = svc();
    const ask = await booksAsk(service);
    await expect(
      service.upload({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        files: [pdf("good.pdf", 1), { filename: "empty.pdf", mediaType: "application/pdf", bytes: new Uint8Array([]) }],
        note: null,
        actor: client,
      }),
    ).rejects.toBeInstanceOf(EmptyContent);
    expect(blobs.blobs.size).toBe(0);
    expect(store.responses).toHaveLength(0);
  });

  it("refuses a kind of file a client may not send, for every caller and not only at the route", async () => {
    const { service } = svc();
    const ask = await booksAsk(service);
    await expect(
      service.upload({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        files: [{ filename: "page.html", mediaType: "text/html", bytes: new Uint8Array([60]) }],
        note: null,
        actor: client,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaType);
  });
});

describe("a colleague uploading on the client's behalf", () => {
  it("is recorded with the STAFF actor, marked on the client's behalf, and answers the ask", async () => {
    const { service, store, events } = svc();
    const ask = await booksAsk(service);
    const record = await service.uploadOnBehalf({
      tenantId: TENANT,
      askId: ask.ask.id,
      files: [pdf("hdfc-oct.pdf", 1), pdf("icici-oct.pdf", 2)],
      note: "Emailed by Meera on 3 Nov.",
      actor: staff,
    });
    expect(record.ask.status).toBe("answered");
    expect(record.ask.firstAnsweredAt).not.toBeNull();
    expect(record.responses).toHaveLength(2);
    expect(record.responses.every((r) => r.response.onBehalf)).toBe(true);
    // The FIRM's read names the colleague who added it.
    expect(record.responses.every((r) => r.respondedByName === "Aarav Menon")).toBe(true);

    // Stored exactly as the client's upload would be, except who.
    expect(store.uploads.map((u) => u.upload.documentKind)).toEqual(["books_input", "books_input"]);
    expect(store.uploads.every((u) => u.isClientVisible && u.onBehalf && u.createdBy === PARTNER)).toBe(true);
    expect(store.responses.every((r) => r.respondedBy === PARTNER)).toBe(true);

    const answered = events.recorded.filter((e) => e.verb === "client_ask.answered");
    expect(answered).toHaveLength(2);
    expect(answered.every((e) => e.actorType === "human" && e.actorId === PARTNER)).toBe(true);
    expect(answered.every((e) => e.payload["onBehalf"] === true)).toBe(true);
    const stored = events.recorded.filter((e) => e.verb === "document.stored");
    expect(stored.map((e) => e.payload["origin"])).toEqual(["uploaded", "uploaded"]);
    expect(stored.map((e) => e.payload["kind"])).toEqual(["books_input", "books_input"]);
    expect(JSON.stringify(events.recorded)).not.toContain("Emailed by Meera");
  });

  it("shows on the client's action centre as the firm's, naming nobody at the firm", async () => {
    const { service } = svc();
    const ask = await booksAsk(service);
    await service.uploadOnBehalf({ tenantId: TENANT, askId: ask.ask.id, files: [pdf("a.pdf", 1)], note: null, actor: staff });
    const centre = await service.actionCentre(TENANT, MEERA);
    expect(centre.awaitingYou).toEqual([]);
    const sent = centre.withTheFirm[0]?.responses[0];
    expect(sent?.response.onBehalf).toBe(true);
    expect(sent?.respondedByName).toBeNull();
    expect(sent?.document?.filename).toBe("a.pdf");
  });

  it("files a question ask's file as correspondence, the client's rule", async () => {
    const { service, store } = svc();
    const ask = await service.raise({
      tenantId: TENANT,
      workItemId: WI,
      askKind: "question",
      prompt: "Which bank holds the term deposit?",
      documentKind: null,
      actor: staff,
    });
    await service.uploadOnBehalf({ tenantId: TENANT, askId: ask.ask.id, files: [pdf("fd.pdf", 1)], note: null, actor: staff });
    expect(store.uploads[0]?.upload.documentKind).toBe("correspondence");
  });

  it("refuses an ask the firm has closed, and an ask it does not have", async () => {
    const { service, store } = svc();
    const ask = await booksAsk(service);
    await service.close({ tenantId: TENANT, askId: ask.ask.id, actor: staff });
    await expect(
      service.uploadOnBehalf({ tenantId: TENANT, askId: ask.ask.id, files: [pdf("a.pdf", 1)], note: null, actor: staff }),
    ).rejects.toBeInstanceOf(AskAlreadySettled);
    await expect(
      service.uploadOnBehalf({
        tenantId: TENANT,
        askId: "00000000-0000-4000-8000-00000000dead",
        files: [pdf("a.pdf", 1)],
        note: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(AskNotFound);
    expect(store.uploads).toHaveLength(0);
  });

  it("refuses a caller that is not a person: an upload is somebody's act", async () => {
    const { service } = svc();
    const ask = await booksAsk(service);
    await expect(
      service.uploadOnBehalf({ tenantId: TENANT, askId: ask.ask.id, files: [pdf("a.pdf", 1)], note: null, actor: SYSTEM_ACTOR }),
    ).rejects.toBeInstanceOf(AskAnswerEmpty);
  });

  it("holds the same rules as the client's upload: the count, and the kinds of file", async () => {
    const { service } = svc();
    const ask = await booksAsk(service);
    const many = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => pdf(`f${String(i)}.pdf`, i));
    await expect(
      service.uploadOnBehalf({ tenantId: TENANT, askId: ask.ask.id, files: many, note: null, actor: staff }),
    ).rejects.toBeInstanceOf(AskFileCount);
    await expect(
      service.uploadOnBehalf({
        tenantId: TENANT,
        askId: ask.ask.id,
        files: [{ filename: "setup.exe", mediaType: "application/x-msdownload", bytes: new Uint8Array([77, 90]) }],
        note: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaType);
  });
});
