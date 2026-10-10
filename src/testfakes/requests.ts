// In-memory port fakes for the requests sweep (F1.4).
//
// They reproduce what the sweep's rules depend on — subjects as the read hands
// them over, a published template or none, and an ask raised at most once per
// (task, template key, item key) — and nothing else. The anti-join across a
// job's tasks, the open-task choice, the pinned body and 0385's unique index are
// database properties, proven against real Postgres in
// `tests/requests/sweep.integration.test.ts`.
import type { PublishedRequestTemplate, RequestSubject } from "../domain/requests/model";
import type {
  PublishedRequestTemplateSource,
  RequestSubjectSource,
  RequestTenantDirectory,
  TemplateAskInput,
  TemplateAskRaiser,
} from "../usecase/requests/ports";

export class FakeRequestTenants implements RequestTenantDirectory {
  constructor(private readonly ids: readonly string[]) {}
  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

/** The period jobs at each firm, as the read would return them. A firm can be
 *  made to FAIL, for the isolation test: one firm's bad read must not stop the
 *  firms after it. */
export class FakeRequestSubjects implements RequestSubjectSource {
  private readonly byTenant = new Map<string, RequestSubject[]>();
  private readonly failing = new Map<string, string>();

  add(tenantId: string, subject: RequestSubject): this {
    const held = this.byTenant.get(tenantId) ?? [];
    held.push(subject);
    this.byTenant.set(tenantId, held);
    return this;
  }

  /** Replace what the read returns, as the database moves between passes. */
  set(tenantId: string, subjects: readonly RequestSubject[]): this {
    this.byTenant.set(tenantId, [...subjects]);
    return this;
  }

  fail(tenantId: string, message: string): this {
    this.failing.set(tenantId, message);
    return this;
  }

  periodJobs(tenantId: string): Promise<readonly RequestSubject[]> {
    const failure = this.failing.get(tenantId);
    if (failure !== undefined) return Promise.reject(new Error(failure));
    return Promise.resolve(this.byTenant.get(tenantId) ?? []);
  }
}

/** What each firm has PUBLISHED, by key. Nothing by default — the shipped
 *  state, since nothing is seeded. Counts its lookups, so a test can see the
 *  per-pass cache. */
export class FakePublishedRequestTemplates implements PublishedRequestTemplateSource {
  private readonly published = new Map<string, PublishedRequestTemplate>();
  readonly lookups: { tenantId: string; key: string }[] = [];

  publish(tenantId: string, template: PublishedRequestTemplate): this {
    this.published.set(`${tenantId}/${template.key}`, template);
    return this;
  }

  publishedByKey(tenantId: string, key: string): Promise<PublishedRequestTemplate | null> {
    this.lookups.push({ tenantId, key });
    return Promise.resolve(this.published.get(`${tenantId}/${key}`) ?? null);
  }

  anyPublished(tenantId: string): Promise<boolean> {
    return Promise.resolve([...this.published.keys()].some((k) => k.startsWith(`${tenantId}/`)));
  }
}

/**
 * The ask module's door, reproduced at the one property the sweep relies on:
 * a second raise of the same (task, template key, item key) writes nothing and
 * answers `created: false`. A find here, an `ON CONFLICT` there; the race is
 * the integration test's.
 */
export class FakeTemplateAskRaiser implements TemplateAskRaiser {
  readonly raised: TemplateAskInput[] = [];
  readonly calls: TemplateAskInput[] = [];

  raiseFromTemplate(input: TemplateAskInput): Promise<{ readonly created: boolean }> {
    this.calls.push(input);
    const already = this.raised.some(
      (a) =>
        a.tenantId === input.tenantId &&
        a.workItemId === input.workItemId &&
        a.template.templateKey === input.template.templateKey &&
        a.template.itemKey === input.template.itemKey,
    );
    if (already) return Promise.resolve({ created: false });
    this.raised.push(input);
    return Promise.resolve({ created: true });
  }
}
