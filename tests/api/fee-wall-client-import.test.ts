// B50 (audit 2026-10-03): the client import's report shows, for every letter
// it would draft, each line's fee (`unitAmount`). An administrator without fee
// visibility read every fee in the firm's book there. Over HTTP on the import
// registrar, against a staged import the stub service holds: the fee is null
// for that login on every answer that carries the report (stage, read,
// confirm), and there for a login that sees fees.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerClientImportRoutes } from "../../src/api/handler/clientimport";
import type { ClientImportService } from "../../src/usecase/clientimport/service";
import type { StagedImport } from "../../src/usecase/clientimport/ports";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";

const TENANT = "00000000-0000-4000-8000-0000000007a1";
const USER = "00000000-0000-4000-8000-0000000007a2";
const IMPORT = "00000000-0000-4000-8000-0000000007a3";

const STAGED: StagedImport = {
  id: IMPORT,
  tenantId: TENANT,
  status: "staged",
  fileNames: { clients: "clients.xlsx", people: null, engagements: "engagements.xlsx" },
  rows: { clients: [], people: [], engagements: [] },
  report: {
    findings: [],
    blocking: 0,
    warnings: 0,
    rows: [],
    letters: [
      {
        clientName: "Cobalt Foods Private Limited",
        clientLineNo: 2,
        clientPartyId: null,
        jurisdiction: "IN",
        currency: "INR",
        effectiveFrom: "2026-04-01",
        signatory: "Siddharth",
        lines: [
          {
            engagementLineNo: 2,
            entityLineNo: 2,
            entityPartyId: null,
            entityName: "Cobalt Foods Private Limited",
            serviceCode: "ACC",
            serviceName: "Monthly bookkeeping",
            serviceVersionId: "00000000-0000-4000-8000-0000000007a4",
            startedOn: "2026-04-01",
            billingFrequency: "monthly",
            unitAmount: "25000.00",
            jurisdiction: "IN",
            basis: null,
          },
        ],
      },
    ],
    portalInvites: [],
    peoplePhones: new Map(),
    counts: {
      clientsToCreate: 1,
      clientsOnFile: 0,
      clientsBlocked: 0,
      entitiesToRegister: 0,
      peopleToCreate: 0,
      rolesToRecord: 0,
      peopleOnFile: 0,
      peopleBlocked: 0,
      engagementsToCreate: 1,
      engagementsOnFile: 0,
      engagementsBlocked: 0,
      lettersToDraft: 1,
      assignmentsToRecord: 0,
      portalInvitesToSend: 0,
    },
    compliance: { floor: null, reachBackFrom: "2026-07-01", engagementsBeforeReachBack: 0 },
  },
  outcome: null,
  stagedBy: { userId: USER, name: "Siddharth", email: "siddharth@example.in" },
  stagedAt: "2026-10-03T06:00:00.000Z",
  confirmedBy: null,
  confirmedAt: null,
} as unknown as StagedImport;

function world() {
  // The handler's mapping is under test, so the use case is a stub answering
  // with one staged import.
  const service = {
    get: () => Promise.resolve(STAGED),
    confirm: () => Promise.resolve(STAGED),
  } as unknown as ClientImportService;
  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  const as = { fees: true };
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000007a5",
      tenantId: TENANT,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: as.fees,
    });
    await next();
  });
  registerClientImportRoutes(app, { service, authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }) });
  const call = async (method: string, path: string) => {
    const res = await app.request(path, { method });
    return { status: res.status, json: (await res.json()) as { report: { letters: { lines: { unitAmount: string | null; serviceName: string }[] }[] } } };
  };
  return { as, call };
}

describe("a fee in the import's report", () => {
  it("is null for an administrator who cannot see fees, on the read and on the confirm", async () => {
    const w = world();
    w.as.fees = false;
    const read = await w.call("GET", `/api/v1/client-imports/${IMPORT}`);
    expect(read.status).toBe(200);
    expect(read.json.report.letters[0]?.lines[0]?.unitAmount).toBeNull();
    expect(read.json.report.letters[0]?.lines[0]?.serviceName).toBe("Monthly bookkeeping");
    const confirmed = await w.call("POST", `/api/v1/client-imports/${IMPORT}/confirm`);
    expect(confirmed.json.report.letters[0]?.lines[0]?.unitAmount).toBeNull();
  });

  it("is there for one who can", async () => {
    const w = world();
    const read = await w.call("GET", `/api/v1/client-imports/${IMPORT}`);
    expect(read.json.report.letters[0]?.lines[0]?.unitAmount).toBe("25000.00");
  });
});
