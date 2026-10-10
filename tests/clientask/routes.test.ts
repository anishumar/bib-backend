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
  return { service, raise, list, centre };
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
