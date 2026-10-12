// F4.2: the findings store's rules, against fakes. Raised once and recorded
// once; a person's decision appended, refused in words, and logged by CODE.
//
// The CHECKs, RLS, the GLOBAL table's grants and the membership key are
// database properties, proven in `tests/fin/findings.integration.test.ts`.
import { describe, expect, it } from "vitest";
import {
  AskClientNotWired,
  DeciderNotStaff,
  DismissalNeedsReason,
  FinNotEnabled,
  FindingDraftInvalid,
  FindingNotFound,
  OtherNeedsWords,
  ReasonOnlyOnDismissal,
  ReasonTooLong,
} from "../../src/domain/fin/errors";
import { decisionProblem, normaliseDecision, statusOf } from "../../src/domain/fin/finding";
import type { DecisionInput, FindingDraft } from "../../src/domain/fin/finding";
import { FindingService } from "../../src/usecase/fin/findings";
import { FakeFinFirms } from "../../src/testfakes/fin";
import { FakeFindingStore, FakeRuleParameters, SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { rateText } from "../../src/domain/fin/checks-money";

const FIRM = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PRIYA = "00000000-0000-4000-8000-0000000000a1";
const LEFT = "00000000-0000-4000-8000-0000000000a2";

function draft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    lane: "rule",
    checkKey: "doc.gst_rate",
    clientPartyId: CLIENT,
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    lineIds: ["00000000-0000-4000-8000-00000000d001"],
    facts: { gst: "46.00", expectedGst: "51.75", rateInForce: "9", copies: 1, known: true, note: null },
    dedupeKey: "doc.gst_rate:00000000-0000-4000-8000-00000000d001",
    ...over,
  };
}

function world() {
  const firms = new FakeFinFirms();
  firms.enabled.add(FIRM);
  firms.enabled.add(OTHER);
  const store = new FakeFindingStore().addStaff(FIRM, PRIYA, "Priya Sharma");
  const events = new RecordingEventSink();
  const service = new FindingService({
    firms,
    store,
    parameters: new FakeRuleParameters(SINGAPORE_PARAMETERS),
    events,
    ids: new FakeIds(),
  });
  const as = (userId: string) => ({ userId, actor: { type: "human" as const, id: userId } });
  return { firms, store, events, service, as };
}

const dismiss = (reasonCode: DecisionInput["reasonCode"], reasonText: string | null = null): DecisionInput => ({
  decision: "dismiss",
  reasonCode,
  reasonText,
});

describe("raising findings", () => {
  it("keeps each once and records one event per row it created, as the SYSTEM", async () => {
    const { service, store, events } = world();
    const first = await service.raise(FIRM, [draft(), draft({ checkKey: "doc.cutoff", dedupeKey: "doc.cutoff:x" })]);
    expect(first).toMatchObject({ created: 2, existing: 0 });
    const again = await service.raise(FIRM, [draft(), draft({ checkKey: "doc.cutoff", dedupeKey: "doc.cutoff:x" })]);
    expect(again).toMatchObject({ created: 0, existing: 2 });
    expect(store.findings).toHaveLength(2);
    expect(events.verbs()).toEqual(["fin.finding_raised", "fin.finding_raised"]);
    expect(events.recorded[0]).toMatchObject({ actorType: "system", actorId: null });
  });

  it("treats two drafts with one key in one call as one finding", async () => {
    const { service, events } = world();
    expect(await service.raise(FIRM, [draft(), draft()])).toMatchObject({ created: 1, existing: 1 });
    expect(events.verbs()).toHaveLength(1);
  });

  it("puts ids, codes, counts and the period in the event, never a fact or an amount", async () => {
    const { service, events } = world();
    await service.raise(FIRM, [draft()]);
    expect(events.recorded[0]?.payload).toEqual({
      checkKey: "doc.gst_rate",
      lane: "rule",
      clientPartyId: CLIENT,
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      lineCount: 1,
    });
  });

  it("refuses the whole batch when one draft cannot be stored, writing nothing", async () => {
    const { service, store, events } = world();
    await expect(service.raise(FIRM, [draft(), draft({ checkKey: "Not A Key", dedupeKey: "y" })])).rejects.toBeInstanceOf(
      FindingDraftInvalid,
    );
    await expect(service.raise(FIRM, [draft({ periodEnd: "2025-03-01" })])).rejects.toBeInstanceOf(FindingDraftInvalid);
    await expect(service.raise(FIRM, [draft({ dedupeKey: "" })])).rejects.toBeInstanceOf(FindingDraftInvalid);
    await expect(
      service.raise(FIRM, [draft({ facts: { nested: { a: 1 } } as unknown as FindingDraft["facts"] })]),
    ).rejects.toBeInstanceOf(FindingDraftInvalid);
    expect(store.findings).toHaveLength(0);
    expect(events.verbs()).toHaveLength(0);
  });

  it("keeps one firm's dedupe keys to that firm", async () => {
    const { service } = world();
    await service.raise(FIRM, [draft()]);
    expect(await service.raise(OTHER, [draft()])).toMatchObject({ created: 1 });
  });

  it("is refused as not there for a firm with fin off", async () => {
    const { service, firms } = world();
    firms.enabled.delete(FIRM);
    await expect(service.raise(FIRM, [draft()])).rejects.toBeInstanceOf(FinNotEnabled);
  });
});

describe("a person's decision", () => {
  async function raised() {
    const w = world();
    const report = await w.service.raise(FIRM, [draft()]);
    const id = report.createdIds[0] ?? "";
    return { ...w, id };
  }

  it("is appended, makes the latest decision the status, and names who decided", async () => {
    const { service, id, as } = await raised();
    const corrected = await service.decide(FIRM, id, { decision: "correct", reasonCode: null, reasonText: null }, as(PRIYA));
    expect(corrected.status).toBe("correct");
    const dismissed = await service.decide(FIRM, id, dismiss("price_change"), as(PRIYA));
    expect(dismissed.status).toBe("dismiss");
    expect(dismissed.decisions.map((d) => d.decision)).toEqual(["dismiss", "correct"]);
    expect(dismissed.latestDecision).toMatchObject({ reasonCode: "price_change", decidedByUserId: PRIYA, decidedByName: "Priya Sharma" });
  });

  it("logs the decision and the reason CODE with the person as actor, never the words", async () => {
    const { service, id, as, events } = await raised();
    await service.decide(FIRM, id, dismiss("other", "Ravi confirmed the supplier reissued it as 9%."), as(PRIYA));
    const event = events.recorded.find((e) => e.verb === "fin.finding_decided");
    expect(event).toMatchObject({ actorType: "human", actorId: PRIYA, objectId: id });
    expect(event?.payload).toMatchObject({ decision: "dismiss", reasonCode: "other", checkKey: "doc.gst_rate", lane: "rule" });
    expect(JSON.stringify(event?.payload)).not.toContain("Ravi");
  });

  it("keeps the reason trimmed in the row", async () => {
    const { service, id, as, store } = await raised();
    await service.decide(FIRM, id, dismiss("seasonal", "  December rush  "), as(PRIYA));
    expect(store.decisions[0]?.reasonText).toBe("December rush");
  });

  it.each([
    ["a dismissal with no reason", dismiss(null), DismissalNeedsReason],
    ["`other` with no words", dismiss("other", null), OtherNeedsWords],
    ["`other` with only whitespace", dismiss("other", " \n\t\u00a0 "), OtherNeedsWords],
    ["a reason with `correct`", { decision: "correct", reasonCode: "one_off", reasonText: null }, ReasonOnlyOnDismissal],
    ["words with `correct`", { decision: "correct", reasonCode: null, reasonText: "because" }, ReasonOnlyOnDismissal],
    ["a reason past 2,000 characters", dismiss("other", "x".repeat(2001)), ReasonTooLong],
  ] as const)("refuses %s, writing nothing", async (_label, input, refusal) => {
    const { service, id, as, store, events } = await raised();
    await expect(service.decide(FIRM, id, input, as(PRIYA))).rejects.toBeInstanceOf(refusal);
    expect(store.decisions).toHaveLength(0);
    expect(events.verbs()).toEqual(["fin.finding_raised"]);
  });

  it("accepts words with any reason code, and exactly 2,000 characters", async () => {
    const { service, id, as } = await raised();
    await expect(service.decide(FIRM, id, dismiss("one_off", "The office move."), as(PRIYA))).resolves.toMatchObject({ status: "dismiss" });
    await expect(service.decide(FIRM, id, dismiss("other", "y".repeat(2000)), as(PRIYA))).resolves.toMatchObject({ status: "dismiss" });
  });

  it("refuses asking the client honestly: it is not built, and nothing is recorded", async () => {
    const { service, id, as, store } = await raised();
    const err = await service.decide(FIRM, id, { decision: "ask_client", reasonCode: null, reasonText: null }, as(PRIYA)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AskClientNotWired);
    expect((err as Error).message).toMatch(/^Asking the client from a finding is not built yet/);
    expect(store.decisions).toHaveLength(0);
  });

  it("refuses a person who is not active staff here", async () => {
    const { service, id, as } = await raised();
    await expect(service.decide(FIRM, id, dismiss("expected"), as(LEFT))).rejects.toBeInstanceOf(DeciderNotStaff);
  });

  it("refuses another firm's finding as not there, and a firm with fin off", async () => {
    const { service, id, as, firms } = await raised();
    await expect(service.decide(OTHER, id, dismiss("expected"), as(PRIYA))).rejects.toBeInstanceOf(FindingNotFound);
    await expect(service.get(OTHER, id)).rejects.toBeInstanceOf(FindingNotFound);
    firms.enabled.delete(FIRM);
    await expect(service.decide(FIRM, id, dismiss(null), as(PRIYA))).rejects.toBeInstanceOf(FinNotEnabled);
    await expect(service.get(FIRM, id)).rejects.toBeInstanceOf(FinNotEnabled);
  });
});

describe("the decision rules, pure", () => {
  it("normalises blank words to none and trims the rest", () => {
    expect(normaliseDecision(dismiss("other", "  \t"))).toEqual(dismiss("other", null));
    expect(normaliseDecision(dismiss("other", " ok "))).toEqual(dismiss("other", "ok"));
  });

  it("states the two CHECKs of 0387", () => {
    expect(decisionProblem(dismiss("expected"))).toBeNull();
    expect(decisionProblem({ decision: "ask_client", reasonCode: null, reasonText: null })).toBeNull();
    expect(decisionProblem(dismiss(null))).toBe("dismissal_needs_reason");
    expect(decisionProblem(dismiss("other"))).toBe("other_needs_words");
  });

  it("reads the status off the newest decision", () => {
    expect(statusOf([])).toBe("open");
    expect(statusOf([{ decision: "dismiss" }, { decision: "correct" }])).toBe("dismiss");
  });
});

describe("listing findings", () => {
  it("pages newest first without skipping or repeating, and counts the whole filtered set", async () => {
    const { service, as } = world();
    const { createdIds } = await service.raise(FIRM, [
      draft({ dedupeKey: "a" }),
      draft({ dedupeKey: "b", checkKey: "doc.cutoff" }),
      draft({ dedupeKey: "c", checkKey: "payroll.sdl_missing" }),
    ]);
    await service.decide(FIRM, createdIds[0] ?? "", dismiss("one_off"), as(PRIYA));
    const all = { clientPartyId: null, lane: null, checkKey: null, status: null } as const;
    const first = await service.list(FIRM, { ...all, before: null, limit: 2 });
    expect(first.items.map((f) => f.checkKey)).toEqual(["payroll.sdl_missing", "doc.cutoff"]);
    const second = await service.list(FIRM, { ...all, before: first.nextBefore, limit: 2 });
    expect(second.items.map((f) => f.checkKey)).toEqual(["doc.gst_rate"]);
    expect(second.nextBefore).toBeNull();
    expect(first.summary).toMatchObject({ total: 3, byStatus: { open: 2, ask_client: 0, correct: 0, dismiss: 1 } });
    expect(first.summary.byCheck).toEqual([
      { checkKey: "doc.cutoff", lane: "rule", total: 1, byStatus: { open: 1, ask_client: 0, correct: 0, dismiss: 0 } },
      { checkKey: "doc.gst_rate", lane: "rule", total: 1, byStatus: { open: 0, ask_client: 0, correct: 0, dismiss: 1 } },
      { checkKey: "payroll.sdl_missing", lane: "rule", total: 1, byStatus: { open: 1, ask_client: 0, correct: 0, dismiss: 0 } },
    ]);
  });

  it("filters by status, and its counts do not narrow with the status or the check", async () => {
    const { service, as } = world();
    const { createdIds } = await service.raise(FIRM, [draft({ dedupeKey: "a" }), draft({ dedupeKey: "b" })]);
    await service.decide(FIRM, createdIds[1] ?? "", dismiss("expected"), as(PRIYA));
    const open = await service.list(FIRM, { clientPartyId: null, lane: null, checkKey: "doc.gst_rate", status: "open", before: null, limit: 10 });
    expect(open.items.map((f) => f.id)).toEqual([createdIds[0]]);
    expect(open.summary.total).toBe(2);
  });
});

describe("the dated values, read for a run", () => {
  it("reads one jurisdiction's rows strictly", async () => {
    const { service } = world();
    const sg = await service.parameters("SG");
    expect(sg.jurisdiction).toBe("SG");
    const gst = sg.value("gst.standard_rate", "2025-06-30");
    expect(gst === null ? null : rateText(gst.rate)).toBe("9");
  });
});
