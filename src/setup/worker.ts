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
import { WorkItemService } from "../usecase/workitem/service";
import { ObligationService } from "../usecase/obligation/service";
import { DunningService } from "../usecase/dunning/service";
import { EscalationService } from "../usecase/escalation/service";
import { ChaserService } from "../usecase/chaser/service";
import { PostgresFirmTimeZone } from "../infrastructure/postgres/firm-timezone-repository";
import { NudgeService } from "../usecase/nudge/service";
import { OrchestratorService } from "../usecase/orchestrator/service";
import { PostgresJobStepRepository } from "../infrastructure/postgres/job-step-repository";
import { PostgresJobSubjectRepository } from "../infrastructure/postgres/job-subject-repository";
import { PostgresConfigRepository } from "../infrastructure/postgres/config-repository";
import { PostgresPartyRepository } from "../infrastructure/postgres/party-repository";
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
import { PostgresObligationCoverage } from "../infrastructure/postgres/obligation-coverage";
import { PostgresEngagementWorkSource } from "../infrastructure/postgres/engagement-work-source";
import { NoAgentsBuiltYet } from "../infrastructure/agent/no-agents";
import { PostgresMembershipRepository } from "../infrastructure/postgres/membership-repository";
import { PostgresStepApprovalRepository } from "../infrastructure/postgres/step-approval-repository";
import { PostgresAgentRunRepository } from "../infrastructure/postgres/agent-run-repository";
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
import type { JobQueue } from "../usecase/scheduler/ports";

/** The queue the spawn sweep runs on. A name, because pg-boss keys a schedule
 *  by it — see `BossJobQueue.schedule`. */
export const SPAWN_QUEUE = "delivery.spawn";

/** The queue the dunning sweep runs on. Its own name and its own cadence: the
 *  ladder is counted in days and the spawn sweep in hours, and one queue doing
 *  both would have to run at the faster of the two. */
export const DUNNING_QUEUE = "billing.dunning";

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

export interface WiredWorker {
  readonly pools: Pools;
  readonly queue: JobQueue;
  readonly scheduler: SchedulerService;
  readonly dunning: DunningService;
  readonly orchestrator: OrchestratorService;
  readonly obligations: ObligationService;
  readonly escalations: EscalationService;
  readonly chaser: ChaserService;
  readonly nudges: NudgeService;
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
    axes: new PostgresServiceAxisRepository(pools.app),
    policies: configRepository,
    reviewers: memberships,
    permissions: configRepository,
    engagements: new PostgresEngagementWorkSource(pools.app),
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
    filings: {
      reconcileFiling: (tenantId, workItemId, discharged, actor): Promise<void> =>
        obligations.reconcileFiling(tenantId, workItemId, discharged, actor),
    },
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
    templates: new PostgresObligationTemplateRepository(pools.app),
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
    dunning: new PostgresDunningRepository(pools.app),
    ladders: new PostgresDunningLadder(pools.app),
    invoices: invoiceRepository,
    tenants: new PostgresTenantDirectory(pools.app),
    ids: systemIds,
    clock: systemClock,
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
    policies: configRepository,
    checkers: memberships,
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
    tenants: new PostgresNudgeTenants(pools.app),
    ladders: new PostgresNudgeLadder(pools.app),
    candidates: new PostgresNudgeCandidates(pools.app),
    nudges: new PostgresNudgeRepository(pools.app),
    clock: systemClock,
    events: ledger,
  });

  const escalations = new EscalationService({
    ladders: new PostgresEscalationLadder(pools.app),
    notices: new PostgresEscalationNoticeRepository(pools.app),
    subjects: new PostgresEscalationSubjects(pools.app),
    staff: memberships,
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
    orchestrator,
    obligations,
    escalations,
    chaser,
    nudges,
    async run(): Promise<void> {
      await queue.start();
      await queue.register(SPAWN_QUEUE, async () => {
        const reports = await scheduler.sweepActivations();
        for (const r of reports) {
          if (r.spawned === 0 && r.alreadySpawned === 0) continue;
          // `alreadySpawned` is logged rather than dropped: it is the number
          // that shows idempotency working. A sweep reporting spawned:0 and
          // alreadySpawned:40 is the system correctly doing nothing, which
          // looks identical to a broken sweep if it says nothing at all.
          log.info(
            { tenantId: r.tenantId, spawned: r.spawned, alreadySpawned: r.alreadySpawned },
            "spawn sweep",
          );
        }
      });
      await queue.schedule(SPAWN_QUEUE, cfg.worker.spawnCron);

      await queue.register(DUNNING_QUEUE, async () => {
        const reports = await dunning.sweep();
        for (const r of reports) {
          if (r.escalated === 0 && r.alreadyTaken === 0) continue;
          // `awaitingApproval` is logged because it is the number somebody has
          // to ACT on: the worker has climbed to a credit hold and stopped, and
          // nothing further happens until a partner decides.
          log.info(
            {
              tenantId: r.tenantId,
              escalated: r.escalated,
              alreadyTaken: r.alreadyTaken,
              awaitingApproval: r.awaitingApproval,
            },
            "dunning sweep",
          );
        }
      });
      await queue.schedule(DUNNING_QUEUE, cfg.worker.dunningCron);

      await queue.register(ORCHESTRATOR_QUEUE, async () => {
        const reports = await orchestrator.sweep();
        for (const r of reports) {
          if (r.started === 0 && r.advanced === 0 && r.awaitingTemplate === 0) continue;
          // `awaitingPeople` and `awaitingTemplate` are the two numbers somebody
          // has to ACT on, and they are different people: the first is work on
          // colleagues' desks, the second is a partner who has not written a
          // process yet. A sweep that logged only what it moved would say the
          // engine is idle when it is actually waiting on the firm.
          log.info(
            {
              tenantId: r.tenantId,
              started: r.started,
              advanced: r.advanced,
              awaitingPeople: r.awaitingPeople,
              completed: r.completed,
              awaitingTemplate: r.awaitingTemplate,
            },
            "orchestrator sweep",
          );
        }
      });
      await queue.schedule(ORCHESTRATOR_QUEUE, cfg.worker.orchestratorCron);

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
          if (r.created === 0 && r.raised === 0 && r.uncoveredEngagements === 0) continue;
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
    },
  };
}
