// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../api/guards";
import type { Config } from "../config/config";
import { isProductionLike } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import { systemClock, systemSleeper } from "../platform/clock";
import { InMemoryRateLimiter } from "../platform/ratelimit";
import type { Logger } from "../platform/log";
import { PostgresTenantRepository } from "../infrastructure/postgres/tenant-repository";
import { PostgresUserRepository } from "../infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { PostgresPartyRepository } from "../infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import {
  PostgresCredentialRepository,
  PostgresMagicLinkRepository,
  PostgresSessionRepository,
} from "../infrastructure/postgres/identity-repository";
import { ScryptPasswordHasher } from "../infrastructure/crypto/scrypt-hasher";
import { RandomTokenFactory, Sha256ContentHasher } from "../infrastructure/crypto/random-tokens";
import { mailerFor } from "./mailer";
import { PostgresFirmTimeZone } from "../infrastructure/postgres/firm-timezone-repository";

import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import { PostgresStaffGradeRepository } from "../infrastructure/postgres/staff-grade-repository";
import { PostgresClientAssignmentRepository } from "../infrastructure/postgres/client-assignment-repository";
import {
  PostgresClientImportDirectory,
  PostgresClientImportRepository,
} from "../infrastructure/postgres/client-import-repository";
import { NodeSheetReader } from "../infrastructure/sheet/grid-reader";
import { PostgresPortalAccessRepository } from "../infrastructure/postgres/portal-access-repository";
import { PostgresPortalHomeRepository } from "../infrastructure/postgres/portal-home-repository";
import { PostgresPortalLibraryRepository } from "../infrastructure/postgres/portal-library-repository";
import { PostgresClientAskRepository } from "../infrastructure/postgres/client-ask-repository";
import { PostgresPortalAskRepository } from "../infrastructure/postgres/portal-ask-repository";
import { PostgresClientRequestRepository } from "../infrastructure/postgres/client-request-repository";
import { PostgresPortalRequestRepository } from "../infrastructure/postgres/portal-request-repository";
import { PostgresRequestRoutingRepository } from "../infrastructure/postgres/request-routing-repository";
import {
  PostgresChaseCandidates,
  PostgresChaseRepository,
  PostgresChaserLadder,
  PostgresChaserTenants,
  PostgresClientFreezeRepository,
} from "../infrastructure/postgres/chaser-repository";
import { PostgresWorkVocabularyRepository } from "../infrastructure/postgres/work-vocabulary-repository";
import { PostgresWorkItemRepository } from "../infrastructure/postgres/work-item-repository";
import { PostgresWorkItemApprovalRepository } from "../infrastructure/postgres/work-item-approval-repository";
import {
  PostgresObligationExceptionRepository,
  PostgresObligationStateRepository,
  PostgresResolutionOptionRepository,
  PostgresObligationTemplateRepository,
} from "../infrastructure/postgres/obligation-rule-repository";
import {
  PostgresCalendarSource,
  PostgresObligationInstanceRepository,
} from "../infrastructure/postgres/obligation-instance-repository";
import { PostgresRuleServiceLinkRepository } from "../infrastructure/postgres/obligation-link-repository";
import { PostgresObligationCoverage } from "../infrastructure/postgres/obligation-coverage";
import {
  PostgresEngagementWorkSource,
  PostgresLetterWorkSource,
} from "../infrastructure/postgres/engagement-work-source";
import {
  PostgresServiceAxisRepository,
  PostgresWorkSplitSetting,
} from "../infrastructure/postgres/service-axis-repository";
import {
  PostgresJobRepository,
  PostgresTenantDirectory,
} from "../infrastructure/postgres/job-repository";
import { PostgresLeadRepository } from "../infrastructure/postgres/lead-repository";
import {
  FirstMatchAssignment,
  PostgresRoundRobinAssignment,
  PostgresTerritoryAssignment,
  PostgresTerritoryRules,
} from "../infrastructure/postgres/lead-assignment";
import { PostgresProposalRepository } from "../infrastructure/postgres/proposal-repository";
import { PostgresEngagementRepository } from "../infrastructure/postgres/engagement-repository";
import { PostgresEngagementLifecycle } from "../infrastructure/postgres/engagement-lifecycle";
import { PostgresDocumentRepository } from "../infrastructure/postgres/document-repository";
import { PostgresFirmEntityRepository } from "../infrastructure/postgres/firm-entity-repository";
import { PostgresInvoiceRepository } from "../infrastructure/postgres/invoice-repository";
import { PostgresDocumentStoreRepository } from "../infrastructure/postgres/document-store-repository";
import { Sha256ByteDigest } from "../infrastructure/storage/filesystem-blob-store";
import { FileStoreService } from "../usecase/filestore/service";
import { PdfLibRenderer } from "../infrastructure/render/pdf-renderer";
import { PostgresRenderSource } from "../infrastructure/postgres/render-source";
import { PostgresDashboardRepository } from "../infrastructure/postgres/dashboard-repository";
import { DashboardService } from "../usecase/dashboard/service";
import { PostgresReadinessFacts } from "../infrastructure/postgres/readiness-facts";
import { ReadinessService } from "../usecase/readiness/service";
import { InvoiceService } from "../usecase/invoice/service";
import { BillingDeskService } from "../usecase/billing/desk";
import { GoLiveScheduler } from "../usecase/billing/golive";
import { AdvanceBiller, AdvanceDesk } from "../usecase/billing/advance";
import {
  PostgresAdvancePolicy,
  PostgresAdvanceReminderFacts,
  PostgresIssuerTaxDefaults,
} from "../infrastructure/postgres/advance-reminders";
import { FinalBiller } from "../usecase/billing/final";
import {
  PostgresAutoBillingSetting,
  PostgresBillingDueDesk,
  PostgresBillingSchedules,
} from "../infrastructure/postgres/billing-desk";
import {
  PostgresAutoBillingFirms,
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../infrastructure/postgres/billing-repository";
import { PostgresAdvanceBillFacts, PostgresFinalBillFacts } from "../infrastructure/postgres/billing-facts";
import { DunningService } from "../usecase/dunning/service";
import { EscalationService } from "../usecase/escalation/service";
import {
  PostgresDunningLadder,
  PostgresDunningRepository,
} from "../infrastructure/postgres/dunning-repository";
import {
  PostgresEscalationLadder,
  PostgresEscalationNoticeRepository,
  PostgresEscalationSubjects,
} from "../infrastructure/postgres/escalation-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../infrastructure/postgres/block-repository";
import { AttestedSigner } from "../infrastructure/esign/attested-signer";
import { PostgresSignatureRequestRepository } from "../infrastructure/postgres/signature-request-repository";
import { esignFor } from "./esign";
import { blobStoreFor } from "./blobs";
import { signedCopyFiler } from "./signed-copies";
import { proposalLinks, proposalPdfs } from "./proposal-delivery";
import { invoiceIssuedCopies } from "./invoice-copies";
import type { LetterPdf } from "../usecase/engagement/ports";
import { TenancyService } from "../usecase/tenancy/service";
import { PartyService } from "../usecase/party/service";
import { LedgerService } from "../usecase/ledger/service";
import { AuthzService } from "../usecase/authz/service";
import { ConfigService } from "../usecase/config/service";
import { StaffGradeService } from "../usecase/staffgrade/service";
import { ServiceAxisService } from "../usecase/serviceaxis/service";
import { ClientAssignmentService } from "../usecase/clientassignment/service";
import type { CaughtUpWork } from "../usecase/clientassignment/ports";
import { ClientImportService } from "../usecase/clientimport/service";
import type { PortalMemberFinder } from "../usecase/clientimport/ports";
import { PortalAccessService } from "../usecase/portalaccess/service";
import { PortalInviteService } from "../usecase/portalinvite/service";
import { StaffInviteService } from "../usecase/staffinvite/service";
import { PortalHomeService } from "../usecase/portalhome/service";
import { PortalLibraryService } from "../usecase/portallibrary/service";
import { ClientRequestService } from "../usecase/clientrequest/service";
import { ClientAskService } from "../usecase/clientask/service";
import { ChaserService } from "../usecase/chaser/service";
import { WorkItemService, WorkVocabularyService } from "../usecase/workitem/service";
import { ObligationService } from "../usecase/obligation/service";
import { ObligationVocabularyService } from "../usecase/obligation/vocabulary";
import { SchedulerService } from "../usecase/scheduler/service";
import { OrchestratorService } from "../usecase/orchestrator/service";
import { PostgresJobStepRepository } from "../infrastructure/postgres/job-step-repository";
import { PostgresJobDeskResolver } from "../infrastructure/postgres/job-desk-resolver";
import { PostgresWorkOwnerDirectory } from "../infrastructure/postgres/work-owner";
import { PostgresJobSubjectRepository } from "../infrastructure/postgres/job-subject-repository";
import { NoAgentsBuiltYet } from "../infrastructure/agent/no-agents";
import { PostgresStepApprovalRepository } from "../infrastructure/postgres/step-approval-repository";
import { PostgresStepCheckRepository } from "../infrastructure/postgres/step-check-repository";
import { PostgresAgentRunRepository } from "../infrastructure/postgres/agent-run-repository";
import { LeadService } from "../usecase/lead/service";
import { ProposalService } from "../usecase/proposal/service";
import { EngagementService } from "../usecase/engagement/service";
import { EngagementLifecycleService } from "../usecase/engagement/lifecycle";
import { DocumentService } from "../usecase/document/service";
import { FirmEntityService } from "../usecase/document/firm-entities";
import { IdentityService } from "../usecase/identity/service";
import type { TenancyDeps } from "../api/handler/tenancy";
import { devHeaderResolver, firstOf, sessionResolver } from "../api/principal";
import { buildRouter } from "../api/router";

export interface Wired {
  readonly app: OpenAPIHono<AppEnv>;
  readonly pools: Pools;
  /** Fail-closed readiness: throws if the tenant wall is not intact. */
  assertReady(): Promise<void>;
}

export function wire(cfg: Config, log: Logger): Wired {
  const pools = createPools(cfg.db);

  // The ledger is constructed BEFORE the services that will write to it: every
  // module that records events receives this one instance through its own
  // EventSink port, so there is exactly one implementation of the event
  // contract in the process and no service can reach the table around it.
  const ledger = new LedgerService({
    events: new PostgresEventStore(pools.app),
    ids: systemIds,
  });

  // The users and memberships repositories serve two use cases: tenancy
  // creates them, identity reads them. Identity states its needs as its own
  // narrow ports (UserDirectory / MembershipDirectory), which these satisfy —
  // so one adapter, two consumers, and neither use case knows about the other.
  const users = new PostgresUserRepository(pools.app);
  const memberships = new PostgresMembershipRepository(pools.app);

  // ONE adapter over the config tables, serving TWO ports. The registry uses it
  // as its repository; gate 3 uses it as its PermissionSource, because "what
  // does the role `partner` carry here" is a config read like any other. Two
  // adapters over the same two tables would eventually disagree about what
  // "published" means, and one of them would be answering an authorization
  // question.
  const configRepository = new PostgresConfigRepository(pools.app);

  // ONE adapter over the ladder, serving TWO ports, on the same reasoning as
  // the config adapter above. The staff-grade use case holds it as its
  // repository; tenancy holds it as its GradeDirectory, because "does this firm
  // have this rung, and does it still promote through it" is a ladder read like
  // any other. Two adapters would eventually disagree about what "retired"
  // means, and one of them would be answering an assignment question.
  const staffGradeRepository = new PostgresStaffGradeRepository(pools.app);

  const staffGrades = new StaffGradeService({
    grades: staffGradeRepository,
    ids: systemIds,
    events: ledger,
  });

  // ONE adapter over `tenancy.service_axis`, serving FOUR ports: the
  // service-axis use case's own, the config registry's `AxisDirectory`, G3.2's
  // `AssignableAxisDirectory` and T3.1's `WorkAxisDirectory`. One adapter
  // because it is one table — two would eventually disagree about which Depts a
  // firm has, and the registry would accept a code the picker never offered.
  //
  // Constructed HERE, above the scheduler, because the work-item service below
  // needs it and the scheduler needs the work-item service.
  const serviceAxisRepository = new PostgresServiceAxisRepository(pools.app);

  // ONE adapter over `core.party`, serving the party use case, the
  // client-assignment use case and now T3.1 — each holding it as its own narrow
  // directory. It must refuse work raised against a party that is not there or
  // that the firm has archived, and only this adapter can say.
  const partyRepository = new PostgresPartyRepository(pools.app);

  // THE FIRM'S OWN WORDS FOR WORK (T3.1), and the work itself.
  //
  // Two services over one adapter, because they have two audiences and two
  // permissions: the vocabulary is an admin screen changed rarely, the board is
  // everybody's screen all day. `workVocabularyRepository` is shared, so a board
  // and its admin screen can never disagree about what a state means.
  const workVocabularyRepository = new PostgresWorkVocabularyRepository(pools.app);
  const workVocabulary = new WorkVocabularyService({
    vocabulary: workVocabularyRepository,
    ids: systemIds,
    events: ledger,
  });

  // Seven seams, and six of them are adapters something else already holds —
  // which is the point rather than a coincidence:
  //
  //   · `clients`     — the party adapter. One notion of what a party is and
  //     whether it is archived; a second would eventually disagree about
  //     whether work may be raised against an archived client.
  //   · `staff`       — the SAME membership adapter the lead and
  //     client-assignment use cases hold: `tenancy.user_account` is GLOBAL, so
  //     nothing but the roster can say a person works HERE.
  //   · `spocs`       — G3.2's own adapter, asked ONE question: who does this
  //     client talk to about FRC work, on this day. Two adapters over
  //     `crm.client_assignment` would eventually disagree about what "in force"
  //     means, and a filing would land on somebody whose handover finished last
  //     week.
  //   · `axes`        — a FOURTH port on the service-axis adapter, and the one
  //     that makes T3.1's acceptance line work: a pinned service body carries
  //     `module: "FRC"` — the CODE — so the chain from a service to a SPOC has
  //     to pass through a lookup by code.
  //   · `policies` /
  //     `reviewers` /
  //     `permissions` — the SAME three T2.9 gave the orchestrator. One answer to
  //     "who checks whose work" at this firm, whether the work is a process step
  //     or a task; two would drift the first time a firm changed its policy.
  const workItems: WorkItemService = new WorkItemService({
    items: new PostgresWorkItemRepository(pools.app),
    approvals: new PostgresWorkItemApprovalRepository(pools.app),
    vocabulary: workVocabularyRepository,
    clients: partyRepository,
    staff: memberships,
    spocs: new PostgresClientAssignmentRepository(pools.app),
    // THE OWNER RULE'S LATER RUNGS (2026-09-27): the client's Key Manager,
    // then the person who signs for the firm, when there is no SPOC.
    owners: new PostgresWorkOwnerDirectory(pools.app),
    // The firm's day, which a spawned task's owner is looked up on: the same
    // day the job's steps ask on (2026-09-27).
    timeZones: new PostgresFirmTimeZone(pools.app),
    // A task's unheld steps go with it when it is handed on. The same kind of
    // cycle as `filings`, broken the same way: the orchestrator is built
    // further down, and nothing calls this before a request.
    jobSteps: {
      adoptUnheldSteps: (tenantId, jobId, from, to, actor): Promise<number> =>
        orchestrator.adoptUnheldSteps(tenantId, jobId, from, to, actor),
    },
    axes: serviceAxisRepository,
    policies: configRepository,
    reviewers: memberships,
    permissions: configRepository,
    engagements: new PostgresEngagementWorkSource(pools.app),
    // The routing preview on an unsigned letter's Send (T6.17): its lines read
    // the way `engagements` reads the signed letter's, so the warning names the
    // desk the work will really land on.
    letters: new PostgresLetterWorkSource(pools.app),
    // T3.2. Where a compliance rule already covers an engagement, the CALENDAR
    // puts a task on somebody's desk once per period and this must not add a
    // thirteenth that can never be completed. Derived rather than configured —
    // see `ObligationCoverage` — so a firm with no rules keeps exactly the
    // behaviour it had before the calendar existed.
    obligations: new PostgresObligationCoverage(pools.app),
    // THE RETURN LEG, AND THE ONE CYCLE IN THIS FILE — broken here, which is
    // where a cycle belongs. The calendar raises a task (`workItems` below is
    // passed to it as `WorkItemRaiser`); finishing that task files the
    // obligation. Two use cases naming each other cannot both be constructed
    // first, so this closure defers the lookup to CALL time — by which point
    // `obligations` has long been assigned, since nothing calls it before a
    // request. Neither use case imports the other; only this line knows both.
    filings: {
      reconcileFiling: (tenantId, workItemId, discharged, actor): Promise<void> =>
        obligations.reconcileFiling(tenantId, workItemId, discharged, actor),
    },
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE COMPLIANCE CALENDAR (T3.2). The API holds it for its READS and its rule
  // writes; the SWEEP that materialises the calendar runs in the worker, over
  // the same service, so there is one definition of what a rule produces.
  //
  // `workItems` is passed as the `WorkItemRaiser` port rather than as the
  // service itself: the boundary between "what the law asks of the entity" and
  // "what a person must do about it" is the one idea this whole module rests
  // on, and it is visible here in the type as well as in the comments.
  const obligationTemplates = new PostgresObligationTemplateRepository(pools.app);
  const obligations: ObligationService = new ObligationService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    templates: obligationTemplates,
    exceptions: new PostgresObligationExceptionRepository(pools.app),
    states: new PostgresObligationStateRepository(pools.app),
    resolutionOptions: new PostgresResolutionOptionRepository(pools.app),
    instances: new PostgresObligationInstanceRepository(pools.app),
    // Which catalogue services owe which filing (T6.16). The catalogue is the
    // one writer; the generator, the coverage read and the library read it.
    links: new PostgresRuleServiceLinkRepository(pools.app),
    // The firm's go-live floor, read from the config registry it is published
    // in. `configRepository` already implements two other ports for this
    // module's neighbours; this is the third, and it stays a PORT so the
    // compliance use case never imports the registry's own service.
    compliancePolicy: configRepository,
    calendarSource: new PostgresCalendarSource(pools.app),
    services: configRepository,
    workItems,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // The firm's own words for that calendar (T3.3). Its own service rather than
  // more methods on `ObligationService`, which is already the generator, the
  // raiser, the sweep and the decision queue — and it reads the SAME flag
  // helpers, so a screen and a rule cannot disagree about what a flag means.
  const obligationVocabulary = new ObligationVocabularyService({
    states: new PostgresObligationStateRepository(pools.app),
    resolutionOptions: new PostgresResolutionOptionRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });

  // The API holds the scheduler READ-ONLY: the same service the worker runs, so
  // there is one definition of what "runnable" means, but this process never
  // sweeps and never advances a job. Writing is the worker's and the
  // orchestrator's; a route that could finish a job would be a way to mark work
  // done without doing it.
  const jobs = new PostgresJobRepository(pools.app);
  const scheduler = new SchedulerService({
    jobs,
    activations: jobs,
    // T6.13 — the same adapter in its third role: which engagements recur.
    recurring: jobs,
    // The floor and the financial year, off the compliance policy — the
    // config adapter in yet another role, and the same instance the calendar
    // reads, so a sweep and a screen cannot disagree about the firm's year.
    compliancePolicy: configRepository,
    timeZone: new PostgresFirmTimeZone(pools.app),
    tenants: new PostgresTenantDirectory(pools.app),
    // ONE adapter satisfying two ports declared in two use cases — the shape
    // AxisDirectory and RoleDirectory already have. `usecase/serviceaxis` owns
    // the write side of this setting; the scheduler reads it, and neither
    // imports the other.
    splitAxis: new PostgresWorkSplitSetting(pools.app),
    // T3.1's seam. A spawned job puts TASKS on desks, and the scheduler does not
    // know what an assignee or a due date is — it hands the engagements it just
    // linked to the work-item service and moves on. Wired here even though this
    // process never sweeps, because the API and the worker construct the same
    // service and a scheduler that behaved differently in the two would be the
    // worst kind of bug to find.
    workItems,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  const serviceAxes = new ServiceAxisService({
    axes: serviceAxisRepository,
    split: new PostgresWorkSplitSetting(pools.app),
    timeZone: new PostgresFirmTimeZone(pools.app),
    ids: systemIds,
    events: ledger,
  });

  // The API holds the orchestrator for the two things a PERSON does: reading a
  // job's steps, and saying one is finished. It never sweeps — that is the
  // worker's, and a route that could advance work nobody performed would be a
  // way to mark a filing done without filing it.
  //
  // The same `NoAgentsBuiltYet` as the worker, and for the same reason: when a
  // person completes a step the service asks whether an agent exists for it, and
  // an API that answered differently from the worker would let somebody tick off
  // work a machine was already doing.
  // THE ADVANCE AND THE FINAL BILL (0320). A one-time service's final bill is
  // written when its job finishes; the advance bill when a letter is signed.
  const finalBills = new FinalBiller({
    facts: new PostgresFinalBillFacts(pools.app),
    dues: new PostgresBillingDueWriter(pools.app),
    managers: new PostgresBillingManagerFacts(pools.app),
    setting: new PostgresAutoBillingSetting(pools.app),
    firms: new PostgresAutoBillingFirms(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
    ids: systemIds,
    events: ledger,
  });
  // 0322: the advance holds no work. Signing writes the bill and drafts its
  // invoice through the billing desk (composed further down: a closure, reached
  // only on a request, by which time it exists).
  const advanceBills = new AdvanceBiller({
    facts: new PostgresAdvanceBillFacts(pools.app),
    dues: new PostgresBillingDueWriter(pools.app),
    managers: new PostgresBillingManagerFacts(pools.app),
    ids: systemIds,
    events: ledger,
    drafter: {
      draftAdvance: (tenantId, dueId, actor) => billing.draftAdvance(tenantId, dueId, actor),
    },
  });
  const advancePolicy = new PostgresAdvancePolicy(pools.app);
  const taxDefaults = new PostgresIssuerTaxDefaults(pools.app);
  // Where each advance stands and who is reminded (0322): My day and the
  // Advances list read it.
  const advanceDesk = new AdvanceDesk({
    desk: new PostgresBillingDueDesk(pools.app),
    policy: advancePolicy,
    people: new PostgresAdvanceReminderFacts(pools.app),
    taxDefaults,
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
  });

  const orchestrator = new OrchestratorService({
    // A finished job may make a one-time service's final bill due (0320).
    jobDone: finalBills,
    // A cancelled job closes its tasks through the work-item module (V2.4).
    jobTasks: workItems,
    timeZones: new PostgresFirmTimeZone(pools.app),
    jobs,
    steps: new PostgresJobStepRepository(pools.app),
    templates: configRepository,
    subjects: new PostgresJobSubjectRepository(pools.app),
    agents: new NoAgentsBuiltYet(),
    // The guardrail's two seams (T2.8). Both are wired even though nothing runs
    // through them yet, and that is the order the board asks for — the rails
    // exist before anything is on them, so the first real agent is a change to
    // ONE line above and not a conversation about what it may do while somebody
    // waits for it to ship.
    tiers: configRepository,
    runs: new PostgresAgentRunRepository(pools.app),
    // T2.9's three seams. `checkers` and `permissions` are the SAME two adapters
    // the roster and the authz guard already use — one notion of who works here
    // and one of what a role carries, because eligibility to check somebody's
    // work must not be able to disagree with either.
    checks: new PostgresStepApprovalRepository(pools.app),
    // The ticks on a step's sub-steps and a check's review points (T6.15). In
    // BOTH processes: the worker's walk reads them too, because a step with a
    // ticked sub-step is work recorded and is never withdrawn (0304's rule).
    stepChecks: new PostgresStepCheckRepository(pools.app),
    policies: configRepository,
    checkers: memberships,
    desks: new PostgresJobDeskResolver(pools.app),
    permissions: configRepository,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  const config = new ConfigService({
    registry: configRepository,
    // The registry can see that a role carries tenant:admin; only the roster
    // knows whether anybody has that role. Both halves are needed to refuse a
    // publish that would leave the firm with no administrator.
    holders: memberships,
    // A `service` body names a Dept and a delivery team by CODE, and once the
    // firm has such a list the code has to be on it — see `checkServiceAxes`.
    axes: serviceAxisRepository,
    ids: systemIds,
    events: ledger,
  });

  // ONE adapter over the document tables, serving THREE ports: the reference
  // counter, the firm's issuing-entity rule, and — for provisioning — the seed
  // that gives a new firm its own entity. The three are one adapter because
  // they are one pair of tables, and two adapters over them would eventually
  // disagree about what the fallback is.
  const documentRepository = new PostgresDocumentRepository(pools.app);

  // WHO issues the firm's documents, and what they are called. Both documents
  // ask this and neither of them is a quoting question, so it is answered once
  // here rather than twice in two modules that would drift.
  // The prose blocks (G1.7) get their own two adapters rather than a fourth and
  // fifth `implements` on the one above. Not tidiness: both ports declare
  // `list`, `find`, `add` and `edit`, and one class cannot carry three meanings
  // of `list` — the collision is the design saying these are separate concerns.
  const documents = new DocumentService({
    preferences: documentRepository,
    refs: documentRepository,
    standardBlocks: new PostgresStandardBlockRepository(pools.app),
    blocks: new PostgresDocumentBlockRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });

  // INVOICING (T3.4). Its repository is the only one in this codebase whose
  // `create` both allocates and writes — a gapless series cannot be handed to a
  // caller, because a failure between the two spends the number. See the file.
  const invoiceRepository = new PostgresInvoiceRepository(pools.app);

  // THE DOCUMENT STORE (T3.6). The blob adapter is chosen here and nowhere
  // else, which is what makes replacing the filesystem stub with an object
  // store a one-line change in this file. `validateServer` has already refused
  // to boot a production-like environment on the stub by the time this runs.
  // The blob store is named once and handed to BOTH the document store and the
  // render source — the source needs it to fetch a firm's logo, and giving it
  // its own instance would mean two objects believing they own the same files.
  const blobs = blobStoreFor(cfg);
  // pdf-lib, chosen for DETERMINISM rather than fidelity: a rendered
  // document's content hash is evidence, and a headless browser's bytes are
  // not stable across versions. See the renderer's own header. ONE instance of
  // each, held by the document store and by the envelope a letter is sent in,
  // so the PDF a client signs in DocuSign is the PDF the firm can download.
  const renderer = new PdfLibRenderer();
  const renderSource = new PostgresRenderSource(pools.app, (i) => blobs.get(i));
  // ONE instance, because engagement letters read brand assets through it too
  // (0081) and two would be two answers to "which signature is in force".
  const documentStore = new PostgresDocumentStoreRepository(pools.app);
  const fileStore = new FileStoreService({
    documents: documentStore,
    blobs,
    digest: new Sha256ByteDigest(),
    ids: systemIds,
    events: ledger,
    maxUploadBytes: cfg.storage.maxUploadBytes,
    renderer,
    renderSource,
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
  });

  const invoices = new InvoiceService({
    // "Today" on an invoice nobody dated is the firm's day, or the caller's.
    timeZones: new PostgresFirmTimeZone(pools.app),
    // WHO an invoice names (F-10-1): the issuer is one of the firm's own
    // companies and the billed party is not. `DocumentService` owns that list
    // (it is the issuing-entity rule's), so the "Charged by" picker and this
    // refusal are one definition. Names and archiving come from the party read.
    firmEntities: documents,
    parties: partyRepository,
    invoices: invoiceRepository,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
    // Its PDF, filed as it is issued: the copy of record (2026-09-29). Built
    // after the document store for this.
    issuedCopies: invoiceIssuedCopies(fileStore, log),
    // A manager a person names must be on the roster today (T4).
    staff: memberships,
  });

  // BILL DUES (0318): what a manager does with a bill the sweep found owed.
  // Raising goes through the InvoiceService above, so every invoice rule (the
  // issuer, the client, the currency, the gapless number) applies exactly as
  // to an invoice raised by hand.
  const billing = new BillingDeskService({
    desk: new PostgresBillingDueDesk(pools.app),
    invoices: {
      raise: (input, actor) => invoices.raise(input, actor),
      addLine: (input) => invoices.addLine(input),
      find: (tenantId, invoiceId) => invoiceRepository.find(tenantId, invoiceId),
      issueCreditNote: (input, actor) => invoices.issueCreditNote(input, actor),
    },
    schedules: new PostgresBillingSchedules(pools.app),
    setting: new PostgresAutoBillingSetting(pools.app),
    fiscalYears: configRepository,
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
    events: ledger,
    // 0322: the automatic advance draft's rate, and how advances are chased.
    taxDefaults,
    policy: advancePolicy,
    // A default tax rate is for one of the firm's own companies.
    firmEntities: documents,
  });

  // THE LEADERSHIP FIGURES (T3.7). No writes: every number is derived from
  // rows at read time. The clock and the firm's timezone are for the one
  // figure cut by month (billing by company, Wave 5): which month the FIRM is
  // in now, as every daily sweep asks since T6.14.
  const dashboards = new DashboardService({
    dashboards: new PostgresDashboardRepository(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    fiscalYears: configRepository,
    clock: systemClock,
  });

  // SETUP READINESS (V2.6). Read-only: eight lines computed from one read, on
  // the firm's own day.
  const readiness = new ReadinessService({
    facts: new PostgresReadinessFacts(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
  });

  // CHASING is its own use case, and it runs in TWO places: the worker sweeps
  // the ladder, and a partner decides the terminal rung from a request. Only
  // the second half is wired here — `setup/worker.ts` builds its own graph, as
  // it does for the scheduler, because a worker and an API are two processes
  // and sharing a composition root between them is how one ends up importing
  // the other's config.
  const dunning = new DunningService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    dunning: new PostgresDunningRepository(pools.app),
    ladders: new PostgresDunningLadder(pools.app),
    invoices: invoiceRepository,
    // The SAME adapter the scheduler uses. Two would be two pieces of SQL
    // that could disagree about which firms a sweep walks.
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE ESCALATION QUEUE (T4.5) — the READ half only.
  //
  // The same split the dunning ladder has one block above: the worker climbs
  // the ladder on a clock, and this process only ever shows somebody what it
  // climbed. The sweep is wired in `setup/worker.ts` and is deliberately not
  // reachable from a request — a monitor a person can trigger is a monitor that
  // can be triggered a hundred times, and nothing here needs it.
  const escalations = new EscalationService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    ladders: new PostgresEscalationLadder(pools.app),
    notices: new PostgresEscalationNoticeRepository(pools.app),
    subjects: new PostgresEscalationSubjects(pools.app),
    // `memberships` again — one notion of who works here, so who may be
    // escalated to cannot disagree with who may check work.
    staff: memberships,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // Creating a firm now also gives it its own role definitions, in the same
  // call — gate 3 reads those rows and has no built-in table to fall back on,
  // so a tenant without them is a tenant nobody can sign in to. The seam is a
  // port on tenancy (RoleRegistrySeeder) rather than a direct call, so neither
  // use case knows the other exists; this is the one place they meet.
  // ONE instance, shared by the two services that need it. `IdentityService`
  // reads `isOpen` on every authenticated request; `TenancyService` owns the
  // rest of the firm's row.
  const tenantRepository = new PostgresTenantRepository(pools.app);
  const tenancy = new TenancyService({
    tenants: tenantRepository,
    users,
    memberships,
    roleSeeder: {
      seedDefaultRoles: (tenantId, actor) => config.seedDefaultRoles(tenantId, actor),
    },
    // And its own entity, with the fallback row naming it as the issuer of the
    // firm's documents. Same seam, same reason: `issuing_entity_party_id` is
    // NOT NULL on both documents, so a firm without that row could not draft a
    // proposal at all. The adapter writes the party, the organization and the
    // preference in one transaction — a firm with some of the three is worse
    // than a firm with none.
    issuingEntitySeeder: documentRepository,
    // The other direction of the same relationship: administration has to know
    // which roles this firm actually publishes, so it can refuse to assign one
    // that does not exist and refuse to remove its last administrator. The
    // config adapter already answers both questions for gate 3.
    roleDirectory: configRepository,
    // And the same pair again for seniority (G3.3): the firm gets its ladder as
    // part of coming into existence, and administration asks the ladder whether
    // a rung is real and still in use before putting anybody on it.
    gradeSeeder: {
      seedDefaultGrades: (tenantId, actor) => staffGrades.seedDefaultGrades(tenantId, actor),
    },
    gradeDirectory: staffGradeRepository,
    // And the firm's own words for work (T3.1), for the same reason again: a
    // firm with no work-item states cannot create a single task, and telling it
    // to configure that before it can record any work would be a worse first
    // day than the roles problem above.
    workVocabularySeeder: workVocabulary,
    // And the compliance calendar's two halves (T3.2), for the same reason a
    // third time. A firm with no obligation STATES cannot have a filing
    // generated at all; a firm with no RULES has an empty calendar and no
    // explanation for it, which is the exact silence this module was built to
    // prevent. Both are idempotent, and the rule pack never overwrites a rule a
    // partner has since confirmed.
    obligationVocabularySeeder: {
      seedDefaultStates: (tenantId, actor) => obligations.seedDefaultStates(tenantId, actor),
    },
    obligationRuleSeeder: {
      seedIndiaRulePack: (tenantId, actor) => obligations.seedIndiaRulePack(tenantId, actor),
    },
    ids: systemIds,
    events: ledger,
  });

  // ONE limiter instance, two very different uses: the edge keys it on the
  // client address, identity keys it on the account. Sharing the store is safe
  // because the keys are namespaced, and it keeps a single eviction budget.
  //
  // HONEST LIMITATION: this state is per-process, so behind N pods every limit
  // is effectively N times looser. Acceptable at one pod; the Redis adapter
  // behind the same port is the fix when there are more.
  const rateLimiter = new InMemoryRateLimiter(systemClock);

  // Gate 3 reads the firm's own role rows. The seeded four-role matrix that used
  // to answer this is now only what a NEW tenant's rows are initialised from
  // (domain/authz/model.ts, DEFAULT_ROLES); nothing consults it at request time.
  // The port did not change and neither did any call site — which was the point
  // of putting a port here before there was anything to swap in.
  const authz = new AuthzService({ permissions: configRepository });

  // ONE mailer for every letter this API writes — the sign-in and invitation
  // letters below, and since 0085 the proposal and its answer notice — so
  // `log` or `smtp` is decided in one place and cannot differ between them.
  const mailer = mailerFor(cfg, log);

  const identity = new IdentityService({
    users,
    memberships,
    // Whether the firm a session points at is still open. The column had no
    // reader at all before this — suspending a firm changed a string and
    // nothing else.
    tenants: tenantRepository,
    credentials: new PostgresCredentialRepository(pools.app),
    sessions: new PostgresSessionRepository(pools.app),
    magicLinks: new PostgresMagicLinkRepository(pools.app),
    passwords: new ScryptPasswordHasher(),
    tokens: new RandomTokenFactory(),
    // HONEST REGISTRY, and the ONE stub that now has a real counterpart.
    // `log` writes the link to the log instead of sending it and
    // validateServer refuses it in a production-like environment; `smtp` is
    // the real transport. The switch is here rather than inside either adapter
    // so that neither of them can be half-registered.
    mailer,
    ids: systemIds,
    clock: systemClock,
    // The constant-time floor on the sign-in-link route. Injected because a
    // real setTimeout in a unit test would make the whole suite pay it —
    // see MAGIC_LINK_FLOOR_MS.
    sleeper: systemSleeper,
    events: ledger,
    attempts: rateLimiter,
    magicLinkBaseUrl: cfg.auth.appBaseUrl,
  });

  // HONEST REGISTRY, the second half. The session resolver is the real one and
  // is always registered. The dev resolver — which trusts an x-user-id header
  // and is not authentication — is added ONLY when config says so, and
  // validateServer has already refused that config in any public environment.
  // So there is no fallback to fall back to in production; there is one
  // resolver, and it requires a session.
  const principalOf = cfg.auth.devAuthEnabled
    ? firstOf(sessionResolver(identity, cfg.auth.sessionCookieName), devHeaderResolver())
    : sessionResolver(identity, cfg.auth.sessionCookieName);
  log.info(
    {
      clients: cfg.auth.internalClients.map((c) => ({
        name: c.name,
        capabilities: c.capabilities,
      })),
    },
    "provisioning clients registered (keys redacted)",
  );

  if (cfg.auth.devAuthEnabled) {
    log.warn(
      "DEV AUTH IS ON: an x-user-id header is accepted as a principal. Local development only.",
    );
  }

  // T7.2. The same arrangement as `portalAccessForInvite` below and for the same
  // reason: adding a colleague is the membership write plus a LETTER, and the
  // letter is the half that differs by WHY the membership is being made. Putting
  // it inside `TenancyService.inviteMember` would mail every client contact
  // twice, because `PortalInviteService` calls that method too. Both ports are
  // satisfied structurally, so neither use case imports the other.
  const staffInvite = new StaffInviteService({
    identity,
    memberships: tenancy,
    firms: tenancy,
  });

  const tenancyDeps: TenancyDeps = { service: tenancy, staffInvite };

  // Held in a variable rather than constructed inline, because the
  // client-assignment use case needs the same adapter as its `ClientDirectory`
  // — it must refuse an assignment to a party that is not there or that the
  // firm has archived, and only this adapter can say.
  const party = new PartyService({
    parties: partyRepository,
    identifiers: new PostgresIdentifierRepository(pools.app),
    relationships: new PostgresRelationshipRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });

  // WHO OWNS A CLIENT (G3.2). Four ports, and three of them are adapters that
  // already exist for somebody else — which is the point of stating ports in
  // each use case's own vocabulary.
  //
  //   · `clients`  — the party adapter. One notion of what a party is and
  //     whether it is archived; a second would eventually disagree about
  //     whether an archived client may be given an owner.
  //   · `staff`    — the SAME membership adapter the lead use case holds as its
  //     own `StaffDirectory`, and for the same reason: `tenancy.user_account` is
  //     GLOBAL, so nothing but the roster can say the person works HERE.
  //   · `axes`     — a THIRD port on `PostgresServiceAxisRepository`, beside the
  //     service-axis repository and the config registry's `AxisDirectory`. One
  //     table, one adapter: two would let a SPOC be assigned to a Dept the
  //     picker never offered.
  // Hoisted, because T6.8's routing reads the SAME rows through the same
  // adapter: the Key Manager it places a request on is `crm.client_assignment`,
  // and a second instance over the same pool would be a second answer waiting
  // to drift from this one.
  const clientAssignmentRepository = new PostgresClientAssignmentRepository(pools.app);

  const clientAssignments = new ClientAssignmentService({
    assignments: clientAssignmentRepository,
    clients: partyRepository,
    staff: memberships,
    axes: serviceAxisRepository,
    ids: systemIds,
    clock: systemClock,
    timeZones: new PostgresFirmTimeZone(pools.app),
    events: ledger,
    // THE CATCH-UP (T6.17): naming somebody on a client's account team moves
    // the work already waiting on a fallback desk. The work item service is
    // built above, so this is an ordinary call and not a cycle; a closure all
    // the same, so the port stays in this use case's own words.
    //
    // A FAILURE IS LOGGED HERE, because this is its only trace. The use case
    // swallows it on purpose (the assignment stands, and the answer says
    // `caughtUp: null`), and a use case holds no logger, so without this line
    // "the SPOC was named and none of the work moved" had nothing to read
    // afterwards. Rethrown, so the use case still answers null.
    work: {
      catchUp: async (tenantId, clientPartyId, actor): Promise<CaughtUpWork> => {
        try {
          return await workItems.catchUpClient(tenantId, clientPartyId, actor);
        } catch (err) {
          log.error(
            { err, tenantId, clientPartyId },
            "catch-up after an account-team assignment failed; the client's waiting work stayed where it was",
          );
          throw err;
        }
      },
    },
  });

  // GATE 4's writer (G3.4). 0059 built the wall — `crm.portal_access`,
  // `crm.portal_sees()` and the restrictive policies — and shipped with nothing
  // that could write a grant, so the gate could only deny. This is that half.
  //
  // ONE adapter satisfies all three seams, the arrangement `PostgresConfigRepository`
  // already has: the repository, the membership directory (audience and
  // is_active, which the composite foreign key cannot check) and the client
  // directory. Two adapters over one table eventually disagree, and here that
  // would mean granting a client to a login the roster says was revoked.
  const portalAccessRepository = new PostgresPortalAccessRepository(pools.app);
  // T6.5. Three existing services made into ONE act, because "let this client's
  // CFO in" is one decision a partner takes and every halfway state of it is
  // silent: a membership with no grant is a portal that shows nothing, and a
  // grant with no membership is unreachable. Each port is satisfied
  // structurally, so no use case imports another.
  const portalAccessForInvite = (): PortalInviteService =>
    new PortalInviteService({
      identity,
      memberships: tenancy,
      access: portalAccess,
      firms: tenancy,
      // `invite` records nothing itself — its three writes each emit their own
      // event. `resend` writes no row at all, so this is the only record that a
      // credential was mailed outside the firm and who said so.
      events: ledger,
    });

  const portalAccess = new PortalAccessService({
    // A portal session's grants are resolved on the FIRM's day (F-07-1).
    timeZones: new PostgresFirmTimeZone(pools.app),
    grants: portalAccessRepository,
    memberships: portalAccessRepository,
    clients: portalAccessRepository,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // One instance, reused by the invite route AND by the client import: both
  // are "one of the firm's people invites one of a client's" acting through
  // the SAME three writes, and two instances would just be the same deps
  // built twice.
  const portalInvite = portalAccessForInvite();

  // No use case answers "does this email already hold a CLIENT_PORTAL login
  // at this firm" — the client import is the first caller to need it, and it
  // is a narrow enough question that a second service would exist for this
  // one method. Satisfied here with a closure over the roster, the same move
  // `usecase/obligation`'s filing reconciliation documents for a use case
  // that needs one fact from another without importing it.
  const portalMemberFinder: PortalMemberFinder = {
    async findClientMembership(tenantId, email) {
      const wanted = email.trim().toLowerCase();
      const roster = await tenancy.listMembers(tenantId);
      const found = roster.find(
        (m) => m.membership.audience === "CLIENT_PORTAL" && m.email.trim().toLowerCase() === wanted,
      );
      return found ? { membershipId: found.membership.id } : null;
    },
  };

  // THE PORTAL'S OWN READ (T6.5) — and this line is where the firm's write
  // surface and the client's read surface meet, which is the only place they
  // should.
  //
  // `PortalScopeSource` is declared by `usecase/portalhome` in its own words and
  // satisfied here STRUCTURALLY by `PortalAccessService`, so neither use case
  // imports the other: "who may be granted access" and "what does a client see"
  // stay separate blast radii. This line is where a drift between them would
  // fail — at compile time, in one place, which is what the port bought.
  const portalHome = new PortalHomeService({
    scope: {
      scopedCompanies: (tenantId, userId) => portalAccess.scopedClientsForUser(tenantId, userId),
    },
    // The ONE adapter in this product that uses `withPortal`. Everything else
    // reaches tenant data through `withTenant`, which sets the firm and nothing
    // narrower — and would leave gate 4's restrictive policies disarmed.
    rows: new PostgresPortalHomeRepository(pools.app),
    clock: systemClock,
  });

  // THE SELF-SERVE LIBRARY (T6.7) — the THIRD `withPortal` adapter, and
  // CLAUDE.md's "it should stay countable on one hand" is now half spent.
  //
  // `PortalScopeSource` again, satisfied structurally by the same
  // `PortalAccessService` for the third time — three use cases each asking "what
  // may this session read" in their own words, one implementation, no imports
  // between them.
  //
  // `blobs` is the SAME object the firm's own `FileStoreService` holds, and that
  // is the point rather than a convenience: two blob stores would mean a
  // client's download and the firm's download reading different disks, and the
  // symptom would be a file the firm can open and the client cannot.
  const portalLibrary = new PortalLibraryService({
    scope: {
      scopedCompanies: (tenantId, userId) => portalAccess.scopedClientsForUser(tenantId, userId),
    },
    timeZones: new PostgresFirmTimeZone(pools.app),
    library: new PostgresPortalLibraryRepository(pools.app),
    blobs,
    clock: systemClock,
  });

  // THE CLIENT-DIRECTED ASK (T6.6) — one service, two adapters, two scopes.
  //
  // `asks` is the FIRM's side under `withTenant`; `portal` is the client's under
  // `withPortal`, and it is the SECOND adapter in this product to use it and the
  // FIRST to write through it. The rules about an ask — a decision only answers
  // an approval, an answered ask still accepts another answer, a closed one
  // accepts nothing — are the same whoever is looking, so they live in one
  // service and only the transaction the adapter opens differs.
  //
  // `scope` is satisfied by `PortalAccessService` again, structurally, exactly
  // as the status home's is: the grant table is the firm's write surface and
  // this is a client's read surface, and neither use case imports the other.
  //
  // `blobs` and `digest` are the SAME two objects the staff document store
  // holds, reused rather than re-declared — they are the only ports in
  // `usecase/filestore` that carry no tenant scoping, which is what makes them
  // safe to share across a wall. `FileStoreService` itself is deliberately NOT
  // wired in here: its repository writes through `withTenant`, so a portal
  // upload routed through it would put the row naming the client outside gate 4.
  const clientAsks = new ClientAskService({
    asks: new PostgresClientAskRepository(pools.app),
    portal: new PostgresPortalAskRepository(pools.app),
    scope: {
      scopedCompanies: (tenantId, userId) => portalAccess.scopedClientsForUser(tenantId, userId),
    },
    blobs,
    digest: new Sha256ByteDigest(),
    ids: systemIds,
    events: ledger,
    clock: systemClock,
    maxUploadBytes: cfg.storage.maxUploadBytes,
  });

  // THE CLIENT'S OWN REQUEST (T6.8) — the other direction, and the first thing
  // on this portal a client can START.
  //
  // NO MAILER, and the absence is asserted structurally in
  // `tests/clientrequest/service.test.ts` the way the chaser's and the nudge's
  // are: transport is P10 (Phase 7), so a client raising a request raises a row
  // and the firm sees it when it opens the inbox. A logging stub saying the
  // firm was notified would be the same class of lie as a scan() that returns
  // clean, and a transport appearing in this Deps turns the build red on
  // purpose so the decision is taken on the board.
  //
  // The same `scopedCompanies` closure the ask service holds, satisfying a port
  // this use case declares for itself — TypeScript is structural, and one
  // implementation serves all three portal use cases without any of them
  // importing another's ports.
  const clientRequests = new ClientRequestService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    requests: new PostgresClientRequestRepository(pools.app),
    portal: new PostgresPortalRequestRepository(pools.app),
    scope: {
      scopedCompanies: (tenantId, userId) => portalAccess.scopedClientsForUser(tenantId, userId),
    },
    routing: new PostgresRequestRoutingRepository(pools.app),
    // ── THE KEY MANAGER, THROUGH THE SERVICE THAT OWNS THAT TABLE ────────
    //
    // `crm.client_assignment` has a use case already and this one does not
    // reach past it into a second adapter over the same rows — the composition
    // root is where concrete meets interface, so the closure lives here.
    //
    // `listOpenForClient` returns a LIST because G3.2 allows several SPOCs per
    // axis. A key_manager cannot be several: an exclusion constraint refuses
    // overlapping periods, and the port narrows to at most one BECAUSE of that
    // rather than by taking the first of an arbitrary set. `open[0]` is the
    // incumbent, which is that method's own documented contract.
    keyManagers: {
      keyManagerFor: async (tenantId, clientPartyId, on) => {
        const open = await clientAssignmentRepository.listOpenForClient(
          tenantId,
          clientPartyId,
          "key_manager",
          on,
        );
        // `open[0]` is the incumbent — that method returns newest first and
        // says so. A key_manager cannot be several: an exclusion constraint
        // refuses overlapping periods, so taking the first is reading a
        // guarantee rather than picking from a set.
        return open[0]?.userId ?? null;
      },
    },
    staff: {
      isActiveStaff: (tenantId, userId) => memberships.isActiveStaff(tenantId, userId),
    },
    ids: systemIds,
    events: ledger,
    clock: systemClock,
  });

  // THE CHASER (T4.4) — the ask ladder aimed OUTWARD, and the freeze that stops
  // it. The API surface here is the FREEZE only: the sweep is a cron in the
  // worker (`setup/worker.ts`), because a "chase now" button would be a person
  // telling the product to remind a client and would make the ledger's SYSTEM
  // actor a lie on some rows and not others.
  //
  // No mailer is wired in on purpose. Transport is P10 (Phase 7), and an honest
  // logging stub here would put a line in an operator's log saying a client was
  // emailed — the same class of lie as a `scan()` that returns clean. Until a
  // channel exists, a chase raises the reminder and the client's own action
  // centre shows it, which is the board's hard limit met by there being nothing
  // to send through rather than by a check somebody could delete.
  const chaser = new ChaserService({
    tenants: new PostgresChaserTenants(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    ladders: new PostgresChaserLadder(pools.app),
    candidates: new PostgresChaseCandidates(pools.app),
    chases: new PostgresChaseRepository(pools.app),
    freezes: new PostgresClientFreezeRepository(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // The pipeline sits ON TOP of the party module rather than beside it: a lead
  // is an opportunity about a party, so capture creates prospects through
  // PartyService — which owns display-name derivation, identifier normalisation
  // and the party.created / party_identifier.added events. Wiring the party
  // REPOSITORIES in here instead would produce parties the party module never
  // saw, with no events and none of its rules.
  //
  // ProspectDirectory is declared by the lead use case in its own vocabulary and
  // PartyService satisfies it structurally, so neither module imports the other.
  // This line is where they meet, and where a drift in party's inputs would
  // fail — at compile time, in one place.
  //
  // ASSIGNMENT is the second seam on this service, and this line is the whole
  // of the territory decision: round robin is what a firm gets today, and the
  // day an axis is agreed with the client, a territory strategy is constructed
  // HERE and no caller changes. That is what the port bought.
  const lead = new LeadService({
    leads: new PostgresLeadRepository(pools.app),
    prospects: party,
    staff: memberships,
    // TERRITORY FIRST, ROTATION SECOND — which is what T2.1b's "a territory
    // rule OVERRIDES the rotation" means as wiring. The ORDER here IS the
    // firm's precedence, stated in one visible place: a third rule is a line in
    // this array, not a branch inside a strategy.
    assignment: new FirstMatchAssignment([
      new PostgresTerritoryAssignment(pools.app),
      new PostgresRoundRobinAssignment(pools.app),
    ]),
    territories: new PostgresTerritoryRules(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    // The firm's reporting currency, read by the adapter the dashboard already
    // uses for it — satisfied structurally, one query for one fact.
    currency: new PostgresDashboardRepository(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // Quoting meets the configuration registry HERE, and nowhere else. The
  // proposal use case declares two narrow ports in its own vocabulary —
  // "resolve this pin" and "what is the discount limit right now" — and the
  // config adapter satisfies both structurally, so neither module imports the
  // other. Same seam, same reason, as leads meeting parties above.
  const proposal = new ProposalService({
    proposals: new PostgresProposalRepository(pools.app),
    catalogue: configRepository,
    policies: configRepository,
    // An archived client is refused by name before a new proposal names it
    // (0305). The repository's read-one-by-id never hides the archive.
    parties: partyRepository,
    // A lead deleted as a mistake gains no proposal (0086) — the lead
    // repository's read-one-by-id never hides a deletion, so the refusal can
    // say what happened.
    leads: new PostgresLeadRepository(pools.app),
    // The reference series and the issuing-entity rule, behind quoting's own
    // narrow port. `DocumentService` satisfies it structurally, so neither
    // module imports the other — the same seam the catalogue arrives through.
    documents,
    // The same token adapter identity uses for sessions and magic links. Both
    // want 32 bytes from the OS CSPRNG and only the digest at rest; one
    // implementation of that is the right number.
    shareTokens: new RandomTokenFactory(),
    // Whom a proposal may be prepared for (0084): the same structure read the
    // letter's addressee is held to, so the two documents accept the same
    // people — on the firm's day.
    structure: new PostgresRelationshipRepository(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    // Who may be named as having prepared one: the lead pipeline's question.
    staff: memberships,
    // The proposal by email (0085): the SAME mailer the sign-in letters use,
    // so `log` and `smtp` are decided once for every letter this API writes;
    // the PDF of record through the document store; links from the origin the
    // sign-in letters link from.
    mailer,
    pdfs: proposalPdfs(fileStore),
    links: proposalLinks(cfg.auth.appBaseUrl),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // Engagement letters meet the configuration registry the same way proposals
  // do — one narrow port, satisfied structurally, so neither module imports the
  // other. The clause library and the service catalogue are the same two tables.
  //
  // HONEST REGISTRY: `AttestedSigner` is the third stub in this codebase, and
  // `validateServer` has already refused this config in any production-like
  // environment by the time this line runs.
  // THE LETTER AS THE CLIENT WILL SIGN IT — rendered for the envelope from
  // the same source and renderer the document store uses. A closure rather
  // than a call into `fileStore`: sending a letter for signature must not also
  // file a document version and write its events as a side effect.
  const letterPdf: LetterPdf = {
    render: async (tenantId, letterId) => {
      const described = await renderSource.describe({
        tenantId,
        kind: "engagement_letter",
        subjectRef: letterId,
      });
      if (described === null) {
        throw new Error(`engagement letter ${letterId} has nothing to render at tenant ${tenantId}`);
      }
      return {
        bytes: await renderer.render(described.document),
        filename: `${described.document.reference.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`,
      };
    },
  };
  const esign = esignFor(cfg, log);

  const engagement = new EngagementService({
    // 0320: a signed letter's advance becomes a bill to raise.
    advanceBilling: advanceBills,
    // 0319: a signed letter's billing terms set each engagement's schedule.
    goLiveBilling: new GoLiveScheduler({
      schedules: new PostgresBillingSchedules(pools.app),
      setting: new PostgresAutoBillingSetting(pools.app),
      fiscalYears: configRepository,
      events: ledger,
    }),
    letters: new PostgresEngagementRepository(pools.app),
    library: configRepository,
    // The SAME instance proposals hold. Two documents of the same firm must not
    // be able to disagree about which of its entities serves a UAE client.
    documents,
    // WHO BINDS THE FIRM, snapshotted onto the letter when it is sent. Tenancy
    // owns the standing signatory (a column on the tenant row) and satisfies
    // this port structurally, so neither module imports the other — the same
    // seam the catalogue and the reference series arrive through.
    firm: tenancy,
    // THE MARK, resolved at send and pinned to the letter (0081). A closure over
    // the document store rather than the store itself: this use case needs one
    // answer about brand assets and must not be handed the whole file cabinet.
    firmSignatureImage: {
      activeSignatureVersion: async (tenantId, entityPartyId) => {
        const assets = await documentStore.activeBrandAssets(tenantId, entityPartyId);
        return assets.find((a) => a.asset.kind === "signature")?.version.id ?? null;
      },
    },
    parties: partyRepository,
    // THE QUOTE A LETTER IS WRITTEN UP FROM (T3.5b). The SAME instance the
    // proposal routes hold, satisfied structurally by `findQuote` — so neither
    // use case imports the other, and there is one answer to "what did we
    // actually quote" rather than two reads that can drift.
    quotes: proposal,
    // THE CLIENT'S STRUCTURE (F-10-1): which companies a letter's lines may be
    // for, and whom it may be addressed to, read on the firm's day. The party
    // module's relationship adapter satisfies it structurally.
    structure: new PostgresRelationshipRepository(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    esign: esign.signer,
    // Letters signed BEFORE the firm used this product arrive through the book
    // import and are attested by the person confirming it. Always the attested
    // signer, even when `esign` is DocuSign: a paper letter has no envelope.
    // `validateServer` refuses `attested` as THE provider in production-like
    // environments; this is the one deliberate exception, reached only via
    // `SignInput.migrated`, which the HTTP route does not expose.
    migrationSigner: new AttestedSigner(),
    hasher: new Sha256ContentHasher(),
    // SENDING FOR SIGNATURE (0080). The API raises envelopes when a letter is
    // sent; the worker's sweep learns how each one ended.
    signatures: new PostgresSignatureRequestRepository(pools.app),
    dispatch: esign.dispatch,
    letterPdf,
    // The API files nothing itself — the worker's sweep does — but a letter
    // signed through the form with an envelope id is a completed request
    // like any other, so the same filer is here for symmetry of the graph.
    signedCopies: signedCopyFiler(fileStore),
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // LOADING A FIRM'S EXISTING BOOK. The three WRITER ports are the real party,
  // assignment and engagement services, narrowed structurally — an imported
  // client goes through exactly the doors a typed one does, so it is the same
  // thing: same events, same triggers, same calendar. The directory is one
  // adapter reading the tables the snapshot needs in one shape; the only table
  // this module writes is its own staging row.
  const clientImports = new ClientImportService({
    store: new PostgresClientImportRepository(pools.app),
    directory: new PostgresClientImportDirectory(pools.app),
    sheets: new NodeSheetReader(),
    parties: party,
    assignments: clientAssignments,
    letters: engagement,
    timeZones: new PostgresFirmTimeZone(pools.app),
    portalInvites: portalInvite,
    portalAccess,
    portalMembers: portalMemberFinder,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  return {
    app: buildRouter(
      {
        auth: {
          service: identity,
          authz,
          // So /auth/me can say what the firm is CALLED, not only which uuid it
          // is. Every screen reads its identity from that one response.
          tenancy,
          // And so a CLIENT PORTAL session is told which companies it may read
          // (gate 4). Staff sessions never reach that branch.
          portalAccess,
          cookieName: cfg.auth.sessionCookieName,
          cookieSecure: cfg.auth.sessionCookieSecure,
          cookieSameSite: cfg.auth.sessionCookieSameSite,
        },
        tenancy: tenancyDeps,
        staffGrades: { service: staffGrades },
        serviceAxes: { service: serviceAxes },
        clientAssignments: { service: clientAssignments },
        clientImports: { service: clientImports },
        portalAccess: { service: portalAccess },
        portalHome: { service: portalHome },
        clientAsks: { service: clientAsks },
        clientRequests: { service: clientRequests },
        chaser: { service: chaser },
        portalAsks: { service: clientAsks },
        portalLibrary: { service: portalLibrary },
        portalRequests: { service: clientRequests },
        portalInvites: {
          service: portalInvite,
          identity,
          cookieName: cfg.auth.sessionCookieName,
          cookieSecure: cfg.auth.sessionCookieSecure,
          cookieSameSite: cfg.auth.sessionCookieSameSite,
        },
        workItems: { service: workItems, vocabulary: workVocabulary },
        obligations: { service: obligations, vocabulary: obligationVocabulary },
        escalations: { service: escalations },
        orchestrator: { service: orchestrator, grades: staffGrades, jobs: scheduler },
        scheduler: { service: scheduler },
        party: { service: party },
        ledger: { service: ledger },
        config: { service: config },
        lead: { service: lead, authz },
        proposal: { service: proposal, authz },
        engagement: {
          service: engagement,
          authz,
          // End, pause, resume (V2.3): the engagement row and the calendar
          // that hangs off it, in one transaction per end.
          lifecycle: new EngagementLifecycleService({
            lifecycle: new PostgresEngagementLifecycle(pools.app),
            timeZones: new PostgresFirmTimeZone(pools.app),
            clock: systemClock,
            events: ledger,
          }),
        },
        document: {
          service: documents,
          // The firm's own companies (T6.18): created in one transaction, so
          // an adapter of their own over the party and preference tables.
          firmEntities: new FirmEntityService({
            firmEntities: new PostgresFirmEntityRepository(pools.app),
            ids: systemIds,
            events: ledger,
          }),
        },
        invoice: { service: invoices, dunning, authz },
        billing: { service: billing, authz, advances: advanceDesk, finals: finalBills },
        filestore: { service: fileStore, authz },
        dashboard: { service: dashboards, authz },
        readiness: { service: readiness },
      },
      log,
      {
        docsEnabled: cfg.docsEnabled,
        internalClients: cfg.auth.internalClients,
        principalOf,
        authz,
        rateLimiter,
        corsOrigins: cfg.cors.origins,
        // The edge's copy of the upload budget. The service checks the FILE's
        // bytes; this refuses the REQUEST before parseBody() has pulled the
        // whole multipart body into memory to be measured.
        maxUploadBytes: cfg.storage.maxUploadBytes,
        // HSTS only where the API is actually served over https.
        hstsEnabled: isProductionLike(cfg),
        // What GET /health reports: the commit and build time stamped into
        // the image (V0.2), null when it was built without them.
        build: cfg.build,
        rateLimit: {
          auth: { limit: cfg.rateLimit.authPerMinute, windowSeconds: 60 },
          general: { limit: cfg.rateLimit.generalPerMinute, windowSeconds: 60 },
          trustProxy: cfg.rateLimit.trustProxy,
          trustedProxyHops: cfg.rateLimit.trustedProxyHops,
        },
      },
    ),
    pools,
    assertReady: async () => {
      await assertTenantWall(pools.app);
      await assertLedgerAppendOnly(pools.app);
    },
  };
}
