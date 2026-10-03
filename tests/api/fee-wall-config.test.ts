// B09 / F09 (audit 2026-10-03): the catalogue's list prices reached a login
// that cannot see fees through GET /config/service, while the same price was
// already nulled on a proposal's and a letter's service lines.
//
// Redacted to null on every read of a SERVICE's body for that login (every
// other kind is untouched), and a write of a service (define, a new version,
// publish) is refused to it: it reads null, so whatever it sent back would
// wipe a price it never saw. Also B48: the three writes answer field by field.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerConfigRoutes } from "../../src/api/handler/config";
import { ConfigService } from "../../src/usecase/config/service";
import { AuthzService } from "../../src/usecase/authz/service";
import { makeConfigFakes, withDefaultRoles } from "../../src/testfakes/config";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const TENANT = "00000000-0000-4000-8000-0000000004a1";
const USER = "00000000-0000-4000-8000-0000000004a2";

const AUDIT = {
  name: "Statutory audit",
  description: "Audit under the Companies Act",
  category: "assurance",
  jurisdictions: ["IN"],
  billingBasis: "fixed",
  listPrice: { amount: "175000.00", currency: "INR" },
  pricingNote: "plus out of pocket at actuals",
};

async function world() {
  const service = new ConfigService(makeConfigFakes());
  await service.seedDefaultRoles(TENANT, SYSTEM_ACTOR);
  const { draft } = await service.define(
    { tenantId: TENANT, kind: "service", key: "statutory-audit", body: AUDIT },
    SYSTEM_ACTOR,
  );
  await service.publish(
    { tenantId: TENANT, kind: "service", key: "statutory-audit", version: draft.version },
    SYSTEM_ACTOR,
  );
  // A draft waiting beside it, priced differently.
  await service.addVersion({
    tenantId: TENANT,
    kind: "service",
    key: "statutory-audit",
    body: { ...AUDIT, listPrice: { amount: "190000.00", currency: "INR" } },
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
      sessionId: "00000000-0000-4000-8000-0000000004a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerConfigRoutes(app, { service, authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { as, call };
}

type Version = { body: Record<string, unknown>; version: number };
type Listed = { entry: { key: string }; published: Version | null; pendingDraft: Version | null };
const refusal = (r: { json: Record<string, unknown> }) =>
  r.json["error"] as { code: string; reason?: string; message: string };

describe("a service's list price, for a login that cannot see fees", () => {
  it("is null in the catalogue list, in force and in the waiting draft; the rest of the body is there", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.call("GET", "/api/v1/config/service");
    expect(r.status).toBe(200);
    const audit = (r.json["entries"] as Listed[]).find((e) => e.entry.key === "statutory-audit");
    expect(audit?.published?.body["listPrice"]).toBeNull();
    expect(audit?.pendingDraft?.body["listPrice"]).toBeNull();
    expect(audit?.published?.body["name"]).toBe("Statutory audit");
    expect(audit?.published?.body["pricingNote"]).toBe("plus out of pocket at actuals");
  });

  it("is null in every version of the history", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.call("GET", "/api/v1/config/service/statutory-audit");
    const versions = r.json["versions"] as Version[];
    expect(versions.length).toBe(2);
    for (const v of versions) expect(v.body["listPrice"]).toBeNull();
  });

  it("is there for a login that sees fees", async () => {
    const w = await world();
    const r = await w.call("GET", "/api/v1/config/service");
    const audit = (r.json["entries"] as Listed[]).find((e) => e.entry.key === "statutory-audit");
    expect(audit?.published?.body["listPrice"]).toEqual({ amount: "175000.00", currency: "INR" });
  });

  it("leaves every other kind alone", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.call("GET", "/api/v1/config/role");
    const partner = (r.json["entries"] as Listed[]).find((e) => e.entry.key === "partner");
    expect(partner?.published?.body["permissions"]).toContain("tenant:admin");
  });
});

describe("writing a service, for a login that cannot see fees", () => {
  it("refuses defining, drafting and publishing one, in plain words", async () => {
    const w = await world();
    w.as.fees = false;
    const define = await w.call("POST", "/api/v1/config/service", {
      key: "gst-filing",
      body: { ...AUDIT, name: "GST filing", listPrice: null },
    });
    expect(define.status).toBe(403);
    expect(refusal(define)).toMatchObject({ code: "FORBIDDEN", reason: "FEES_NOT_VISIBLE" });
    expect(refusal(define).message).toBe(
      "Your login is not set to see fees, so it cannot change a service in the catalogue. Ask somebody who can see fees.",
    );

    const draft = await w.call("POST", "/api/v1/config/service/statutory-audit/versions", { body: AUDIT });
    expect(draft.status).toBe(403);
    const publish = await w.call("POST", "/api/v1/config/service/statutory-audit/versions/2/publish");
    expect(publish.status).toBe(403);
  });

  it("does not stop the same login changing a role", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.call("POST", "/api/v1/config/role/manager/versions", {
      body: { label: "Manager", permissions: ["party:read"] },
    });
    expect(r.status).toBe(201);
  });

  it("answers a write field by field (B48), nothing the schema does not name", async () => {
    const w = await world();
    const r = await w.call("POST", "/api/v1/config/service", { key: "gst-filing", body: { ...AUDIT, name: "GST filing" } });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["draft", "entry"]);
    expect(Object.keys(r.json["draft"] as object).sort()).toEqual(
      ["archivedAt", "body", "entryId", "id", "publishedAt", "status", "tenantId", "version"].sort(),
    );
    expect(Object.keys(r.json["entry"] as object).sort()).toEqual(["id", "key", "kind", "tenantId"]);
  });
});
