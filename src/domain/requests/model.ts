// The requests sweep (F1.4): which of a firm's monthly asks are due to be
// raised on which period job, today. Pure: no I/O, no clock, no `Date`.
//
// ── WHAT A SUBJECT IS ─────────────────────────────────────────────────────
//
// A PERIOD JOB (`delivery.job`, `source_kind = 'engagement_period'`, 0300): one
// period of one client's recurring work, walking the firm's pinned process. A
// step of that process may name a `request_template` by KEY (F1.2), and every
// item of the template PUBLISHED under that key is asked of the client once per
// period, on its send day, through the job's open task (an ask hangs off a work
// item, 0063).
//
// ── THE DAYS ARE THE FIRM'S, AND COUNT FROM THE PERIOD'S LAST DAY ─────────
//
// `requestDates` (domain/config) is the one rule for when an item is asked and
// when it is due. "Today" is the FIRM's calendar day, resolved by the service
// per firm per pass (T6.14): every comparison here is between two `YYYY-MM-DD`
// strings, which is a date comparison with no zone in it.
import type { DocumentKind } from "../filestore/model";
import type { StepStatus } from "../orchestrator/model";
import type { RequestAskKind, RequestTemplateBody } from "../config/model";
import { requestDates } from "../config/model";

/** One step of a period job's PINNED process, as the sweep needs it. */
export interface RequestStep {
  readonly stepKey: string;
  /** The `request_template` key the step names (F1.2), or null for none. */
  readonly requestTemplateKey: string | null;
  /**
   * The step's `job_step` row, or null when there is none yet. A period job's
   * steps are laid out when its period ENDS (S7), so a job read on its last day
   * may have no rows: null asks, because nothing has said the step will not
   * happen.
   */
  readonly status: StepStatus | null;
}

/** An item already asked for on this job, by any of its tasks. */
export interface AskedItem {
  readonly templateKey: string;
  readonly itemKey: string;
}

/** One period job the sweep may ask on. */
export interface RequestSubject {
  readonly jobId: string;
  /** The job's open task the asks hang off. */
  readonly workItemId: string;
  /** The period's LAST day, `YYYY-MM-DD`: what the offsets count from. */
  readonly periodEnd: string;
  /** The pinned `workflow_template` version, or null until the orchestrator
   *  pins the job's process. */
  readonly pinnedVersionId: string | null;
  /** The pinned process's steps. Empty when it is not pinned. */
  readonly steps: readonly RequestStep[];
  /** Template items already asked for on ANY task of this job. */
  readonly asked: readonly AskedItem[];
}

/** A request template as PUBLISHED now, under its key. */
export interface PublishedRequestTemplate {
  /** The `config.version` id every ask raised from it pins (0385). */
  readonly versionId: string;
  readonly key: string;
  readonly template: RequestTemplateBody;
}

/** One ask the sweep is about to raise. */
export interface AskToRaise {
  readonly workItemId: string;
  /** The item's label: what the client reads. */
  readonly prompt: string;
  readonly askKind: RequestAskKind;
  readonly documentKind: DocumentKind | null;
  /** `requestDates(periodEnd, item).dueOn`: the firm's own day, never moved. */
  readonly dueOn: string;
  readonly template: {
    readonly versionId: string;
    readonly templateKey: string;
    readonly itemKey: string;
  };
  /** Its due day is already behind the firm's today: the backlog. */
  readonly overdue: boolean;
}

/** What one template on one job comes to, today. */
export interface AskPlan {
  readonly toRaise: readonly AskToRaise[];
  /** Items whose send day has come and that this job has already asked for. */
  readonly alreadyAsked: number;
}

/** One firm's pass. Every number is a count of asks or of jobs, never money. */
export interface RequestSweepReport {
  readonly tenantId: string;
  /** Asks created on this pass. */
  readonly raised: number;
  /**
   * Items due that were ALREADY asked on their job: seen by the read, or
   * refused by 0385's unique index when two passes raced. The number that shows
   * idempotency working; it grows with every open job and is not a fault.
   */
  readonly alreadyRaised: number;
  /** Of `raised`, the asks whose due day had already passed when raised. */
  readonly overdueOnRaise: number;
  /** (job, step template key) pairs naming a key with no published template. */
  readonly noTemplate: number;
  /**
   * Jobs whose period has ended (or ends today) with no process pinned yet, at
   * a firm that has published a request template. At a firm that has published
   * none, nothing could be asked whatever the job pinned, and the orchestrator
   * already reports a job waiting for its process (`awaitingTemplate`).
   */
  readonly awaitingPin: number;
  readonly failure?: string;
}

/** The empty report: what a firm with nothing to ask comes to. */
export function emptyReport(tenantId: string): RequestSweepReport {
  return {
    tenantId,
    raised: 0,
    alreadyRaised: 0,
    overdueOnRaise: 0,
    noTemplate: 0,
    awaitingPin: 0,
  };
}

/**
 * Is this job's process still unpinned at a moment it could matter?
 *
 * Only once its period has ended, or ends today. Before then no item can be
 * due: every send offset counts from the period's last day and is at least 0.
 * Counting this month's jobs, which the orchestrator pins only once the month
 * is over (S7), would make the number permanently non-zero and so meaningless.
 * On the last day itself it is the S7 caveat: an offset-0 item is due and the
 * process is not pinned until the period ends, so it is asked a pass late.
 */
export function awaitsPin(subject: RequestSubject, today: string): boolean {
  return subject.pinnedVersionId === null && subject.periodEnd <= today;
}

/**
 * The template keys this job's steps ask for, in step order, each ONCE.
 *
 * A step that will not happen asks for nothing: `skipped` (a condition that
 * does not apply, or a person skipping it with a reason) and `failed`. Every
 * other state asks, including no row at all (see `RequestStep.status`). Two
 * steps naming one template ask once, because the item keys are one list.
 */
export function templateKeysToAsk(steps: readonly RequestStep[]): readonly string[] {
  const keys: string[] = [];
  for (const step of steps) {
    if (step.requestTemplateKey === null) continue;
    if (step.status === "skipped" || step.status === "failed") continue;
    if (!keys.includes(step.requestTemplateKey)) keys.push(step.requestTemplateKey);
  }
  return keys;
}

/**
 * Which of one template's items to raise on one job, today.
 *
 * An item is raised once the firm's today has reached its send day, and never
 * before; one this job already asked for is counted and left. There is no upper
 * bound: a job still open months after its period asks for that period's items
 * with their own due days, already past (`overdue`), because a late ask with
 * the firm's own day is the truth and a moved day would be one this product
 * invented (0385).
 */
export function planAsks(
  subject: RequestSubject,
  published: PublishedRequestTemplate,
  today: string,
): AskPlan {
  const toRaise: AskToRaise[] = [];
  let alreadyAsked = 0;
  for (const item of published.template.items) {
    const { sendOn, dueOn } = requestDates(subject.periodEnd, item);
    if (today < sendOn) continue;
    const asked = subject.asked.some(
      (a) => a.templateKey === published.key && a.itemKey === item.key,
    );
    if (asked) {
      alreadyAsked += 1;
      continue;
    }
    toRaise.push({
      workItemId: subject.workItemId,
      prompt: item.label,
      askKind: item.askKind,
      documentKind: item.documentKind,
      dueOn,
      template: { versionId: published.versionId, templateKey: published.key, itemKey: item.key },
      overdue: dueOn < today,
    });
  }
  return { toRaise, alreadyAsked };
}
