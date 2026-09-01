// The API edge, exercised through the router with in-memory ports — no server,
// no database. Proves three things the OpenAPI adoption must hold:
//   1. the spec is generated from the routes (single source of truth),
//   2. a validation failure returns the SAME envelope as every other error,
//   3. the principal gate still answers 401 with that envelope.
import { FakeClock } from "../../src/testfakes/clock";
import { describe, expect, it } from "vitest";
import { buildRouter } from "../../src/api/router";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { CAPABILITIES } from "../../src/api/capabilities";
import { AuthzService } from "../../src/usecase/authz/service";
import { ConfigService } from "../../src/usecase/config/service";
import { LeadService } from "../../src/usecase/lead/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FileStoreService } from "../../src/usecase/filestore/service";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import {
  FakeBlobStore,
  FakeContentDigest,
  FakeDocumentStoreRepo,
  FakeRenderSource,
  FakeRenderer,
} from "../../src/testfakes/filestore";
import { systemClock } from "../../src/platform/clock";
import type { RouterDeps } from "../../src/api/router";
import type { PrincipalResolver } from "../../src/api/principal";
import { TenancyService } from "../../src/usecase/tenancy/service";
import {
  FakeServiceAxisRepo,
  FakeWorkSplitSetting,
} from "../../src/testfakes/serviceaxis";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeTierSource,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeTemplateSource,
} from "../../src/testfakes/orchestrator";
import { ServiceAxisService } from "../../src/usecase/serviceaxis/service";
import { ClientAssignmentService } from "../../src/usecase/clientassignment/service";
import {
  FakeAssignableAxes,
  FakeAssignmentStaff,
  FakeClientAssignmentRepo,
  FakeClientDirectory,
} from "../../src/testfakes/clientassignment";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { SchedulerService } from "../../src/usecase/scheduler/service";
import {
  FakeActivationFeed,
  FakeJobRepo,
  FakeTenantDirectory,
  FakeWorkItemSpawner,
  FakeWorkSplit,
} from "../../src/testfakes/scheduler";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { PartyService } from "../../src/usecase/party/service";
import { LedgerService } from "../../src/usecase/ledger/service";
import { IdentityService } from "../../src/usecase/identity/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import { makePartyFakes } from "../../src/testfakes/party";
import { makeLedgerFakes } from "../../src/testfakes/ledger";
import { makeConfigFakes, withDefaultRoles } from "../../src/testfakes/config";
import { makeLeadFakes } from "../../src/testfakes/lead";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { makeEngagementFakes } from "../../src/testfakes/engagement";
import { makeDocumentFakes } from "../../src/testfakes/document";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import { FakeDunningLadder, FakeDunningRepo } from "../../src/testfakes/dunning";
import {
  FakeCheckerDirectory,
  FakeStepApprovalRepo,
  FakeVerificationPolicySource,
  FakeWorkPermissions,
} from "../../src/testfakes/verification";
import { DunningService } from "../../src/usecase/dunning/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import type { PermissionSource } from "../../src/usecase/authz/ports";
import {
  FakeCredentialRepo,
  FakeMagicLinkRepo,
  FakeMailer,
  FakePasswordHasher,
  FakeSessionRepo,
  FakeTokenFactory,
} from "../../src/testfakes/identity";
import {
  FakeEngagementWork,
  FakeObligationCoverage,
  FakeObligationFiling,
  FakeReviewPermissions,
  FakeReviewPolicies,
  FakeReviewers,
  FakeSpocDirectory,
  FakeWorkAxes,
  FakeWorkItemApprovalRepo,
  FakeWorkItemClients,
  FakeWorkItemRepo,
  FakeWorkItemStaff,
  FakeWorkVocabularyRepo,
} from "../../src/testfakes/workitem";
import { WorkItemService, WorkVocabularyService } from "../../src/usecase/workitem/service";
import { ObligationVocabularyService } from "../../src/usecase/obligation/vocabulary";
import { ObligationService } from "../../src/usecase/obligation/service";
import {
  FakeCalendarSource,
  FakeObligationExceptionRepo,
  FakeObligationInstanceRepo,
  FakeObligationServices,
  FakeCompliancePolicySource,
  FakeObligationStateRepo,
  FakeResolutionOptionRepo,
  FakeObligationTemplateRepo,
  FakeObligationTenants,
  FakeWorkItemRaiser,
} from "../../src/testfakes/obligation";
import { EscalationService } from "../../src/usecase/escalation/service";
import {
  FakeEscalationLadder,
  FakeEscalationNotices,
  FakeEscalationStaff,
  FakeEscalationSubjects,
  FakeEscalationTenants,
} from "../../src/testfakes/escalation";

const silentLog = { info() {}, warn() {}, error() {} };

// The dev resolver, as the composition root registers it locally: an x-user-id
// header stands in for a session. Not authentication — see api/principal.ts.
const devPrincipal: PrincipalResolver = (getHeader) => {
  const userId = getHeader("x-user-id");
  return Promise.resolve(
    userId
      ? {
          userId,
          sessionId: DEV_SESSION,
          tenantId: null,
          audience: null,
          role: null,
          commercialVisibility: null,
        }
      : null,
  );
};

const DEV_SESSION = "00000000-0000-0000-0000-0000000000de";

/**
 * Gate 3's permission source for these tests.
 *
 * The dev principal above has NO tenant — it has not chosen an org — so this is
 * never actually consulted: every route it reaches here is either public or in
 * NO_PERMISSION_REQUIRED. It is a real seeded registry rather than an empty one
 * anyway, so that a test added later which does pick a tenant fails on what it
 * is testing rather than on a firm with no roles.
 */
const DEV_TENANT = "00000000-0000-0000-0000-0000000000fa";
const permissions: PermissionSource = withDefaultRoles(DEV_TENANT);

function identityService(): IdentityService {
  const fakes = makeFakes();
  return new IdentityService({
    users: fakes.users,
    memberships: fakes.memberships,
    credentials: new FakeCredentialRepo(),
    sessions: new FakeSessionRepo(),
    magicLinks: new FakeMagicLinkRepo(),
    passwords: new FakePasswordHasher(),
    tokens: new FakeTokenFactory(),
    mailer: new FakeMailer(),
    ids: fakes.ids,
    clock: new FakeClock(),
    magicLinkBaseUrl: "http://localhost:3000",
    events: fakes.events,
    attempts: new InMemoryRateLimiter(systemClock),
  });
}

function deps(): RouterDeps {
  const obligationTemplates = new FakeObligationTemplateRepo();
  const obligationExceptions = new FakeObligationExceptionRepo();
  obligationTemplates.exceptions = obligationExceptions;
  return {
    // T3.2. This test only asks what the SPEC documents, so the service is real
    // over empty stores — enough to answer, and nothing invented.
    // T4.5. Same treatment as the calendar above: the real service over empty
    // stores, which is enough to answer what the router exposes.
    escalations: {
      service: new EscalationService({
        ladders: new FakeEscalationLadder(),
        notices: new FakeEscalationNotices(),
        subjects: new FakeEscalationSubjects(),
        staff: new FakeEscalationStaff(),
        tenants: new FakeEscalationTenants(),
        ids: new FakeIds(),
        clock: new FakeClock(),
        events: new RecordingEventSink(),
      }),
    },
    obligations: {
      service: new ObligationService({
        templates: obligationTemplates,
        exceptions: obligationExceptions,
        states: new FakeObligationStateRepo(),
        resolutionOptions: new FakeResolutionOptionRepo(),
        instances: new FakeObligationInstanceRepo(),
        compliancePolicy: new FakeCompliancePolicySource(),
        calendarSource: new FakeCalendarSource(),
        services: new FakeObligationServices(),
        workItems: new FakeWorkItemRaiser(),
        tenants: new FakeObligationTenants(),
        ids: new FakeIds(),
        clock: { now: () => new Date("2026-08-30T00:00:00.000Z") },
        events: new RecordingEventSink(),
      }),
      vocabulary: new ObligationVocabularyService({
        states: new FakeObligationStateRepo(),
        resolutionOptions: new FakeResolutionOptionRepo(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
      }),
    },
    tenancy: { service: new TenancyService(makeFakes()) },
    staffGrades: { service: new StaffGradeService(makeFakes()) },
    orchestrator: {
      service: new OrchestratorService({
        jobs: new FakeJobRepo(),
        steps: new FakeJobStepRepo(),
        templates: new FakeTemplateSource(),
        subjects: new FakeJobSubjectSource(),
        agents: new FakeAgentRuntime(),
        tiers: new FakeTierSource(),
        runs: new FakeAgentRunRepo(),
        checks: new FakeStepApprovalRepo(),
        policies: new FakeVerificationPolicySource(),
        checkers: new FakeCheckerDirectory(),
        permissions: new FakeWorkPermissions(),
        tenants: { activeTenantIds: () => Promise.resolve([]) },
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-29T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    serviceAxes: {
      service: new ServiceAxisService({
        axes: new FakeServiceAxisRepo(),
        split: new FakeWorkSplitSetting(),
        ids: makeFakes().ids,
        events: makeFakes().events,
      }),
    },
    // T3.1. Every port is a fake, because these two tests are about the ROUTER —
    // that every registered route is gated and that the spec renders — and not
    // about what a work item does.
    workItems: (() => {
      const vocabulary = new FakeWorkVocabularyRepo();
      const items = new FakeWorkItemRepo();
      const approvals = new FakeWorkItemApprovalRepo();
      items.vocabulary = vocabulary;
      items.approvals = approvals;
      approvals.items = items;
      return {
        service: new WorkItemService({
          items,
          approvals,
          vocabulary,
          clients: new FakeWorkItemClients(),
          staff: new FakeWorkItemStaff(),
          spocs: new FakeSpocDirectory(),
          axes: new FakeWorkAxes(),
          policies: new FakeReviewPolicies(),
          reviewers: new FakeReviewers(),
          permissions: new FakeReviewPermissions(),
          engagements: new FakeEngagementWork(),
          obligations: new FakeObligationCoverage(),
          filings: new FakeObligationFiling(),
          ids: new FakeIds(),
          clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
          events: new RecordingEventSink(),
        }),
        vocabulary: new WorkVocabularyService({
          vocabulary,
          ids: new FakeIds(),
          events: new RecordingEventSink(),
        }),
      };
    })(),
    clientAssignments: {
      service: new ClientAssignmentService({
        assignments: new FakeClientAssignmentRepo(),
        clients: new FakeClientDirectory(),
        staff: new FakeAssignmentStaff(),
        axes: new FakeAssignableAxes(),
        ids: makeFakes().ids,
        clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
        events: makeFakes().events,
      }),
    },
    scheduler: {
      service: new SchedulerService({
        jobs: new FakeJobRepo(),
        activations: new FakeActivationFeed(),
        tenants: { activeTenantIds: () => Promise.resolve([]) },
        splitAxis: new FakeWorkSplit(),
        workItems: new FakeWorkItemSpawner(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-29T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
    config: { service: new ConfigService(makeConfigFakes()) },
    lead: { service: new LeadService(makeLeadFakes()) },
    proposal: {
      service: new ProposalService(makeProposalFakes()),
      authz: new AuthzService({ permissions }),
    },
    engagement: {
      service: new EngagementService(makeEngagementFakes()),
      authz: new AuthzService({ permissions }),
    },
    document: { service: new DocumentService(makeDocumentFakes()) },
    dashboard: {
      service: new DashboardService({ dashboards: new FakeDashboardRepo() }),
      authz: new AuthzService({ permissions: permissions }),
    },
    filestore: {
      service: new FileStoreService({
        documents: new FakeDocumentStoreRepo(),
        blobs: new FakeBlobStore(),
        digest: new FakeContentDigest(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
        maxUploadBytes: 25 * 1024 * 1024,
        renderer: new FakeRenderer(),
        renderSource: new FakeRenderSource(),
      }),
    },
    invoice: {
      authz: new AuthzService({ permissions }),
      service: new InvoiceService(makeInvoiceFakes()),
      dunning: new DunningService({
        dunning: new FakeDunningRepo(),
        ladders: new FakeDunningLadder(),
        invoices: makeInvoiceFakes().invoices,
        tenants: new FakeTenantDirectory(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
        events: new RecordingEventSink(),
      }),
    },
    auth: {
      service: identityService(),
      authz: new AuthzService({ permissions }),
      // /auth/me names the caller's FIRM, not only its uuid.
      tenancy: new TenancyService(makeFakes()),
      cookieName: "bib_session",
      cookieSecure: false,
    },
  };
}

const INTERNAL_KEY = "test-internal-key-at-least-32-characters-long";
const INTERNAL_CLIENTS = [
  { name: "test-ops", key: INTERNAL_KEY, capabilities: CAPABILITIES },
];
const internal = { authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" };

function app() {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalClients: INTERNAL_CLIENTS,
    // A firm with the roles every real firm is created with. Gate 3 reads the
    // registry now, so a permission source with an empty one would refuse
    // everything and these tests would pass for the wrong reason.
    authz: new AuthzService({ permissions }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false },
    principalOf: devPrincipal,
  });
}

describe("OpenAPI spec", () => {
  it("is generated from the registered routes", async () => {
    const res = await app().request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    // Tenancy, party and ledger routes are all mounted; assert a representative set.
    expect(paths).toContain("/internal/v1/tenants");
    expect(paths).toContain("/api/v1/tenancy/me/memberships");
    expect(paths).toContain("/api/v1/events");
    expect(paths).toContain("/api/v1/parties/organizations");
    expect(paths).toContain("/api/v1/parties/{partyId}");
    expect(paths).toContain("/api/v1/auth/login");
  });

  it("is not served when docs are disabled", async () => {
    const res = await buildRouter(deps(), silentLog, {
      docsEnabled: false,
      internalClients: INTERNAL_CLIENTS,
    authz: new AuthzService({ permissions }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false },
      principalOf: devPrincipal,
    }).request("/openapi.json");
    expect(res.status).toBe(404);
  });
});

describe("the spec and the wire agree", () => {
  it("documents exactly the fields /auth/me actually sends", async () => {
    // This is the failure that motivated the test. `role` and
    // `commercialVisibility` were on the wire for six tasks while the spec
    // described four fields, because the handler forwarded the domain Principal
    // and zod-openapi documents a response without validating it. In a codebase
    // whose entire frontend client is generated from this spec, an undocumented
    // field is one the browser cannot see and a removed one breaks at runtime.
    const spec = (await (await app().request("/openapi.json")).json()) as {
      components: { schemas: { Principal: { properties: Record<string, unknown> } } };
    };
    const documented = Object.keys(spec.components.schemas.Principal.properties).sort();

    const me = await app().request("/api/v1/auth/me", {
      headers: { "x-user-id": "00000000-0000-0000-0000-000000000001" },
    });
    expect(me.status).toBe(200);
    const sent = Object.keys((await me.json()) as Record<string, unknown>).sort();

    expect(sent).toEqual(documented);
  });

  it("documents exactly the fields a created tenant sends", async () => {
    // The second route to hold this line, and the reason the handler maps field
    // by field instead of returning the domain object: `reportingCurrency` was
    // added to the aggregate and would have reached the wire undocumented, which
    // in a frontend generated from this spec means invisible.
    const spec = (await (await app().request("/openapi.json")).json()) as {
      components: { schemas: { Tenant: { properties: Record<string, unknown> } } };
    };
    const documented = Object.keys(spec.components.schemas.Tenant.properties).sort();

    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({ name: "Acme", slug: "acme-books", reportingCurrency: "AED" }),
    });
    expect(res.status).toBe(201);
    const sent = Object.keys((await res.json()) as Record<string, unknown>).sort();

    expect(sent).toEqual(documented);
  });

  it("documents exactly the fields a lead sends", async () => {
    // The third route to hold this line, and G3.1 is why it is here: `title` and
    // `lostReason` were added to the aggregate, and a field on the wire that the
    // spec does not describe is one the generated frontend client cannot see —
    // so a titled lead would have rendered as an untitled one and nothing would
    // have failed. zod-openapi documents a response without validating it, so
    // only a comparison like this notices.
    const spec = (await (await app().request("/openapi.json")).json()) as {
      components: { schemas: { Lead: { properties: Record<string, unknown> } } };
    };
    const documented = Object.keys(spec.components.schemas.Lead.properties).sort();

    // A real lead from the real service, not a literal — a literal would just
    // be this list written twice.
    const fakes = makeLeadFakes();
    const captured = await new LeadService(fakes).capture(
      {
        tenantId: "00000000-0000-4000-8000-0000000000c1",
        source: "inbound",
        title: "FY27 statutory audit",
        kind: "organization",
        name: "Meridian Textiles Private Limited",
        identifiers: [{ type: "email", value: "priya@meridian.example" }],
      },
      { type: "human", id: "00000000-0000-4000-8000-0000000000d1" },
    );

    expect(Object.keys(captured.lead).sort()).toEqual(documented);
  });

  it("tells the caller what it may do, so a screen need not guess", async () => {
    const me = await app().request("/api/v1/auth/me", {
      headers: { "x-user-id": "00000000-0000-0000-0000-000000000001" },
    });
    const body = (await me.json()) as { permissions: string[]; tenantId: string | null };
    // This session has not chosen an org, so it holds no membership and
    // therefore carries nothing — present and empty, not absent.
    expect(body.tenantId).toBeNull();
    expect(body.permissions).toEqual([]);
  });
});

describe("validation", () => {
  it("maps a schema failure to the shared error envelope", async () => {
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({ name: "Acme" }), // slug missing
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.reason).toContain("slug");
  });
});

describe("happy path", () => {
  it("creates a tenant and echoes it", async () => {
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({
        name: "Harbour Point",
        slug: "harbour-point",
        reportingCurrency: "INR",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; status: string };
    expect(body.slug).toBe("harbour-point");
    expect(body.status).toBe("active");
  });

  it("refuses to create a firm that has not said what its books are in", async () => {
    // No default on the wire, in the service, or on the column. A firm given a
    // reporting currency it never chose is the failure this whole design is
    // arranged against: every FX rate stored later is struck against it, so it
    // cannot be corrected afterwards without invalidating them all.
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: JSON.stringify({ name: "Harbour Point", slug: "harbour-point" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.reason).toContain("reportingCurrency");
  });
});

describe("principal gate", () => {
  it("answers 401 with the envelope when no principal is present", async () => {
    const res = await app().request("/api/v1/tenancy/me/memberships");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns memberships for a present principal", async () => {
    const res = await app().request("/api/v1/tenancy/me/memberships", {
      headers: { "x-user-id": "00000000-0000-0000-0000-000000000001" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberships: unknown[] };
    expect(Array.isArray(body.memberships)).toBe(true);
  });
});


describe("transport-level faults", () => {
  it("answers a malformed JSON body 400, not 500", async () => {
    // Hono raises HTTPException before any handler runs. Falling through to
    // INTERNAL blamed the server for the client's bad request AND logged every
    // one as an unhandled error, which is how a real 500 gets lost.
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: internal,
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("answers an unknown /internal path 403, not 404", async () => {
    // The capability guard runs before routing, so it cannot tell a route that
    // forgot its entry from a path that never existed — and answers "no" to
    // both. Losing the accurate 404 is the price of deny-by-default, and the
    // right side of that trade: no provisioning route can be open by omission.
    const res = await app().request("/internal/v1/nope", { headers: internal });
    expect(res.status).toBe(403);
  });

  it("still answers an unknown path outside /internal with a 404", async () => {
    expect((await app().request("/no/such/thing")).status).toBe(404);
  });
});
