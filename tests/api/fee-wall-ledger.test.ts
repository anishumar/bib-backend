// B08 (audit 2026-10-03): the audit trail carried money past the fee wall. A
// manager without fee visibility (managers hold ledger:read) opened a client's
// timeline and read every payment and billed amount. Over HTTP, on the ledger
// registrar: the same events, the money nulled for that login.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerLedgerRoutes } from "../../src/api/handler/ledger";
import { LedgerService } from "../../src/usecase/ledger/service";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
import { makeLedgerFakes } from "../../src/testfakes/ledger";

const TENANT = "00000000-0000-4000-8000-0000000005a1";
const USER = "00000000-0000-4000-8000-0000000005a2";
const INVOICE = "00000000-0000-4000-8000-0000000005a3";
const LEAD = "00000000-0000-4000-8000-0000000005a4";

async function world() {
  const ledger = new LedgerService(makeLedgerFakes());
  const actor = { type: "human" as const, id: USER };
  await ledger.recordEvent({
    tenantId: TENANT,
    verb: "payment.recorded",
    objectId: INVOICE,
    actor,
    payload: { invoiceId: INVOICE, invoiceNumber: "INV/2026-27/0001", amount: "59000.00", currency: "INR", method: "bank_transfer" },
  });
  await ledger.recordEvent({
    tenantId: TENANT,
    verb: "lead.details_changed",
    objectId: LEAD,
    actor,
    payload: { partyId: LEAD, jurisdictionFrom: null, jurisdictionTo: "IN", estimatedValueFrom: null, estimatedValueTo: "320000.00", currency: "INR" },
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
      sessionId: "00000000-0000-4000-8000-0000000005a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "manager",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerLedgerRoutes(app, { service: ledger, authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }) });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, json: (await res.json()) as { events: { event: { verb: string; payload: Record<string, unknown> } }[] } };
  };
  return { as, get };
}

const payloadOf = (r: { json: { events: { event: { verb: string; payload: Record<string, unknown> } }[] } }, verb: string) =>
  r.json.events.find((e) => e.event.verb === verb)?.event.payload;

describe("money in the audit trail", () => {
  it("is null on the firm's timeline for a login that cannot see fees; the rest of the event is there", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.get("/api/v1/events");
    expect(r.status).toBe(200);
    expect(payloadOf(r, "payment.recorded")).toEqual({
      invoiceId: INVOICE,
      invoiceNumber: "INV/2026-27/0001",
      amount: null,
      currency: "INR",
      method: "bank_transfer",
    });
    expect(payloadOf(r, "lead.details_changed")).toMatchObject({
      jurisdictionTo: "IN",
      estimatedValueFrom: null,
      estimatedValueTo: null,
    });
  });

  it("is null on one object's timeline too", async () => {
    const w = await world();
    w.as.fees = false;
    const r = await w.get(`/api/v1/objects/payment/${INVOICE}/events`);
    expect(payloadOf(r, "payment.recorded")?.["amount"]).toBeNull();
  });

  it("is there for a login that sees fees", async () => {
    const w = await world();
    const r = await w.get(`/api/v1/objects/payment/${INVOICE}/events`);
    expect(payloadOf(r, "payment.recorded")?.["amount"]).toBe("59000.00");
  });
});
