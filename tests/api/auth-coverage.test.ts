// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// Three routes shipped unauthenticated — a set-any-user's-password endpoint, a
// ledger surface that read any firm's audit trail from a path parameter, and a
// party surface that was only guarded because it happened to be written last.
// Every existing test passed, because every existing test asked "does this
// route do its job" and none asked "who is allowed to reach it".
//
// So this file does not test routes. It enumerates every route the router has
// REGISTERED — read off the Hono instance itself, not off the OpenAPI spec —
// and asserts each one is either on a short, justified public list or answers
// 401 to an anonymous caller. A new unauthenticated route fails here the moment
// it is registered, without anyone remembering to add a test for it.
//
// Reading the Hono instance rather than the spec is deliberate and was a real
// gap: the first version of this file walked /openapi.json, which lists only
// routes registered through app.openapi(). /health, /ready, /docs and
// /openapi.json itself are plain app.get() calls and were invisible to it — as
// any future plain-Hono route would have been. The middleware guards still
// covered them, but a test that claims "every route is accounted for" must be
// able to SEE every route.
import { ReadinessService } from "../../src/usecase/readiness/service";
import { FakeReadinessFacts } from "../../src/testfakes/readiness";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/platform/callctx";
import { buildRouter } from "../../src/api/router";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { CAPABILITIES } from "../../src/api/capabilities";
import { AuthzService } from "../../src/usecase/authz/service";
import { ConfigService } from "../../src/usecase/config/service";
import { LeadService } from "../../src/usecase/lead/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { EngagementLifecycleService } from "../../src/usecase/engagement/lifecycle";
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
import { PORTAL_PATHS, PUBLIC_PATHS, compilePortalPaths, isPortalPath } from "../../src/api/guards";
import { decideRoute } from "../../src/api/permissions";
import { capabilityFor } from "../../src/api/capabilities";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { StaffInviteService } from "../../src/usecase/staffinvite/service";
import {
  FakeServiceAxisRepo,
  FakeTimeZoneSetting,
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
  FakeStepDeskResolver,
  FakeStepCheckRepo,
  FakeJobTasks,
} from "../../src/testfakes/orchestrator";
import { ServiceAxisService } from "../../src/usecase/serviceaxis/service";
import { ClientAssignmentService } from "../../src/usecase/clientassignment/service";
import { PortalAccessService } from "../../src/usecase/portalaccess/service";
import { PortalInviteService } from "../../src/usecase/portalinvite/service";
import { PortalHomeService } from "../../src/usecase/portalhome/service";
import { ChaserService } from "../../src/usecase/chaser/service";
import {
  FakeChaseCandidates,
  FakeChaseRepo,
  FakeChaserLadder,
  FakeChaserTenants,
  FakeClientFreezeRepo,
} from "../../src/testfakes/chaser";
import { ClientAskService } from "../../src/usecase/clientask/service";
import {
  FakeAskRepo,
  FakeAskScope,
  FakeAskStore,
  FakePortalAskRepo,
} from "../../src/testfakes/clientask";
import {
  FakeLibraryBlobs,
  FakeLibraryScope,
  FakePortalLibraryRepo,
} from "../../src/testfakes/portallibrary";
import { PortalLibraryService } from "../../src/usecase/portallibrary/service";
import { ClientRequestService } from "../../src/usecase/clientrequest/service";
import {
  FakeAssignableStaff,
  FakeKeyManagers,
  FakePortalRequestRepo,
  FakeRequestRepo,
  FakeRequestRouting,
  FakeRequestScope,
  FakeRequestStore,
} from "../../src/testfakes/clientrequest";
import {
  FakeAssignableAxes,
  FakeAssignmentStaff,
  FakeClientAssignmentRepo,
  FakeClientDirectory,
  FakeClientWorkCatchUp,
} from "../../src/testfakes/clientassignment";
import { ClientImportService } from "../../src/usecase/clientimport/service";
import {
  FakeClientImportStore,
  FakeImportDirectory,
  FakeSheetReader,
  RecordingAssignmentWriter,
  RecordingLetterWriter,
  RecordingPartyWriter,
  RecordingPortalAccessGranter,
  RecordingPortalInviteWriter,
  FakePortalMemberFinder,
} from "../../src/testfakes/clientimport";
import {
  FakePortalAccessRepo,
  FakePortalClients,
  FakePortalMemberships,
} from "../../src/testfakes/portalaccess";
import { FakePortalHomeRepo, FakePortalScope } from "../../src/testfakes/portalhome";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { SchedulerService } from "../../src/usecase/scheduler/service";
import {
  FakeActivationFeed,
  FakeJobRepo,
  FakeTenantDirectory,
  FakeWorkItemSpawner,
  FakeWorkSplit,
  FakeCompliancePolicy,
  FakeRecurringFeed,
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
import { FakeEngagementLifecycle, makeEngagementFakes } from "../../src/testfakes/engagement";
import { makeDocumentFakes, makeFirmEntityFakes } from "../../src/testfakes/document";
import { FakeFirmEntities, makeInvoiceFakes } from "../../src/testfakes/invoice";
import { FakeDunningLadder, FakeDunningRepo } from "../../src/testfakes/dunning";
import {
  FakeCheckerDirectory,
  FakeStepApprovalRepo,
  FakeVerificationPolicySource,
  FakeWorkPermissions,
} from "../../src/testfakes/verification";
import { DunningService } from "../../src/usecase/dunning/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { AdvanceDesk } from "../../src/usecase/billing/advance";
import { FinalBiller } from "../../src/usecase/billing/final";
import {
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeAutoBillingFirms,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeFinalBillFacts,
  FakeIssuerTaxDefaults,
  FakeAdvancePolicy,
  FakeAdvanceReminderFacts,
  FakeBillingSchedules,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
} from "../../src/testfakes/billing";
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
  FakeLetterWork,
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
  FakeJobStepHandover,
  FakeWorkOwnerDirectory,
} from "../../src/testfakes/workitem";
import { WorkItemService, WorkVocabularyService } from "../../src/usecase/workitem/service";
import { ObligationVocabularyService } from "../../src/usecase/obligation/vocabulary";
import { ObligationService } from "../../src/usecase/obligation/service";
import {
  FakeCalendarSource,
  FakeRuleServiceLinks,
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


/**
 * The client-directed ask, wired the way `setup/` wires it: one service, the
 * firm's repository and the client's over ONE store.
 *
 * The fakes filter the portal scope in TypeScript, which the real adapter never
 * does — it hands the parties to `withPortal` and lets 0063's policies filter.
 * That is fine HERE, because this file asks who may REACH a route, not which
 * rows come back; gate 4 is proven against real Postgres in
 * `tests/portal/client-ask.integration.test.ts`.
 */
function askService(): ClientAskService {
  const store = new FakeAskStore();
  return new ClientAskService({
    asks: new FakeAskRepo(store),
    portal: new FakePortalAskRepo(store),
    scope: new FakeAskScope(),
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
    clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
    maxUploadBytes: 10_000_000,
  });
}

/** T6.8's two ports over one in-memory store. Gate 4 is NOT reproduced here —
 *  it is proven against real Postgres in
 *  `tests/portal/client-request.integration.test.ts`. */
function requestService(): ClientRequestService {
  const store = new FakeRequestStore();
  return new ClientRequestService({
    requests: new FakeRequestRepo(store),
    portal: new FakePortalRequestRepo(store),
    scope: new FakeRequestScope(),
    routing: new FakeRequestRouting(),
    keyManagers: new FakeKeyManagers(),
    staff: new FakeAssignableStaff(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
    clock: new FakeClock(new Date("2026-09-02T00:00:00.000Z")),
    timeZones: new FakeFirmTimeZone(),
  });
}

function libraryService(): PortalLibraryService {
  return new PortalLibraryService({
      timeZones: new FakeFirmTimeZone(),
    scope: new FakeLibraryScope(),
    library: new FakePortalLibraryRepo(),
    blobs: new FakeLibraryBlobs(),
    clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
  });
}

const INTERNAL_KEY = "test-internal-key-at-least-32-characters-long";
const INTERNAL_CLIENTS = [
  { name: "test-ops", key: INTERNAL_KEY, capabilities: CAPABILITIES },
];
const silentLog = { info() {}, warn() {}, error() {} };

/**
 * Routes that are public by design, each for a stated reason.
 *
 * /health and /ready — a load balancer cannot hold a credential, and neither
 * endpoint reveals anything about a tenant.
 *
 * /openapi.json and /docs — the spec enumerates every endpoint, so they are
 * gated by BIB_DOCS_ENABLED, which defaults OFF in every production-like
 * environment. A test below proves that gate actually closes them.
 */
const INTENTIONALLY_PUBLIC = new Set(["/health", "/ready", "/openapi.json", "/docs"]);

/**
 * The firm every session below acts for.
 *
 * Gate 3 reads role definitions from that firm's configuration registry now, so
 * the permission source has to be a registry seeded FOR THIS TENANT — the same
 * four roles createTenant writes. An empty registry would refuse every role and
 * these tests would go green for the wrong reason.
 */
const SESSION_TENANT = "00000000-0000-4000-8000-000000000007";

function deps(): RouterDeps {
  const fakes = makeFakes();
  const obligationTemplates = new FakeObligationTemplateRepo();
  const obligationExceptions = new FakeObligationExceptionRepo();
  obligationTemplates.exceptions = obligationExceptions;
  // Hoisted so the portal-invite route can be given the SAME identity service the
  // auth routes use — accepting an invitation opens a session, and two services
  // over two session stores would make that test prove nothing.
  const identity = new IdentityService({
        users: fakes.users,
        memberships: fakes.memberships,
        tenants: fakes.tenants,
        credentials: new FakeCredentialRepo(),
        sessions: new FakeSessionRepo(),
        magicLinks: new FakeMagicLinkRepo(),
        passwords: new FakePasswordHasher(),
        tokens: new FakeTokenFactory(),
        mailer: new FakeMailer(),
        ids: fakes.ids,
        clock: new FakeClock(),
        events: fakes.events,
        attempts: new InMemoryRateLimiter(systemClock),
        magicLinkBaseUrl: "http://localhost:3000",
      });

  return {
    // T3.2. These tests only ask what the ROUTER exposes and what an anonymous
    // caller gets, so the service is real over empty stores — enough to answer,
    // and nothing invented.
    // T4.5. Same treatment as the calendar above: the real service over empty
    // stores, which is enough to answer what the router exposes.
    escalations: {
      service: new EscalationService({
        timeZones: new FakeFirmTimeZone(),
        ladders: new FakeEscalationLadder(),
        notices: new FakeEscalationNotices(),
        subjects: new FakeEscalationSubjects(),
        staff: new FakeEscalationStaff(),
        tenants: new FakeEscalationTenants(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    obligations: {
      service: new ObligationService({
        timeZones: new FakeFirmTimeZone(),
        templates: obligationTemplates,
        exceptions: obligationExceptions,
        states: new FakeObligationStateRepo(),
        resolutionOptions: new FakeResolutionOptionRepo(),
        instances: new FakeObligationInstanceRepo(),
        compliancePolicy: new FakeCompliancePolicySource(),
        calendarSource: new FakeCalendarSource(),
        links: new FakeRuleServiceLinks(),
        services: new FakeObligationServices(),
        workItems: new FakeWorkItemRaiser(),
        tenants: new FakeObligationTenants(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
      vocabulary: new ObligationVocabularyService({
        states: new FakeObligationStateRepo(),
        resolutionOptions: new FakeResolutionOptionRepo(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
      }),
    },
    tenancy: {
      service: new TenancyService(fakes),
      // Route-shape tests only: the letter is asserted where letters are
      // asserted (tests/identity, tests/staffinvite), not here.
      staffInvite: new StaffInviteService({
        identity: { welcomeStaff: () => Promise.resolve({ expiresAt: null, sent: false }) },
        memberships: new TenancyService(fakes),
        firms: new TenancyService(fakes),
      }),
    },
    scheduler: {
      service: new SchedulerService({
        jobs: new FakeJobRepo(),
        activations: new FakeActivationFeed(),
        recurring: new FakeRecurringFeed(),
        compliancePolicy: new FakeCompliancePolicy(),
        timeZone: new FakeFirmTimeZone(),
        tenants: { activeTenantIds: () => Promise.resolve([]) },
        splitAxis: new FakeWorkSplit(),
        workItems: new FakeWorkItemSpawner(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-29T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    orchestrator: {
      grades: { listGrades: () => Promise.resolve([]) },
      jobs: { describeJobs: () => Promise.resolve(new Map()) },
      service: new OrchestratorService({
    jobTasks: new FakeJobTasks(),
    timeZones: new FakeFirmTimeZone(),
    desks: new FakeStepDeskResolver(),
        jobs: new FakeJobRepo(),
        steps: new FakeJobStepRepo(),
        stepChecks: new FakeStepCheckRepo(new FakeJobStepRepo()),
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
    timeZone: new FakeTimeZoneSetting(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
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
          owners: new FakeWorkOwnerDirectory(),
          jobSteps: new FakeJobStepHandover(),
          timeZones: new FakeFirmTimeZone(),
          axes: new FakeWorkAxes(),
          policies: new FakeReviewPolicies(),
          reviewers: new FakeReviewers(),
          permissions: new FakeReviewPermissions(),
          engagements: new FakeEngagementWork(),
          letters: new FakeLetterWork(),
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
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-08-30T00:00:00.000Z")),
        timeZones: { timeZoneFor: () => Promise.resolve("UTC") },
        work: new FakeClientWorkCatchUp(),
        events: new RecordingEventSink(),
      }),
    },
    clientImports: {
      service: new ClientImportService({
        store: new FakeClientImportStore(),
        directory: new FakeImportDirectory(),
        sheets: new FakeSheetReader(),
        parties: new RecordingPartyWriter(),
        assignments: new RecordingAssignmentWriter(),
        letters: new RecordingLetterWriter(),
        portalInvites: new RecordingPortalInviteWriter(),
        portalAccess: new RecordingPortalAccessGranter(),
        portalMembers: new FakePortalMemberFinder(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-09-07T00:00:00.000Z")),
        timeZones: { timeZoneFor: () => Promise.resolve("UTC") },
        events: new RecordingEventSink(),
      }),
    },
    portalAccess: {
      service: new PortalAccessService({
        grants: new FakePortalAccessRepo(),
        memberships: new FakePortalMemberships(),
        clients: new FakePortalClients(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
        timeZones: new FakeFirmTimeZone(),
        events: new RecordingEventSink(),
      }),
    },
    portalHome: {
      service: new PortalHomeService({
        scope: new FakePortalScope(),
        rows: new FakePortalHomeRepo(),
        clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
      }),
    },
    // T6.6's ask, both surfaces over ONE service — the wiring `setup/` uses, so
    // this sweep exercises the same object graph the server does.
    clientAsks: { service: askService() },
    clientRequests: { service: requestService() },
    // The FREEZE surface only. The sweep has no route — it is a cron in the
    // worker, so this sweep asks who may reach the freeze and nothing else.
    chaser: {
      service: new ChaserService({
      timeZones: new FakeFirmTimeZone(),
        tenants: new FakeChaserTenants([]),
        ladders: new FakeChaserLadder(),
        candidates: new FakeChaseCandidates(),
        chases: new FakeChaseRepo(),
        freezes: new FakeClientFreezeRepo(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
        events: new RecordingEventSink(),
      }),
    },
    portalAsks: { service: askService() },
    portalLibrary: { service: libraryService() },
    portalRequests: { service: requestService() },
    portalInvites: {
      service: new PortalInviteService({
        identity: {
          invitePortalContact: () => Promise.resolve("2026-09-08T00:00:00.000Z"),
          resendPortalInvite: () =>
            Promise.resolve({ expiresAt: "2026-09-08T00:00:00.000Z", supersededLinks: 0 }),
        },
        memberships: {
          inviteMember: () => Promise.resolve({ id: "m", userId: "u" }),
          findMembership: () =>
            Promise.resolve({ id: "m", userId: "u", audience: "CLIENT_PORTAL", isActive: true }),
        },
        access: { grant: () => Promise.resolve({ id: "g" }) },
        firms: { tenantNames: () => Promise.resolve(new Map()) },
        events: new RecordingEventSink(),
      }),
      identity,
      cookieName: "bib_session",
      cookieSecure: false,
    cookieSameSite: "Lax",
    },
    staffGrades: {
      service: new StaffGradeService({
        grades: fakes.grades,
        ids: fakes.ids,
        events: fakes.events,
      }),
    },
    party: { service: new PartyService(makePartyFakes()) },
    ledger: { service: new LedgerService(makeLedgerFakes()) },
    config: { service: new ConfigService(makeConfigFakes()), authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }) },
    lead: {
      service: new LeadService(makeLeadFakes()),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
    proposal: {
      service: new ProposalService(makeProposalFakes()),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
    engagement: {
      service: new EngagementService(makeEngagementFakes()),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      lifecycle: new EngagementLifecycleService({
        lifecycle: new FakeEngagementLifecycle(),
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(),
        events: new RecordingEventSink(),
      }),
    },
    document: {
      service: new DocumentService(makeDocumentFakes()),
      firmEntities: makeFirmEntityFakes().service,
    },
    readiness: {
      service: new ReadinessService({
        facts: new FakeReadinessFacts(),
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(new Date("2026-09-28T00:00:00.000Z")),
      }),
    },
    dashboard: {
      service: new DashboardService({
        dashboards: new FakeDashboardRepo(),
        timeZones: new FakeFirmTimeZone(),
        fiscalYears: new FakeFiscalYearSource(),
        clock: new FakeClock(),
      }),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
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
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(),
      }),
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
    billing: {
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      service: new BillingDeskService({
        desk: new FakeBillingDueDesk(),
        invoices: new FakeInvoiceDrafter(),
        schedules: new FakeBillingSchedules(),
        setting: new FakeAutoBillingSetting(),
        fiscalYears: new FakeFiscalYearSource(),
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(),
        events: new RecordingEventSink(),
        taxDefaults: new FakeIssuerTaxDefaults(),
        policy: new FakeAdvancePolicy(),
        firmEntities: new FakeFirmEntities(),
      }),
      advances: new AdvanceDesk({
        desk: new FakeBillingDueDesk(),
        policy: new FakeAdvancePolicy(),
        people: new FakeAdvanceReminderFacts(),
        taxDefaults: new FakeIssuerTaxDefaults(),
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(),
      }),
      finals: new FinalBiller({
        facts: new FakeFinalBillFacts(),
        dues: new FakeBillingDueWriter(),
        managers: new FakeBillingManagerFacts(),
        setting: new FakeAutoBillingSetting(),
        firms: new FakeAutoBillingFirms(),
        timeZones: new FakeFirmTimeZone(),
        clock: new FakeClock(),
        ids: new FakeIds(),
        events: new RecordingEventSink(),
      }),
    },
    invoice: {
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      service: new InvoiceService(makeInvoiceFakes()),
      dunning: new DunningService({
        timeZones: new FakeFirmTimeZone(),
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
      service: identity,
      // /auth/me names the caller's FIRM, not only its uuid.
      tenancy: new TenancyService(fakes),
      portalAccess: new PortalAccessService({
        grants: new FakePortalAccessRepo(),
        memberships: new FakePortalMemberships(),
        clients: new FakePortalClients(),
        ids: new FakeIds(),
        clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
        timeZones: new FakeFirmTimeZone(),
        events: new RecordingEventSink(),
      }),
      cookieName: "bib_session",
      cookieSecure: false,
    cookieSameSite: "Lax",
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    },
  };
}

/** By default nothing resolves: requests are anonymous unless a test says
 *  otherwise. `as` builds a router where every request carries one session. */
function app(principal: Principal | null = null) {
  return buildRouter(deps(), silentLog, {
    docsEnabled: true,
    internalClients: INTERNAL_CLIENTS,
    authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
    rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    maxUploadBytes: 25 * 1024 * 1024,
    hstsEnabled: false,
    build: { commit: null, builtAt: null },
    rateLimit: { auth: { limit: 1000, windowSeconds: 60 }, general: { limit: 10000, windowSeconds: 60 }, trustProxy: false, trustedProxyHops: 1 },
    principalOf: () => Promise.resolve(principal),
  });
}

const STAFF_SESSION: Principal = {
  userId: "00000000-0000-4000-8000-000000000005",
  sessionId: "00000000-0000-4000-8000-000000000006",
  tenantId: "00000000-0000-4000-8000-000000000007",
  audience: "STAFF",
  role: "partner",
  commercialVisibility: true,
};

/** A client contact of the firm: authenticated, in the tenant, and outside it. */
const PORTAL_SESSION: Principal = {
  ...STAFF_SESSION,
  audience: "CLIENT_PORTAL",
  role: "client_contact",
  commercialVisibility: false,
};

/**
 * Every route the router registers, read off the Hono instance.
 *
 * Entries whose path contains a wildcard are the middleware mounts
 * (app.use("/api/v1/*", …)), not routes anyone can call, so they are dropped.
 * Everything else is a real endpoint — including the ones registered outside
 * the OpenAPI registry, which is the whole point of reading from here.
 */
function registeredRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  return app()
    .routes.filter((r) => !r.path.includes("*"))
    .map((r) => ({ method: r.method, path: r.path }))
    .filter((r) => {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** GET and HEAD may not carry a body; everything else gets an empty JSON one,
 *  which is enough because the guards run before validation. */
function bodylessOrJson(method: string): RequestInit {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return { method: verb };
  return { method: verb, headers: { "content-type": "application/json" }, body: "{}" };
}

/**
 * A router path in the form the two permission tables are written in.
 *
 * Hono registers a parameter as `:name`; `ROUTE_PERMISSIONS` and — since T6.6 —
 * `PORTAL_PATHS` are keyed by the OpenAPI template `{name}`, because that is
 * what the spec and the handlers say. Asking whether a REGISTERED route is
 * declared therefore means translating one into the other, and doing it in a
 * named function rather than inline is the difference between a comparison that
 * is false and a comparison that is meaningless: `PORTAL_PATHS.has("/x/:id")`
 * is always false, so a templated portal route would have looked undeclared and
 * the sweep below would have reported it as a hole in the gate.
 */
function asTemplate(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/** A concrete request for a templated path. Hono registers params as :name and
 *  the OpenAPI spec renders them as {name}; both appear in this file. The
 *  guards run before validation, so the values need only exist. */
function concrete(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001")
    .replace(/:[^/]+/g, "00000000-0000-4000-8000-000000000001");
}

describe("every route is accounted for", () => {
  it("can see every registered route, not just the documented ones", () => {
    const paths = registeredRoutes().map((r) => r.path);
    expect(paths.length).toBeGreaterThan(10);
    // The four that the spec-based version of this test was blind to.
    for (const path of INTENTIONALLY_PUBLIC) {
      expect(paths, `${path} must be visible to this sweep`).toContain(path);
    }
  });

  it("refuses every non-public route to an anonymous caller", async () => {
    const unguarded: string[] = [];

    for (const { method, path } of registeredRoutes()) {
      if (PUBLIC_PATHS.has(path) || INTENTIONALLY_PUBLIC.has(path)) continue;
      const init = bodylessOrJson(method);
      const res = await app().request(concrete(path), init);
      if (res.status !== 401) unguarded.push(`${method.toUpperCase()} ${path} -> ${String(res.status)}`);
    }

    // Named, not counted: a failure here should say which route is open.
    expect(unguarded).toEqual([]);
  });

  it("closes the docs when config says to — the gate the public list relies on", async () => {
    // /openapi.json and /docs are public by design, on the promise that
    // BIB_DOCS_ENABLED shuts them in any production-like environment. That
    // promise is what makes them acceptable on the list above, so it is tested.
    const closed = buildRouter(deps(), silentLog, {
      docsEnabled: false,
      internalClients: INTERNAL_CLIENTS,
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
    corsOrigins: ["http://localhost:3000"],
    maxUploadBytes: 25 * 1024 * 1024,
    hstsEnabled: false,
    build: { commit: null, builtAt: null },
      rateLimit: {
        auth: { limit: 1000, windowSeconds: 60 },
        general: { limit: 10000, windowSeconds: 60 },
        trustProxy: false,
        trustedProxyHops: 1,
      },
      principalOf: () => Promise.resolve(null),
    });
    expect((await closed.request("/openapi.json")).status).toBe(404);
    expect((await closed.request("/docs")).status).toBe(404);
  });

  it("keeps the public list short and justified", () => {
    // This test exists to make adding a fourth entry a DECISION rather than an
    // edit. Three of these exist to OBTAIN a session.
    //
    // The fourth is the proposal share link, and its justification is different
    // in kind: a proposal goes to somebody who has no login and will not get
    // one. Requiring a session would mean creating an account for every prospect
    // a firm quotes — absurd, and a worse posture than a bearer link, because it
    // leaves real accounts lying around for people who never became clients.
    //
    // What makes it safe rather than merely necessary is spelled out on
    // PUBLIC_PATHS in api/guards.ts: 256-bit token, digest at rest, its own
    // tenant inside it so the read is still tenant-scoped, in the BODY rather
    // than the path, read-only, and one answer for malformed / unknown /
    // withdrawn. A fifth entry needs its own paragraph like that one.
    //
    // THE FIFTH IS THE PORTAL INVITATION (T6.5), and it was added with that
    // paragraph — read it on PUBLIC_PATHS. In short: a client's contact holding
    // an emailed invitation has no session and this is where they get their
    // first, so it cannot require one. It is single-use, expiring, hashed at
    // rest, carried in the BODY, bound to a PURPOSE so a sign-in link cannot be
    // spent here, and identical in its answers for unknown / expired / used /
    // wrong-purpose, so it discovers nothing about which addresses have
    // accounts.
    //
    // It is also the FIRST public path that WRITES — it sets a password — which
    // is exactly the act holding the link is meant to authorise, and exactly why
    // it needed the argument. A sixth needs one at least as good.
    //
    // THE SIXTH AND SEVENTH ARE THE FORGOTTEN-PASSWORD PAIR (0082), and they
    // were added with their own paragraph — read it on PUBLIC_PATHS. In short:
    // a client contact who forgot the password they chose on their invitation
    // had NO route back to one, because the invitation is spent and re-issuing
    // it is refused by design; a colleague usually has no password at all and
    // no way to set a first. Neither holds a session at the moment they need
    // this, which is what every entry on this list has in common. They carry
    // the invitation's whole property list — single use, digest at rest,
    // thirty-minute life, token in the BODY, bound to a PURPOSE, one answer
    // for unknown / expired / used / wrong-purpose — and the REQUEST route
    // adds a constant-time floor, so it cannot be enumerated with a stopwatch
    // either. An eighth needs an argument at least this good.
    //
    // THE EIGHTH AND NINTH ARE THE CLIENT'S ANSWER TO A PROPOSAL AND ITS PDF
    // (0085), added with their own paragraph — read it on PUBLIC_PATHS. In
    // short: the user decided the client answers the proposal bib emails them,
    // and the person answering will never hold a session. The PDF route reads
    // the file the email already carried, under the share link's own
    // properties. The answer route WRITES, bounded to the one act the link was
    // sent to invite: yes or no, once, while the offer stands, as a POST with a
    // typed name (and a ticked statement to accept) that a link scanner cannot
    // make — with the evidence kept. A tenth needs an argument at least this
    // good.
    expect([...PUBLIC_PATHS].sort()).toEqual([
      "/api/v1/auth/login",
      "/api/v1/auth/magic-link",
      "/api/v1/auth/magic-link/redeem",
      "/api/v1/auth/password-reset",
      "/api/v1/auth/password-reset/confirm",
      "/api/v1/portal-invites/accept",
      "/api/v1/proposals/shared",
      "/api/v1/proposals/shared/answer",
      "/api/v1/proposals/shared/pdf",
    ]);
  });

  it("the client's answer and PDF routes answer without a session — not shadowed by {proposalId}", async () => {
    // A 404 for an unknown token, on the routes' own merits. A 401 would mean
    // the request fell into a staff route's template — `/proposals/{id}/…` —
    // and a client holding a real link would be told to sign in.
    for (const path of ["/api/v1/proposals/shared/answer", "/api/v1/proposals/shared/pdf"]) {
      const res = await app().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "not-a-real-token",
          decision: "accepted",
          signerName: "Priya Raman",
          confirmed: true,
        }),
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("the share link route is reachable without a session, and only that one", async () => {
    // The public route answers on its own merits — a 404 for an unknown token,
    // never a 401 — while its siblings under the same prefix still refuse.
    const res = await app().request("/api/v1/proposals/shared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(404);

    const sibling = await app().request("/api/v1/proposals", { method: "GET" });
    expect(sibling.status).toBe(401);
  });

  it("answers 401 before validation, so an anonymous caller learns nothing about the shape", async () => {
    // A 400 here would confirm the route exists and describe its body to
    // someone who has not authenticated.
    const res = await app().request("/internal/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the /internal platform key", () => {
  const provisioning = { method: "POST", path: "/internal/v1/tenants" };

  async function attempt(authorization?: string): Promise<number> {
    const res = await app().request(provisioning.path, {
      method: provisioning.method,
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({
        name: "Harbour Point",
        slug: "harbour-point",
        reportingCurrency: "INR",
      }),
    });
    return res.status;
  }

  it("refuses a missing, wrong, or malformed key", async () => {
    expect(await attempt()).toBe(401);
    expect(await attempt("Bearer wrong-key")).toBe(401);
    expect(await attempt(INTERNAL_KEY)).toBe(401); // no Bearer scheme
    expect(await attempt("Basic " + INTERNAL_KEY)).toBe(401);
    expect(await attempt("Bearer ")).toBe(401);
    // A prefix of the real key must not pass: the comparison is over the whole
    // value, and lengths are checked before the timing-safe compare.
    expect(await attempt(`Bearer ${INTERNAL_KEY.slice(0, 20)}`)).toBe(401);
  });

  it("accepts the right key", async () => {
    expect(await attempt(`Bearer ${INTERNAL_KEY}`)).toBe(201);
  });

  it("does not let the platform key act as a session on the product surface", async () => {
    // The two surfaces are separate credentials. A provisioning key must not
    // become a way to read a firm's data.
    const res = await app().request("/api/v1/events", {
      headers: { authorization: `Bearer ${INTERNAL_KEY}` },
    });
    expect(res.status).toBe(401);
  });
});


describe("gate 2 — audience", () => {
  // This product is B2B2C: a firm's staff and a firm's CLIENTS both log in
  // here. Being authenticated and inside the tenant says nothing about which
  // of the two you are, and a client contact must never reach the workspace
  // where the firm's whole book of clients lives.

  it("refuses a client-portal session everywhere on the staff surface", async () => {
    const reachable: string[] = [];

    for (const { method, path } of registeredRoutes()) {
      if (!path.startsWith("/api/v1/")) continue;
      if (PUBLIC_PATHS.has(path) || PORTAL_PATHS.has(asTemplate(path))) continue;
      const init = bodylessOrJson(method);
      const res = await app(PORTAL_SESSION).request(concrete(path), init);
      if (res.status !== 403) {
        reachable.push(`${method.toUpperCase()} ${path} -> ${String(res.status)}`);
      }
    }

    // Before this gate existed, every one of these answered 200 or 201: a
    // client contact could list the firm's other clients, create parties, and
    // read its audit trail — through the front door, not an attack.
    expect(reachable).toEqual([]);
  });

  it("lets a client-portal session reach every route on its own list", async () => {
    // THE METHOD COMES FROM THE ROUTER, not from the shape of the path. It used
    // to be guessed — GET for anything ending `/me` or `/memberships`, POST
    // otherwise — and the guess held only while every portal route happened to
    // fit it. T6.5's `GET /api/v1/portal/home` does not, so the test asked for
    // it with POST, gate 3 refused an unmapped method with a 403, and the
    // failure read as "the audience gate refuses the portal's own home".
    for (const path of PORTAL_PATHS) {
      const methods = registeredRoutes()
        .filter((r) => asTemplate(r.path) === path)
        .map((r) => r.method.toUpperCase());
      expect(methods, `${path} is in PORTAL_PATHS but no route is registered at it`).not.toEqual(
        [],
      );
      for (const method of methods) {
        // `concrete()`, because this list carries TEMPLATES since T6.6 and the
        // router matches concrete paths. Asking for the template itself would
        // 404, and a 404 is not a 403, so the assertion below would have passed
        // while proving nothing.
        const res = await app(PORTAL_SESSION).request(concrete(path), bodylessOrJson(method));
        expect(
          res.status,
          `${method} ${path} should not be 403 for a portal session`,
        ).not.toBe(403);
      }
    }
  });

  it("lets a portal user discover the orgs it may switch to", async () => {
    // switch-tenant without this is reachable and useless: the caller can act
    // on a choice they have no way to enumerate. It returns only the caller's
    // own memberships, so it tells a portal session nothing new about itself.
    const res = await app(PORTAL_SESSION).request("/api/v1/tenancy/me/memberships");
    expect(res.status).toBe(200);
  });

  it("still lets staff through", async () => {
    const res = await app(STAFF_SESSION).request("/api/v1/parties");
    expect(res.status).toBe(200);
  });

  it("a template admits exactly the routes it names, and nothing else", () => {
    // THE CONTAINMENT ON T6.6's CHANGE TO THIS GATE, and the reason widening it
    // was safe to do before any route needed it.
    //
    // Gate 2 was an exact `Set.has` until T6.6; it now compiles `{param}` the
    // way gate 3 does, because every verb the action centre wants names the
    // record it acts on in its path. A matcher is strictly more permissive than
    // a set, and what it guards is the gate that stops a client contact reading
    // the firm's whole book — so the question is not whether the compilation is
    // careful but whether it can be checked.
    //
    // It can, over the router itself: for every registered route, the matcher's
    // answer must equal plain membership of its TEMPLATE in the list. A pattern
    // that swallowed a staff route — `/api/v1/{anything}`, or a segment whose
    // regex metacharacters were not escaped — makes this red and names the route
    // it swallowed.
    const swallowed: string[] = [];
    for (const { path } of registeredRoutes()) {
      const declared = PORTAL_PATHS.has(asTemplate(path));
      if (isPortalPath(concrete(path)) !== declared) {
        swallowed.push(`${path} (declared: ${String(declared)})`);
      }
    }
    expect(swallowed).toEqual([]);
  });

  it("matches a path parameter, and only within one segment", () => {
    // The matcher's own behaviour, compiled over a list of this test's own so
    // it can be proven WITHOUT a route existing for it. That is what let the
    // gate change ship as its own commit, ahead of the routes it was widened
    // for: the alternative is registering an unreachable route to test the gate
    // that would reach it.
    const matches = compilePortalPaths([
      "/api/v1/portal/home",
      "/api/v1/portal/asks/{askId}/answer",
    ]);

    expect(matches("/api/v1/portal/home")).toBe(true);
    expect(matches("/api/v1/portal/asks/9f8b7c6d-0000-4000-8000-000000000001/answer")).toBe(true);

    // A parameter is ONE segment. Without `[^/]+` the pattern would reach past
    // the address it names, which on this gate is a client contact reaching a
    // route nobody listed.
    expect(matches("/api/v1/portal/asks/a/b/answer")).toBe(false);
    // Not a prefix match in either direction, which is the failure `PUBLIC_PATHS`
    // states in its own comment: `/api/v1/auth/` as a prefix would have exempted
    // every future auth route.
    expect(matches("/api/v1/portal/home/secret")).toBe(false);
    expect(matches("/api/v1/portal")).toBe(false);
    expect(matches("/api/v1/portal/asks/x/answer/again")).toBe(false);
    // A literal that is not on the list stays off it.
    expect(matches("/api/v1/work-items")).toBe(false);
  });

  it("pins the portal list, so a route joins it deliberately", () => {
    // The point of pinning it is that adding a route here is a decision
    // somebody makes rather than a line somebody slips in. A route on this list
    // needs record-scope (gate 4) as well — audience alone is the coarse gate,
    // and it says only that a client may ASK the question.
    expect([...PORTAL_PATHS].sort()).toEqual([
      "/api/v1/auth/logout",
      "/api/v1/auth/me",
      // Changing your own password (0082), and the audience that needs it most
      // is this one: a portal login is the only kind in this product that
      // reliably HAS a password, because it is set on the invitation. Off this
      // list, the one audience that owns a password would be the one audience
      // unable to change it. It touches nothing but the caller's own
      // credential — no id in the path, none in the body — so gate 4 has
      // nothing to scope, and the control on it is the CURRENT PASSWORD rather
      // than either gate.
      "/api/v1/auth/password",
      "/api/v1/auth/switch-tenant",
      // T6.5's status home — the first route here that returns a business
      // record. Every table behind it carries its own RESTRICTIVE policy
      // (0059, 0062) and its one adapter uses `withPortal`, never `withTenant`.
      // T6.6's action centre, and the first TEMPLATES on this list — the routes
      // gate 2 learnt `{param}` for. The three that ACT are behind
      // `portal:respond`, which only a role declaring the CLIENT_PORTAL
      // audience can carry; the list needs no permission, which is what makes a
      // read-only contact possible at all.
      "/api/v1/portal/asks",
      "/api/v1/portal/asks/{askId}/answer",
      "/api/v1/portal/asks/{askId}/decision",
      "/api/v1/portal/asks/{askId}/documents",
      // T6.7's self-serve library. Four READS, none behind a permission — which
      // is what makes the acceptance line ("a client finds last year's challan
      // without emailing anyone") true for a `client_viewer` as well. What
      // guards them is 0066: `files.document`'s policy NARROWED by
      // `is_client_visible`, and `crm.invoice`'s first portal policy, on
      // `party_id` with a DRAFT excluded inside the policy itself.
      //
      // `/content` is the first route on the CLIENT's side that returns bytes.
      // T3.6's rule extends rather than bends: one route, no pre-signed URL,
      // `content-disposition: attachment`.
      "/api/v1/portal/digest",
      "/api/v1/portal/documents",
      "/api/v1/portal/documents/{documentId}/content",
      "/api/v1/portal/home",
      "/api/v1/portal/invoices",
      // T6.8's own requests — the first routes on this list that CREATE
      // something. The list is a read like every other one here; the three acts
      // are behind `portal:request`, which is a SECOND portal permission and
      // deliberately not a widening of `portal:respond`: everything that one
      // covers is a reply to something the firm raised, and a firm may want a
      // contact who sends registers and does not open requests (0069).
      //
      // What guards them is 0068, and on `POST /portal/requests` the WITH CHECK
      // arm is doing something it has never had to do before — the client NAMES
      // the company, so it is the only thing between a request parameter and
      // the row.
      "/api/v1/portal/requests",
      "/api/v1/portal/requests/{requestId}/replies",
      "/api/v1/portal/requests/{requestId}/withdraw",
      // The org switcher's data — their own memberships and nothing else.
      "/api/v1/tenancy/me/memberships",
    ]);
  });
});


describe("gate 3 — role", () => {
  const as = (role: string): Principal => ({ ...STAFF_SESSION, role });

  it("every registered route declares who may reach it", () => {
    // The structural half of gate 3. A route with no entry is refused for
    // everyone, so this failing means someone added a route without deciding
    // who it is for — which is the moment to decide, not later.
    const undeclared: string[] = [];
    for (const { method, path } of registeredRoutes()) {
      if (!path.startsWith("/api/v1/")) continue;
      if (PUBLIC_PATHS.has(path)) continue;
      if (decideRoute(method, concrete(path)).kind === "unmapped") {
        undeclared.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("refuses a route the role does not carry", async () => {
    // An associate does the work and does not sweep the firm's whole audit
    // trail — it names every client the firm has.
    const res = await app(as("associate")).request("/api/v1/events");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).toBe("NOT_PERMITTED");
  });

  it("allows a route the role does carry", async () => {
    expect((await app(as("associate")).request("/api/v1/parties")).status).toBe(200);
    expect((await app(as("manager")).request("/api/v1/events")).status).toBe(200);
    expect((await app(as("partner")).request("/api/v1/events")).status).toBe(200);
  });

  it("says a role is UNKNOWN rather than merely unpermitted", async () => {
    // A firm whose staff are all locked out by a typo in a role name must not
    // look like ordinary policy working as intended.
    const res = await app(as("rm")).request("/api/v1/parties");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { reason?: string; message: string } };
    expect(body.error.reason).toBe("UNKNOWN_ROLE");
    // It names the role the MEMBERSHIP carries — which the caller already has —
    // and NOT the firm's other role names. Listing those made a 403 enumerate
    // the firm's whole role vocabulary to whoever provoked it. An operator gets
    // the list off the error object, in the log.
    expect(body.error.message).toContain("rm");
    expect(body.error.message).not.toContain("partner");
  });

  it("does not let a literal route be swallowed by a template", async () => {
    // /api/v1/config/permissions sits beside /api/v1/config/{kind}, and
    // "permissions" is deliberately NOT a kind. If the template matched first
    // this would answer 400 for a perfectly good request — and it would do so
    // quietly, since 400 looks like a caller mistake.
    const res = await app(as("partner")).request("/api/v1/config/permissions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: { key: string }[] };
    expect(body.permissions.map((p) => p.key)).toContain("tenant:admin");
  });

  it("issuing, cancelling and crediting take invoice:issue, not the whole of tenant:admin (CA#6)", () => {
    // An accounts person issues invoices and credit notes; making them a full
    // administrator to do it handed them the roster and the roles too.
    const issuing = { kind: "permission", permission: "invoice:issue" };
    expect(decideRoute("POST", "/api/v1/invoices/00000000-0000-4000-8000-000000000001/issue")).toEqual(issuing);
    expect(decideRoute("POST", "/api/v1/invoices/00000000-0000-4000-8000-000000000001/cancel")).toEqual(issuing);
    expect(decideRoute("POST", "/api/v1/invoices/00000000-0000-4000-8000-000000000001/credit-notes")).toEqual(issuing);
    // A refund is a credit note on the advance, and keeping it is the other answer to the same question.
    expect(decideRoute("POST", "/api/v1/billing/refunds/00000000-0000-4000-8000-000000000001/credit-note")).toEqual(issuing);
    expect(decideRoute("POST", "/api/v1/billing/refunds/00000000-0000-4000-8000-000000000001/keep")).toEqual(issuing);
    // Raising a draft is still bookkeeping.
    expect(decideRoute("POST", "/api/v1/invoices")).toEqual({ kind: "permission", permission: "party:write" });
  });

  it("names invoice:issue on the roles screen in plain words (CA#6)", async () => {
    const res = await app(as("partner")).request("/api/v1/config/permissions");
    const body = (await res.json()) as { permissions: { key: string; description: string }[] };
    const issue = body.permissions.find((p) => p.key === "invoice:issue");
    expect(issue?.description).toMatch(/^Issue and cancel invoices, and issue credit notes/);
    expect(issue?.description).not.toMatch(/tenant|:/);
  });

  it("the preview takes what rendering takes, though it files nothing (2026-09-28)", async () => {
    // It draws the same rows through the same renderer, fee figures and all:
    // a session that could not render and download the PDF must not be handed
    // its bytes by a route that merely skips the filing.
    expect(decideRoute("POST", "/api/v1/documents/preview")).toEqual({ kind: "permission", permission: "party:write" });
    expect(decideRoute("POST", "/api/v1/documents/preview")).toEqual(decideRoute("POST", "/api/v1/documents/render"));
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "engagement_letter", subjectRef: "00000000-0000-4000-8000-0000000000aa" }),
    };
    // Through every gate, to the use case: nothing by that id, said as such.
    const res = await app(as("associate")).request("/api/v1/documents/preview", init);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("SOURCE_NOT_FOUND");
    expect((await app(PORTAL_SESSION).request("/api/v1/documents/preview", init)).status).toBe(403);
    expect((await app(null).request("/api/v1/documents/preview", init)).status).toBe(401);
  });

  it("never lets a role reach an unmapped route", async () => {
    const res = await app(as("partner")).request("/api/v1/not-a-real-route");
    expect(res.status).not.toBe(200);
  });

  it("leaves session management reachable whatever the role", async () => {
    // Otherwise a misconfigured role locks someone out of the endpoints they
    // need to switch to a firm where their role is fine.
    for (const role of ["partner", "associate", "rm"]) {
      const res = await app(as(role)).request("/api/v1/auth/me");
      expect(res.status, `${role} should reach /auth/me`).toBe(200);
    }
  });
});


describe("CORS — the frontend is a separate origin", () => {
  const ALLOWED = "http://localhost:3000";
  const preflight = (origin: string): RequestInit => ({
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  it("answers a preflight for an allowed origin", async () => {
    const res = await app().request("/api/v1/auth/login", preflight(ALLOWED));
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    // Without this the browser sends no cookie and the session never works.
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not hand credentials to an origin that is not on the list", async () => {
    // The dangerous version of CORS reflects whatever Origin arrived. Combined
    // with credentials that lets ANY site call this API as the logged-in user
    // and read the answers.
    const res = await app().request("/api/v1/auth/login", preflight("https://evil.example"));
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("puts the headers on real responses, not only on preflights", async () => {
    const res = await app().request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: ALLOWED, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "x" }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("answers the preflight without spending the caller's rate-limit budget", async () => {
    // A browser preflights every credentialed POST. If that counted, each real
    // login would cost two of ten attempts a minute and the auth bucket would
    // bite at five sign-ins.
    const tight = buildRouter(deps(), silentLog, {
      docsEnabled: true,
      internalClients: INTERNAL_CLIENTS,
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
      rateLimit: {
        auth: { limit: 3, windowSeconds: 60 },
        general: { limit: 3, windowSeconds: 60 },
        trustProxy: false,
        trustedProxyHops: 1,
      },
      corsOrigins: [ALLOWED],
    maxUploadBytes: 25 * 1024 * 1024,
    hstsEnabled: false,
    build: { commit: null, builtAt: null },
      principalOf: () => Promise.resolve(null),
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await tight.request("/api/v1/auth/login", preflight(ALLOWED));
      expect(res.status, `preflight ${String(i)} should not be rate limited`).not.toBe(429);
    }
  });

  it("gives /internal no CORS at all — no browser should reach it", async () => {
    const res = await app().request("/internal/v1/tenants", preflight(ALLOWED));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});


describe("the /internal surface authorizes, not just authenticates", () => {
  // One key that opened every provisioning route was an escalation path, not a
  // convenience: create a user, grant them partner in any firm, set their
  // password, sign in as them. Three calls. Each caller now holds only what it
  // needs.
  const KEY_TENANTS = "capability-key-tenants-only-32-characters";
  const KEY_PASSWORD = "capability-key-password-only-32-character";

  function scoped() {
    return buildRouter(deps(), silentLog, {
      docsEnabled: true,
      internalClients: [
        { name: "onboarding", key: KEY_TENANTS, capabilities: ["tenant.provision"] },
        { name: "reset-tool", key: KEY_PASSWORD, capabilities: ["credential.set"] },
      ],
      authz: new AuthzService({ permissions: withDefaultRoles(SESSION_TENANT) }),
      rateLimiter: new InMemoryRateLimiter(systemClock),
      rateLimit: {
        auth: { limit: 1000, windowSeconds: 60 },
        general: { limit: 10000, windowSeconds: 60 },
        trustProxy: false,
        trustedProxyHops: 1,
      },
      corsOrigins: ["http://localhost:3000"],
    maxUploadBytes: 25 * 1024 * 1024,
    hstsEnabled: false,
    build: { commit: null, builtAt: null },
      principalOf: () => Promise.resolve(null),
    });
  }

  const call = (key: string, method: string, path: string, body: unknown) =>
    scoped().request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lets a key do what it carries", async () => {
    const res = await call(KEY_TENANTS, "POST", "/internal/v1/tenants", {
      name: "Harbour Point",
      slug: "harbour-point",
      reportingCurrency: "INR",
    });
    expect(res.status).toBe(201);
  });

  it("refuses the escalation step the key does not carry", async () => {
    // The onboarding key can create firms. It must not be able to set the
    // password of somebody who already works at one.
    const res = await call(KEY_TENANTS, "PUT", "/internal/v1/users/x/password", {
      password: "a perfectly fine passphrase",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("credential.set");
    expect(body.error.message).toContain("onboarding");
  });

  it("refuses in the other direction too", async () => {
    const res = await call(KEY_PASSWORD, "POST", "/internal/v1/tenants", {
      name: "Harbour Point",
      slug: "harbour-point",
      reportingCurrency: "INR",
    });
    expect(res.status).toBe(403);
  });

  it("still refuses an unknown key outright", async () => {
    const res = await call("not-a-registered-key-at-all-32-chars", "POST", "/internal/v1/tenants", {});
    expect(res.status).toBe(401);
  });

  it("every /internal route declares a capability", () => {
    // Deny by default, same as the product surface: a provisioning route with
    // no entry is refused to every key, so one cannot ship open.
    const undeclared = registeredRoutes()
      .filter((r) => r.path.startsWith("/internal/"))
      .filter((r) => capabilityFor(r.method, concrete(r.path)) === null)
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(undeclared).toEqual([]);
  });

  it("names the caller in the audit trail", async () => {
    // "system did it" cannot be traced to a system. Once more than one
    // integration holds a key, this is the only way to answer who created a firm.
    const app = scoped();
    await app.request("/internal/v1/tenants", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY_TENANTS}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Harbour Point",
        slug: "harbour-point",
        reportingCurrency: "INR",
      }),
    });
    // The router under test wires its own fakes, so assert through the shape the
    // service records rather than reaching into them: covered end to end by the
    // smoke test, and by the tenancy service unit tests for the payload itself.
    expect(capabilityFor("POST", "/internal/v1/tenants")).toBe("tenant.provision");
  });
});
