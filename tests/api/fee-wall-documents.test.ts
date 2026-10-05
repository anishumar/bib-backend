// B01 / F01 (audit 2026-10-03): the fee wall reached the JSON and stopped at
// the PDF. A login that cannot see fees read "Hidden" on an invoice and then
// downloaded the issued copy, which prints every figure; the proposal builder
// drew the whole Summary of Fees for her through /documents/preview.
//
// The four kinds that print the firm's fees — proposal, engagement letter,
// invoice, credit note — now open, render and preview only for a login that
// sees fees, and every other kind (a PAN card, a filing) is untouched. Over
// HTTP, on the filestore's own registrar, with the router's error mapping.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerFileStoreRoutes } from "../../src/api/handler/filestore";
import { FileStoreService } from "../../src/usecase/filestore/service";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
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
import type { DocumentKind } from "../../src/domain/filestore/model";

const TENANT = "00000000-0000-4000-8000-0000000002a1";
const USER = "00000000-0000-4000-8000-0000000002a2";
const PARTY = "00000000-0000-4000-8000-0000000002a3";
const INVOICE = "00000000-0000-4000-8000-0000000002a4";

function world() {
  const renderSource = new FakeRenderSource();
  renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
  renderSource.documents.set(INVOICE, aRenderableDocument("INV/2026-27/0001"));
  renderSource.parties.set(INVOICE, PARTY);
  const service = new FileStoreService({
    documents: new FakeDocumentStoreRepo(),
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
    maxUploadBytes: 1024 * 1024,
    renderer: new FakeRenderer(),
    renderSource,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-10-03T06:00:00Z")),
  });

  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  const as = { fees: true };
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000002a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "associate",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerFileStoreRoutes(app, {
    service,
    authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }),
  });

  const store = (kind: DocumentKind) =>
    service.store({
      tenantId: TENANT,
      title: `A ${kind}`,
      kind,
      partyId: PARTY,
      filename: `${kind}.pdf`,
      mediaType: "application/pdf",
      // A PDF's own signature first: the store checks the bytes are the type
      // they were sent as (F-14-1).
      bytes: new TextEncoder().encode(`%PDF-1.7\nthe ${kind}, with its fees`),
      actor: { type: "human", id: USER },
    });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json, text };
  };
  return { as, store, call };
}

const refusal = (r: { json: Record<string, unknown> }) =>
  r.json["error"] as { code: string; reason?: string; message: string };

const FEE_KINDS: DocumentKind[] = ["proposal", "engagement_letter", "invoice", "credit_note"];

describe("the bytes of a document that prints fees", () => {
  for (const kind of FEE_KINDS) {
    it(`opens a ${kind} for a login that sees fees, and refuses it in plain words to one that does not`, async () => {
      const w = world();
      const doc = await w.store(kind);

      w.as.fees = true;
      const open = await w.call("GET", `/api/v1/documents/${doc.document.id}/content`);
      expect(open.status).toBe(200);
      expect(open.text).toContain("with its fees");

      w.as.fees = false;
      const shut = await w.call("GET", `/api/v1/documents/${doc.document.id}/content`);
      expect(shut.status).toBe(403);
      expect(refusal(shut)).toMatchObject({ code: "FORBIDDEN", reason: "FEES_NOT_VISIBLE" });
      expect(refusal(shut).message).toBe(
        "Your login is not set to see fees, so it cannot open a document that shows fees. Ask somebody who can see fees.",
      );
      expect(shut.text).not.toContain("with its fees");

      // A named version is the same bytes by another door.
      const version = await w.call(
        "GET",
        `/api/v1/documents/${doc.document.id}/versions/${doc.latestVersion.id}/content`,
      );
      expect(version.status).toBe(403);
      expect(refusal(version).reason).toBe("FEES_NOT_VISIBLE");
    });
  }

  it("leaves every other kind alone: a PAN card opens for the login that cannot see fees", async () => {
    const w = world();
    const doc = await w.store("identity_proof");
    w.as.fees = false;
    const open = await w.call("GET", `/api/v1/documents/${doc.document.id}/content`);
    expect(open.status).toBe(200);
  });

  it("says on the record whether it shows fees, so a screen offers only what will open", async () => {
    const w = world();
    const invoice = await w.store("invoice");
    const pan = await w.store("identity_proof");
    w.as.fees = false;
    const a = await w.call("GET", `/api/v1/documents/${invoice.document.id}`);
    const b = await w.call("GET", `/api/v1/documents/${pan.document.id}`);
    expect(a.status).toBe(200);
    expect(a.json["showsFees"]).toBe(true);
    expect(b.json["showsFees"]).toBe(false);
  });
});

describe("drawing a document that prints fees", () => {
  it("refuses Generate PDF to a login that cannot see fees, before anything is filed", async () => {
    const w = world();
    w.as.fees = false;
    const r = await w.call("POST", "/api/v1/documents/render", { kind: "invoice", subjectRef: INVOICE });
    expect(r.status).toBe(403);
    expect(refusal(r).reason).toBe("FEES_NOT_VISIBLE");
    // Nothing was filed against the invoice.
    w.as.fees = true;
    const filed = await w.call("GET", `/api/v1/subjects/invoice/${INVOICE}/documents`);
    expect((filed.json["documents"] as unknown[]).length).toBe(0);
  });

  it("files it for a login that sees fees", async () => {
    const w = world();
    const r = await w.call("POST", "/api/v1/documents/render", { kind: "invoice", subjectRef: INVOICE });
    expect(r.status).toBe(201);
  });

  it("refuses the preview to a login that cannot see fees, and draws it for one that can", async () => {
    const w = world();
    w.as.fees = false;
    const shut = await w.call("POST", "/api/v1/documents/preview", { kind: "invoice", subjectRef: INVOICE });
    expect(shut.status).toBe(403);
    expect(refusal(shut).reason).toBe("FEES_NOT_VISIBLE");
    expect(shut.text).not.toContain("pdf");

    w.as.fees = true;
    const open = await w.call("POST", "/api/v1/documents/preview", { kind: "invoice", subjectRef: INVOICE });
    expect(open.status).toBe(200);
    expect(typeof open.json["pdf"]).toBe("string");
  });
});
