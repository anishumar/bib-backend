// B48 (audit 2026-10-03): handlers that forwarded a domain object, or spread
// one, instead of naming each field. zod-openapi documents a response without
// validating it, so a forwarded object ships whatever it holds: a field added
// to the use case's object reaches the browser undocumented, and the
// generated client never learns it exists (CLAUDE.md, and the two bugs that
// rule was written from). Every field matched its schema on the day of the
// audit; this is the drift.
//
// Each registrar here answers from a STUB use case whose objects carry one
// field no schema names, `leak`. A handler that maps field by field never
// sends it.
import { describe, expect, it } from "vitest";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import type { AppEnv } from "../../src/api/guards";
import { registerPartyRoutes } from "../../src/api/handler/party";
import { registerTenancyRoutes } from "../../src/api/handler/tenancy";
import { registerPortalInviteRoutes } from "../../src/api/handler/portalinvite";
import type { PartyService } from "../../src/usecase/party/service";
import type { TenancyService } from "../../src/usecase/tenancy/service";
import type { StaffInviteService } from "../../src/usecase/staffinvite/service";
import type { PortalInviteService } from "../../src/usecase/portalinvite/service";
import type { IdentityService } from "../../src/usecase/identity/service";

const TENANT = "00000000-0000-4000-8000-0000000009a1";
const USER = "00000000-0000-4000-8000-0000000009a2";
const PARTY = "00000000-0000-4000-8000-0000000009a3";
const OTHER = "00000000-0000-4000-8000-0000000009a4";
const ID = "00000000-0000-4000-8000-0000000009a5";
const LEAK = { leak: "a field no schema names" };

function app(register: (app: OpenAPIHono<AppEnv>) => void) {
  const a = createOpenAPIApp();
  a.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  a.use("*", async (c, next) => {
    c.set("principal", {
      userId: USER,
      sessionId: "00000000-0000-4000-8000-0000000009a6",
      tenantId: TENANT,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
    c.set("internalClient", null);
    await next();
  });
  register(a);
  return async (method: string, path: string, body?: unknown) => {
    const res = await a.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  };
}

const ORG = { partyId: PARTY, tenantId: TENANT, legalName: "Cobalt Foods", tradeName: null, industry: null, website: null, isFirmSelf: false, ...LEAK };
const PERSON = { partyId: PARTY, tenantId: TENANT, fullName: "Meera Menon", nationality: null, dateOfBirth: null, ...LEAK };
const ENTITY = { partyId: PARTY, tenantId: TENANT, jurisdiction: "IN", entityType: "private_limited", incorporatedOn: null, financialYearEnd: null, registeredAddress: null, status: "active", ...LEAK };
const IDENTIFIER = { id: ID, tenantId: TENANT, partyId: PARTY, type: "pan", value: "AABCC1234F", jurisdiction: "IN", isPrimary: true, validFrom: "2026-01-01", validTo: null, voidedAt: null, ...LEAK };
const RELATIONSHIP = { id: ID, tenantId: TENANT, fromPartyId: PARTY, toPartyId: OTHER, type: "director_of", validFrom: "2026-01-01", validTo: null, attributes: {}, ...LEAK };
const PARTY_ROW = { id: PARTY, tenantId: TENANT, kind: "organization", displayName: "Cobalt Foods", archivedAt: null, isOwnCompany: false, ...LEAK };

describe("party.ts answers field by field", () => {
  const service = {
    createOrganization: () => Promise.resolve(ORG),
    createPerson: () => Promise.resolve(PERSON),
    registerLegalEntity: () => Promise.resolve(ENTITY),
    correctLegalEntity: () => Promise.resolve(ENTITY),
    endIdentifier: () => Promise.resolve(IDENTIFIER),
    voidIdentifier: () => Promise.resolve(IDENTIFIER),
    addIdentifier: () => Promise.resolve(IDENTIFIER),
    relationshipTypes: () =>
      Promise.resolve([{ code: "director_of", label: "a director of", inverseLabel: "has director", category: "governance", ...LEAK }]),
    addRelationship: () => Promise.resolve(RELATIONSHIP),
    endRelationship: () => Promise.resolve(RELATIONSHIP),
    partyProfile: () =>
      Promise.resolve({
        party: PARTY_ROW,
        organization: ORG,
        person: null,
        legalEntities: [ENTITY],
        identifiers: [IDENTIFIER],
        relationships: [
          { relationship: RELATIONSHIP, counterparty: { id: OTHER, kind: "person", displayName: "Meera", ...LEAK }, direction: "outgoing", ...LEAK },
        ],
        ...LEAK,
      }),
  } as unknown as PartyService;
  const call = app((a) => {
    registerPartyRoutes(a, { service });
  });

  const routes: [string, string, unknown?][] = [
    ["POST", "/api/v1/parties/organizations", { legalName: "Cobalt Foods" }],
    ["POST", "/api/v1/parties/persons", { fullName: "Meera Menon" }],
    ["POST", `/api/v1/parties/organizations/${PARTY}/legal-entities`, { jurisdiction: "IN", entityType: "private_limited" }],
    ["PATCH", `/api/v1/parties/${PARTY}/legal-entity`, { jurisdiction: "IN" }],
    ["POST", `/api/v1/parties/${PARTY}/identifiers/${ID}/end`, { validTo: "2026-10-01" }],
    ["POST", `/api/v1/parties/${PARTY}/identifiers/${ID}/void`],
    ["POST", `/api/v1/parties/${PARTY}/identifiers`, { type: "pan", value: "AABCC1234F", validFrom: "2026-01-01" }],
    ["GET", "/api/v1/parties/relationship-types"],
    ["POST", "/api/v1/parties/relationships", { fromPartyId: PARTY, toPartyId: OTHER, type: "director_of", validFrom: "2026-01-01" }],
    ["POST", `/api/v1/parties/relationships/${ID}/end`, { validTo: "2026-10-01" }],
    ["GET", `/api/v1/parties/${PARTY}`],
  ];
  for (const [method, path, body] of routes) {
    it(`${method} ${path.replace(/[0-9a-f-]{36}/g, "{id}")}`, async () => {
      const r = await call(method, path, body);
      expect(r.status, r.text).toBeLessThan(300);
      expect(r.text).not.toContain("leak");
    });
  }
});

const MEMBERSHIP = {
  id: ID, tenantId: TENANT, userId: USER, audience: "STAFF", role: "partner", commercialVisibility: true,
  gradeId: null, reportsToUserId: null, isActive: true, ...LEAK,
};

describe("tenancy.ts answers field by field", () => {
  const service = {
    ensureUser: () => Promise.resolve({ id: USER, email: "a@b.in", displayName: null, status: "active", ...LEAK }),
    addMember: () => Promise.resolve(MEMBERSHIP),
    listMembers: () =>
      Promise.resolve([
        { membership: MEMBERSHIP, email: "a@b.in", displayName: null, grade: { id: ID, code: "p", name: "Partner", rank: 9, isActive: true, ...LEAK }, ...LEAK },
      ]),
    changeMemberRole: () => Promise.resolve(MEMBERSHIP),
    setMemberActive: () => Promise.resolve(MEMBERSHIP),
    changeMemberGrade: () => Promise.resolve(MEMBERSHIP),
    setReportsTo: () => Promise.resolve(MEMBERSHIP),
    firmSignatory: () => Promise.resolve({ userId: USER, displayName: "Sid", title: "Director", ...LEAK }),
    resolveAccess: () => Promise.resolve([MEMBERSHIP]),
    tenantNames: () => Promise.resolve(new Map([[TENANT, "10x Global"]])),
  } as unknown as TenancyService;
  const staffInvite = {
    add: () => Promise.resolve({ membership: MEMBERSHIP, invitationSent: true, invitationExpiresAt: null, ...LEAK }),
  } as unknown as StaffInviteService;
  const call = app((a) => {
    registerTenancyRoutes(a, { service, staffInvite });
  });

  const routes: [string, string, unknown?][] = [
    ["POST", "/internal/v1/users", { email: "a@b.in" }],
    ["POST", "/internal/v1/memberships", { tenantId: TENANT, userId: USER, audience: "STAFF", role: "partner" }],
    ["GET", "/api/v1/tenancy/members"],
    ["POST", "/api/v1/tenancy/members", { email: "a@b.in", audience: "STAFF", role: "partner" }],
    ["PUT", `/api/v1/tenancy/members/${ID}/role`, { role: "manager" }],
    ["PUT", `/api/v1/tenancy/members/${ID}/active`, { isActive: false }],
    ["PUT", `/api/v1/tenancy/members/${ID}/grade`, { gradeId: null }],
    ["PUT", `/api/v1/tenancy/members/${ID}/reports-to`, { reportsToUserId: null }],
    ["GET", "/api/v1/tenancy/firm-signatory"],
    ["GET", "/api/v1/tenancy/me/memberships"],
  ];
  for (const [method, path, body] of routes) {
    it(`${method} ${path.replace(/[0-9a-f-]{36}/g, "{id}")}`, async () => {
      const r = await call(method, path, body);
      expect(r.status, r.text).toBeLessThan(300);
      expect(r.text).not.toContain("leak");
    });
  }
});

describe("portalinvite.ts answers field by field", () => {
  const invitation = { membershipId: ID, userId: USER, grantId: ID, expiresAt: "2026-10-10T00:00:00.000Z", ...LEAK };
  const service = {
    invite: () => Promise.resolve(invitation),
    resend: () => Promise.resolve(invitation),
  } as unknown as PortalInviteService;
  const call = app((a) => {
    registerPortalInviteRoutes(a, {
      service,
      identity: {} as unknown as IdentityService,
      cookieName: "bib_session",
      cookieSecure: false,
      cookieSameSite: "Lax",
    });
  });

  it("POST /portal-invites", async () => {
    const r = await call("POST", "/api/v1/portal-invites", { email: "meera@cobalt.in", clientPartyId: PARTY });
    expect(r.status, r.text).toBeLessThan(300);
    expect(r.text).not.toContain("leak");
  });

  it("POST /portal-invites/{id}/resend", async () => {
    const r = await call("POST", `/api/v1/portal-invites/${ID}/resend`);
    expect(r.status, r.text).toBeLessThan(300);
    expect(r.text).not.toContain("leak");
  });
});
