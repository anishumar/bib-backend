// The seams of the findings store (docs/FIN_BUILD_PLAN.md F4.1, F4.2). The
// adapters are `infrastructure/fin/postgres-findings.ts`; the fakes are
// `testfakes/fin-findings.ts`.
import type {
  DismissReason,
  FindingDecision,
  FindingDraft,
  FindingFact,
  FindingLane,
  FindingStatus,
} from "../../domain/fin/finding";
import type { RuleParameterRow } from "../../domain/fin/parameters";

/** A finding to keep: the draft, with the id it will have if it is new. */
export interface NewFinding {
  readonly id: string;
  readonly tenantId: string;
  readonly draft: FindingDraft;
}

/** A person's decision, as stored. The reason is already normalised. */
export interface NewDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly findingId: string;
  readonly decision: FindingDecision;
  readonly reasonCode: DismissReason | null;
  readonly reasonText: string | null;
  readonly decidedByUserId: string;
}

/** One decision, as a screen reads it. */
export interface DecisionView {
  readonly id: string;
  readonly decision: FindingDecision;
  readonly reasonCode: DismissReason | null;
  /** The person's own words; on a dismissal only. */
  readonly reasonText: string | null;
  readonly decidedByUserId: string;
  /** Their display name as it is now; null when the account has none. */
  readonly decidedByName: string | null;
  /** ISO 8601 instant. */
  readonly decidedAt: string;
}

/** One finding, as the staff list reads it: with the client's name, its
 *  status and the decision that gave it. */
export interface FindingView {
  readonly id: string;
  readonly lane: FindingLane;
  readonly checkKey: string;
  readonly clientPartyId: string;
  readonly clientName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly lineIds: readonly string[];
  readonly facts: Readonly<Record<string, FindingFact>>;
  readonly status: FindingStatus;
  readonly latestDecision: DecisionView | null;
  /** ISO 8601 instant. */
  readonly createdAt: string;
}

/** One finding with every decision taken on it, newest first. */
export interface FindingDetail extends FindingView {
  readonly decisions: readonly DecisionView[];
}

/** Which findings a staff screen asks for, newest first. */
export interface FindingFilter {
  readonly clientPartyId: string | null;
  readonly lane: FindingLane | null;
  readonly checkKey: string | null;
  readonly status: FindingStatus | null;
  /** The id of the last finding on the previous page; null for the newest. */
  readonly before: string | null;
  readonly limit: number;
}

export type StatusCounts = Readonly<Record<FindingStatus, number>>;

/** How many findings, by status and by check, for a client and lane filter
 *  (never for one page, and never narrowed by the check or the status the
 *  list is filtered on, so the counts a screen shows as tabs do not move as
 *  somebody clicks them). */
export interface FindingSummary {
  readonly total: number;
  readonly byStatus: StatusCounts;
  readonly byCheck: readonly {
    readonly checkKey: string;
    readonly lane: FindingLane;
    readonly total: number;
    readonly byStatus: StatusCounts;
  }[];
}

export interface FindingStore {
  /** Keeps a finding and the lines it is about, in one transaction. True when
   *  the row was created; false when the firm already holds one with this
   *  dedupe key (a re-run, or two runs at once). Never throws for that case. */
  insert(finding: NewFinding): Promise<boolean>;
  find(tenantId: string, findingId: string): Promise<FindingDetail | null>;
  list(tenantId: string, filter: FindingFilter): Promise<readonly FindingView[]>;
  summary(tenantId: string, filter: { readonly clientPartyId: string | null; readonly lane: FindingLane | null }): Promise<FindingSummary>;
  /** Whether this person is an ACTIVE member of this firm's staff. The
   *  decision's foreign key proves STAFF of this firm; only this proves still
   *  here. */
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
  /** Appends a decision. The finding is known to exist. */
  insertDecision(decision: NewDecision): Promise<void>;
}

/** The dated statutory values (`fin.rule_parameter`, GLOBAL). */
export interface RuleParameterSource {
  /** Every row of one jurisdiction, oldest first. */
  rows(jurisdiction: string): Promise<readonly RuleParameterRow[]>;
}
