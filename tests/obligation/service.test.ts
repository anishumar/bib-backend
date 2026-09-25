// The generator, the raise, and the two rules that make the calendar
// trustworthy (T3.2).
//
// The real `ObligationService` over in-memory STORES, never spies. The
// acceptance line — "re-running the generator changes nothing" — is a claim
// about state after a second call, and only a store can show it: a spy that
// recorded "createIfAbsent was called twice" would pass whether or not the
// second call did anything.
import { beforeEach, describe, expect, it } from "vitest";
import { ObligationService } from "../../src/usecase/obligation/service";
import {
  FakeCalendarSource,
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
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import type { Actor } from "../../src/domain/ledger/model";

const FIRM = "00000000-0000-4000-8000-0000000000f1";
const OTHER_FIRM = "00000000-0000-4000-8000-0000000000f2";
const ENTITY = "00000000-0000-4000-8000-0000000000e1";
const ENGAGEMENT = "00000000-0000-4000-8000-00000000e001";
const SERVICE = "00000000-0000-4000-8000-00000000c001";
const ACTOR: Actor = { type: "human", id: "00000000-0000-4000-8000-000000000001" };
const TODAY = "2026-08-30";

function harness() {
  const templates = new FakeObligationTemplateRepo();
  const exceptions = new FakeObligationExceptionRepo();
  templates.exceptions = exceptions;
  const states = new FakeObligationStateRepo();
  const resolutionOptions = new FakeResolutionOptionRepo();
  const instances = new FakeObligationInstanceRepo();
  // The instance fake reads the FLAGS off the state list, exactly as the sweep
  // does, so a test that renames a state proves the rule still holds.
  instances.states = states.rows;
  // One world, as one database is: the handover moves calendar rows, and the
  // calendar keys on the rule's lineage (0303).
  templates.instances = instances;
  instances.templates = templates;
  const compliancePolicy = new FakeCompliancePolicySource();
  const calendarSource = new FakeCalendarSource();
  const services = new FakeObligationServices();
  const workItems = new FakeWorkItemRaiser();
  const tenants = new FakeObligationTenants();
  const ids = new FakeIds();
  const events = new RecordingEventSink();

  const service = new ObligationService({
    timeZones: new FakeFirmTimeZone(),
    templates,
    exceptions,
    states,
    resolutionOptions,
    instances,
    compliancePolicy,
    calendarSource,
    services,
    workItems,
    tenants,
    ids,
    clock: { now: () => new Date(`${TODAY}T00:00:00Z`) },
    events,
  });

  return {
    service,
    templates,
    exceptions,
    states,
    resolutionOptions,
    instances,
    compliancePolicy,
    calendarSource,
    services,
    workItems,
    tenants,
    events,
  };
}

type H = ReturnType<typeof harness>;

/** A firm that can actually generate: states seeded, one monthly GST rule, one
 *  entity with a live engagement that started at the beginning of the year. */
async function firmWithGst(h: H, over: { leadTimeDays?: number; effectiveFrom?: string } = {}) {
  await h.service.seedDefaultStates(FIRM, ACTOR);
  h.services.keys.set(SERVICE, "gst-filing");
  const { rule } = await h.service.createRule(
    {
      tenantId: FIRM,
      jurisdiction: "IN",
      serviceEntryId: SERVICE,
      name: "GSTR-3B",
      authority: "GST",
      recurrence: "monthly",
      fiscalYearStartMonth: 4,
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20 },
      leadTimeDays: over.leadTimeDays ?? 0,
      rulePack: "gst-in@2026.07",
    },
    ACTOR,
  );
  h.calendarSource.subjects.push({
    entityPartyId: ENTITY,
    engagementId: ENGAGEMENT,
    effectiveFrom: over.effectiveFrom ?? "2026-01-01",
    jurisdiction: "IN",
    entityType: "private_limited",
    serviceEntryId: SERVICE,
  });
  return rule;
}

describe("re-running the generator changes nothing", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it("creates twelve monthly obligations, then zero on the second run", async () => {
    await firmWithGst(h);

    const first = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(first.created).toBe(12);
    expect(h.instances.rows).toHaveLength(12);

    // THE ACCEPTANCE LINE. The unique key on (tenant, template, entity, period)
    // is what makes this structural rather than careful, and this sweep runs
    // every night forever.
    const second = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(second.created).toBe(0);
    expect(h.instances.rows).toHaveLength(12);
  });

  it("records ONE obligation.spawned per instance, and none on the re-run", async () => {
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    const after = h.events.verbs().filter((v) => v === "obligation.spawned").length;
    expect(after).toBe(12);

    await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(h.events.verbs().filter((v) => v === "obligation.spawned")).toHaveLength(12);
  });

  it("puts the law's date and the firm's own on every row", async () => {
    await firmWithGst(h, { leadTimeDays: 6 });
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    const august = h.instances.rows[0];
    expect(august?.periodLabel).toBe("Aug 2026");
    expect(august?.statutoryDueOn).toBe("2026-09-20");
    // T–X. The escalation ladder watches this one, because finding out you are
    // late on the day you are late is useless.
    expect(august?.internalTargetOn).toBe("2026-09-14");
  });

  it("generates NOTHING for a rule that cannot compute a date", async () => {
    // The forty-six unresolved rules in the shipped pack. A plausible-looking
    // wrong due date is the dangerous kind, so the honest answer is no row.
    await h.service.seedDefaultStates(FIRM, ACTOR);
    await h.service.createRule(
      {
        tenantId: FIRM,
        jurisdiction: "IN",
        name: "AOC-4",
        recurrence: "annual",
        fiscalYearStartMonth: 4,
        dueRule: null,
        unresolvedReason: "Due within a statutory period after the AGM, and no AGM date is held.",
        leadTimeDays: 0,
        rulePack: "in-firm-sheet@2026.08",
      },
      ACTOR,
    );
    h.calendarSource.subjects.push({
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      effectiveFrom: "2026-01-01",
      jurisdiction: "IN",
      entityType: "private_limited",
      serviceEntryId: null,
    });

    const out = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(out.created).toBe(0);
    expect(h.instances.rows).toHaveLength(0);
  });

  it("generates nothing for an event-driven rule, formula or not", async () => {
    await h.service.seedDefaultStates(FIRM, ACTOR);
    await h.service.createRule(
      {
        tenantId: FIRM,
        jurisdiction: "IN",
        name: "FC-GPR",
        recurrence: "event",
        fiscalYearStartMonth: 4,
        dueRule: { kind: "days_after", dueDaysAfter: 30 },
        leadTimeDays: 0,
        rulePack: "in-firm-sheet@2026.08",
      },
      ACTOR,
    );
    h.calendarSource.subjects.push({
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      effectiveFrom: "2026-01-01",
      jurisdiction: "IN",
      entityType: null,
      serviceEntryId: null,
    });
    const out = await h.service.generate(FIRM, { from: "2026-01-01", to: "2027-12-31" }, ACTOR);
    expect(out.created).toBe(0);
  });

  it("reports a rule that reached nobody rather than failing", async () => {
    // A country with no clients yet. A NORMAL state, and the sweep runs across
    // every firm — throwing would take the worker down for one of them.
    await firmWithGst(h);
    h.calendarSource.subjects.length = 0;
    const out = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(out.created).toBe(0);
    expect(out.rulesWithNoSubjects).toEqual(["IN · GSTR-3B"]);
  });

  it("does nothing at all for a firm with no rules, and does not throw", async () => {
    await h.service.seedDefaultStates(FIRM, ACTOR);
    const out = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(out.created).toBe(0);
  });

  it("refuses to generate for a firm with no starting state, by name", async () => {
    // Not a 500. The firm is told which flag is missing and where to set it.
    await firmWithGst(h);
    h.states.rows.length = 0;
    await expect(
      h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR),
    ).rejects.toThrow(/no obligation state marked as the starting one/);
  });

  it("refuses a backwards window rather than looping", async () => {
    await firmWithGst(h);
    await expect(
      h.service.generate(FIRM, { from: "2027-03-31", to: "2026-04-01" }, ACTOR),
    ).rejects.toThrow(/earlier one first/);
  });
});

describe("a filing that fell due before the firm was engaged is not the firm's", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it("skips periods whose STATUTORY date precedes the engagement", async () => {
    // Generation reaches ninety days back so a client who signed last month
    // still gets the period already under way. Without this floor, a firm
    // onboarding four hundred clients fills a partner's decision queue with
    // thousands of deadlines nobody ever had — and the one screen whose whole
    // value is being trusted stops being trusted.
    await firmWithGst(h, { effectiveFrom: "2026-08-01" });
    await h.service.generate(FIRM, { from: "2026-04-01", to: "2026-12-31" }, ACTOR);

    const labels = h.instances.rows.map((r) => r.periodLabel);
    // July's return falls due on 20 August, while the firm IS engaged, so it is
    // ours. June's fell due on 20 July and is not.
    expect(labels).toContain("Jul 2026");
    expect(labels).not.toContain("Jun 2026");
    expect(labels).not.toContain("May 2026");
  });

  it("tests the due date and not the period, which is the whole distinction", async () => {
    await firmWithGst(h, { effectiveFrom: "2026-08-15" });
    await h.service.generate(FIRM, { from: "2026-06-01", to: "2026-09-30" }, ACTOR);
    // August's period starts before the engagement did and is still generated,
    // because somebody has to file it. That is a question for the firm, not
    // arithmetic — and it is answered by generating rather than by silence.
    expect(h.instances.rows.map((r) => r.periodLabel)).toContain("Aug 2026");
  });
});

describe("an obligation becomes somebody's job at T–X, and only then", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it("raises nothing while the internal target is still in the future", async () => {
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-09-01", to: "2026-12-31" }, ACTOR);
    expect(await h.service.raise(FIRM, TODAY, ACTOR)).toBe(0);
    expect(h.workItems.raised).toHaveLength(0);
  });

  it("raises one task per obligation that has reached its target", async () => {
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-04-01", to: "2026-08-31" }, ACTOR);
    const raised = await h.service.raise(FIRM, "2026-09-30", ACTOR);
    expect(raised).toBeGreaterThan(0);
    expect(h.workItems.raised).toHaveLength(raised);
  });

  it("gives the task the STATUTORY date, never the internal target", async () => {
    // The task is due when the LAW says. The internal target is only what
    // caused it to appear this early; showing that as the deadline would make
    // every filing look late a fortnight before it was.
    await firmWithGst(h, { leadTimeDays: 10 });
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-11", ACTOR);
    expect(h.workItems.raised[0]?.dueOn).toBe("2026-09-20");
  });

  it("never raises a second task for the same filing", async () => {
    // The sweep is at-least-once like everything else the engine touches: a
    // redelivered message must not put a second task on somebody's desk for
    // work already being done.
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-30", ACTOR);
    const first = h.workItems.raised.length;
    await h.service.raise(FIRM, "2026-09-30", ACTOR);
    expect(h.workItems.raised).toHaveLength(first);
  });

  it("records the join between the calendar and the work board", async () => {
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-30", ACTOR);
    expect(h.events.verbs()).toContain("obligation.work_raised");
  });
});

describe("the filing closes when its task does, and opens again if the task reopens", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  /** Generate one August obligation and put it on a desk. Returns the work item
   *  id, which is the only handle the closing path has. */
  async function raisedFiling(): Promise<string> {
    await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-30", ACTOR);
    const row = h.instances.rows.find((r) => r.workItemId !== null);
    if (!row?.workItemId) throw new Error("nothing was raised; the harness is wrong");
    return row.workItemId;
  }

  function filed() {
    return h.instances.rows.filter((r) => r.filedOn !== null);
  }

  it("was the gap this closes: raising alone files nothing", async () => {
    // T3.2's own note, as a test. `raise` deliberately does not move the state
    // — `work_item_id` being set IS the fact that work started — so before this
    // path existed `filed_on` had four readers and no writer at all.
    await raisedFiling();
    expect(filed()).toHaveLength(0);
  });

  it("files the obligation when the task is finished, and says how late", async () => {
    const workItemId = await raisedFiling();
    await h.service.reconcileFiling(FIRM, workItemId, true, ACTOR);

    const row = filed()[0];
    expect(row?.filedOn).toBe(TODAY);

    // The state moved too, and by the FLAG — a calendar whose rows all read
    // "Pending" forever is what this closes.
    const filedState = (await h.states.list(FIRM)).find((st) => st.isFiled);
    expect(row?.stateId).toBe(filedState?.id);

    const ev = h.events.recorded.find((e) => e.verb === "obligation.filed");
    expect(ev).toBeDefined();
    // Statutory date 20 Sep, filed 30 Aug: twenty-one days EARLY. The one
    // number a partner asks for afterwards, computed once rather than by
    // whoever reads the log.
    expect(ev?.payload).toMatchObject({ workItemId, filedOn: TODAY, daysLate: -21 });
  });

  it("writes ONE obligation.filed however many times it is told", async () => {
    // The call is reconciliation, not a transition: a double-click, a retry and
    // a redelivered message all arrive here, and the guard is in the store's
    // own WHERE clause rather than in a caller that read first.
    const workItemId = await raisedFiling();
    await h.service.reconcileFiling(FIRM, workItemId, true, ACTOR);
    await h.service.reconcileFiling(FIRM, workItemId, true, ACTOR);
    await h.service.reconcileFiling(FIRM, workItemId, true, ACTOR);

    expect(h.events.verbs().filter((v) => v === "obligation.filed")).toHaveLength(1);
    expect(filed()).toHaveLength(1);
  });

  it("un-files it when the task stops being finished, and returns it to the start", async () => {
    // Reopening or cancelling. A calendar still saying "Filed" while somebody
    // is actively working the same thing is a second rule about one fact — and
    // filed is TERMINAL, so `canStillBeMissed` would be false forever and T3.3
    // could never flag it. Un-filing lets the missed sweep correct itself.
    const workItemId = await raisedFiling();
    await h.service.reconcileFiling(FIRM, workItemId, true, ACTOR);
    await h.service.reconcileFiling(FIRM, workItemId, false, ACTOR);

    expect(filed()).toHaveLength(0);
    const initial = (await h.states.list(FIRM)).find((st) => st.isInitial);
    expect(h.instances.rows[0]?.stateId).toBe(initial?.id);
    expect(h.events.verbs()).toContain("obligation.filing_reversed");
  });

  it("says nothing at all when the task was never filed", async () => {
    const workItemId = await raisedFiling();
    await h.service.reconcileFiling(FIRM, workItemId, false, ACTOR);
    expect(h.events.verbs()).not.toContain("obligation.filing_reversed");
  });

  it("ignores a work item that is not a filing", async () => {
    // Most of a firm's board is ordinary work. This is the common case, not a
    // miss, and it must cost one lookup and no event.
    await firmWithGst(h);
    const before = h.events.verbs().length;
    await h.service.reconcileFiling(FIRM, "00000000-0000-4000-8000-0000000000ff", true, ACTOR);
    expect(h.events.verbs()).toHaveLength(before);
  });

  it("refuses rather than quietly leaving the filing open with nowhere to land", async () => {
    // A firm cannot reach this by accident — the seed ships the state and the
    // database allows at most one — so getting here means somebody unflagged or
    // retired it, which is a thing they did and can undo. Swallowing it would
    // be the silent failure this whole module is built against.
    const workItemId = await raisedFiling();
    for (const st of h.states.rows) {
      if (st.isFiled) h.states.rows[h.states.rows.indexOf(st)] = { ...st, isFiled: false };
    }
    await expect(h.service.reconcileFiling(FIRM, workItemId, true, ACTOR)).rejects.toThrow(
      /no obligation state marked as the filed one/i,
    );
  });
});

describe("one firm's failure never stops the others", () => {
  it("catches per tenant and REPORTS the failure", async () => {
    // T3.1's lesson, written as a test this time. `sweepActivations` carried a
    // comment promising exactly this and did not do it — one firm with no work
    // vocabulary stopped the calendar for every client of every firm.
    const h = harness();
    h.tenants.ids.push(FIRM, OTHER_FIRM);
    await firmWithGst(h);
    // The second firm has a rule and NO states, so its pass throws.
    h.services.keys.set(SERVICE, "gst-filing");
    await h.service.createRule(
      {
        tenantId: OTHER_FIRM,
        jurisdiction: "IN",
        serviceEntryId: SERVICE,
        name: "GSTR-3B",
        recurrence: "monthly",
        fiscalYearStartMonth: 4,
        dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20 },
        leadTimeDays: 0,
        rulePack: "gst-in@2026.07",
      },
      ACTOR,
    );

    const reports = await h.service.sweep(ACTOR);
    expect(reports).toHaveLength(2);
    const ok = reports.find((r) => r.tenantId === FIRM);
    const broken = reports.find((r) => r.tenantId === OTHER_FIRM);
    expect(ok?.created).toBeGreaterThan(0);
    expect(ok?.failure).toBeUndefined();
    // REPORTED rather than swallowed: a firm silently skipped forever is worse
    // than a sweep that stops, because a stopped sweep gets noticed.
    expect(broken?.failure).toMatch(/starting one/);
  });
});

describe("writing a rule", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it("refuses a rule with neither a formula nor a reason for not having one", async () => {
    await expect(
      h.service.createRule(
        {
          tenantId: FIRM,
          jurisdiction: "IN",
          name: "Mystery filing",
          recurrence: "annual",
          fiscalYearStartMonth: 4,
          dueRule: null,
          leadTimeDays: 0,
          rulePack: "x@1",
        },
        ACTOR,
      ),
    ).rejects.toThrow(/needs a reason saying what is missing/);
  });

  it("refuses a rule that carries both", async () => {
    await expect(
      h.service.createRule(
        {
          tenantId: FIRM,
          jurisdiction: "IN",
          name: "Confused filing",
          recurrence: "monthly",
          fiscalYearStartMonth: 4,
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 7 },
          unresolvedReason: "we are not sure",
          leadTimeDays: 0,
          rulePack: "x@1",
        },
        ACTOR,
      ),
    ).rejects.toThrow(/cannot also carry a reason/);
  });

  it("refuses a half-stated formula", async () => {
    await expect(
      h.service.createRule(
        {
          tenantId: FIRM,
          jurisdiction: "IN",
          name: "Half a rule",
          recurrence: "monthly",
          fiscalYearStartMonth: 4,
          dueRule: { kind: "day_of_month", dueMonthOffset: 1 },
          leadTimeDays: 0,
          rulePack: "x@1",
        },
        ACTOR,
      ),
    ).rejects.toThrow(/both a month offset and a day of the month/);
  });

  it("refuses a service the firm does not have", async () => {
    await expect(
      h.service.createRule(
        {
          tenantId: FIRM,
          jurisdiction: "IN",
          serviceEntryId: SERVICE,
          name: "GSTR-3B",
          recurrence: "monthly",
          fiscalYearStartMonth: 4,
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20 },
          leadTimeDays: 0,
          rulePack: "x@1",
        },
        ACTOR,
      ),
    ).rejects.toThrow(/no catalogue service/i);
  });

  it("refuses a second rule with the same identity, and says how to revise", async () => {
    await firmWithGst(h);
    await expect(
      h.service.createRule(
        {
          tenantId: FIRM,
          jurisdiction: "IN",
          serviceEntryId: SERVICE,
          name: "GSTR-3B",
          recurrence: "monthly",
          fiscalYearStartMonth: 4,
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20 },
          leadTimeDays: 0,
          rulePack: "gst-in@2026.07",
        },
        ACTOR,
      ),
    ).rejects.toThrow(/add it under a NEW rule pack/);
  });

  it("creates a rule the firm writes as CONFIRMED — it is the firm's own statement", async () => {
    const rule = await firmWithGst(h);
    expect(rule.status).toBe("confirmed");
  });

  it("lets a partner confirm a shipped date, records who did, and fills the calendar then", async () => {
    // Confirming is the moment a date stops coming from a document and starts
    // coming from the firm — and since 2026-09-18 it is also the moment the
    // rule starts generating at all. A pack row reaches every live engagement
    // in its country, so an unchecked one on the calendar is a claim about
    // every client the firm has.
    await h.service.seedDefaultStates(FIRM, ACTOR);
    await h.service.seedIndiaRulePack(FIRM, ACTOR);
    h.calendarSource.subjects.push({
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      effectiveFrom: "2026-01-01",
      jurisdiction: "IN",
      entityType: "private_limited",
      serviceEntryId: SERVICE,
    });
    const gstr3b = h.templates.rows.find((r) => r.name === "GSTR-3B");
    if (!gstr3b) throw new Error("no GSTR-3B in the pack");
    expect(gstr3b.status).toBe("unconfirmed");

    const before = await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    expect(before.created).toBe(0);
    expect(h.instances.rows).toHaveLength(0);

    const { rule: confirmed, effect } = await h.service.updateRule(
      FIRM,
      gstr3b.id,
      { status: "confirmed" },
      ACTOR,
    );
    expect(confirmed.status).toBe("confirmed");
    // THE CROSSING: answering it fills the calendar there and then.
    expect(effect.spawned).toBeGreaterThan(0);
    expect(h.instances.rows.length).toBe(effect.spawned);
    const event = h.events.recorded.find((e) => e.verb === "obligation_rule.updated");
    expect(event?.payload).toMatchObject({ statusFrom: "unconfirmed", statusTo: "confirmed" });
  });

  it("stops a retired rule generating, and keeps what it already produced", async () => {
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    expect(h.instances.rows).toHaveLength(1);

    await h.service.updateRule(FIRM, rule.id, { isActive: false }, ACTOR);
    await h.service.generate(FIRM, { from: "2026-09-01", to: "2026-09-30" }, ACTOR);
    // Nothing new, and the August row still stands: a retired rule still
    // explains an old filing's date.
    expect(h.instances.rows).toHaveLength(1);
  });

  it("lets a lead time be set later, which is what the shipped zero is for", async () => {
    const rule = await firmWithGst(h);
    const { rule: updated } = await h.service.updateRule(FIRM, rule.id, { leadTimeDays: 8 }, ACTOR);
    expect(updated.leadTimeDays).toBe(8);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    expect(h.instances.rows[0]?.internalTargetOn).toBe("2026-09-12");
  });

  it("MOVES the calendar already generated when the lead time changes", async () => {
    // Found by using the screen. The sweep materialises a year ahead and
    // generation is idempotent, so without this a partner sets T-X and watches
    // nothing happen for twelve months — a control that looks live and is
    // inert, which is the trap this codebase keeps naming.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);
    expect(h.instances.rows.every((r) => r.internalTargetOn === r.statutoryDueOn)).toBe(true);

    await h.service.updateRule(FIRM, rule.id, { leadTimeDays: 6 }, ACTOR);
    const august = h.instances.rows.find((r) => r.periodLabel === "Aug 2026");
    expect(august?.internalTargetOn).toBe("2026-09-14");
    // The STATUTORY date is untouched: one is the firm's own working practice
    // and is theirs to change, the other is the law's and is not.
    expect(august?.statutoryDueOn).toBe("2026-09-20");

    const updates = h.events.recorded.filter((e) => e.verb === "obligation_rule.updated");
    const event = updates[updates.length - 1];
    expect(event?.payload).toMatchObject({
      leadTimeFrom: 0,
      leadTimeTo: 6,
      restated: 3,
      // Nothing was already on a desk, so nothing was left behind.
      locked: 0,
    });
  });

  it("MOVES the statutory date too when the FORMULA changes, not just the target", async () => {
    // The reversal that matters, and the reason this is not the lead-time
    // version of the same thing. A lead time is the firm's own practice and the
    // law's date is not in question; when the FORMULA changes, the old
    // statutory date was this system's guess from a vendor's document and the
    // new one is the firm's answer. Leaving a date we now know to be wrong,
    // out of respect for the law, keeps a wrong legal deadline.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);
    expect(h.instances.rows.find((r) => r.periodLabel === "Aug 2026")?.statutoryDueOn).toBe(
      "2026-09-20",
    );

    // The 11th of the following month, not the 20th.
    const { effect } = await h.service.updateRule(
      FIRM,
      rule.id,
      { dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null } },
      ACTOR,
    );
    expect(effect).toEqual({ restated: 3, locked: 0, spawned: 0 });
    const august = h.instances.rows.find((r) => r.periodLabel === "Aug 2026");
    expect(august?.statutoryDueOn).toBe("2026-09-11");
    // Lead time is zero here, so the target follows the statutory date.
    expect(august?.internalTargetOn).toBe("2026-09-11");
  });

  it("reports the filings it could NOT move, rather than reporting a whole change", async () => {
    // A partial change reported as a whole one is how a deadline moves without
    // anybody being told.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-30", ACTOR);

    const { effect } = await h.service.updateRule(
      FIRM,
      rule.id,
      { dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null } },
      ACTOR,
    );
    expect(effect.locked).toBe(1);
    expect(effect.restated).toBe(2);
  });

  it("fills the calendar the moment a rule that was waiting on a fact is answered", async () => {
    // The whole point of the rules screen. Forty-seven of the fifty-seven
    // shipped rules have no formula; supplying one has to produce filings there
    // and then, not at the worker's next pass — a control that appears to work
    // and does nothing until tomorrow is the trap this codebase keeps naming.
    await h.service.seedDefaultStates(FIRM, ACTOR);
    h.services.keys.set(SERVICE, "gst-filing");
    const { rule } = await h.service.createRule(
      {
        tenantId: FIRM,
        jurisdiction: "IN",
        serviceEntryId: SERVICE,
        name: "PF monthly return",
        recurrence: "monthly",
        fiscalYearStartMonth: 4,
        dueRule: null,
        unresolvedReason: "Due date depends on the State the establishment is registered in.",
        leadTimeDays: 0,
        rulePack: "gst-in@2026.07",
      },
      ACTOR,
    );
    h.calendarSource.subjects.push({
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      effectiveFrom: "2026-01-01",
      jurisdiction: "IN",
      entityType: "private_limited",
      serviceEntryId: SERVICE,
    });
    // Creating it generated NOTHING — a half-written rule must not fill a
    // calendar, and a brand-new rule is what the nightly sweep is for.
    expect(h.instances.rows).toHaveLength(0);

    const { effect } = await h.service.updateRule(
      FIRM,
      rule.id,
      {
        dueRule: { kind: "days_after", dueMonthOffset: null, dueDayOfMonth: null, dueDaysAfter: 15 },
        unresolvedReason: null,
      },
      ACTOR,
    );
    expect(effect.spawned).toBeGreaterThan(0);
    expect(h.instances.rows.length).toBe(effect.spawned);
    // Nothing to restate: it had produced nothing to restate.
    expect(effect.restated).toBe(0);
  });

  it("spawns nothing when a rule that was ALREADY generating is merely corrected", async () => {
    // The periods exist. Restating them is the whole of it — and the period
    // shape is locked once rows exist, so no correction can produce new ones.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);
    const before = h.instances.rows.length;

    const { effect } = await h.service.updateRule(
      FIRM,
      rule.id,
      { dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null } },
      ACTOR,
    );
    expect(effect.spawned).toBe(0);
    expect(h.instances.rows).toHaveLength(before);
  });

  it("restates nothing when the edit could not have changed a date", async () => {
    // Renaming the authority changes nothing about when anything is due, and a
    // response claiming it moved every filing would be a lie a partner acts on.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);

    const { effect } = await h.service.updateRule(
      FIRM,
      rule.id,
      { authority: "GSTN", status: "confirmed" },
      ACTOR,
    );
    expect(effect).toEqual({ restated: 0, locked: 0, spawned: 0 });
  });

  it("refuses to change the period shape once the rule has produced filings", async () => {
    // `period_start` is the key every generated filing is deduplicated on.
    // Moving monthly to quarterly under existing rows would orphan all of them,
    // the next sweep would generate a second copy of work already done, and
    // nothing would report an error.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-10-31" }, ACTOR);

    await expect(
      h.service.updateRule(FIRM, rule.id, { recurrence: "quarterly" }, ACTOR),
    ).rejects.toMatchObject({ code: "PERIOD_SHAPE_LOCKED" });
    await expect(
      h.service.updateRule(FIRM, rule.id, { fiscalYearStartMonth: 1 }, ACTOR),
    ).rejects.toMatchObject({ code: "PERIOD_SHAPE_LOCKED" });
  });

  it("allows the period shape to change while the rule has produced nothing", async () => {
    // Which is the state of all forty-seven rules a partner actually has to
    // answer for.
    const rule = await firmWithGst(h);
    const { rule: updated } = await h.service.updateRule(
      FIRM,
      rule.id,
      { recurrence: "quarterly" },
      ACTOR,
    );
    expect(updated.recurrence).toBe("quarterly");
  });

  it("never re-dates a filing somebody has already started", async () => {
    // A task on a desk has a date its owner is working to. Re-dating it
    // underneath them is how a deadline moves without anybody being told.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-08-01", to: "2026-08-31" }, ACTOR);
    await h.service.raise(FIRM, "2026-09-30", ACTOR);
    const before = h.instances.rows[0]?.internalTargetOn;

    await h.service.updateRule(FIRM, rule.id, { leadTimeDays: 6 }, ACTOR);
    expect(h.instances.rows[0]?.internalTargetOn).toBe(before);
  });
});

describe("superseding a rule — the law changed, from a day", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  /** The cutover used throughout: the successor governs September onward, the
   *  predecessor everything before it. */
  const CUTOVER = "2026-09-01";

  async function supersede(h: H, ruleId: string, over: Record<string, unknown> = {}) {
    return h.service.supersedeRule(
      FIRM,
      ruleId,
      {
        effectiveFrom: CUTOVER,
        rulePack: "gst-in@2026.09",
        // The 11th rather than the 20th — a real change of law, not a typo fix.
        dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null },
        ...over,
      },
      ACTOR,
    );
  }

  it("gives ONE rule to each period, which is the whole reason for the window", async () => {
    // THE BUG THIS EXISTS TO PREVENT. Generation is keyed on
    // (tenant, template, entity, period_start), so a successor with no window
    // regenerates every period its predecessor already produced under a
    // DIFFERENT template id — the re-run key cannot see it, and every return
    // lands on the calendar twice with nothing reporting an error.
    const rule = await firmWithGst(h);
    const { rule: successor } = await supersede(h, rule.id);

    await h.service.generate(FIRM, { from: "2026-07-01", to: "2026-10-31" }, ACTOR);

    const labels = h.instances.rows.map((r) => r.periodLabel);
    expect(new Set(labels).size).toBe(labels.length);

    const by = (label: string) => h.instances.rows.find((r) => r.periodLabel === label);
    // July and August are the PREDECESSOR's — the 20th of the following month.
    expect(by("Jul 2026")?.templateId).toBe(rule.id);
    expect(by("Aug 2026")?.statutoryDueOn).toBe("2026-09-20");
    // September onward is the successor's — the 11th.
    expect(by("Sep 2026")?.templateId).toBe(successor.id);
    expect(by("Sep 2026")?.statutoryDueOn).toBe("2026-10-11");
  });

  it("closes the predecessor at the cutover and chains the successor to it", async () => {
    const rule = await firmWithGst(h);
    const { rule: successor } = await supersede(h, rule.id);

    const predecessor = h.templates.rows.find((r) => r.id === rule.id);
    expect(predecessor?.effectiveTo).toBe(CUTOVER);
    // NOT retired. It still governs its own periods, and retiring it would stop
    // the ninety-day reach-back materialising a period from before the cutover
    // for a client onboarded last month.
    expect(predecessor?.isActive).toBe(true);

    expect(successor.effectiveFrom).toBe(CUTOVER);
    expect(successor.effectiveTo).toBeNull();
    expect(successor.supersedesId).toBe(rule.id);
    // The IDENTITY carries over — same filing, same country, same period shape.
    // Only the pack moves, which is what makes it a different row at all.
    expect(successor.name).toBe(predecessor?.name);
    expect(successor.jurisdiction).toBe(predecessor?.jurisdiction);
    expect(successor.recurrence).toBe(predecessor?.recurrence);
    expect(successor.rulePack).not.toBe(predecessor?.rulePack);
  });

  it("records the handover with both packs and both formulas", async () => {
    // "Which rule was this return due under" is the question an audit asks, and
    // the answer moved on a date.
    const rule = await firmWithGst(h);
    await supersede(h, rule.id);

    const event = h.events.recorded.find((e) => e.verb === "obligation_rule.superseded");
    expect(event?.payload).toMatchObject({
      supersedesId: rule.id,
      effectiveFrom: CUTOVER,
      rulePackFrom: "gst-in@2026.07",
      rulePackTo: "gst-in@2026.09",
    });
  });

  it("REFUSES a successor reusing the predecessor's pack", async () => {
    // A pack is part of a rule's identity, so this collides on
    // (tenant, jurisdiction, name, rule_pack) — refused with the reason rather
    // than as a unique violation.
    const rule = await firmWithGst(h);
    await expect(supersede(h, rule.id, { rulePack: "gst-in@2026.07" })).rejects.toMatchObject({
      code: "SUCCESSOR_NEEDS_ITS_OWN_PACK",
    });
  });

  it("REFUSES superseding a rule that has already handed over", async () => {
    // Two successors covering the same periods is two filings for one return,
    // which is the duplicate this whole mechanism exists to prevent.
    const rule = await firmWithGst(h);
    await supersede(h, rule.id);
    await expect(
      supersede(h, rule.id, { rulePack: "gst-in@2026.10", effectiveFrom: "2026-10-01" }),
    ).rejects.toMatchObject({ code: "ALREADY_SUPERSEDED" });
  });

  it("REFUSES a cutover at or before the rule's own start", async () => {
    const rule = await firmWithGst(h);
    await supersede(h, rule.id);
    const successor = h.templates.rows.find((r) => r.supersedesId === rule.id);
    if (!successor) throw new Error("expected a successor");

    await expect(
      h.service.supersedeRule(
        FIRM,
        successor.id,
        {
          effectiveFrom: CUTOVER,
          rulePack: "gst-in@2026.11",
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 9, dueDaysAfter: null },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CUTOVER_BEFORE_START" });
  });

  it("REFUSES a cutover that is not a day", async () => {
    const rule = await firmWithGst(h);
    await expect(supersede(h, rule.id, { effectiveFrom: "September" })).rejects.toMatchObject({
      code: "INVALID_CUTOVER",
    });
  });

  it("leaves nothing behind when it refuses — the predecessor is not half-closed", async () => {
    // The atomicity that matters. A closed predecessor with no successor is a
    // calendar that silently stops telling the firm's clients what they owe,
    // and every refusal above happens BEFORE the write for that reason.
    const rule = await firmWithGst(h);
    await expect(supersede(h, rule.id, { rulePack: "  " })).rejects.toMatchObject({
      code: "INVALID_RULE_PACK",
    });
    expect(h.templates.rows.find((r) => r.id === rule.id)?.effectiveTo).toBeNull();
    expect(h.templates.rows).toHaveLength(1);
  });

  it("does NOT restate a period that now belongs to the successor", async () => {
    // The predecessor's own edits reach only its own periods. September was
    // handed over, so a lead-time change on the OLD rule leaves it alone.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-07-01", to: "2026-10-31" }, ACTOR);

    await supersede(h, rule.id);
    const septAfterHandover = h.instances.rows.find((r) => r.periodLabel === "Sep 2026");

    const { effect: edit } = await h.service.updateRule(
      FIRM,
      rule.id,
      { leadTimeDays: 5 },
      ACTOR,
    );
    // July and August moved; September did not, because it is not this rule's.
    expect(edit.restated).toBe(2);
    expect(h.instances.rows.find((r) => r.periodLabel === "Sep 2026")?.statutoryDueOn).toBe(
      septAfterHandover?.statutoryDueOn,
    );
  });

  describe("AFTER the calendar already holds the successor's periods (0303)", () => {
    // THE ACCEPTANCE LINE. The nightly sweep materialises a year ahead, so on
    // the day a partner records an amendment the OLD rule has already produced
    // every period past the cutover. Before 0303 those rows stayed on the old
    // rule and the successor generated the same periods again: every return
    // from the cutover on appeared twice.
    //
    // So each test starts from the calendar the real sweep would have left —
    // its own window, ninety days back and a year ahead of TODAY.
    const SWEEP = { from: "2026-06-01", to: "2027-08-30" };

    const at = (h: H, label: string) => h.instances.rows.filter((r) => r.periodLabel === label);
    const pastCutover = (h: H) => h.instances.rows.filter((r) => r.periodStart >= CUTOVER);

    it("keeps periods before the cutover on the old rule, moves the rest, and makes nothing twice", async () => {
      const rule = await firmWithGst(h);
      await h.service.generate(FIRM, SWEEP, ACTOR);
      const before = h.instances.rows.length;
      const ids = new Map(h.instances.rows.map((r) => [r.periodLabel, r.id]));
      const moving = pastCutover(h).length;
      expect(moving).toBeGreaterThan(6);

      const { rule: successor, effect } = await supersede(h, rule.id);

      // NOTHING TWICE: the same number of filings, one per month.
      const labels = h.instances.rows.map((r) => r.periodLabel);
      expect(labels).toHaveLength(before);
      expect(new Set(labels).size).toBe(before);

      // Before D: the old rule, the old date (the 20th).
      expect(at(h, "Jul 2026")[0]?.templateId).toBe(rule.id);
      expect(at(h, "Aug 2026")[0]?.templateId).toBe(rule.id);
      expect(at(h, "Aug 2026")[0]?.statutoryDueOn).toBe("2026-09-20");
      // From D: the new rule and the new date (the 11th), on the SAME row, so
      // anything that already named that filing still names it.
      expect(at(h, "Sep 2026")[0]?.templateId).toBe(successor.id);
      expect(at(h, "Sep 2026")[0]?.statutoryDueOn).toBe("2026-10-11");
      expect(at(h, "Sep 2026")[0]?.id).toBe(ids.get("Sep 2026"));
      expect(pastCutover(h).every((r) => r.templateId === successor.id)).toBe(true);

      // Told as it is: every one past the cutover moved to a new date, none
      // was left behind, and the successor had nothing of its own to add.
      expect(effect).toEqual({ restated: moving, locked: 0, spawned: 0 });

      // And the next sweep changes nothing.
      const again = await h.service.generate(FIRM, SWEEP, ACTOR);
      expect(again.created).toBe(0);
      expect(h.instances.rows).toHaveLength(before);
    });

    it("leaves a filing somebody STARTED on the old rule, and does not generate it again", async () => {
      // A task on a desk keeps the date its owner is working to, the rule every
      // correction already follows. The successor must then NOT produce a
      // second September beside it, which only the lineage key can stop: the
      // two rows would have different template ids.
      const rule = await firmWithGst(h);
      await h.service.generate(FIRM, SWEEP, ACTOR);
      const before = h.instances.rows.length;
      const moving = pastCutover(h).length;
      const sept = at(h, "Sep 2026")[0];
      if (!sept) throw new Error("expected September");
      h.instances.rows[h.instances.rows.indexOf(sept)] = {
        ...sept,
        workItemId: "00000000-0000-4000-8000-00000000a001",
      };

      const { rule: successor, effect } = await supersede(h, rule.id);

      expect(at(h, "Sep 2026")).toHaveLength(1);
      expect(at(h, "Sep 2026")[0]?.templateId).toBe(rule.id);
      expect(at(h, "Sep 2026")[0]?.statutoryDueOn).toBe("2026-10-20");
      // October was untouched, so it moved.
      expect(at(h, "Oct 2026")[0]?.templateId).toBe(successor.id);
      expect(effect).toEqual({ restated: moving - 1, locked: 1, spawned: 0 });
      expect(h.instances.rows).toHaveLength(before);

      const again = await h.service.generate(FIRM, SWEEP, ACTOR);
      expect(again.created).toBe(0);
    });

    it("hands rows to a successor that is still waiting on a fact, keeping their dates", async () => {
      // "We do not know the new date yet" is not "this is no longer due". The
      // rows change hands and keep the date they had, so the successor's first
      // formula restates them as its own.
      const rule = await firmWithGst(h);
      await h.service.generate(FIRM, SWEEP, ACTOR);
      const before = h.instances.rows.length;
      const moving = pastCutover(h).length;

      const { rule: successor, effect } = await supersede(h, rule.id, {
        dueRule: null,
        unresolvedReason: "The notification names a date we have not been sent yet.",
      });
      expect(effect).toEqual({ restated: 0, locked: 0, spawned: 0 });
      expect(at(h, "Oct 2026")[0]?.templateId).toBe(successor.id);
      expect(at(h, "Oct 2026")[0]?.statutoryDueOn).toBe("2026-11-20");

      const { effect: answered } = await h.service.updateRule(
        FIRM,
        successor.id,
        {
          dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null },
          unresolvedReason: null,
        },
        ACTOR,
      );
      expect(answered.restated).toBe(moving);
      expect(answered.spawned).toBe(0);
      expect(at(h, "Oct 2026")[0]?.statutoryDueOn).toBe("2026-11-11");
      expect(h.instances.rows).toHaveLength(before);
    });

    it("records what the handover moved on the ledger, as counts", async () => {
      const rule = await firmWithGst(h);
      await h.service.generate(FIRM, SWEEP, ACTOR);
      const moving = pastCutover(h).length;
      await supersede(h, rule.id);
      const event = h.events.recorded.find((e) => e.verb === "obligation_rule.superseded");
      expect(event?.payload).toMatchObject({ handedOver: moving, restated: moving, kept: 0 });
    });
  });
});

describe("exceptions", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it("changes the date for one period and leaves the other eleven", async () => {
    await h.service.seedDefaultStates(FIRM, ACTOR);
    const { rule: tds } = await h.service.createRule(
      {
        tenantId: FIRM,
        jurisdiction: "IN",
        name: "TDS deposit",
        recurrence: "monthly",
        fiscalYearStartMonth: 4,
        dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 7 },
        leadTimeDays: 0,
        rulePack: "tds-in@2026.08",
      },
      ACTOR,
    );
    await h.service.addException(
      FIRM,
      tds.id,
      {
        periodEndMonth: 3,
        kind: "day_of_month",
        dueMonthOffset: 1,
        dueDayOfMonth: 30,
        note: "March's deduction is due 30 April by statute",
      },
      ACTOR,
    );
    h.calendarSource.subjects.push({
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      effectiveFrom: "2026-01-01",
      jurisdiction: "IN",
      entityType: null,
      serviceEntryId: null,
    });

    await h.service.generate(FIRM, { from: "2027-02-01", to: "2027-03-31" }, ACTOR);
    const byLabel = new Map(h.instances.rows.map((r) => [r.periodLabel, r.statutoryDueOn]));
    expect(byLabel.get("Feb 2027")).toBe("2027-03-07");
    expect(byLabel.get("Mar 2027")).toBe("2027-04-30");
  });

  it("demands a note, because an unexplained carve-out is unreviewable", async () => {
    const rule = await firmWithGst(h);
    await expect(
      h.service.addException(
        FIRM,
        rule.id,
        { periodEndMonth: 3, kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 30, note: "  " },
        ACTOR,
      ),
    ).rejects.toThrow(/needs a note saying why/);
  });

  it("refuses a second exception for the same period month", async () => {
    // Two rows claiming March would make the due date depend on row order,
    // which is not a rule at all.
    const rule = await firmWithGst(h);
    const add = () =>
      h.service.addException(
        FIRM,
        rule.id,
        {
          periodEndMonth: 3,
          kind: "day_of_month",
          dueMonthOffset: 1,
          dueDayOfMonth: 30,
          note: "statutory",
        },
        ACTOR,
      );
    await add();
    await expect(add()).rejects.toThrow(/already has an exception/);
  });

  it("refuses an exception on an event-driven rule, which has no periods", async () => {
    await h.service.seedDefaultStates(FIRM, ACTOR);
    const { rule } = await h.service.createRule(
      {
        tenantId: FIRM,
        jurisdiction: "IN",
        name: "PAS-3",
        recurrence: "event",
        fiscalYearStartMonth: 4,
        dueRule: null,
        unresolvedReason: "Triggered by a share allotment, which nothing here sees yet.",
        leadTimeDays: 0,
        rulePack: "in-firm-sheet@2026.08",
      },
      ACTOR,
    );
    await expect(
      h.service.addException(
        FIRM,
        rule.id,
        { periodEndMonth: 3, kind: "days_after", dueDaysAfter: 30, note: "x" },
        ACTOR,
      ),
    ).rejects.toThrow(/no periods/);
  });

  it("MOVES the filings already generated for the period it carves out", async () => {
    // March's TDS is generated eleven months before anybody adds the carve-out
    // saying March is due on 30 April. Without this the exception is right on
    // paper and absent from every row it was written for.
    const rule = await firmWithGst(h);
    await h.service.generate(FIRM, { from: "2026-04-01", to: "2027-03-31" }, ACTOR);
    const march = () => h.instances.rows.find((r) => r.periodLabel === "Mar 2027");
    expect(march()?.statutoryDueOn).toBe("2027-04-20");

    const { effect } = await h.service.addException(
      FIRM,
      rule.id,
      {
        periodEndMonth: 3,
        kind: "day_of_month",
        dueMonthOffset: 1,
        dueDayOfMonth: 30,
        note: "March is the year end, and the statute gives until the 30th.",
      },
      ACTOR,
    );
    expect(effect).toEqual({ restated: 1, locked: 0, spawned: 0 });
    expect(march()?.statutoryDueOn).toBe("2027-04-30");
    // The other eleven are untouched — that is what makes it an exception.
    expect(h.instances.rows.filter((r) => r.statutoryDueOn.endsWith("-20"))).toHaveLength(11);

    // And withdrawing it puts the period back under the rule's own formula,
    // which is a date change in exactly the same way.
    const back = await h.service.removeException(FIRM, rule.id, 3, ACTOR);
    expect(back).toEqual({ restated: 1, locked: 0, spawned: 0 });
    expect(march()?.statutoryDueOn).toBe("2027-04-20");
  });

  it("withdraws by flag, never by destroying the row", async () => {
    const rule = await firmWithGst(h);
    await h.service.addException(
      FIRM,
      rule.id,
      {
        periodEndMonth: 3,
        kind: "day_of_month",
        dueMonthOffset: 1,
        dueDayOfMonth: 30,
        note: "statutory",
      },
      ACTOR,
    );
    await h.service.removeException(FIRM, rule.id, 3, ACTOR);
    expect(h.exceptions.forTemplate(rule.id)).toHaveLength(0);
    // The row is not gone: an exception is WHY a filing was due on the day it
    // was, and withdrawing it in June must not erase April's reason.
    expect(h.exceptions.withdrawn).toEqual([{ templateId: rule.id, periodEndMonth: 3 }]);
    expect(h.events.verbs()).toContain("obligation_rule.exception_removed");
  });
});

describe("the shipped rule pack, seeded", () => {
  it("gives a new firm fifty-seven rules and never overwrites a confirmation", async () => {
    const h = harness();
    // States first, as every firm has them: confirming a rule now fills the
    // calendar there and then, and a generated filing has to have somewhere
    // to begin.
    await h.service.seedDefaultStates(FIRM, ACTOR);
    const created = await h.service.seedIndiaRulePack(FIRM, ACTOR);
    expect(created).toBe(57);

    // A partner confirms one and sets a lead time on it.
    const gstr3b = h.templates.rows.find((r) => r.name === "GSTR-3B");
    if (!gstr3b) throw new Error("GSTR-3B missing from the pack");
    await h.service.updateRule(FIRM, gstr3b.id, { status: "confirmed", leadTimeDays: 5 }, ACTOR);

    // Running the seed again must leave the firm's own work alone.
    expect(await h.service.seedIndiaRulePack(FIRM, ACTOR)).toBe(0);
    const after = h.templates.rows.find((r) => r.id === gstr3b.id);
    expect(after?.status).toBe("confirmed");
    expect(after?.leadTimeDays).toBe(5);
  });

  it("records both numbers, so the honest ratio reaches the log", async () => {
    const h = harness();
    await h.service.seedIndiaRulePack(FIRM, ACTOR);
    const event = h.events.recorded.find((e) => e.verb === "obligation_rules.seeded");
    // "Forty-seven of your rules are waiting on a fact you have not given us"
    // is the state of the firm's own specification, and it belongs in the log
    // rather than only on a screen.
    expect(event?.payload).toMatchObject({ created: 57, generating: 10, awaitingAFact: 47 });
  });

  it("seeds every one of them UNCONFIRMED, India included", async () => {
    const h = harness();
    await h.service.seedIndiaRulePack(FIRM, ACTOR);
    expect(h.templates.rows.every((r) => r.status === "unconfirmed")).toBe(true);
  });
});
