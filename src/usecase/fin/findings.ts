// FinCompliance findings (docs/FIN_BUILD_PLAN.md F4.1, F4.2): keeping what the
// checks say, and recording what a person decides about it.
//
// Ground rule 2, as a use case: `raise` is the machine saying "check this" and
// is called by the fin job with the SYSTEM as actor; `decide` is a person's
// answer, behind `books:write`, and is the only way a finding's status moves.
// Nothing here changes a line, posts anything or tells the client anything.
//
// ── RAISED ONCE, HOWEVER OFTEN THE CHECKS RUN ───────────────────────────────
//
// A check builds the same `dedupeKey` for the same finding every run, and the
// store's insert conflicts on the firm's unique key, so the fin job can run the
// checks every ten minutes and a person sees each finding once. The ledger
// event is written only for a row actually created: the intake sweep's
// at-least-once arrangement, and the requests sweep's.
//
// ── NOT WIRED YET, AND SAID ─────────────────────────────────────────────────
//
// Nothing calls `raise` from a sweep: there are no committed lines until
// staging (F2.8) exists, and a sweep over the read drafts would raise findings
// about lines no person has accepted. Asking the client from a finding is F4.6
// and is refused (`AskClientNotWired`) rather than recorded as if it happened.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
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
} from "../../domain/fin/errors";
import {
  REASON_TEXT_MAX,
  decisionProblem,
  findingDraftProblem,
  normaliseDecision,
} from "../../domain/fin/finding";
import type { DecisionInput, DecisionProblem, FindingDraft } from "../../domain/fin/finding";
import { RuleParameters } from "../../domain/fin/parameters";
import type { EventSink } from "../ledger/ports";
import type { FinFirms } from "./ports";
import type {
  FindingDetail,
  FindingFilter,
  FindingStore,
  FindingSummary,
  FindingView,
  RuleParameterSource,
} from "./finding-ports";

export interface FindingDeps {
  readonly firms: FinFirms;
  readonly store: FindingStore;
  readonly parameters: RuleParameterSource;
  readonly events: EventSink;
  readonly ids: IdGen;
}

export interface RaiseReport {
  readonly tenantId: string;
  /** Findings written on this call. */
  readonly created: number;
  /** Drafts the firm already held a finding for: the number that shows the
   *  dedupe working. */
  readonly existing: number;
  readonly createdIds: readonly string[];
}

export interface FindingPage {
  readonly items: readonly FindingView[];
  readonly summary: FindingSummary;
  /** Pass back as `before` for the next page; null when this is the last. */
  readonly nextBefore: string | null;
}

/** Who is deciding: the session's person, and the actor the ledger names. */
export interface Decider {
  readonly userId: string;
  readonly actor: Actor;
}

export class FindingService {
  constructor(private readonly deps: FindingDeps) {}

  /** Refuses a firm with fin off as not there (a 404), as every fin read does. */
  private async requireEnabled(tenantId: string): Promise<void> {
    if ((await this.deps.firms.enabledSince(tenantId)) === null) throw new FinNotEnabled();
  }

  /**
   * Keeps what the checks said, once each. Every draft is checked BEFORE any
   * is written, so a check with a bug writes nothing rather than half its
   * findings. Two drafts with one dedupe key in one call are one finding.
   */
  async raise(tenantId: string, drafts: readonly FindingDraft[]): Promise<RaiseReport> {
    await this.requireEnabled(tenantId);
    for (const draft of drafts) {
      const problem = findingDraftProblem(draft);
      if (problem !== null) throw new FindingDraftInvalid(`${draft.checkKey}: ${problem}`);
    }
    const createdIds: string[] = [];
    let existing = 0;
    for (const draft of drafts) {
      const id = this.deps.ids.newId();
      if (!(await this.deps.store.insert({ id, tenantId, draft }))) {
        existing += 1;
        continue;
      }
      createdIds.push(id);
      await this.deps.events.recordEvent({
        tenantId,
        verb: "fin.finding_raised",
        objectId: id,
        actor: SYSTEM_ACTOR,
        payload: {
          checkKey: draft.checkKey,
          lane: draft.lane,
          clientPartyId: draft.clientPartyId,
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          lineCount: draft.lineIds.length,
        },
      });
    }
    return { tenantId, created: createdIds.length, existing, createdIds };
  }

  /**
   * A person's answer to a finding. Refused, in this order: fin off at this
   * firm, a decision the form can fix (a dismissal's reason), a finding that is
   * not there, "ask the
   * client" (not built, F4.6), and a person who is not active staff here. The
   * decision is appended, never overwritten; the event carries the reason CODE
   * and never its words.
   */
  async decide(
    tenantId: string,
    findingId: string,
    input: DecisionInput,
    by: Decider,
  ): Promise<FindingDetail> {
    await this.requireEnabled(tenantId);
    const decision = normaliseDecision(input);
    const problem = decisionProblem(decision);
    if (problem !== null) throw refusalFor(problem);
    const finding = await this.deps.store.find(tenantId, findingId);
    if (finding === null) throw new FindingNotFound(findingId);
    if (decision.decision === "ask_client") throw new AskClientNotWired();
    if (!(await this.deps.store.isActiveStaff(tenantId, by.userId))) throw new DeciderNotStaff(by.userId);

    const decisionId = this.deps.ids.newId();
    await this.deps.store.insertDecision({
      id: decisionId,
      tenantId,
      findingId,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      reasonText: decision.reasonText,
      decidedByUserId: by.userId,
    });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "fin.finding_decided",
      objectId: findingId,
      actor: by.actor,
      payload: {
        decisionId,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        checkKey: finding.checkKey,
        lane: finding.lane,
      },
    });
    const after = await this.deps.store.find(tenantId, findingId);
    if (after === null) throw new FindingNotFound(findingId);
    return after;
  }

  /** One finding with its decisions and who made them. */
  async get(tenantId: string, findingId: string): Promise<FindingDetail> {
    await this.requireEnabled(tenantId);
    const finding = await this.deps.store.find(tenantId, findingId);
    if (finding === null) throw new FindingNotFound(findingId);
    return finding;
  }

  /**
   * The firm's findings, newest first, a page at a time, with the counts by
   * status and by check for the client and lane filter (see `FindingSummary`).
   */
  async list(tenantId: string, filter: FindingFilter): Promise<FindingPage> {
    await this.requireEnabled(tenantId);
    // One more than the page, to know whether there is a next one.
    const rows = await this.deps.store.list(tenantId, { ...filter, limit: filter.limit + 1 });
    const items = rows.slice(0, filter.limit);
    const last = items.at(-1);
    const summary = await this.deps.store.summary(tenantId, {
      clientPartyId: filter.clientPartyId,
      lane: filter.lane,
    });
    return { items, summary, nextBefore: rows.length > filter.limit && last !== undefined ? last.id : null };
  }

  /** The dated statutory values of one jurisdiction, read and checked once,
   *  for a run of the checks. */
  async parameters(jurisdiction: string): Promise<RuleParameters> {
    return RuleParameters.from(jurisdiction, await this.deps.parameters.rows(jurisdiction));
  }
}

function refusalFor(problem: DecisionProblem): Error {
  switch (problem) {
    case "dismissal_needs_reason":
      return new DismissalNeedsReason();
    case "other_needs_words":
      return new OtherNeedsWords();
    case "reason_only_on_dismissal":
      return new ReasonOnlyOnDismissal();
    case "reason_too_long":
      return new ReasonTooLong(REASON_TEXT_MAX);
  }
}
