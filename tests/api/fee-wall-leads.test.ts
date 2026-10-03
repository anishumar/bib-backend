// B33 / F02 (audit 2026-10-03): what a lead could be worth reached a login
// that cannot see fees on the list, the lead's page and the pipeline's "Total
// value", and that login could write one. Over HTTP, on the lead registrar.
//
// Redacted to null on every answer that carries a lead, as the fee axis does
// everywhere else (the screen reads the session to say "Hidden"); refused as a
// WRITE; and a save that does not mention the value keeps it, so that login
// can still correct the country without wiping a figure it never saw.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerLeadRoutes } from "../../src/api/handler/lead";
import { LeadService } from "../../src/usecase/lead/service";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
import { makeLeadFakes } from "../../src/testfakes/lead";

const TENANT = "00000000-0000-4000-8000-0000000003a1";
const USER = "00000000-0000-4000-8000-0000000003a2";

function world() {
  const fakes = makeLeadFakes();
  const service = new LeadService(fakes);
  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  const as = { fees: true };
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000003a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "associate",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerLeadRoutes(app, { service, authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const capture = (over: Record<string, unknown> = {}) =>
    call("POST", "/api/v1/leads", {
      source: "inbound",
      kind: "organization",
      name: `Meridian Textiles ${String(Math.random()).slice(2, 8)}`,
      title: "FY27 statutory audit",
      identifiers: [{ type: "email", value: `p${String(Math.random()).slice(2, 8)}@meridian.example` }],
      ownerUserId: null,
      ...over,
    });
  return { as, call, capture };
}

type Lead = { id: string; estimatedValue: { amount: string; currency: string } | null; jurisdiction: string | null };
const leadOf = (r: { json: Record<string, unknown> }) => r.json["lead"] as Lead;
const refusal = (r: { json: Record<string, unknown> }) =>
  r.json["error"] as { code: string; reason?: string; message: string };

describe("what a lead could be worth, for a login that cannot see fees", () => {
  it("is null on the list, the page, and every write's answer; there for a login that sees fees", async () => {
    const w = world();
    const made = await w.capture({ estimatedValue: "320000" });
    expect(made.status).toBe(201);
    const id = leadOf(made).id;
    expect(leadOf(made).estimatedValue).toEqual({ amount: "320000.00", currency: "INR" });

    w.as.fees = false;
    const list = await w.call("GET", "/api/v1/leads");
    const row = (list.json["leads"] as { lead: Lead }[]).find((l) => l.lead.id === id);
    expect(row?.lead.estimatedValue).toBeNull();

    const page = await w.call("GET", `/api/v1/leads/${id}`);
    expect(leadOf(page).estimatedValue).toBeNull();

    const moved = await w.call("POST", `/api/v1/leads/${id}/stage`, { stage: "qualified" });
    expect(moved.status).toBe(200);
    expect((moved.json as unknown as Lead).estimatedValue).toBeNull();

    const owned = await w.call("PUT", `/api/v1/leads/${id}/owner`, { ownerUserId: null });
    expect((owned.json as unknown as Lead).estimatedValue).toBeNull();

    w.as.fees = true;
    const seen = await w.call("GET", `/api/v1/leads/${id}`);
    expect(leadOf(seen).estimatedValue).toEqual({ amount: "320000.00", currency: "INR" });
  });

  it("refuses a capture that carries a value, in plain words, and writes nothing", async () => {
    const w = world();
    w.as.fees = false;
    const r = await w.capture({ estimatedValue: "500000" });
    expect(r.status).toBe(403);
    expect(refusal(r)).toMatchObject({ code: "FORBIDDEN", reason: "FEES_NOT_VISIBLE" });
    expect(refusal(r).message).toBe(
      "Your login is not set to see fees, so it cannot say what a lead could be worth. Ask somebody who can see fees.",
    );
    w.as.fees = true;
    const list = await w.call("GET", "/api/v1/leads");
    expect(list.json["leads"]).toEqual([]);
  });

  it("captures without a value, and answers with the value hidden", async () => {
    const w = world();
    w.as.fees = false;
    const r = await w.capture();
    expect(r.status).toBe(201);
    expect(leadOf(r).estimatedValue).toBeNull();
  });

  it("refuses a details save that names a value, even null, and lets one that leaves it out change the country", async () => {
    const w = world();
    const id = leadOf(await w.capture({ estimatedValue: "320000" })).id;
    w.as.fees = false;

    const named = await w.call("PUT", `/api/v1/leads/${id}/details`, { jurisdiction: "AE", estimatedValue: "1" });
    expect(named.status).toBe(403);
    expect(refusal(named).reason).toBe("FEES_NOT_VISIBLE");
    // Null is a value too ("we no longer know"): it would wipe a figure this login never saw.
    const wiped = await w.call("PUT", `/api/v1/leads/${id}/details`, { jurisdiction: "AE", estimatedValue: null });
    expect(wiped.status).toBe(403);

    const country = await w.call("PUT", `/api/v1/leads/${id}/details`, { jurisdiction: "AE" });
    expect(country.status).toBe(200);
    expect((country.json as unknown as Lead).jurisdiction).toBe("AE");
    expect((country.json as unknown as Lead).estimatedValue).toBeNull();

    w.as.fees = true;
    const kept = await w.call("GET", `/api/v1/leads/${id}`);
    expect(leadOf(kept).estimatedValue).toEqual({ amount: "320000.00", currency: "INR" });
    expect(leadOf(kept).jurisdiction).toBe("AE");
  });
});
