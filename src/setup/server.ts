// The composition root — the ONE place a concrete type meets an interface.
// Every wiring decision lives here so the rest of the codebase can be read
// without knowing which adapter is plugged into which port.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../api/guards";
import type { Config } from "../config/config";
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { systemIds } from "../platform/ids";
import { systemClock } from "../platform/clock";
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
import { LoggingMailer } from "../infrastructure/mail/logging-mailer";
import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import { PostgresStaffGradeRepository } from "../infrastructure/postgres/staff-grade-repository";
import { PostgresClientAssignmentRepository } from "../infrastructure/postgres/client-assignment-repository";
import { PostgresPortalAccessRepository } from "../infrastructure/postgres/portal-access-repository";
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
import { PostgresObligationCoverage } from "../infrastructure/postgres/obligation-coverage";
import { PostgresEngagementWorkSource } from "../infrastructure/postgres/engagement-work-source";
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
import { PostgresDocumentRepository } from "../infrastructure/postgres/document-repository";
import { PostgresInvoiceRepository } from "../infrastructure/postgres/invoice-repository";
import { PostgresDocumentStoreRepository } from "../infrastructure/postgres/document-store-repository";
import {
  FilesystemBlobStore,
  Sha256ByteDigest,
} from "../infrastructure/storage/filesystem-blob-store";
import { FileStoreService } from "../usecase/filestore/service";
import { PdfLibRenderer } from "../infrastructure/render/pdf-renderer";
import { PostgresRenderSource } from "../infrastructure/postgres/render-source";
import { PostgresDashboardRepository } from "../infrastructure/postgres/dashboard-repository";
import { DashboardService } from "../usecase/dashboard/service";
import { InvoiceService } from "../usecase/invoice/service";
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
import { TenancyService } from "../usecase/tenancy/service";
import { PartyService } from "../usecase/party/service";
import { LedgerService } from "../usecase/ledger/service";
import { AuthzService } from "../usecase/authz/service";
import { ConfigService } from "../usecase/config/service";
import { StaffGradeService } from "../usecase/staffgrade/service";
import { ServiceAxisService } from "../usecase/serviceaxis/service";
import { ClientAssignmentService } from "../usecase/clientassignment/service";
import { PortalAccessService } from "../usecase/portalaccess/service";
import { PortalInviteService } from "../usecase/portalinvite/service";
import { WorkItemService, WorkVocabularyService } from "../usecase/workitem/service";
import { ObligationService } from "../usecase/obligation/service";
import { ObligationVocabularyService } from "../usecase/obligation/vocabulary";
import { SchedulerService } from "../usecase/scheduler/service";
import { OrchestratorService } from "../usecase/orchestrator/service";
import { PostgresJobStepRepository } from "../infrastructure/postgres/job-step-repository";
import { PostgresJobSubjectRepository } from "../infrastructure/postgres/job-subject-repository";
import { NoAgentsBuiltYet } from "../infrastructure/agent/no-agents";
import { PostgresStepApprovalRepository } from "../infrastructure/postgres/step-approval-repository";
import { PostgresAgentRunRepository } from "../infrastructure/postgres/agent-run-repository";
import { LeadService } from "../usecase/lead/service";
import { ProposalService } from "../usecase/proposal/service";
import { EngagementService } from "../usecase/engagement/service";
import { DocumentService } from "../usecase/document/service";
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
    axes: serviceAxisRepository,
    policies: configRepository,
    reviewers: memberships,
    permissions: configRepository,
    engagements: new PostgresEngagementWorkSource(pools.app),
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
    templates: obligationTemplates,
    exceptions: new PostgresObligationExceptionRepository(pools.app),
    states: new PostgresObligationStateRepository(pools.app),
    resolutionOptions: new PostgresResolutionOptionRepository(pools.app),
    instances: new PostgresObligationInstanceRepository(pools.app),
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
  const orchestrator = new OrchestratorService({
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
    policies: configRepository,
    checkers: memberships,
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
  const invoices = new InvoiceService({
    invoices: invoiceRepository,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE DOCUMENT STORE (T3.6). The blob adapter is chosen here and nowhere
  // else, which is what makes replacing the filesystem stub with an object
  // store a one-line change in this file. `validateServer` has already refused
  // to boot a production-like environment on the stub by the time this runs.
  // The blob store is named once and handed to BOTH the document store and the
  // render source — the source needs it to fetch a firm's logo, and giving it
  // its own instance would mean two objects believing they own the same files.
  const blobs = new FilesystemBlobStore(cfg.storage.root);
  const fileStore = new FileStoreService({
    documents: new PostgresDocumentStoreRepository(pools.app),
    blobs,
    digest: new Sha256ByteDigest(),
    ids: systemIds,
    events: ledger,
    maxUploadBytes: cfg.storage.maxUploadBytes,
    // pdf-lib, chosen for DETERMINISM rather than fidelity: a rendered
    // document's content hash is evidence, and a headless browser's bytes are
    // not stable across versions. See the renderer's own header.
    renderer: new PdfLibRenderer(),
    renderSource: new PostgresRenderSource(pools.app, (i) => blobs.get(i)),
  });

  // THE LEADERSHIP FIGURES (T3.7). No writes and no ports beyond the one
  // repository: every number is derived from rows at read time, so there is
  // nothing to inject a clock or an id generator for.
  const dashboards = new DashboardService({
    dashboards: new PostgresDashboardRepository(pools.app),
  });

  // CHASING is its own use case, and it runs in TWO places: the worker sweeps
  // the ladder, and a partner decides the terminal rung from a request. Only
  // the second half is wired here — `setup/worker.ts` builds its own graph, as
  // it does for the scheduler, because a worker and an API are two processes
  // and sharing a composition root between them is how one ends up importing
  // the other's config.
  const dunning = new DunningService({
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
  const tenancy = new TenancyService({
    tenants: new PostgresTenantRepository(pools.app),
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

  const identity = new IdentityService({
    users,
    memberships,
    credentials: new PostgresCredentialRepository(pools.app),
    sessions: new PostgresSessionRepository(pools.app),
    magicLinks: new PostgresMagicLinkRepository(pools.app),
    passwords: new ScryptPasswordHasher(),
    tokens: new RandomTokenFactory(),
    // HONEST REGISTRY: the only mailer registered writes the link to the log
    // instead of sending it. validateServer refuses to boot a production-like
    // environment with it — see config/validate.ts.
    mailer: new LoggingMailer(log),
    ids: systemIds,
    clock: systemClock,
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

  const tenancyDeps: TenancyDeps = { service: tenancy };

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
  const clientAssignments = new ClientAssignmentService({
    assignments: new PostgresClientAssignmentRepository(pools.app),
    clients: partyRepository,
    staff: memberships,
    axes: serviceAxisRepository,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
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
    });

  const portalAccess = new PortalAccessService({
    grants: portalAccessRepository,
    memberships: portalAccessRepository,
    clients: portalAccessRepository,
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
    // The reference series and the issuing-entity rule, behind quoting's own
    // narrow port. `DocumentService` satisfies it structurally, so neither
    // module imports the other — the same seam the catalogue arrives through.
    documents,
    // The same token adapter identity uses for sessions and magic links. Both
    // want 32 bytes from the OS CSPRNG and only the digest at rest; one
    // implementation of that is the right number.
    shareTokens: new RandomTokenFactory(),
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
  const engagement = new EngagementService({
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
    esign: new AttestedSigner(),
    hasher: new Sha256ContentHasher(),
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
        },
        tenancy: tenancyDeps,
        staffGrades: { service: staffGrades },
        serviceAxes: { service: serviceAxes },
        clientAssignments: { service: clientAssignments },
        portalAccess: { service: portalAccess },
        portalInvites: {
          service: portalAccessForInvite(),
          identity,
          cookieName: cfg.auth.sessionCookieName,
          cookieSecure: cfg.auth.sessionCookieSecure,
        },
        workItems: { service: workItems, vocabulary: workVocabulary },
        obligations: { service: obligations, vocabulary: obligationVocabulary },
        escalations: { service: escalations },
        orchestrator: { service: orchestrator },
        scheduler: { service: scheduler },
        party: { service: party },
        ledger: { service: ledger },
        config: { service: config },
        lead: { service: lead },
        proposal: { service: proposal, authz },
        engagement: { service: engagement, authz },
        document: { service: documents },
        invoice: { service: invoices, dunning, authz },
        filestore: { service: fileStore },
        dashboard: { service: dashboards, authz },
      },
      log,
      {
        docsEnabled: cfg.docsEnabled,
        internalClients: cfg.auth.internalClients,
        principalOf,
        authz,
        rateLimiter,
        corsOrigins: cfg.cors.origins,
        rateLimit: {
          auth: { limit: cfg.rateLimit.authPerMinute, windowSeconds: 60 },
          general: { limit: cfg.rateLimit.generalPerMinute, windowSeconds: 60 },
          trustProxy: cfg.rateLimit.trustProxy,
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
