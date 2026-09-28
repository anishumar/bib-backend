// The ports the lead use case needs from the world. Interfaces are owned by the
// use case that needs them, stated in our vocabulary; adapters in
// infrastructure/ implement them, and one of them is satisfied by another use
// case at the composition root.
import type { Actor } from "../../domain/ledger/model";
import type {
  IdentifierType,
  Organization,
  PartyIdentifier,
  PartyKind,
  Person,
} from "../../domain/party/model";
import type {
  AssignmentPolicy,
  TerritoryRule,
  Lead,
  LeadSource,
  LeadStage,
  LeadValue,
} from "../../domain/lead/model";
import type { LeadErrorCode } from "../../domain/lead/errors";

export interface NewLead {
  readonly id: string;
  readonly tenantId: string;
  /** Already trimmed and already known non-empty — the service checks it before
   *  anything is written, so an adapter never has to decide what a blank title
   *  means. */
  readonly title: string;
  readonly partyId: string;
  readonly source: LeadSource;
  readonly ownerUserId: string | null;
  readonly notes: string | null;
  /** Where the PROSPECT is, normalised and validated by the service. Null is
   *  ordinary — often nobody knows yet, and the rotation answers for it. */
  readonly jurisdiction: string | null;
  /** The estimate, already validated and already carrying the firm's reporting
   *  currency. Null when nobody said. */
  readonly estimatedValue: LeadValue | null;
}

/**
 * A lead with the people it refers to — the pipeline READ.
 *
 * `Lead` alone carries `partyId` and `ownerUserId`, which is right for the
 * aggregate and useless for a screen: a board rendering it shows two uuids per
 * card, or fetches a party and an account per row. The same joined-read-model
 * shape the roster uses (`MemberRecord`), for the same reason.
 *
 * The owner carries an email as well as a name, because an account may have no
 * name and "owned by 3f9c…" helps nobody. That does disclose a colleague's
 * address to anybody with `party:read` — acceptable here because this surface is
 * staff-only (gate 2 keeps client-portal sessions off it entirely), and it is
 * the first real answer to the staff-directory question the roster deferred.
 * Recorded on the board so the two are revisited together.
 */
export interface LeadRecord {
  readonly lead: Lead;
  readonly party: {
    readonly id: string;
    readonly kind: PartyKind;
    readonly displayName: string;
  };
  readonly owner: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
}

/**
 * ONE lead as its own page shows it: the record, and who deleted it (0086).
 *
 * Its own type rather than a field on `LeadRecord`, because a pipeline row is
 * never deleted — the list leaves deleted leads out — and a column that is null
 * on every row a list can return is a join the list pays for and never uses.
 */
export interface LeadDetail extends LeadRecord {
  readonly deletedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
}

/**
 * A lead's own page: the detail, and whether Delete would work for THIS caller
 * (0086). "A caller is told what it may do": the page offers the button only
 * when it will work, and otherwise shows the very sentence a DELETE would be
 * refused with, so nobody presses it to find out.
 */
export interface LeadView extends LeadDetail {
  /** Why Delete would be refused right now, or null when it would work. The
   *  caller's `party:write` is not part of it — `/auth/me` already says that. */
  readonly deleteRefusal: { readonly code: LeadErrorCode; readonly message: string } | null;
}

export interface LeadRepository {
  create(l: NewLead): Promise<Lead>;
  /** Deleted or not: this is the read every rule about a lead starts from, and
   *  "it was deleted" is one of the answers. */
  findById(tenantId: string, leadId: string): Promise<Lead | null>;
  /**
   * The party's OPEN lead, if it has one — the merge target.
   *
   * At most one can exist: the partial unique index in migration 0007 is what
   * makes that true, rather than this query's ORDER BY.
   */
  findOpenForParty(tenantId: string, partyId: string): Promise<Lead | null>;
  /** The pipeline, newest first, with the people each lead refers to. Filtered
   *  by stage when one is named. A DELETED lead is never in it (0086). */
  list(tenantId: string, stage: LeadStage | null): Promise<readonly LeadRecord[]>;
  /** One lead, with the same joins — deleted or not, because a link to a lead
   *  must still open, and say what happened to it. */
  findRecord(tenantId: string, leadId: string): Promise<LeadDetail | null>;
  /**
   * The references of the LIVE proposals drafted from this lead — what stops it
   * being deleted (0086). A deleted proposal is not one: deleting in order, the
   * quote and then the lead, always works.
   */
  liveProposalRefs(tenantId: string, leadId: string): Promise<readonly string[]>;
  /**
   * Mark the lead deleted, or return null when it already was.
   *
   * `AND deleted_at IS NULL` makes the transition its own lock, the way the
   * party archive does: two people pressing Delete at once get one deletion and
   * one refusal, never two `lead.deleted` rows in a log that cannot be
   * corrected. The rest of the rule is the trigger's (`trg_lead_guard_deletion`),
   * which the service has already asked about by name.
   */
  markDeleted(
    tenantId: string,
    leadId: string,
    deletedByUserId: string | null,
  ): Promise<Lead | null>;
  /**
   * Moves the stage, closed_at and lost_reason TOGETHER, so no two of them can
   * disagree — the database CHECKs are the backstop, not the mechanism.
   *
   * All three in one signature rather than a separate `recordLostReason`: a
   * closing reason written a moment after the close is a second write that can
   * fail on its own, leaving a lost lead that never says why, which is the
   * state this field exists to end.
   */
  moveStage(
    tenantId: string,
    leadId: string,
    stage: LeadStage,
    closedAt: string | null,
    lostReason: string | null,
  ): Promise<Lead>;
  setOwner(tenantId: string, leadId: string, ownerUserId: string | null): Promise<Lead>;
  /**
   * Where the prospect is and what the opportunity could be worth, written
   * TOGETHER — the two facts the pipeline list sizes and filters on. Both are
   * replaced: null clears either.
   */
  setDetails(
    tenantId: string,
    leadId: string,
    jurisdiction: string | null,
    estimatedValue: LeadValue | null,
  ): Promise<Lead>;
}

/**
 * The firm's reporting currency (0009) — what a lead's estimate is written in.
 *
 * One currency per firm is what makes the pipeline's value filter honest: a
 * "more than 5,00,000" that compared rupees with dollars would be a number, not
 * an answer. Satisfied structurally by the dashboard adapter, which already
 * reads it, so there is one query for this fact rather than two.
 */
export interface FirmCurrency {
  reportingCurrency(tenantId: string): Promise<string>;
}

/**
 * Who at the firm may hold a lead.
 *
 * Narrow on purpose — this use case does not want to know what a membership is,
 * only whether a proposed owner can actually work the lead. Satisfied by the
 * membership adapter, the same way identity states its needs as its own narrow
 * ports over the same rows.
 */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/**
 * WHOSE DESK an unclaimed lead lands on — the seam a firm's assignment rule
 * plugs into.
 *
 * ## Why the argument is the whole lead
 *
 * A strategy is handed the OPPORTUNITY, not a tenant id and a shrug. That is
 * what lets a territory strategy drop in here without touching a single caller
 * on the day its axis is finally chosen: whichever axis wins, it is reachable
 * from what a `Lead` already carries. Geography and industry hang off
 * `partyId`; service line and campaign hang off `source` or a column a later
 * migration adds to the lead itself. So the seam commits to no axis and
 * forecloses none — which is precisely the shape T2.1 deferred territory in
 * order to keep.
 *
 * ## Why it RECORDS the owner rather than returning a name
 *
 * The obvious signature is `chooseOwner(lead): Promise<string | null>`, with
 * the use case writing the answer afterwards. It is wrong, and subtly: any
 * strategy that divides work between people decides against SHARED STATE — how
 * loaded the other desks are, whose turn it is — and a decision applied outside
 * the critical section it was taken in is not a decision, it is a guess that
 * two simultaneous captures will make identically. Choosing and recording are
 * one operation or the rotation is not fair, so they are one method.
 *
 * The use case still owns the TIMELINE: the strategy writes `owner_user_id` and
 * nothing else, and `lead.captured` is recorded by the service, once, naming
 * the policy that chose.
 *
 * ## What it returns
 *
 * The lead as it now stands. An owner on it means the strategy chose somebody;
 * `ownerUserId === null` means it declined and the lead stays in the unassigned
 * queue — a firm with nobody active to give it to, or a strategy with no rule
 * covering this lead. **Declining is a real answer, not a failure**: a capture
 * must not be lost because assignment had nobody to pick, and the unassigned
 * queue is a state this pipeline has supported since migration 0007.
 */
export interface AssignmentStrategy {
  assign(lead: Lead): Promise<AssignmentOutcome>;
}

/**
 * What assignment did — the lead, and WHICH rule chose.
 *
 * The policy used to be a field on the strategy, read by the service off
 * `deps.assignment.policy`. That worked while there was exactly one rule and
 * stopped working the moment there were two: a strategy that tries territory
 * and falls through to the rotation cannot answer "which rule is this" in
 * advance, because the answer is per lead. A field would have made the timeline
 * lie about half the captures, which is the one thing `ownerAssignedBy` exists
 * to prevent — "the rotation chose Anand" and "the UK desk rule chose Anand"
 * are different facts, and only the first is evidence about whether the
 * rotation is working.
 *
 * `policy: null` means nothing chose, and the lead is in the unassigned queue.
 * DECLINING IS A REAL ANSWER: a firm with nobody active, or no rule covering
 * this lead. A capture must not be lost because assignment had nobody to pick.
 */
export interface AssignmentOutcome {
  readonly lead: Lead;
  readonly policy: AssignmentPolicy | null;
}

/**
 * Whose desk covers a country — the rules a firm maintains (T2.1b).
 *
 * Read LIVE, never pinned: a firm that moves the UK to somebody else expects it
 * that afternoon, the same reading roles get. Nothing historical resolves
 * through this — what a lead's assignment MEANT is already on the timeline, in
 * `lead.captured`'s `ownerAssignedBy`.
 */
export interface TerritoryRules {
  list(tenantId: string): Promise<readonly TerritoryRule[]>;
  /** Upsert by (tenant, jurisdiction). One desk per country is a constraint in
   *  the schema, so "set" is the only honest verb. */
  set(r: NewTerritoryRule): Promise<TerritoryRule>;
}

export interface NewTerritoryRule {
  readonly id: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly ownerUserId: string;
  readonly note: string | null;
}

/**
 * Which zone the firm keeps its calendar in (0071): "today" for a contact
 * detail a capture attaches, when the caller did not say. Structural:
 * satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

// ── The party seam ───────────────────────────────────────────────────────────

export interface ProspectOrganization {
  readonly tenantId: string;
  readonly legalName: string;
  readonly tradeName?: string | undefined;
  readonly industry?: string | undefined;
  readonly website?: string | undefined;
}

export interface ProspectPerson {
  readonly tenantId: string;
  readonly fullName: string;
}

export interface ProspectIdentifier {
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly validFrom: string;
}

/**
 * Creating and finding the party a lead is about.
 *
 * Satisfied by `PartyService` at the composition root — NOT by a repository.
 * That is the point: party creation carries rules this use case must not
 * reimplement (display-name derivation, identifier normalisation and shape
 * validation, refusing a duplicate identifier) and it records `party.created`
 * and `party_identifier.added` itself. A lead capture that reached the tables
 * directly would quietly produce parties the party module never saw.
 *
 * The shapes below are declared here rather than imported from usecase/party,
 * so this module states what it needs in its own file and the two happen to
 * agree structurally. If party's inputs drift, this breaks at the composition
 * root — one place, at compile time.
 */
export interface ProspectDirectory {
  createOrganization(input: ProspectOrganization, actor: Actor): Promise<Organization>;
  createPerson(input: ProspectPerson, actor: Actor): Promise<Person>;
  addIdentifier(input: ProspectIdentifier, actor: Actor): Promise<PartyIdentifier>;
  /** The dedup lookup. Normalises the value itself, so callers pass what the
   *  user typed and matching stays consistent with how it was stored. */
  findByIdentifier(
    tenantId: string,
    type: IdentifierType,
    value: string,
  ): Promise<PartyIdentifier | null>;
  /** The party a capture matched, archived or not — so a match on a client the
   *  firm put away is refused by name rather than quietly given a lead (0305). */
  findParty(
    tenantId: string,
    partyId: string,
  ): Promise<{
    readonly displayName: string;
    readonly archivedAt: string | null;
    /** One of the firm's own companies (0313): a capture that lands on one is refused. */
    readonly isOwnCompany: boolean;
  } | null>;
}
