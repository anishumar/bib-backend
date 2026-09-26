// The T6.16 routes over HTTP: what the CATALOGUE screen is sent.
//
// `tests/obligation/service.test.ts` proves what the service decides and
// `service-filings.integration.test.ts` what the SQL does; this proves the
// wire: every field of the read models and the effects mapped by name, the
// status each refusal maps to, and that the rule editor's old service field is
// no longer a way to link anything (the catalogue is the one place, decision
// 3). The obligation registrar on a bare app, with the router's error mapping
// and a principal standing in for the session guard; gates 1 to 3 are
// `auth-coverage.test.ts`'s.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerObligationRoutes } from "../../src/api/handler/obligation";
import { ObligationService } from "../../src/usecase/obligation/service";
import { ObligationVocabularyService } from "../../src/usecase/obligation/vocabulary";
import {
  FakeCalendarSource,
  FakeCompliancePolicySource,
  FakeObligationExceptionRepo,
  FakeObligationInstanceRepo,
  FakeObligationServices,
  FakeObligationStateRepo,
  FakeObligationTemplateRepo,
  FakeObligationTenants,
  FakeResolutionOptionRepo,
  FakeRuleServiceLinks,
  FakeWorkItemRaiser,
} from "../../src/testfakes/obligation";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const TENANT = "00000000-0000-4000-8000-0000000016f1";
const PARTNER = "00000000-0000-4000-8000-0000000016fa";
const GST = "00000000-0000-4000-8000-0000000016c1";
const FULL = "00000000-0000-4000-8000-0000000016c2";
const NOWHERE = "00000000-0000-4000-8000-0000000016c9";
const ENTITY = "00000000-0000-4000-8000-0000000016e1";
const ENGAGEMENT = "00000000-0000-4000-8000-00000016e001";

async function world() {
  const templates = new FakeObligationTemplateRepo();
  const exceptions = new FakeObligationExceptionRepo();
  const states = new FakeObligationStateRepo();
  const resolutionOptions = new FakeResolutionOptionRepo();
  const instances = new FakeObligationInstanceRepo();
  const calendarSource = new FakeCalendarSource();
  const services = new FakeObligationServices();
  const links = new FakeRuleServiceLinks();
  templates.exceptions = exceptions;
  templates.instances = instances;
  templates.links = links;
  instances.templates = templates;
  instances.states = states.rows;
  instances.links = links;
  instances.engagements = calendarSource;
  calendarSource.links = links;
  links.services = services;
  links.calendar = calendarSource;
  links.instances = instances;
  links.templates = templates;
  services.keys.set(GST, "gst-monthly");
  services.names.set(GST, "GST monthly filing");
  services.keys.set(FULL, "full-compliance");
  services.names.set(FULL, "Full compliance");
  const ids = new FakeIds();
  const events = new RecordingEventSink();
  const service = new ObligationService({
    timeZones: new FakeFirmTimeZone(),
    templates,
    exceptions,
    states,
    resolutionOptions,
    instances,
    links,
    compliancePolicy: new FakeCompliancePolicySource(),
    calendarSource,
    services,
    workItems: new FakeWorkItemRaiser(),
    tenants: new FakeObligationTenants(),
    ids,
    clock: { now: () => new Date("2026-08-30T00:00:00Z") },
    events,
  });
  const actor = { type: "human" as const, id: PARTNER };
  await service.seedDefaultStates(TENANT, actor);
  await service.seedIndiaRulePack(TENANT, actor);
  calendarSource.subjects.push({
    entityPartyId: ENTITY,
    engagementId: ENGAGEMENT,
    effectiveFrom: "2026-01-01",
    jurisdiction: "IN",
    entityType: "private_limited",
    serviceEntryId: GST,
  });

  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: PARTNER,
      sessionId: "00000000-0000-4000-8000-0000000016de",
      tenantId: TENANT,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
    await next();
  });
  registerObligationRoutes(app, {
    service,
    vocabulary: new ObligationVocabularyService({ states, resolutionOptions, ids, events }),
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const gstr3b = templates.rows.find((r) => r.name === "GSTR-3B");
  if (!gstr3b) throw new Error("no GSTR-3B in the pack");
  return { call, gstr3b, instances, links };
}

const refusal = (r: { body: Record<string, unknown> }) =>
  r.body["error"] as { code: string; reason?: string; message: string };

describe("GET /obligation-filings — the catalogue's one read", () => {
  it("answers one row per chain, each with its lineage and where it is used, named", async () => {
    const w = await world();
    await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    const r = await w.call("GET", "/api/v1/obligation-filings");
    expect(r.status).toBe(200);
    const filings = r.body["filings"] as Record<string, unknown>[];
    expect(filings).toHaveLength(57);
    const row = filings.find((f) => f["id"] === w.gstr3b.id);
    expect(row).toMatchObject({
      lineageId: w.gstr3b.lineageId,
      name: "GSTR-3B",
      status: "confirmed",
      coverage: "generating",
      usedIn: [
        {
          serviceEntryId: GST,
          serviceKey: "gst-monthly",
          serviceName: "GST monthly filing",
          linkedAt: expect.stringMatching(/Z$/) as unknown,
        },
      ],
    });
    // The old single-service fields are gone from the wire.
    expect(row).not.toHaveProperty("serviceEntryId");
    expect(row).not.toHaveProperty("serviceName");
    // A pack row on no service says so.
    const other = filings.find((f) => f["name"] === "GSTR-1");
    expect(other).toMatchObject({ usedIn: [], coverage: "unlinked" });
  });
});

describe("POST /services/{serviceEntryId}/filings", () => {
  it("adds it, confirms it, fills the calendar, and says so, field by field", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    expect(r.status).toBe(200);
    const effect = r.body["effect"] as Record<string, unknown>;
    expect(Object.keys(effect).sort()).toEqual(["companies", "confirmed", "linked", "restored", "spawned"]);
    expect(effect).toMatchObject({ linked: true, confirmed: true, restored: 0, companies: 1 });
    expect(effect["spawned"]).toBe(w.instances.rows.length);
    expect(r.body["rule"]).toMatchObject({ id: w.gstr3b.id, status: "confirmed", coverage: "generating" });

    const again = await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    expect(again.status).toBe(200);
    expect(again.body["effect"]).toMatchObject({ linked: false, spawned: 0 });
  });

  it("refuses a service the firm does not have as a 404 naming what to do", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/services/${NOWHERE}/filings`, { ruleId: w.gstr3b.id });
    expect(r.status).toBe(404);
    expect(refusal(r)).toMatchObject({ code: "NOT_FOUND", reason: "SERVICE_NOT_FOUND" });
    expect(refusal(r).message).toMatch(/Catalogue/);
    expect(refusal(r).message).not.toMatch(/—/);
  });

  it("refuses a rule the firm does not have as a 404", async () => {
    const w = await world();
    const r = await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: NOWHERE });
    expect(r.status).toBe(404);
    expect(refusal(r)).toMatchObject({ reason: "TEMPLATE_NOT_FOUND" });
  });
});

describe("POST /services/{serviceEntryId}/filings/{ruleId}/unlink", () => {
  it("removes it and answers what that did, field by field", async () => {
    const w = await world();
    await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    const r = await w.call("POST", `/api/v1/services/${GST}/filings/${w.gstr3b.lineageId}/unlink`);
    expect(r.status).toBe(200);
    const effect = r.body["effect"] as Record<string, unknown>;
    expect(Object.keys(effect).sort()).toEqual(
      ["kept", "keptCoveredElsewhere", "keptPastDue", "keptStarted", "unlinked", "withdrawn"],
    );
    expect(effect["unlinked"]).toBe(true);
    expect(effect["withdrawn"]).toBe(w.instances.rows.filter((i) => i.withdrawnAt !== null).length);
    expect(effect["withdrawn"]).toBeGreaterThan(0);
    expect(r.body["rule"]).toMatchObject({ usedIn: [], coverage: "unlinked" });

    const listed = await w.call("GET", `/api/v1/services/${GST}/filings`);
    expect(listed.body["filings"]).toEqual([]);
  });
});

describe("GET /services/{serviceEntryId}/filings", () => {
  it("answers the service's filings, and a 404 for a service that is not there", async () => {
    const w = await world();
    await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    const r = await w.call("GET", `/api/v1/services/${GST}/filings`);
    expect(r.status).toBe(200);
    expect((r.body["filings"] as { id: string }[]).map((f) => f.id)).toEqual([w.gstr3b.id]);
    expect((await w.call("GET", `/api/v1/services/${FULL}/filings`)).body["filings"]).toEqual([]);
    expect((await w.call("GET", `/api/v1/services/${NOWHERE}/filings`)).status).toBe(404);
  });
});

describe("the rule routes no longer link anything (decision 3)", () => {
  it("POST /obligation-rules with serviceEntryIds writes the rule ON the service", async () => {
    const w = await world();
    const r = await w.call("POST", "/api/v1/obligation-rules", {
      jurisdiction: "IN",
      name: "Professional tax",
      recurrence: "monthly",
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 15, dueDaysAfter: null },
      rulePack: "firm@2026",
      serviceEntryIds: [GST],
    });
    expect(r.status).toBe(201);
    expect(r.body["rule"]).toMatchObject({ coverage: "generating" });
    expect((r.body["rule"] as { usedIn: { serviceEntryId: string }[] }).usedIn.map((u) => u.serviceEntryId)).toEqual([
      GST,
    ]);
    expect((r.body["effect"] as { spawned: number }).spawned).toBeGreaterThan(0);
  });

  it("a PATCH carrying the old serviceEntryId changes no service: the field is not read", async () => {
    const w = await world();
    const r = await w.call("PATCH", `/api/v1/obligation-rules/${w.gstr3b.id}`, {
      status: "confirmed",
      serviceEntryId: GST,
    });
    expect(r.status).toBe(200);
    expect(r.body["rule"]).toMatchObject({ status: "confirmed", usedIn: [], coverage: "unlinked" });
    expect(w.links.rows).toHaveLength(0);
    expect(w.instances.rows).toHaveLength(0);
  });
});

describe("every rule row carries its chain read on the firm's today (T6.16 follow-up)", () => {
  const FIELDS = [
    "coverage",
    "dueRule",
    "effectiveFrom",
    "effectiveTo",
    "exceptions",
    "ruleId",
    "unresolvedReason",
  ];
  // The change also says the first period it governs (review, 2026-09-26).
  const NEXT_FIELDS = [...FIELDS, "firstPeriodStart"].sort();

  /** GSTR-3B on the GST service, then "the law changed" from `from`. */
  async function amended(from: string, body: Record<string, unknown> = {}) {
    const w = await world();
    await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    const superseded = await w.call("POST", `/api/v1/obligation-rules/${w.gstr3b.id}/supersede`, {
      effectiveFrom: from,
      rulePack: "gst-in@2027.04",
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 22, dueDaysAfter: null },
      ...body,
    });
    expect(superseded.status).toBe(201);
    const successorId = (superseded.body["rule"] as { id: string }).id;
    const card = async () =>
      ((await w.call("GET", "/api/v1/obligation-filings")).body["filings"] as Record<string, unknown>[])
        .find((r) => r["lineageId"] === w.gstr3b.lineageId) as Record<string, Record<string, unknown>>;
    return { w, successorId, card };
  }

  it("after a law change from April 2027: today's row, and the change, field by field, on all three reads", async () => {
    const w = await world();
    await w.call("POST", `/api/v1/services/${GST}/filings`, { ruleId: w.gstr3b.id });
    const superseded = await w.call("POST", `/api/v1/obligation-rules/${w.gstr3b.id}/supersede`, {
      effectiveFrom: "2027-04-01",
      rulePack: "gst-in@2027.04",
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 22, dueDaysAfter: null },
    });
    expect(superseded.status).toBe(201);
    const successorId = (superseded.body["rule"] as { id: string }).id;

    const reads = [
      ((await w.call("GET", "/api/v1/obligation-filings")).body["filings"] as Record<string, unknown>[]),
      ((await w.call("GET", `/api/v1/services/${GST}/filings`)).body["filings"] as Record<string, unknown>[]),
      ((await w.call("GET", "/api/v1/obligation-rules")).body["rules"] as Record<string, unknown>[]),
    ];
    for (const rows of reads) {
      const mine = rows.filter((r) => r["lineageId"] === w.gstr3b.lineageId);
      expect(mine.length).toBeGreaterThan(0);
      for (const row of mine) {
        const today = row["inForceToday"] as Record<string, unknown>;
        const next = row["nextChange"] as Record<string, unknown>;
        expect(Object.keys(today).sort()).toEqual(FIELDS);
        expect(Object.keys(next).sort()).toEqual(NEXT_FIELDS);
        expect(today).toMatchObject({
          ruleId: w.gstr3b.id,
          effectiveTo: "2027-04-01",
          coverage: "generating",
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20, dueDaysAfter: null },
        });
        expect(next).toMatchObject({
          ruleId: successorId,
          effectiveFrom: "2027-04-01",
          firstPeriodStart: "2027-04-01",
          coverage: "generating",
          effectiveTo: null,
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 22, dueDaysAfter: null },
          exceptions: [],
        });
      }
    }
    // The catalogue's row is still the successor: it is what a link judges.
    expect(reads[0]?.find((r) => r["lineageId"] === w.gstr3b.lineageId)?.["id"]).toBe(successorId);
  });

  it("answers today's row and no change on a chain nobody has amended", async () => {
    const w = await world();
    const r = await w.call("GET", "/api/v1/obligation-filings");
    const row = (r.body["filings"] as Record<string, unknown>[]).find((f) => f["id"] === w.gstr3b.id);
    expect(row?.["inForceToday"]).toMatchObject({ ruleId: w.gstr3b.id, effectiveFrom: null, effectiveTo: null });
    expect(row?.["nextChange"]).toBeNull();
  });

  it("a cutover mid-month sends the day recorded AND the first period the new row governs", async () => {
    // The card names `firstPeriodStart`: "From May 2027", never "15 April",
    // because April's return is still April's law.
    const { card } = await amended("2027-04-15");
    const row = await card();
    expect(row["inForceToday"]).toMatchObject({ effectiveTo: "2027-04-15" });
    expect(row["nextChange"]).toMatchObject({
      effectiveFrom: "2027-04-15",
      firstPeriodStart: "2027-05-01",
    });
  });

  it("says what TODAY's row is doing, which after a law change is not the newest row's standing", async () => {
    // The successor waits on a fact; the predecessor, confirmed and on the
    // service, is still putting this year's returns on the calendar. The pill
    // reads today's coverage, so it must not come from the successor.
    const { card } = await amended("2027-04-01", {
      dueRule: null,
      unresolvedReason: "The notification has not been published yet.",
    });
    const row = await card();
    expect(row["coverage"]).toBe("needs_formula");
    expect(row["inForceToday"]).toMatchObject({ coverage: "generating" });
    expect(row["nextChange"]).toMatchObject({ coverage: "needs_formula", dueRule: null });
  });

  it("says a retired row is retired, on either side of the change", async () => {
    // The generator dates nothing under a retired row: a retired successor
    // means nothing is dated from April 2027, and a retired predecessor that
    // nothing is dated today.
    const { w, successorId, card } = await amended("2027-04-01");
    expect((await w.call("PATCH", `/api/v1/obligation-rules/${successorId}`, { isActive: false })).status).toBe(200);
    let row = await card();
    expect(row["inForceToday"]).toMatchObject({ ruleId: w.gstr3b.id, coverage: "generating" });
    expect(row["nextChange"]).toMatchObject({ ruleId: successorId, coverage: "retired" });

    expect((await w.call("PATCH", `/api/v1/obligation-rules/${successorId}`, { isActive: true })).status).toBe(200);
    expect((await w.call("PATCH", `/api/v1/obligation-rules/${w.gstr3b.id}`, { isActive: false })).status).toBe(200);
    row = await card();
    expect(row["inForceToday"]).toMatchObject({ ruleId: w.gstr3b.id, coverage: "retired" });
    expect(row["nextChange"]).toMatchObject({ ruleId: successorId, coverage: "generating" });
  });
});
