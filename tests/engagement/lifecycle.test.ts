// An engagement's life after signature (V2.3): end, pause, resume, against the
// in-memory fakes. The SQL half (the withdrawal, the spawn and generator
// filters, the archive guard) is `lifecycle.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { EngagementLifecycleService } from "../../src/usecase/engagement/lifecycle";
import { FakeEngagementLifecycle } from "../../src/testfakes/engagement";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { Engagement } from "../../src/domain/engagement/model";
import type { Actor } from "../../src/domain/ledger/model";

const FIRM = "00000000-0000-4000-8000-0000000000e1";
const ENGAGEMENT = "00000000-0000-4000-8000-0000000000e2";
const PARTNER: Actor = { type: "human", id: "00000000-0000-4000-8000-0000000000e3" };

function engagement(over: Partial<Engagement> = {}): Engagement {
  return {
    id: ENGAGEMENT,
    tenantId: FIRM,
    engagementLetterId: "00000000-0000-4000-8000-0000000000e4",
    engagementLetterLineId: "00000000-0000-4000-8000-0000000000e5",
    partyId: "00000000-0000-4000-8000-0000000000e6",
    entityPartyId: "00000000-0000-4000-8000-0000000000e7",
    status: "active",
    activatedAt: "2026-07-01T00:00:00.000Z",
    effectiveFrom: "2026-07-01",
    endsOn: null,
    endReason: null,
    endedAt: null,
    pausedAt: null,
    resumedOn: null,
    pausedOn: null,
    firstInvoiceOn: null,
    ...over,
  };
}

function world(over: Partial<Engagement> = {}) {
  const lifecycle = new FakeEngagementLifecycle();
  lifecycle.rows.push(engagement(over));
  const events = new RecordingEventSink();
  const service = new EngagementLifecycleService({
    lifecycle,
    timeZones: new FakeFirmTimeZone(),
    clock: new FakeClock(new Date("2026-09-29T06:00:00.000Z")),
    events,
  });
  return { lifecycle, events, service };
}

describe("ending an engagement (V2.3)", () => {
  it("ends it on its last day, keeps the reason off the ledger, and counts what moved", async () => {
    const w = world();
    w.lifecycle.filings = { ...w.lifecycle.filings, withdrawn: 6, kept: 1, keptStarted: 1 };
    w.lifecycle.openJobsAfterEnd = [{ jobId: "00000000-0000-4000-8000-0000000000e8", periodLabel: "Oct 2026" }];

    const out = await w.service.end(
      { tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-09-30", reason: "  Moved to another firm.  " },
      PARTNER,
    );

    expect(out.engagement).toMatchObject({
      status: "completed",
      endsOn: "2026-09-30",
      endReason: "Moved to another firm.",
    });
    expect(out.record.state).toBe("completed");
    const [event] = w.events.recorded;
    expect(event?.verb).toBe("engagement.ended");
    expect(event?.payload).toEqual({
      from: "active",
      to: "completed",
      endsOn: "2026-09-30",
      effectiveFrom: "2026-07-01",
      filingsWithdrawn: 6,
      filingsKept: 1,
      filingsRepointed: 0,
      openJobsAfterEnd: 1,
    });
    // The reason is prose about a client: on the row, never in the log.
    expect(JSON.stringify(event)).not.toContain("Moved to another firm");
  });

  it("ends as CANCELLED when the last day falls before the work began", async () => {
    const w = world({ effectiveFrom: "2026-10-01" });
    const out = await w.service.end(
      { tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-09-29", reason: "Client withdrew before starting." },
      PARTNER,
    );
    expect(out.engagement.status).toBe("cancelled");
  });

  it("ends a paused one and one still waiting for its advance", async () => {
    for (const status of ["paused", "pending_advance"] as const) {
      const w = world({ status, pausedAt: status === "paused" ? "2026-09-01T00:00:00.000Z" : null });
      const out = await w.service.end(
        { tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-09-30", reason: "Stopped." },
        PARTNER,
      );
      expect(out.engagement).toMatchObject({ status: "completed", pausedAt: null });
    }
  });

  it("refuses no reason, an impossible day, and an engagement already ended", async () => {
    const w = world();
    await expect(
      w.service.end({ tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-09-30", reason: "   " }, PARTNER),
    ).rejects.toMatchObject({ code: "END_REASON_REQUIRED" });
    await expect(
      w.service.end({ tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-02-31", reason: "x" }, PARTNER),
    ).rejects.toMatchObject({ code: "INVALID_END_DATE" });
    await w.service.end({ tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-09-30", reason: "x" }, PARTNER);
    await expect(
      w.service.end({ tenantId: FIRM, engagementId: ENGAGEMENT, endsOn: "2026-10-31", reason: "x" }, PARTNER),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_ENDED" });
    await expect(
      w.service.end({ tenantId: FIRM, engagementId: FIRM, endsOn: "2026-10-31", reason: "x" }, PARTNER),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_NOT_FOUND" });
    expect(w.events.verbs()).toEqual(["engagement.ended"]);
  });
});

describe("pausing and resuming (V2.3)", () => {
  it("pauses running work and resumes it on the firm's day", async () => {
    const w = world();
    const paused = await w.service.pause({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER);
    expect(paused.engagement.status).toBe("paused");
    const resumed = await w.service.resume({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER);
    // 06:00 UTC on the 29th is the 29th in Kolkata too; the fake zone is the
    // firm's, and the day it resumed is what the spawn reads.
    expect(resumed.engagement).toMatchObject({ status: "active", pausedAt: null, resumedOn: "2026-09-29" });
    expect(w.events.verbs()).toEqual(["engagement.paused", "engagement.resumed"]);
    expect(w.events.recorded[1]?.payload).toMatchObject({ resumedOn: "2026-09-29" });
  });

  it("records the firm's day the pause began, and keeps it after the resume (0318)", async () => {
    // Billing pro-rates a period half served before a pause, so the pause's
    // first day must survive the resume that clears `pausedAt`.
    const w = world();
    const paused = await w.service.pause({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER);
    expect(paused.engagement.pausedOn).toBe("2026-09-29");
    const resumed = await w.service.resume({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER);
    expect(resumed.engagement).toMatchObject({ pausedAt: null, pausedOn: "2026-09-29" });
  });

  it("refuses a pause that is not running work, and a resume that is not paused", async () => {
    const waiting = world({ status: "pending_advance", activatedAt: null });
    await expect(
      waiting.service.pause({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_NOT_ACTIVE" });
    await expect(
      waiting.service.resume({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_NOT_PAUSED" });
    const ended = world({ status: "completed", endsOn: "2026-08-31", endReason: "x", endedAt: "2026-08-31T00:00:00.000Z" });
    await expect(
      ended.service.pause({ tenantId: FIRM, engagementId: ENGAGEMENT }, PARTNER),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_ENDED" });
  });
});
