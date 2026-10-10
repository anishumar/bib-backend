// The requests sweep (F1.4): the monthly ask, raised on its send day.
//
// A firm writes down once what it asks a client for every period, and when
// (`request_template`, F1.1); a step of its process names that list (F1.2).
// This sweep is what turns the two into asks on the client's page, one per item
// per period, through the ask module's own door (F1.3).
//
// ── TODAY IS THE FIRM'S DAY ──────────────────────────────────────────────
//
// `dayInZone(now, the firm's zone)`, resolved once per firm per pass (T6.14).
// The server's UTC day is yesterday in India until 05:30, and an item due to be
// asked "on the 1st" would otherwise wait for the next morning's run.
//
// ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ─────────────────────
//
// pg-boss redelivers and the next pass re-reads what this one saw. The read
// leaves out an item the job has already asked for, and 0385's unique index is
// the wall under it: two passes racing leave one ask and one
// `client_ask.raised`, which the ask module records only for a row it created.
//
// ── IT NEVER DOES ANYTHING ELSE ───────────────────────────────────────────
//
// No seam here can close, withdraw or change an ask, move a task or a job, or
// send anything: the deps below are reads and one raise. A client who sent the
// records already is answered by the firm closing the ask, never by a machine
// deciding they did.
import type { Clock } from "../../platform/clock";
import { dayInZone } from "../../domain/scheduler/zone";
import type { PublishedRequestTemplate, RequestSweepReport } from "../../domain/requests/model";
import { awaitsPin, emptyReport, planAsks, templateKeysToAsk } from "../../domain/requests/model";
import type {
  FirmTimeZone,
  PublishedRequestTemplateSource,
  RequestSubjectSource,
  RequestTenantDirectory,
  TemplateAskRaiser,
} from "./ports";

export interface Deps {
  readonly tenants: RequestTenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly subjects: RequestSubjectSource;
  readonly templates: PublishedRequestTemplateSource;
  /** The one write. `tests/requests/service.test.ts` pins this list, so a
   *  mailer or anything that could act on a task arriving here is a decision
   *  somebody takes, not a line somebody slips in. */
  readonly asks: TemplateAskRaiser;
  readonly clock: Clock;
}

export class RequestSweepService {
  constructor(private readonly deps: Deps) {}

  /** One pass over every active firm. */
  async sweep(): Promise<readonly RequestSweepReport[]> {
    const reports: RequestSweepReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      try {
        reports.push(await this.sweepTenant(tenantId));
      } catch (err) {
        // ONE FIRM'S FAILURE NEVER STOPS THE OTHERS — T3.1's lesson. Reported,
        // not swallowed: a firm silently skipped every morning is worse than a
        // sweep that stops.
        reports.push({
          ...emptyReport(tenantId),
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string): Promise<RequestSweepReport> {
    const today = dayInZone(
      this.deps.clock.now().toISOString(),
      await this.deps.timeZones.timeZoneFor(tenantId),
    );
    const subjects = await this.deps.subjects.periodJobs(tenantId);

    // ONE LOOKUP PER KEY PER FIRM PER PASS. Four hundred clients on one
    // process name one template; asking the registry four hundred times for the
    // same row is a pass nobody could reason about, and the cache also means
    // every job in this pass asks from the same version.
    const published = new Map<string, PublishedRequestTemplate | null>();
    const templateFor = async (key: string): Promise<PublishedRequestTemplate | null> => {
      const held = published.get(key);
      if (held !== undefined) return held;
      const read = await this.deps.templates.publishedByKey(tenantId, key);
      published.set(key, read);
      return read;
    };

    // Asked at most once per firm per pass, and only if an unpinned job makes
    // the answer matter.
    let usesTemplates: boolean | undefined;

    let raised = 0;
    let alreadyRaised = 0;
    let overdueOnRaise = 0;
    let noTemplate = 0;
    let awaitingPin = 0;

    for (const subject of subjects) {
      if (subject.pinnedVersionId === null) {
        // Tried again next pass: the orchestrator pins the process once the
        // period has ended (S7), and only the pinned body says which steps ask.
        // COUNTED only at a firm that asks clients for anything at all: at one
        // that has published no request template this number would be the
        // orchestrator's `awaitingTemplate` again, every morning, about asks
        // that could never exist.
        if (awaitsPin(subject, today)) {
          usesTemplates ??= await this.deps.templates.anyPublished(tenantId);
          if (usesTemplates) awaitingPin += 1;
        }
        continue;
      }
      for (const key of templateKeysToAsk(subject.steps)) {
        const template = await templateFor(key);
        if (template === null) {
          // The step names a list the firm has not published (or retired).
          // Counted, never guessed at: nothing is asked for this step.
          noTemplate += 1;
          continue;
        }
        const plan = planAsks(subject, template, today);
        alreadyRaised += plan.alreadyAsked;
        for (const ask of plan.toRaise) {
          const result = await this.deps.asks.raiseFromTemplate({
            tenantId,
            workItemId: ask.workItemId,
            prompt: ask.prompt,
            askKind: ask.askKind,
            documentKind: ask.documentKind,
            dueOn: ask.dueOn,
            template: ask.template,
          });
          if (!result.created) {
            // The unique index refused it: another pass got there first.
            alreadyRaised += 1;
            continue;
          }
          raised += 1;
          if (ask.overdue) overdueOnRaise += 1;
        }
      }
    }

    return { tenantId, raised, alreadyRaised, overdueOnRaise, noTemplate, awaitingPin };
  }
}
