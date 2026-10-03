// F21 / CA#54 (audit 2026-10-03): refusals a person at a CA firm reads on the
// screen, in their words. They carried the product's internals: "(gate 4) …
// a 403 would confirm it exists", `Role "associate" does not carry
// "ledger:read"`, and a dashboard refusal about "commercial visibility" being
// "a setting on the membership".
import { describe, expect, it } from "vitest";
import { NotPermitted } from "../../src/domain/authz/errors";
import { PERMISSIONS } from "../../src/domain/authz/model";
import { RequestNotFound } from "../../src/domain/clientrequest/errors";
import { AskNotFound } from "../../src/domain/clientask/errors";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerDashboardRoutes } from "../../src/api/handler/dashboard";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";

/** What a CA firm's staff should never read in a refusal. */
const JARGON = /gate \d|403|tenant|membership|commercial visibility|carry|registry|permission|[a-z]+:[a-z]+|"/i;

describe("a refusal for a role that may not do something", () => {
  it("says what the person may not do, in words, for every permission", () => {
    for (const permission of PERMISSIONS) {
      const message = new NotPermitted("associate", permission).message;
      expect(message, permission).toMatch(/^Your role does not let you [a-z]/);
      expect(message, permission).toMatch(/Ask an administrator if you need to\.$/);
      expect(message, permission).not.toMatch(JARGON);
    }
  });

  it("reads naturally for the two the audit saw", () => {
    expect(new NotPermitted("associate", "ledger:read").message).toBe(
      "Your role does not let you read the firm's audit trail. Ask an administrator if you need to.",
    );
    expect(new NotPermitted("associate", "tenant:admin").message).toBe(
      "Your role does not let you manage the firm's people, roles and settings. Ask an administrator if you need to.",
    );
  });
});

describe("a request or a question that cannot be opened", () => {
  it("says so without the product's internals", () => {
    for (const message of [
      new RequestNotFound("00000000-0000-4000-8000-000000000000").message,
      new AskNotFound("00000000-0000-4000-8000-000000000000").message,
    ]) {
      expect(message).toBe("This request could not be found, or you do not have access to it.");
      expect(message).not.toMatch(JARGON);
    }
  });
});

describe("the firm's numbers, for a login that cannot see fees", () => {
  it("refuses in plain words", async () => {
    const TENANT = "00000000-0000-4000-8000-0000000008a1";
    const app = createOpenAPIApp();
    app.onError((err, c) => {
      const m = mapError(err);
      return c.json(toEnvelope(m), m.status);
    });
    app.use("*", async (c, next) => {
      c.set("principal", {
        userId: "00000000-0000-4000-8000-0000000008a2",
        sessionId: "00000000-0000-4000-8000-0000000008a3",
        tenantId: TENANT,
        audience: "STAFF",
        role: "associate",
        commercialVisibility: false,
      });
      await next();
    });
    registerDashboardRoutes(app, {
      service: new DashboardService({
        dashboards: new FakeDashboardRepo(),
        timeZones: new FakeFirmTimeZone(),
        fiscalYears: new FakeFiscalYearSource(),
        clock: new FakeClock(),
      }),
      authz: new AuthzService({ permissions: withDefaultRoles(TENANT) }),
    });
    const res = await app.request("/api/v1/dashboard/overview");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string; reason: string } };
    expect(body.error.reason).toBe("FEES_NOT_VISIBLE");
    expect(body.error.message).toBe(
      "These are the firm's revenue figures, and your login is not set to see fees. Ask somebody who can see fees.",
    );
    expect(body.error.message).not.toMatch(JARGON);
  });
});
