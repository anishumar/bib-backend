// The due day over HTTP (0385, F1.3/F1.5) — both wires, and the refusal's status.
//
// The service's rules are `service.test.ts`'s. What only a request can show is
// the transport: that the staff body takes `dueOn`, that `INVALID_DUE_DATE` is a
// 400 and not the 500 an unmapped code becomes (`StaffGradeError`'s lesson), that
// both wires carry `dueOn` field by field, and that the template an ask came
// from reaches the FIRM's wire and not the client's.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerClientAskRoutes } from "../../src/api/handler/clientask";
import { registerPortalAskRoutes } from "../../src/api/handler/portalask";
import { ClientAskService } from "../../src/usecase/clientask/service";
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

const TENANT = "00000000-0000-4000-8000-000000000b01";
const COBALT = "00000000-0000-4000-8000-000000000b02";
const WI = "00000000-0000-4000-8000-000000000b03";
const PARTNER = "00000000-0000-4000-8000-000000000b04";
const MEERA = "00000000-0000-4000-8000-000000000b05";

type Who = "staff" | "client";

function world() {
  const store = new FakeAskStore().workItem(WI, COBALT, "Monthly close · Oct 2026");
  const service = new ClientAskService({
    asks: new FakeAskRepo(store),
    portal: new FakePortalAskRepo(store),
    scope: new FakeAskScope().grant(MEERA, COBALT),
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
    // 1 November, 02:00 in Kolkata: the firm's today is the 1st.
    clock: new FakeClock(new Date("2026-10-31T20:30:00.000Z")),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    maxUploadBytes: 1_000_000,
  });
  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  const as: { who: Who } = { who: "staff" };
  app.use("*", async (c, next) => {
    const staff = as.who === "staff";
    c.set("principal", {
      userId: staff ? PARTNER : MEERA,
      sessionId: "00000000-0000-4000-8000-000000000b06",
      tenantId: TENANT,
      audience: staff ? "STAFF" : "CLIENT_PORTAL",
      role: staff ? "partner" : "client_contact",
      commercialVisibility: staff,
    });
    await next();
  });
  registerClientAskRoutes(app, { service });
  registerPortalAskRoutes(app, { service });

  const raise = async (body: Record<string, unknown>) => {
    as.who = "staff";
    const res = await app.request(`/api/v1/work-items/${WI}/asks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const list = async () => {
    as.who = "staff";
    const res = await app.request(`/api/v1/work-items/${WI}/asks`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown>[] };
  };
  const centre = async () => {
    as.who = "client";
    const res = await app.request("/api/v1/portal/asks");
    return {
      status: res.status,
      json: (await res.json()) as { awaitingYou: Record<string, unknown>[] },
    };
  };
  /** A multipart upload: `who` decides the route (the client's own, or a
   *  colleague's on their behalf), each file its own repeated `file` part. */
  const upload = async (
    who: Who,
    askId: string,
    files: readonly { name: string; type: string; bytes: number[] }[],
    note?: string,
  ) => {
    as.who = who;
    const form = new FormData();
    for (const f of files) form.append("file", new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    if (note !== undefined) form.set("note", note);
    const path = who === "client" ? `/api/v1/portal/asks/${askId}/documents` : `/api/v1/asks/${askId}/documents`;
    const res = await app.request(path, { method: "POST", body: form });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { service, raise, list, centre, upload };
}

const PDF = [37, 80, 68, 70, 45];
const pdfs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `statement-${String(i + 1)}.pdf`, type: "application/pdf", bytes: [...PDF, i] }));

async function booksAsk(w: ReturnType<typeof world>): Promise<string> {
  const res = await w.raise({ askKind: "document", prompt: "October bank statements", documentKind: "books_input" });
  return String(res.json["askId"]);
}

describe("the staff raise takes a due day", () => {
  it("answers 201 with the day on the ask, and no template", async () => {
    const w = world();
    const res = await w.raise({ askKind: "question", prompt: "Which bank?", dueOn: "2026-11-05" });
    expect(res.status).toBe(201);
    expect(res.json["dueOn"]).toBe("2026-11-05");
    expect(res.json["fromTemplate"]).toBeNull();
  });

  it("leaves it out and gets null, exactly as before", async () => {
    const w = world();
    const res = await w.raise({ askKind: "question", prompt: "Which bank?" });
    expect(res.status).toBe(201);
    expect(res.json["dueOn"]).toBeNull();
  });

  it("refuses a day before the FIRM's today with 400 INVALID_DUE_DATE", async () => {
    // 31 October is still today in UTC at this instant, and already yesterday
    // for a firm in Kolkata.
    const w = world();
    const res = await w.raise({ askKind: "question", prompt: "Which bank?", dueOn: "2026-10-31" });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toMatchObject({ code: "VALIDATION", reason: "INVALID_DUE_DATE" });
  });

  it("refuses a day that does not exist with the same 400", async () => {
    const w = world();
    const res = await w.raise({ askKind: "question", prompt: "Which bank?", dueOn: "2026-11-31" });
    expect(res.status).toBe(400);
    expect(res.json["error"]).toMatchObject({ code: "VALIDATION", reason: "INVALID_DUE_DATE" });
  });
});

describe("both wires carry the day", () => {
  it("the client's row shows the day and never the template it came from", async () => {
    const w = world();
    await w.service.raiseFromTemplate({
      tenantId: TENANT,
      workItemId: WI,
      prompt: "Bank statements for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-05",
      template: {
        versionId: "00000000-0000-4000-8000-000000000b07",
        templateKey: "monthly-close",
        itemKey: "bank-statements",
      },
    });
    const res = await w.centre();
    expect(res.status).toBe(200);
    const row = res.json.awaitingYou[0];
    expect(row?.["dueOn"]).toBe("2026-11-05");
    expect(row).not.toHaveProperty("fromTemplate");
    expect(JSON.stringify(res.json)).not.toContain("monthly-close");
  });

  it("the firm's row names the template by its keys", async () => {
    const w = world();
    await w.service.raiseFromTemplate({
      tenantId: TENANT,
      workItemId: WI,
      prompt: "Bank statements for October 2026",
      askKind: "document",
      documentKind: "books_input",
      dueOn: "2026-11-05",
      template: {
        versionId: "00000000-0000-4000-8000-000000000b07",
        templateKey: "monthly-close",
        itemKey: "bank-statements",
      },
    });
    const res = await w.list();
    expect(res.status).toBe(200);
    const row = res.json[0];
    // The keys only: the pinned version id is the firm's internal pin.
    expect(row?.["fromTemplate"]).toEqual({
      templateKey: "monthly-close",
      itemKey: "bank-statements",
    });
    expect(row?.["dueOn"]).toBe("2026-11-05");
    // A template raised it, so no PERSON is named.
    expect(row?.["raisedByName"]).toBeNull();
  });
});

describe("several files on one ask, over HTTP (F1.6)", () => {
  it("takes repeated file parts from the client: one response per file", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const res = await w.upload("client", askId, pdfs(3), "All three accounts.");
    expect(res.status).toBe(200);
    const responses = res.json["responses"] as Record<string, unknown>[];
    expect(responses).toHaveLength(3);
    expect(responses.map((r) => (r["document"] as { filename: string }).filename)).toEqual([
      "statement-1.pdf",
      "statement-2.pdf",
      "statement-3.pdf",
    ]);
    expect(responses.every((r) => r["onBehalf"] === false)).toBe(true);
    expect(res.json["status"]).toBe("answered");
  });

  it("still takes a single file part exactly as before", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const res = await w.upload("client", askId, pdfs(1));
    expect(res.status).toBe(200);
    expect(res.json["responses"]).toHaveLength(1);
  });

  it("refuses too many files with 400 ASK_FILE_COUNT, and a request with none", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const many = await w.upload("client", askId, pdfs(21));
    expect(many.status).toBe(400);
    expect(many.json["error"]).toMatchObject({ code: "VALIDATION", reason: "ASK_FILE_COUNT" });
    const none = await w.upload("client", askId, []);
    expect(none.status).toBe(400);
  });

  it("refuses the whole upload when one part is a kind a client may not send", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const res = await w.upload("client", askId, [...pdfs(1), { name: "page.html", type: "text/html", bytes: [60] }]);
    expect(res.status).toBe(400);
    const after = await w.list();
    expect((after.json[0]?.["responses"] as unknown[]).length).toBe(0);
  });
});

describe("a colleague uploading on the client's behalf, over HTTP (F1.6)", () => {
  it("answers the ask with the files marked onBehalf and names the colleague on the firm's wire", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const res = await w.upload("staff", askId, pdfs(2), "Emailed on 3 Nov.");
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("answered");
    const responses = res.json["responses"] as Record<string, unknown>[];
    expect(responses).toHaveLength(2);
    expect(responses.every((r) => r["onBehalf"] === true && r["respondedByName"] === "Aarav Menon")).toBe(true);
  });

  it("shows the client the firm added it, and names nobody at the firm", async () => {
    const w = world();
    const askId = await booksAsk(w);
    await w.upload("staff", askId, pdfs(1));
    const res = await w.centre();
    const centre = res.json as unknown as { withTheFirm: { responses: Record<string, unknown>[] }[] };
    const sent = centre.withTheFirm[0]?.responses[0];
    expect(sent?.["onBehalf"]).toBe(true);
    expect(sent?.["respondedByName"]).toBeNull();
  });

  it("holds the client's allowlist: an executable is refused even when a colleague carries it in", async () => {
    const w = world();
    const askId = await booksAsk(w);
    const res = await w.upload("staff", askId, [{ name: "setup.exe", type: "application/x-msdownload", bytes: [77, 90] }]);
    expect(res.status).toBe(400);
  });

  it("refuses an ask the firm has already closed with 409", async () => {
    const w = world();
    const askId = await booksAsk(w);
    await w.service.close({ tenantId: TENANT, askId, actor: { type: "human", id: PARTNER } });
    const res = await w.upload("staff", askId, pdfs(1));
    expect(res.status).toBe(409);
  });
});
