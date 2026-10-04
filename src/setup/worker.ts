// The worker's composition root (T2.6) — the ONE place a concrete type meets an
// interface, for the second process.
//
// Separate from `setup/server.ts` on purpose. The worker and the API share a
// database and a domain and almost nothing else: the worker has no HTTP, no
// session, no rate limiter and no CORS, and building it out of the server's
// wiring would drag all of that into a process that must never serve a request.
// What they DO share arrives the same way it always does — through ports.
import { createPools } from "../db/pool";
import type { Pools } from "../db/pool";
import type { Config } from "../config/config";
import type { Logger } from "../platform/log";
import { systemIds } from "../platform/ids";
import { systemClock } from "../platform/clock";
import { AdvanceReminders, NotificationFanout } from "../usecase/notify/fanout";
import { SYSTEM_ACTOR } from "../domain/ledger/model";
import { AdhocAdvanceReminders } from "../usecase/notify/adhoc-reminders";
import { AdhocAdvanceService } from "../usecase/billing/adhoc";
import { PostgresAdhocAdvanceStore } from "../infrastructure/postgres/adhoc-advance";
import { NotificationEmails } from "../usecase/notify/email";
import { PostgresNotificationEmailStore } from "../infrastructure/postgres/notification-email";
import { PostgresNotificationOutbox, PostgresNotifyDirectory } from "../infrastructure/postgres/notification-outbox";
import { PostgresNotificationSettings } from "../infrastructure/postgres/notification-repository";
import { PostgresEventStore } from "../infrastructure/postgres/event-repository";
import {
  PostgresJobRepository,
  PostgresTenantDirectory,
} from "../infrastructure/postgres/job-repository";
import { BossJobQueue } from "../infrastructure/pgboss/boss-queue";
import { CredentialSweeper } from "../usecase/identity/sweep";
import { PostgresSessionRepository } from "../infrastructure/postgres/identity-repository";
import { LedgerService } from "../usecase/ledger/service";
import { PostgresWorkSplitSetting } from "../infrastructure/postgres/service-axis-repository";
import { SchedulerService } from "../usecase/scheduler/service";
import { obligationFilingPort } from "./filing-link";
import { WorkItemService } from "../usecase/workitem/service";
import { ObligationService } from "../usecase/obligation/service";
import { DunningService } from "../usecase/dunning/service";
import { BillingService } from "../usecase/billing/service";
import { GoLiveScheduler } from "../usecase/billing/golive";
import { AdvanceBiller, AdvanceDesk, AdvanceDigest } from "../usecase/billing/advance";
import { FinalBiller } from "../usecase/billing/final";
import { BillingDeskService } from "../usecase/billing/desk";
import { InvoiceService } from "../usecase/invoice/service";
import {
  PostgresAutoBillingSetting,
  PostgresBillingDueDesk,
  PostgresBillingSchedules,
} from "../infrastructure/postgres/billing-desk";
import {
  PostgresAdvanceDigestStore,
  PostgresAdvancePolicy,
  PostgresAdvanceReminderFacts,
  PostgresIssuerTaxDefaults,
} from "../infrastructure/postgres/advance-reminders";
import { invoiceIssuedCopies } from "./invoice-copies";
import { logDunningSweep, logOrchestratorSweep, logSpawnSweep } from "./sweep-log";
import { fxServiceFor } from "./fx";
import { mailerFor } from "./mailer";
import { PostgresAdvanceBillFacts, PostgresFinalBillFacts } from "../infrastructure/postgres/billing-facts";
import { EscalationService } from "../usecase/escalation/service";
import { ChaserService } from "../usecase/chaser/service";
import { PostgresFirmTimeZone } from "../infrastructure/postgres/firm-timezone-repository";
import { NudgeService } from "../usecase/nudge/service";
import { OrchestratorService } from "../usecase/orchestrator/service";
import { PostgresJobStepRepository } from "../infrastructure/postgres/job-step-repository";
import { PostgresJobDeskResolver } from "../infrastructure/postgres/job-desk-resolver";
import { PostgresWorkOwnerDirectory } from "../infrastructure/postgres/work-owner";
import { PostgresJobSubjectRepository } from "../infrastructure/postgres/job-subject-repository";
import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import {
  PostgresAutoBillingFirms,
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../infrastructure/postgres/billing-repository";
import { PostgresPartyRepository } from "../infrastructure/postgres/party-repository";
import { PostgresRelationshipRepository } from "../infrastructure/postgres/relationship-repository";
import { PostgresServiceAxisRepository } from "../infrastructure/postgres/service-axis-repository";
import { PostgresClientAssignmentRepository } from "../infrastructure/postgres/client-assignment-repository";
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
import { NoAgentsBuiltYet } from "../infrastructure/agent/no-agents";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { PostgresStepApprovalRepository } from "../infrastructure/postgres/step-approval-repository";
import { PostgresStepCheckRepository } from "../infrastructure/postgres/step-check-repository";
import { PostgresAgentRunRepository } from "../infrastructure/postgres/agent-run-repository";
import { PostgresInvoiceFirmSettings } from "../infrastructure/postgres/invoice-settings";
import { PostgresInvoiceRepository } from "../infrastructure/postgres/invoice-repository";
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
  PostgresChaseCandidates,
  PostgresChaseRepository,
  PostgresChaserLadder,
  PostgresChaserTenants,
  PostgresClientFreezeRepository,
} from "../infrastructure/postgres/chaser-repository";
import {
  PostgresNudgeCandidates,
  PostgresNudgeLadder,
  PostgresNudgeRepository,
  PostgresNudgeTenants,
} from "../infrastructure/postgres/nudge-repository";
import { EngagementService } from "../usecase/engagement/service";
import { DocumentService } from "../usecase/document/service";
import { ProposalService } from "../usecase/proposal/service";
import { proposalLinks, proposalPdfs } from "./proposal-delivery";
import { PostgresEngagementRepository } from "../infrastructure/postgres/engagement-repository";
import { PostgresDocumentRepository } from "../infrastructure/postgres/document-repository";
import { PostgresProposalRepository } from "../infrastructure/postgres/proposal-repository";
import { PostgresLeadRepository } from "../infrastructure/postgres/lead-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../infrastructure/postgres/block-repository";
import { PostgresTenantRepository } from "../infrastructure/postgres/tenant-repository";
import { PostgresSignatoryRepository } from "../infrastructure/postgres/signatory-repository";
import { PostgresSignatureRequestRepository } from "../infrastructure/postgres/signature-request-repository";
import { RandomTokenFactory, Sha256ContentHasher } from "../infrastructure/crypto/random-tokens";
import { AttestedSigner } from "../infrastructure/esign/attested-signer";
import { esignFor } from "./esign";
import { blobStoreFor } from "./blobs";
import { signedCopyFiler } from "./signed-copies";
import { FileStoreService } from "../usecase/filestore/service";
import { PostgresDocumentStoreRepository } from "../infrastructure/postgres/document-store-repository";
import { Sha256ByteDigest } from "../infrastructure/storage/filesystem-blob-store";
import { PdfLibRenderer } from "../infrastructure/render/pdf-renderer";
import { PostgresRenderSource } from "../infrastructure/postgres/render-source";
import type { JobQueue } from "../usecase/scheduler/ports";

/** The queue the spawn sweep runs on. A name, because pg-boss keys a schedule
 *  by it — see `BossJobQueue.schedule`. */
export const SPAWN_QUEUE = "delivery.spawn";

/** The queue the dunning sweep runs on. Its own name and its own cadence: the
 *  ladder is counted in days and the spawn sweep in hours, and one queue doing
 *  both would have to run at the faster of the two. */
export const DUNNING_QUEUE = "billing.dunning";

/** The queue the billing sweep runs on (0318). Daily, on the dunning cron: a
 *  bill falls due on a DAY, and its own name keeps a failure in one sweep from
 *  silencing the other. */
export const BILLING_QUEUE = "billing.dues";

/** The weekly summary of pending advances to each firm's administrators
 *  (0322). Its own queue and its own HOURLY cron: each firm picks its own
 *  weekday and hour, and a failure here must not silence the daily bills. */
export const ADVANCE_DIGEST_QUEUE = "billing.advance-digest";
/** The notification outbox (0323): each firm's new ledger events become
 *  notifications. Every minute, on its own queue: a bell a day late is a bell
 *  nobody trusts, and a poisoned run must not hold up any billing sweep. */
export const NOTIFY_FANOUT_QUEUE = "notify.fanout";
/** The advance reminders in the bell (0323), on the advance summary's HOURLY
 *  cron: an advance turns overdue on a DAY, so an hour is plenty. */
export const NOTIFY_ADVANCE_QUEUE = "notify.advance-reminders";
/** Retention (0323), daily on the escalation cron. */
export const NOTIFY_PRUNE_QUEUE = "notify.prune";
/** The daily notification email (0324), on the advance summary's HOURLY cron:
 *  each firm picks its own hour, in its own zone. The urgent ones go on the
 *  outbox's every-minute queue, straight after the outbox writes them. */
export const NOTIFY_DIGEST_QUEUE = "notify.email-digest";

/** The queue the orchestrator sweep runs on. Its own name and its own cadence
 *  again — this one is minutes rather than hours or days, because what it is
 *  waiting for is not a clock but a colleague finishing a step. */
export const ORCHESTRATOR_QUEUE = "delivery.orchestrate";
/** The compliance calendar (T3.2): generate a year ahead, then raise a task for
 *  anything that has reached its internal target. Its own queue rather than a
 *  step inside the spawn sweep, because it runs on a different cadence — once a
 *  day rather than every few minutes — and because a firm's calendar failing
 *  must not stop its engagements being spawned. */
export const OBLIGATION_QUEUE = "delivery.obligations";
/** The escalation ladder (T4.5). Its own queue and its own cadence again, and
 *  the cadence is the argument: the rungs are counted in DAYS, so this runs
 *  once a morning — early enough that somebody still has a working day to act
 *  on what it says, and never so often that a partner is told the same thing
 *  twice before lunch. */
export const ESCALATION_QUEUE = "delivery.escalation";

/** The chaser (T4.4). Its own queue, on the escalation ladder's own cadence and
 *  for the same reason: it is a daily sweep over a firm's own rows, not a
 *  reaction to anything, and putting it on another queue would make one job's
 *  failure silence the other. */
export const CHASER_QUEUE = "delivery.chaser";

/** The proactive nudge (T6.7). Its own queue, and the reason is the one that
 *  keeps giving: a daily sweep over a firm's own rows whose failure must not
 *  silence a different daily sweep. It shares the escalation CRON — three
 *  once-a-morning sweeps do not need three knobs a firm has to think about
 *  separately to get one answer — but not the queue, because a poisoned job in
 *  one would stop the others. */
export const NUDGE_QUEUE = "delivery.nudge";

/**
 * The credential sweep: dead sessions and spent magic links, deleted.
 *
 * ── WHY IT IS HERE AND NOT ANYWHERE ELSE ───────────────────────────────────
 *
 * Nothing removed either, ever. `bib_app` held no DELETE grant on the two
 * tables (migration 0075 grants it, and says why these two are the exception to
 * this schema's no-deletes rule), so both grew without limit: every expired
 * session of everybody who has ever signed in, and every spent fifteen-minute
 * token since the product existed.
 *
 * PLATFORM-WIDE and not per firm, which makes it different from every other
 * sweep on this worker. Sessions and magic links are GLOBAL — identity is above
 * tenant — so there is no per-firm loop and no one firm's failure to isolate
 * from another's.
 *
 * On the escalation cron because once a day is far more often than a
 * thirty-day retention window needs, and a knob nobody will ever turn is worse
 * than a shared one.
 */
export const CREDENTIAL_SWEEP_QUEUE = "platform.credential-sweep";

/** The day's exchange rates (0345): PLATFORM-wide like the credential sweep,
 *  because a rate is public data and one fetch serves every firm. */
export const FX_REFRESH_QUEUE = "platform.fx-refresh";

/**
 * The queue the signature sweep runs on (0080): asks the e-sign provider how
 * every envelope still out has ended, and signs or withdraws the letter.
 *
 * On the ORCHESTRATOR's five-minute cron rather than a knob of its own. A
 * client who signs expects the firm to see it within minutes, not tomorrow,
 * and five minutes of polling per open envelope is well inside DocuSign's
 * rate limits for the volume a firm sends. A Connect webhook would make it
 * immediate; it is the sixth public route, and waits for its own argument.
 */
export const SIGNATURE_QUEUE = "commercial.signatures";

export interface WiredWorker {
  readonly pools: Pools;
  readonly queue: JobQueue;
  readonly scheduler: SchedulerService;
  readonly dunning: DunningService;
  readonly billing: BillingService;
  /** The advance bill's and the final bill's catch-up (0320, 0322). */
  readonly advanceBills: AdvanceBiller;
  readonly finalBills: FinalBiller;
  /** The weekly summary of pending advances to the admins (0322). */
  readonly advanceDigest: AdvanceDigest;
  /** The notification outbox and the advance reminders in the bell (0323). */
  readonly notifyFanout: NotificationFanout;
  readonly advanceReminders: AdvanceReminders;
  /** Advances raised before the letter (0363): the letter-signed catch-up,
   *  and the monthly reminder of what is still to be adjusted (Q047). */
  readonly adhocAdvances: AdhocAdvanceService;
  readonly adhocReminders: AdhocAdvanceReminders;
  /** Notifications by email: urgent at once, the rest daily (0324). */
  readonly notifyEmails: NotificationEmails;
  readonly orchestrator: OrchestratorService;
  readonly obligations: ObligationService;
  readonly escalations: EscalationService;
  readonly chaser: ChaserService;
  readonly nudges: NudgeService;
  readonly engagement: EngagementService;
  /** Register the queues and their cadences. Split from `wireWorker` so a test
   *  can build the graph without starting anything. */
  run(): Promise<void>;
}

export function wireWorker(cfg: Config, log: Logger): WiredWorker {
  const pools = createPools(cfg.db);

  // The same ledger service the API uses, constructed the same way: exactly one
  // implementation of the event contract per process, and no service reaching
  // the table around it. A job spawned by a cron is an event like any other,
  // and it names `system` as its actor because a clock did it.
  const ledger = new LedgerService({
    events: new PostgresEventStore(pools.app),
    ids: systemIds,
  });

  // ONE adapter, two ports again: the job table is the scheduler's own, and the
  // activation feed is a read of the ledger. Both are tenant-scoped reads, so
  // they belong to the same RLS-aware adapter rather than to two.
  const jobs = new PostgresJobRepository(pools.app);

  // Constructed above the scheduler, because the work-item service below needs
  // it and the scheduler needs the work-item service. ONE adapter over the
  // config tables in this process, exactly as in the API: the orchestrator's
  // templates, its confidence tiers, its verification policies and the work
  // item's review policies are all config reads, and two adapters would
  // eventually disagree about what "published" means.
  const configRepository = new PostgresConfigRepository(pools.app);
  const memberships = new PostgresMembershipRepository(pools.app);

  // T3.1 — THE TASKS a spawned job puts on people's desks.
  //
  // The worker constructs the same graph the API does, from the same adapters,
  // because this is the process that actually calls it: the sweep spawns a job
  // and hands the engagements it just linked to `spawnForEngagements`. A
  // work-item service that differed between the two processes would put a
  // filing on one desk when the cron ran it and another when a person did.
  const workVocabularyRepository = new PostgresWorkVocabularyRepository(pools.app);
  const workItems: WorkItemService = new WorkItemService({
    items: new PostgresWorkItemRepository(pools.app),
    approvals: new PostgresWorkItemApprovalRepository(pools.app),
    vocabulary: workVocabularyRepository,
    clients: new PostgresPartyRepository(pools.app),
    staff: memberships,
    // G3.2's adapter, asked the one question the acceptance line turns on: who
    // does this client talk to about this Dept's work, on the day the work
    // begins.
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
    axes: new PostgresServiceAxisRepository(pools.app),
    policies: configRepository,
    reviewers: memberships,
    permissions: configRepository,
    engagements: new PostgresEngagementWorkSource(pools.app),
    // Only the API asks for a letter's routing preview; the worker holds the
    // same adapter so the two services are built from one list.
    letters: new PostgresLetterWorkSource(pools.app),
    // T3.2, and it matters MORE here than in the API: this is the process that
    // actually spawns engagement tasks, so a worker whose coverage check
    // disagreed with the API's would put a duplicate on somebody's desk exactly
    // when nobody was watching.
    obligations: new PostgresObligationCoverage(pools.app),
    // The return leg, wired exactly as the API wires it — see `setup/server.ts`
    // for why the closure is what breaks the cycle. It must exist in BOTH
    // processes for this file's own stated reason: a work-item service that
    // behaved differently here would file an obligation when a person ticked a
    // task and not when the worker did.
    // Built once for both processes in `setup/filing-link.ts` (CA#36).
    filings: obligationFilingPort(() => obligations),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE COMPLIANCE CALENDAR (T3.2) — the sweep that materialises it, and the
  // one that turns an obligation into a task at T-X.
  //
  // The same service the API holds, from the same adapters, for the reason
  // stated above the work-item service: a calendar that generated differently
  // in the worker than it reads in the browser is one nobody could debug.
  const obligations: ObligationService = new ObligationService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    templates: new PostgresObligationTemplateRepository(pools.app),
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

  const scheduler = new SchedulerService({
    jobs,
    activations: jobs,
    // T6.13 — the same adapter in its third role: which engagements recur,
    // and which periods each already has a job for.
    recurring: jobs,
    // The floor and the financial year, off the compliance policy: the same
    // config adapter — and the same instance — the calendar sweep reads, so
    // the two sweeps cannot disagree about when the firm went live.
    compliancePolicy: configRepository,
    timeZone: new PostgresFirmTimeZone(pools.app),
    // The one read in this process that is not inside a tenant context, because
    // `tenancy.tenant` is GLOBAL. It returns ids and nothing else; every read
    // that follows is scoped to one of them.
    tenants: new PostgresTenantDirectory(pools.app),
    // ONE adapter satisfying two ports declared in two use cases — the shape
    // AxisDirectory and RoleDirectory already have. `usecase/serviceaxis` owns
    // the write side of this setting; the scheduler reads it, and neither
    // imports the other.
    splitAxis: new PostgresWorkSplitSetting(pools.app),
    // T3.1. The tasks ride on the spawn because "work became owed" is ONE fact:
    // a second sweep would leave a job showing no tasks for as long as it was
    // behind, which is a board that says a client is being looked after when
    // nobody has it.
    workItems,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // CHASING RECEIVABLES runs here rather than in the API for the reason every
  // sweep does: it is work nobody asked for, on a clock, across every firm. The
  // API's own composition root builds a DunningService too — for the half a
  // PARTNER drives, deciding a terminal rung — and the two are separate graphs
  // because a worker and an API are separate processes.
  const invoiceRepository = new PostgresInvoiceRepository(pools.app);
  const dunning = new DunningService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    dunning: new PostgresDunningRepository(pools.app),
    ladders: new PostgresDunningLadder(pools.app),
    invoices: invoiceRepository,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // BILLING DUES (0318): what each recurring engagement owes a bill for, for
  // every firm that turned auto-billing on. It writes dues, never invoices —
  // an invoice draws a gapless number and is a person's act.
  const billing = new BillingService({
    dues: new PostgresBillingDueWriter(pools.app),
    managers: new PostgresBillingManagerFacts(pools.app),
    firms: new PostgresAutoBillingFirms(pools.app),
    fiscalYears: configRepository,
    timeZones: new PostgresFirmTimeZone(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE ADVANCE AND THE FINAL BILL (0320, 0322). The advance bill is written
  // and its invoice DRAFTED at signing (this process settles e-signed letters)
  // and caught up daily for every firm, whatever its switch says; the catch-up
  // also starts work signed before 0322 that still waits on its advance. Both
  // reach use cases composed further down, through closures called only once a
  // sweep runs. A one-time service's final bill is written when its job
  // finishes (the orchestrator below) and caught up daily for firms with the
  // switch on.
  const advanceBills: AdvanceBiller = new AdvanceBiller({
    facts: new PostgresAdvanceBillFacts(pools.app),
    dues: new PostgresBillingDueWriter(pools.app),
    managers: new PostgresBillingManagerFacts(pools.app),
    ids: systemIds,
    events: ledger,
    drafter: {
      draftAdvance: (tenantId, dueId, actor) => billingDesk.draftAdvance(tenantId, dueId, actor),
    },
    work: {
      startWaitingWork: (tenantId, letterId, actor): Promise<{ readonly started: number }> =>
        engagement.startWaitingWork(tenantId, letterId, actor),
    },
  });
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

  // THE THIRD SWEEP (T2.7). It shares the job repository with the scheduler on
  // purpose: the scheduler creates jobs and this one walks them, and two
  // adapters over `delivery.job` would eventually disagree about what "runnable"
  // means — which is the one thing both of them turn on.
  // ONE config repository, in three roles: the template source, the tier source
  // and the catalogue. Two instances would be two adapters over the same table
  // free to disagree about what is published — and one of the two answers here
  // decides whether a machine may act with nobody watching.

  const orchestrator = new OrchestratorService({
    // A finished job may make a one-time service's final bill due (0320).
    jobDone: finalBills,
    // A cancelled job closes its tasks through the work-item module (V2.4).
    jobTasks: workItems,
    timeZones: new PostgresFirmTimeZone(pools.app),
    jobs,
    steps: new PostgresJobStepRepository(pools.app),
    // The config repository, in its `TemplateSource` role. The same class the
    // API reads roles and services through — one adapter over `config`, so what
    // is published is one answer rather than two that agree by luck.
    templates: configRepository,
    subjects: new PostgresJobSubjectRepository(pools.app),
    // There are no agents. Not a stub standing in for something missing — a
    // true statement about this product today, which is why it is not gated on
    // config the way the dev auth resolver is. Every step waits for a person,
    // and the firm's work runs. T2.8 replaces this line.
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

  // THE FIFTH SWEEP (T4.5) — the ladder that tells somebody the firm's OWN
  // work has gone quiet.
  //
  // Deliberately NOT wired through `agents`, even though A9 sits under Phase 4
  // with the agent capabilities. `AgentRuntime.run` is step-scoped
  // (`{ tenantId, jobId, stepKey }`) and this has neither a job nor a step —
  // "no human trigger" is its own line on the board — and it produces no
  // proposal, so there is no confidence for a tier to govern. Forcing it
  // through would mean a fake job and a confidence of 1.0 for arithmetic over
  // two dates, and that number would then sit in the accuracy record making the
  // real agents look better than they are. See `usecase/escalation/service.ts`.
  //
  // `memberships` a third time in this file, and that is the point of the port:
  // one notion of who works here, so who may be ESCALATED to cannot disagree
  // with who may CHECK work or who may be given it.
  // See the note in `setup/server.ts`: no mailer, deliberately. Until P10 there
  // is no channel, so a chase raises the reminder and the portal shows it.
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

  // NO MAILER HERE EITHER, for the chaser's own reason: transport is P10, so a
  // nudge raises the reminder and the client's filings list shows it. No
  // `freezes` port either, and that is the decision rather than an omission —
  // 0067 states both halves: a statutory date is the LAW's and travels whether
  // or not a fee is in dispute, and a freeze is keyed on `client_party_id` while
  // an obligation carries `entity_party_id`.
  // The credential sweep's one dependency. Deliberately not a whole
  // IdentityService: that one is wired with a mailer, a hasher and a ledger to
  // serve requests, and none of it has anything to do with deleting spent keys.
  const credentialSweeper = new CredentialSweeper({
    sessions: new PostgresSessionRepository(pools.app),
    clock: systemClock,
  });

  const nudges = new NudgeService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    tenants: new PostgresNudgeTenants(pools.app),
    ladders: new PostgresNudgeLadder(pools.app),
    candidates: new PostgresNudgeCandidates(pools.app),
    nudges: new PostgresNudgeRepository(pools.app),
    clock: systemClock,
    events: ledger,
  });

  const escalations = new EscalationService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    ladders: new PostgresEscalationLadder(pools.app),
    notices: new PostgresEscalationNoticeRepository(pools.app),
    subjects: new PostgresEscalationSubjects(pools.app),
    staff: memberships,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  // THE SIGNATURE SWEEP (0080). The same use case the API signs through, so
  // a letter the client signed in DocuSign is signed by exactly the code a
  // person recording it would run — verifier, hash, fan-out, activation.
  //
  // It is composed with NO renderer: this process settles envelopes and never
  // raises one (`letterPdf: null`). The drafting-side ports are the real
  // adapters rather than stand-ins, because a stand-in that threw would be a
  // stub waiting for somebody to call it; they cost a constructor each.
  const esign = esignFor(cfg, log);
  // THE DAY'S EXCHANGE RATES (0345), fetched once for every firm.
  const fx = fxServiceFor(cfg, pools.app, systemClock);
  const documentRepository = new PostgresDocumentRepository(pools.app);
  const documents = new DocumentService({
    preferences: documentRepository,
    refs: documentRepository,
    standardBlocks: new PostgresStandardBlockRepository(pools.app),
    blocks: new PostgresDocumentBlockRepository(pools.app),
    ids: systemIds,
    events: ledger,
  });
  // THE DOCUMENT STORE, for the signed copies the sweep files (0080) — the
  // first worker task that stores a document, which is the trigger iam.tf
  // named for giving this process the bucket. The same adapters the API
  // composes, so a signed copy filed here is the document the API serves.
  const blobs = blobStoreFor(cfg);
  // ONE instance, shared with the engagement service's brand-asset lookup (0081).
  const documentStore = new PostgresDocumentStoreRepository(pools.app);
  const fileStore = new FileStoreService({
    documents: documentStore,
    blobs,
    digest: new Sha256ByteDigest(),
    ids: systemIds,
    events: ledger,
    maxUploadBytes: cfg.storage.maxUploadBytes,
    renderer: new PdfLibRenderer(),
    renderSource: new PostgresRenderSource(pools.app, (i) => blobs.get(i)),
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
  });
  const tenantRepository = new PostgresTenantRepository(pools.app);
  const workerSignatories = new PostgresSignatoryRepository(pools.app);
  const workerParties = new PostgresPartyRepository(pools.app);

  // THE ADVANCE'S DRAFT AND ITS REMINDERS (0322). The same invoice service and
  // billing desk the API composes, from the same adapters: a draft this process
  // makes (an e-signed letter, the catch-up) obeys every rule a person's does,
  // and is numbered only when an admin issues it.
  const invoices = new InvoiceService({
    timeZones: new PostgresFirmTimeZone(pools.app),
    firmEntities: documents,
    parties: workerParties,
    invoices: invoiceRepository,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
    issuedCopies: invoiceIssuedCopies(fileStore, log),
    staff: memberships,
    // Reporting currency, financial year start and payment terms (audit 2026-10-03).
    settings: new PostgresInvoiceFirmSettings(pools.app),
  });
  const advancePolicy = new PostgresAdvancePolicy(pools.app);
  const taxDefaults = new PostgresIssuerTaxDefaults(pools.app);
  const billingDesk = new BillingDeskService({
    desk: new PostgresBillingDueDesk(pools.app),
    invoices: {
      prepareDraft: (input) => invoices.prepareDraft(input),
      prepareLine: (draft, input) => invoices.prepareLine(draft, input),
      recordRaised: (invoice, actor) => invoices.recordRaised(invoice, actor),
      find: (tenantId, invoiceId) => invoiceRepository.find(tenantId, invoiceId),
      issueCreditNote: (input, actor) => invoices.issueCreditNote(input, actor),
    },
    schedules: new PostgresBillingSchedules(pools.app),
    setting: new PostgresAutoBillingSetting(pools.app),
    fiscalYears: configRepository,
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
    events: ledger,
    taxDefaults,
    policy: advancePolicy,
    firmEntities: documents,
  });
  const reminderFacts = new PostgresAdvanceReminderFacts(pools.app);
  const advanceDesk = new AdvanceDesk({
    desk: new PostgresBillingDueDesk(pools.app),
    policy: advancePolicy,
    people: reminderFacts,
    taxDefaults,
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
  });
  // THE WEEKLY SUMMARY is the first letter a sweep sends, so this process
  // holds a mailer now, built exactly as the API's (run_worker.tf gives it the
  // relay's password since 0322).
  const advanceDigest = new AdvanceDigest({
    store: new PostgresAdvanceDigestStore(pools.app),
    advances: advanceDesk,
    people: reminderFacts,
    policy: advancePolicy,
    mailer: mailerFor(cfg, log),
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
    events: ledger,
    advancesUrl: `${cfg.auth.appBaseUrl.replace(/\/+$/, "")}/invoices?tab=advances`,
  });
  // NOTIFICATIONS (0323). Who may check a piece of work is asked of the two
  // modules that own the rule (T2.9), never re-derived here.
  const notifyOutbox = new PostgresNotificationOutbox(pools.app);
  const notifyDirectory = new PostgresNotifyDirectory(pools.app);
  const notifySettings = new PostgresNotificationSettings(pools.app);
  const notifyFanout = new NotificationFanout({
    outbox: notifyOutbox,
    directory: notifyDirectory,
    checkers: {
      async workItemCheckers(tenantId, approvalId) {
        return (await workItems.eligibleCheckers(tenantId, approvalId)).filter((c) => c.eligible).map((c) => c.userId);
      },
      async stepCheckers(tenantId, approvalId) {
        return (await orchestrator.eligibleCheckers(tenantId, approvalId)).filter((c) => c.eligible).map((c) => c.userId);
      },
    },
    permissions: configRepository,
    settings: notifySettings,
    clock: systemClock,
  });
  const notifyEmails = new NotificationEmails({
    store: new PostgresNotificationEmailStore(pools.app),
    settings: notifySettings,
    mailer: mailerFor(cfg, log),
    timeZones: new PostgresFirmTimeZone(pools.app),
    clock: systemClock,
    appBaseUrl: cfg.auth.appBaseUrl,
  });
  const advanceReminders = new AdvanceReminders({
    outbox: notifyOutbox,
    advances: advanceDesk,
    directory: notifyDirectory,
    permissions: configRepository,
    settings: notifySettings,
  });
  // ADVANCES RAISED BEFORE THE LETTER (0363). This process settles e-signed
  // letters, so it maps what they named; and it reminds monthly (Q047).
  const adhocAdvances = new AdhocAdvanceService({
    store: new PostgresAdhocAdvanceStore(pools.app),
    invoices: {
      prepareDraft: (input) => invoices.prepareDraft(input),
      prepareLine: (draft, input) => invoices.prepareLine(draft, input),
      recordRaised: (invoice, actor) => invoices.recordRaised(invoice, actor),
      find: (tenantId, invoiceId) => invoiceRepository.find(tenantId, invoiceId),
      issueCreditNote: (input, actor) => invoices.issueCreditNote(input, actor),
    },
    taxDefaults,
    managers: new PostgresBillingManagerFacts(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });
  const notifyEmailStore = new PostgresNotificationEmailStore(pools.app);
  const adhocReminders = new AdhocAdvanceReminders({
    outbox: notifyOutbox,
    advances: { list: (tenantId, filters) => adhocAdvances.list(tenantId, filters) },
    directory: notifyDirectory,
    permissions: configRepository,
    settings: notifySettings,
    timing: {
      dayFor: (tenantId) => advancePolicy.unmappedDayFor(tenantId),
      timeZoneFor: (tenantId) => new PostgresFirmTimeZone(pools.app).timeZoneFor(tenantId),
      digestHour: (tenantId) => notifyEmailStore.digestHour(tenantId),
    },
    clock: systemClock,
  });

  const engagement: EngagementService = new EngagementService({
    // 0320: and writes the advance bill it owes.
    advanceBilling: advanceBills,
    // 0363: and maps the advances it named as received.
    namedAdvances: adhocAdvances,
    // CA#24: a signed letter's filings reach the calendar at once, through the
    // nightly sweep's own generator, not tonight.
    calendar: obligations,
    // 0319: an e-signed letter settled here sets its engagements' billing
    // schedules from its terms, exactly as one signed on the server does.
    goLiveBilling: new GoLiveScheduler({
      schedules: new PostgresBillingSchedules(pools.app),
      setting: new PostgresAutoBillingSetting(pools.app),
      fiscalYears: configRepository,
      calendars: new PostgresFirmTimeZone(pools.app),
      events: ledger,
    }),
    letters: new PostgresEngagementRepository(pools.app),
    library: configRepository,
    documents,
    parties: workerParties,
    // Only `send` asks who binds the firm, and this process never sends. Read
    // from the tenant row directly — the same two columns TenancyService reads
    // — because TenancyService's own graph (seeders for roles, grades,
    // vocabularies and rule packs) is a firm-provisioning concern this process
    // has no business composing.
    firm: {
      firmSignatory: async (tenantId) => {
        const tenant = await tenantRepository.findById(tenantId);
        return tenant?.firmSignatoryUserId && tenant.firmSignatoryTitle
          ? { userId: tenant.firmSignatoryUserId, title: tenant.firmSignatoryTitle }
          : null;
      },
      // The list (0343), from its own table for the same reason: never asked
      // here, but answered truthfully the day something is.
      signatory: async (tenantId, signatoryId) => {
        const entry = await workerSignatories.find(tenantId, signatoryId);
        if (entry === null) return null;
        const tenant = await tenantRepository.findById(tenantId);
        return {
          id: entry.id,
          userId: entry.userId,
          displayName: null,
          title: entry.title,
          signatureVersionId: entry.signatureVersionId,
          isActive: entry.isActive,
          isDefault: tenant?.firmSignatoryUserId === entry.userId,
        };
      },
    },
    // Never called here — this process does not send — but wired to the real
    // store rather than to a stub returning null, which would be a quiet lie
    // about which signature is in force the day something else calls `send`.
    firmSignatureImage: {
      activeSignatureVersion: async (tenantId, entityPartyId) => {
        const assets = await documentStore.activeBrandAssets(tenantId, entityPartyId);
        return assets.find((a) => a.asset.kind === "signature")?.version.id ?? null;
      },
    },
    quotes: new ProposalService({
      proposals: new PostgresProposalRepository(pools.app),
      catalogue: configRepository,
      policies: configRepository,
      parties: workerParties,
      // The worker only reads quotes and never drafts one, but the service's
      // deps are whole: one adapter, the same question the API asks.
      leads: new PostgresLeadRepository(pools.app),
      documents,
      shareTokens: new RandomTokenFactory(),
      structure: new PostgresRelationshipRepository(pools.app),
      timeZones: new PostgresFirmTimeZone(pools.app),
      staff: memberships,
      // NO MAILER, for the chaser's reason and one of its own: this process
      // holds no SMTP password (run_worker.tf) and only ever READS a quote
      // here. An email asked of it is refused by name, before anything moves
      // (0085). The PDF and the links are the real ones, so the graph is the
      // one the API composes.
      mailer: null,
      pdfs: proposalPdfs(fileStore),
      links: proposalLinks(cfg.auth.appBaseUrl),
      ids: systemIds,
      clock: systemClock,
      events: ledger,
    }),
    // Drafting is the API's; the worker settles envelopes and never drafts. The
    // same adapters anyway, so the graph is the one the API composes.
    structure: new PostgresRelationshipRepository(pools.app),
    timeZones: new PostgresFirmTimeZone(pools.app),
    esign: esign.signer,
    migrationSigner: new AttestedSigner(),
    hasher: new Sha256ContentHasher(),
    signatures: new PostgresSignatureRequestRepository(pools.app),
    dispatch: esign.dispatch,
    letterPdf: null,
    signedCopies: signedCopyFiler(fileStore),
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });

  const queue = new BossJobQueue({ connectionString: cfg.db.appUrl, log });

  return {
    pools,
    queue,
    scheduler,
    dunning,
    billing,
    advanceBills,
    finalBills,
    advanceDigest,
    notifyFanout,
    advanceReminders,
    adhocAdvances,
    adhocReminders,
    notifyEmails,
    orchestrator,
    obligations,
    escalations,
    chaser,
    nudges,
    engagement,
    async run(): Promise<void> {
      await queue.start();
      await queue.register(SPAWN_QUEUE, async () => {
        // A failed firm is logged first, whatever it spawned (B32): see
        // `sweep-log.ts`.
        logSpawnSweep(log, await scheduler.sweepActivations());
      });
      await queue.schedule(SPAWN_QUEUE, cfg.worker.spawnCron);

      await queue.register(DUNNING_QUEUE, async () => {
        logDunningSweep(log, await dunning.sweep());
      });
      await queue.schedule(DUNNING_QUEUE, cfg.worker.dunningCron);

      await queue.register(BILLING_QUEUE, async () => {
        for (const r of await billing.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "billing sweep could not visit firm");
            continue;
          }
          if (r.created === 0 && r.alreadyDue === 0 && r.awaitingFiscalYear === 0) continue;
          // `awaitingFiscalYear` is logged because it is a bill that will never
          // fall due until a partner says when the firm's year starts.
          log.info(
            { tenantId: r.tenantId, created: r.created, alreadyDue: r.alreadyDue, awaitingFiscalYear: r.awaitingFiscalYear },
            "billing sweep",
          );
        }
        // The advance's catch-up (0322: start waiting work, write, draft) and
        // the final bill's (0320), on the same day.
        for (const r of await advanceBills.catchUp()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "advance catch-up could not visit firm");
          } else if (r.created > 0 || r.drafted > 0 || r.started > 0) {
            log.info(
              { tenantId: r.tenantId, created: r.created, drafted: r.drafted, started: r.started },
              "advance catch-up",
            );
          }
        }
        // Letters signed with advances named as received (0363), mapped if
        // signing could not: every firm, whatever its switch.
        for (const tenantId of await notifyOutbox.activeTenantIds()) {
          try {
            const r = await adhocAdvances.mapNamedOnSigning({ tenantId }, SYSTEM_ACTOR);
            if (r.mapped > 0) log.info({ tenantId, mapped: r.mapped }, "named advances mapped");
          } catch (err) {
            log.error({ tenantId, failure: err instanceof Error ? err.message : String(err) }, "named advances could not be mapped");
          }
        }
        for (const r of await finalBills.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "final bill catch-up could not visit firm");
          } else if (r.created > 0) {
            log.info({ tenantId: r.tenantId, created: r.created }, "final bills written");
          }
        }
      });
      await queue.schedule(BILLING_QUEUE, cfg.worker.dunningCron);

      await queue.register(ADVANCE_DIGEST_QUEUE, async () => {
        for (const r of await advanceDigest.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, weekOf: r.weekOf, failure: r.failure }, "advance summary could not visit firm");
          } else {
            log.info(
              { tenantId: r.tenantId, weekOf: r.weekOf, advances: r.advances, recipients: r.recipients },
              "advance summary",
            );
          }
        }
      });
      await queue.schedule(ADVANCE_DIGEST_QUEUE, cfg.worker.advanceDigestCron);

      await queue.register(NOTIFY_FANOUT_QUEUE, async () => {
        for (const r of await notifyFanout.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "notification fan-out could not visit firm");
          } else if (r.created > 0 || r.resolved > 0) {
            log.info({ tenantId: r.tenantId, events: r.events, created: r.created, resolved: r.resolved }, "notifications");
          }
        }
        // The urgent ones by email, straight after they were written.
        for (const r of await notifyEmails.sweepInstant()) {
          if (r.failure !== undefined) log.error({ tenantId: r.tenantId, failure: r.failure }, "urgent notification emails could not visit firm");
          else log.info({ tenantId: r.tenantId, letters: r.letters, notifications: r.notifications, refused: r.refused }, "urgent notification emails");
        }
      });
      await queue.schedule(NOTIFY_FANOUT_QUEUE, cfg.worker.notifyCron);

      await queue.register(NOTIFY_ADVANCE_QUEUE, async () => {
        for (const r of await advanceReminders.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "advance reminders could not visit firm");
          } else {
            log.info({ tenantId: r.tenantId, created: r.created, resolved: r.resolved }, "advance reminders");
          }
        }
        // Advances still to be adjusted, monthly (0363, Q047), on the same cron.
        for (const r of await adhocReminders.sweep()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "unmapped advance reminders could not visit firm");
          } else {
            log.info({ tenantId: r.tenantId, month: r.month, created: r.created, resolved: r.resolved }, "unmapped advance reminders");
          }
        }
      });
      await queue.schedule(NOTIFY_ADVANCE_QUEUE, cfg.worker.advanceDigestCron);

      await queue.register(NOTIFY_DIGEST_QUEUE, async () => {
        for (const r of await notifyEmails.sweepDigests()) {
          if (r.failure !== undefined) log.error({ tenantId: r.tenantId, failure: r.failure }, "daily notification emails could not visit firm");
          else log.info({ tenantId: r.tenantId, letters: r.letters, notifications: r.notifications, refused: r.refused }, "daily notification emails");
        }
      });
      await queue.schedule(NOTIFY_DIGEST_QUEUE, cfg.worker.advanceDigestCron);

      await queue.register(ORCHESTRATOR_QUEUE, async () => {
        logOrchestratorSweep(log, await orchestrator.sweep());
      });
      await queue.schedule(ORCHESTRATOR_QUEUE, cfg.worker.orchestratorCron);

      await queue.register(SIGNATURE_QUEUE, async () => {
        for (const r of await engagement.settleSignatures()) {
          if (r.failure !== undefined) {
            log.error({ tenantId: r.tenantId, failure: r.failure }, "signature sweep could not visit firm");
            continue;
          }
          // One line per letter that could not be settled, because each is a
          // letter somebody will ask about: signed in DocuSign and not here.
          for (const f of r.failed) {
            log.warn({ tenantId: r.tenantId, letterId: f.letterId, reason: f.reason }, "signature not settled");
          }
          if (r.signed === 0 && r.withdrawn === 0 && r.copiesFiled === 0) continue;
          log.info(
            {
              tenantId: r.tenantId,
              signed: r.signed,
              withdrawn: r.withdrawn,
              stillOut: r.stillOut,
              copiesFiled: r.copiesFiled,
            },
            "signature sweep",
          );
        }
      });
      await queue.schedule(SIGNATURE_QUEUE, cfg.worker.orchestratorCron);

      await queue.register(OBLIGATION_QUEUE, async () => {
        const reports = await obligations.sweep();
        for (const r of reports) {
          if (r.failure !== undefined) {
            // One firm's failure never stops the others — T3.1's lesson, and
            // it is REPORTED rather than swallowed, because a firm silently
            // skipped forever is worse than a sweep that stops.
            log.error({ tenantId: r.tenantId, failure: r.failure }, "obligation sweep failed");
            continue;
          }
          if (r.created === 0 && r.restored === 0 && r.raised === 0 && r.uncoveredEngagements === 0) {
            continue;
          }
          // `uncoveredEngagements` is the number nobody would think to log and
          // is the one that matters: engagements the firm is delivering that the
          // calendar produced NOTHING for. Most are perfectly ordinary advisory
          // work; some are a rule the firm has not finished writing, and the
          // coverage screen says which is which. Logging it means the hole is
          // visible from the worker as well as from the browser.
          log.info(
            {
              tenantId: r.tenantId,
              created: r.created,
              // Withdrawn filings a linked service proposed again (T6.16).
              restored: r.restored,
              raised: r.raised,
              uncoveredEngagements: r.uncoveredEngagements,
              rulesWithNoSubjects: r.rulesWithNoSubjects.length,
            },
            "obligation sweep",
          );
        }
      });
      await queue.schedule(OBLIGATION_QUEUE, cfg.worker.obligationCron);

      await queue.register(ESCALATION_QUEUE, async () => {
        const reports = await escalations.sweep();
        for (const r of reports) {
          if (r.failure !== undefined) {
            // One firm's org chart never stops the others. The obligation
            // sweep's arrangement, and T3.1's lesson before it.
            log.error({ tenantId: r.tenantId, failure: r.failure }, "escalation sweep failed");
            continue;
          }
          if (r.raised === 0 && r.alreadyRaised === 0) continue;
          // `unresolved` is the number nobody would think to log and the one
          // somebody has to act on: rungs that fired and reached NOBODY,
          // because the firm has no reporting line above that person or nobody
          // holds the grade the rung names. The notice is in the queue either
          // way; this makes the hole visible from the worker too.
          log.info(
            {
              tenantId: r.tenantId,
              raised: r.raised,
              alreadyRaised: r.alreadyRaised,
              unresolved: r.unresolved,
            },
            "escalation sweep",
          );
        }
      });
      await queue.schedule(ESCALATION_QUEUE, cfg.worker.escalationCron);

      // THE CHASER, on the escalation ladder's own cron. Both are daily sweeps
      // over a firm's own rows and neither reacts to anything, so a second knob
      // would be a setting a firm has to think about twice to get one answer.
      await queue.register(CHASER_QUEUE, async () => {
        const reports = await chaser.sweep();
        for (const r of reports) {
          if (r.failure !== undefined) {
            // One firm's bad data never stops the others — T3.1's lesson again.
            log.error({ tenantId: r.tenantId, failure: r.failure }, "chaser sweep failed");
            continue;
          }
          if (r.sent === 0 && r.alreadySent === 0 && r.frozen === 0) continue;
          // `frozen` is the number nobody would think to log and the one that
          // explains a quiet week: a sweep that sent nothing because every
          // client is frozen and one that sent nothing because it is broken
          // look identical from the outside.
          log.info(
            {
              tenantId: r.tenantId,
              sent: r.sent,
              alreadySent: r.alreadySent,
              frozen: r.frozen,
            },
            "chaser sweep",
          );
        }
      });
      await queue.schedule(CHASER_QUEUE, cfg.worker.escalationCron);

      // THE NUDGE, on the same cron and its own queue. See NUDGE_QUEUE.
      await queue.register(NUDGE_QUEUE, async () => {
        const reports = await nudges.sweep();
        for (const r of reports) {
          if (r.failure !== undefined) {
            // One firm's bad calendar never stops the others — T3.1's lesson,
            // where one firm with no work states stopped the calendar for every
            // firm after it in the list.
            log.error({ tenantId: r.tenantId, failure: r.failure }, "nudge sweep failed");
            continue;
          }
          if (r.sent === 0 && r.alreadySent === 0) continue;
          log.info(
            { tenantId: r.tenantId, sent: r.sent, alreadySent: r.alreadySent },
            "nudge sweep",
          );
        }
      });
      await queue.schedule(NUDGE_QUEUE, cfg.worker.escalationCron);

      // THE DAY'S EXCHANGE RATES. See FX_REFRESH_QUEUE. A feed that is down is
      // logged and left: the rates already held answer meanwhile, and the
      // read-through asks again when a rate box needs one.
      await queue.register(FX_REFRESH_QUEUE, async () => {
        const r = await fx.refresh();
        if (r.failure !== undefined) {
          log.error({ failure: r.failure }, "exchange-rate refresh failed");
          return;
        }
        log.info({ day: r.day, source: r.source, saved: r.saved }, "exchange-rate refresh");
      });
      await queue.schedule(FX_REFRESH_QUEUE, cfg.worker.fxCron);

      // THE CREDENTIAL SWEEP. See CREDENTIAL_SWEEP_QUEUE: platform-wide rather
      // than per firm, because sessions and magic links are global.
      await queue.register(CREDENTIAL_SWEEP_QUEUE, async () => {
        const swept = await credentialSweeper.run();
        if (swept.sessions === 0 && swept.magicLinks === 0) return;
        log.info(
          { sessions: swept.sessions, magicLinks: swept.magicLinks },
          "swept dead sessions and magic links",
        );
      });
      await queue.schedule(CREDENTIAL_SWEEP_QUEUE, cfg.worker.escalationCron);

      await queue.register(NOTIFY_PRUNE_QUEUE, async () => {
        const pruned = await notifyFanout.prune();
        if (pruned > 0) log.info({ pruned }, "pruned old notifications");
      });
      await queue.schedule(NOTIFY_PRUNE_QUEUE, cfg.worker.escalationCron);
    },
  };
}
