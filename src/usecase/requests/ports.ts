// The seams the requests sweep (F1.4) needs. Interfaces owned by this use case,
// stated in its vocabulary; the Postgres adapters and `ClientAskService`
// implement them.
//
// ── EVERY PORT HERE IS A READ EXCEPT THE ASK ITSELF ──────────────────────
//
// The chaser's arrangement, for the chaser's reason: the sweep's output lands
// on a CLIENT's page, so there is no seam through which it could close or
// withdraw an ask, move a task or a job, or send anything anywhere. The one
// write is raising an ask, and it goes through the ask module's own door, which
// is idempotent and records the ledger event.
import type { DocumentKind } from "../../domain/filestore/model";
import type { RequestAskKind } from "../../domain/config/model";
import type { PublishedRequestTemplate, RequestSubject } from "../../domain/requests/model";

/** Every ACTIVE firm, for the outer loop. A worker holds no session, so the
 *  tenant list is the only read in this module above RLS. */
export interface RequestTenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}

/**
 * The firm's own timezone (0071): which calendar DAY "today" is for the sweep
 * (T6.14). Declared here because ports live beside the use case that needs
 * them; `PostgresFirmTimeZone` satisfies it, as it does every other sweep's.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * The period jobs the sweep may ask on, at one firm.
 *
 * `engagement_period` jobs that are not done or cancelled and have an OPEN
 * task. One subject per job, on ONE of its open tasks chosen the same way on
 * every pass (client-visible first, then the oldest): a period job merged over
 * several engagements of one company has a task per engagement, and asking on
 * each would put the same month's bank statements on the client's page twice.
 * `asked` is read across ALL the job's tasks for the same reason, so the asks
 * never follow a different task once the first is finished.
 *
 * A pinned job comes with its pinned process's steps and each step's
 * `job_step` status; an unpinned one with `pinnedVersionId` null and no steps.
 */
export interface RequestSubjectSource {
  periodJobs(tenantId: string): Promise<readonly RequestSubject[]>;
}

/**
 * The `request_template` PUBLISHED under a key now, or null.
 *
 * Null when nothing is published under it, and when what is published no longer
 * reads as a template. Read LIVE, as the step names it (F1.2): the ask pins the
 * version it was raised from, not the job.
 */
export interface PublishedRequestTemplateSource {
  publishedByKey(tenantId: string, key: string): Promise<PublishedRequestTemplate | null>;
  /** Has the firm published ANY request template? What makes an unpinned job
   *  worth counting: at a firm with none, nothing could be asked. */
  anyPublished(tenantId: string): Promise<boolean>;
}

/** One template item, asked on one task. */
export interface TemplateAskInput {
  readonly tenantId: string;
  readonly workItemId: string;
  readonly prompt: string;
  readonly askKind: RequestAskKind;
  readonly documentKind: DocumentKind | null;
  /** `YYYY-MM-DD`: the template's own day, possibly already past. */
  readonly dueOn: string;
  readonly template: {
    readonly versionId: string;
    readonly templateKey: string;
    readonly itemKey: string;
  };
}

/**
 * The one write: raise a template's ask at most once per (task, template key,
 * item key).
 *
 * Narrow on purpose, and satisfied STRUCTURALLY by
 * `ClientAskService.raiseFromTemplate`, so neither use case imports the other.
 * `created: false` is an ask already raised (0385's unique index refused it):
 * nothing was written and no event recorded.
 */
export interface TemplateAskRaiser {
  raiseFromTemplate(input: TemplateAskInput): Promise<{ readonly created: boolean }>;
}
