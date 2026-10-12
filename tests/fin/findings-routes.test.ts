// The findings routes over HTTP (F4.2): what a SCREEN is sent. The real gate 3
// (`permissionGuard` over `ROUTE_PERMISSIONS`) runs in front of the registrar,
// with a firm whose roles split reading from deciding, so the 403 is the
// product's own and not this file's. Gates 1 and 2 are `auth-coverage.test.ts`.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { permissionGuard } from "../../src/api/guards";
import { registerFinFindingsRoutes } from "../../src/api/handler/fin-findings";
import type { Permission } from "../../src/domain/authz/model";
import { AuthzService } from "../../src/usecase/authz/service";
import type { PermissionSource } from "../../src/usecase/authz/ports";
import { FindingService } from "../../src/usecase/fin/findings";
import { FakeFinFirms } from "../../src/testfakes/fin";
import { FakeFindingStore, FakeRuleParameters, SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const FIRM = "00000000-0000-4000-8000-0000000002f1";
const CLIENT = "00000000-0000-4000-8000-0000000002c1";
const PRIYA = "00000000-0000-4000-8000-0000000002a1";

const ROLES: Readonly<Record<string, readonly Permission[]>> = {
  partner: ["books:read", "books:write"],
  // Reads what fin flagged and may not decide it: the split 0388 exists for.
  reader: ["books:read"],
  nobody: [],
};

const permissions: PermissionSource = {
  permissionsFor: (_t, role) => Promise.resolve(ROLES[role] ?? []),
  roleFor: (_t, role) => Promise.resolve(ROLES[role] === undefined ? null : { audience: "STAFF", permissions: ROLES[role] ?? [] }),
  knownRoles: () => Promise.resolve(Object.keys(ROLES)),
};

async function world() {
  const firms = new FakeFinFirms();
  firms.enabled.add(FIRM);
  const store = new FakeFindingStore().addStaff(FIRM, PRIYA, "Priya Sharma");
  store.clientNames.set(CLIENT, "Lumen Cloudworks Pte Ltd");
  const events = new RecordingEventSink();
  const findings = new FindingService({
    firms,
    store,
    parameters: new FakeRuleParameters(SINGAPORE_PARAMETERS),
    events,
    ids: new FakeIds(),
  });
  const { createdIds } = await findings.raise(FIRM, [
    {
      lane: "rule",
      checkKey: "doc.gst_rate",
      clientPartyId: CLIENT,
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      lineIds: ["00000000-0000-4000-8000-00000000d002"],
      facts: { gst: "46.00", expectedGst: "51.75", rateInForce: "9" },
      dedupeKey: "doc.gst_rate:d002",
    },
  ]);
  const findingId = createdIds[0] ?? "";

  const as = { role: "partner" };
  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: PRIYA,
      sessionId: "00000000-0000-4000-8000-0000000002de",
      tenantId: FIRM,
      audience: "STAFF",
      role: as.role,
      commercialVisibility: false,
    });
    await next();
  });
  app.use("/api/v1/*", permissionGuard(new AuthzService({ permissions })));
  registerFinFindingsRoutes(app, { findings });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { as, call, findingId, firms, store, events };
}

const refusal = (r: { body: Record<string, unknown> }) => r.body["error"] as { code: string; reason?: string; message: string };

describe("GET /api/v1/fin/findings", () => {
  it("answers a page with names, the status and the counts, mapped field by field", async () => {
    const w = await world();
    const r = await w.call("GET", "/api/v1/fin/findings?status=open");
    expect(r.status).toBe(200);
    expect(r.body["items"]).toEqual([
      {
        findingId: w.findingId,
        lane: "rule",
        checkKey: "doc.gst_rate",
        clientPartyId: CLIENT,
        clientName: "Lumen Cloudworks Pte Ltd",
        periodStart: "2025-04-01",
        periodEnd: "2025-04-30",
        lineIds: ["00000000-0000-4000-8000-00000000d002"],
        facts: { gst: "46.00", expectedGst: "51.75", rateInForce: "9" },
        status: "open",
        latestDecision: null,
        createdAt: "2026-10-11T00:00:00.000Z",
      },
    ]);
    expect(r.body["summary"]).toEqual({
      total: 1,
      byStatus: { open: 1, ask_client: 0, correct: 0, dismiss: 0 },
      byCheck: [{ checkKey: "doc.gst_rate", lane: "rule", total: 1, byStatus: { open: 1, ask_client: 0, correct: 0, dismiss: 0 } }],
    });
    expect(r.body["nextBefore"]).toBeNull();
  });

  it("refuses a malformed filter as a 400", async () => {
    const w = await world();
    expect((await w.call("GET", "/api/v1/fin/findings?checkKey=Not%20a%20key")).status).toBe(400);
    expect((await w.call("GET", "/api/v1/fin/findings?status=closed")).status).toBe(400);
  });

  it("is 403 for a role without books:read, and 404 FIN_NOT_ENABLED for a firm with fin off", async () => {
    const w = await world();
    w.as.role = "nobody";
    expect((await w.call("GET", "/api/v1/fin/findings")).status).toBe(403);
    w.as.role = "reader";
    w.firms.enabled.delete(FIRM);
    const r = await w.call("GET", "/api/v1/fin/findings");
    expect(r.status).toBe(404);
    expect(refusal(r).reason).toBe("FIN_NOT_ENABLED");
  });
});

describe("GET /api/v1/fin/findings/{findingId}", () => {
  it("answers the finding with its decisions and who made them", async () => {
    const w = await world();
    await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "correct" });
    const r = await w.call("GET", `/api/v1/fin/findings/${w.findingId}`);
    expect(r.status).toBe(200);
    expect(r.body["status"]).toBe("correct");
    expect(r.body["decisions"]).toMatchObject([
      { decision: "correct", reasonCode: null, reasonText: null, decidedBy: { userId: PRIYA, displayName: "Priya Sharma" } },
    ]);
  });

  it("is 404 FIN_FINDING_NOT_FOUND for an id this firm does not hold", async () => {
    const w = await world();
    const r = await w.call("GET", "/api/v1/fin/findings/00000000-0000-4000-8000-0000000009ff");
    expect(r.status).toBe(404);
    expect(refusal(r)).toMatchObject({ code: "NOT_FOUND", reason: "FIN_FINDING_NOT_FOUND" });
  });
});

describe("POST /api/v1/fin/findings/{findingId}/decision", () => {
  it("records a dismissal with its reason, the session's person as the decider", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, {
      decision: "dismiss",
      reasonCode: "other",
      reasonText: "  Supplier reissued it at 9%.  ",
    });
    expect(r.status).toBe(200);
    expect(r.body["latestDecision"]).toMatchObject({
      decision: "dismiss",
      reasonCode: "other",
      reasonText: "Supplier reissued it at 9%.",
      decidedBy: { userId: PRIYA },
    });
    expect(w.events.verbs()).toEqual(["fin.finding_raised", "fin.finding_decided"]);
  });

  it("is 400 for a dismissal with no reason, and names what to send", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "dismiss" });
    expect(r.status).toBe(400);
    expect(refusal(r)).toMatchObject({ code: "VALIDATION", reason: "FIN_DISMISSAL_NEEDS_REASON" });
    expect(refusal(r).message).toMatch(/^Dismissing a finding needs a reason/);
    expect(w.store.decisions).toHaveLength(0);
  });

  it("is 400 for `other` with no words, and for a reason sent with `correct`", async () => {
    const w = await world();
    const other = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "dismiss", reasonCode: "other", reasonText: " " });
    expect(refusal(other).reason).toBe("FIN_OTHER_NEEDS_WORDS");
    const stray = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "correct", reasonCode: "one_off" });
    expect(refusal(stray).reason).toBe("FIN_REASON_ONLY_ON_DISMISSAL");
    expect((await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "ignore" })).status).toBe(400);
  });

  it("is 409 FIN_ASK_NOT_WIRED for asking the client, which is not built", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "ask_client" });
    expect(r.status).toBe(409);
    expect(refusal(r)).toMatchObject({ code: "CONFLICT", reason: "FIN_ASK_NOT_WIRED" });
  });

  it("is 403 for a role that may read the books and not decide about them", async () => {
    const w = await world();
    w.as.role = "reader";
    expect((await w.call("GET", `/api/v1/fin/findings/${w.findingId}`)).status).toBe(200);
    const r = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "correct" });
    expect(r.status).toBe(403);
    expect(refusal(r).reason).toBe("NOT_PERMITTED");
    expect(refusal(r).message).toBe(
      "Your role does not let you decide what FinCompliance flagged in a client's books. Ask an administrator if you need to.",
    );
    expect(w.store.decisions).toHaveLength(0);
  });

  it("is 404 FIN_NOT_ENABLED for a firm with fin off, before the body is judged", async () => {
    const w = await world();
    w.firms.enabled.delete(FIRM);
    const r = await w.call("POST", `/api/v1/fin/findings/${w.findingId}/decision`, { decision: "dismiss" });
    expect(r.status).toBe(404);
    expect(refusal(r).reason).toBe("FIN_NOT_ENABLED");
  });
});
