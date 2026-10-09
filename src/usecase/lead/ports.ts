// Ports the lead use case needs. `ProspectDirectory` is satisfied by another use
// case (PartyService) at the composition root; the rest by infrastructure/ adapters.
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
  /** Trimmed and non-empty; the service checks before anything is written. */
  readonly title: string;
  readonly partyId: string;
  readonly source: LeadSource;
  readonly ownerUserId: string | null;
  readonly notes: string | null;
  /** Normalised and validated by the service; null is ordinary. */
  readonly jurisdiction: string | null;
  /** Validated, in the firm's reporting currency; null when nobody said. */
  readonly estimatedValue: LeadValue | null;
}

/**
 * Pipeline read model: the lead with its party and owner named, so a screen
 * shows no uuids (the roster's `MemberRecord` shape). The owner carries an email
 * because an account may have no name; showing a colleague's address to
 * `party:read` is accepted because this surface is staff-only (gate 2). Recorded
 * on the board with the staff-directory question, to revisit together.
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

/** One lead's page: the record plus who deleted it (0086). Not on LeadRecord,
 *  since the list never returns a deleted lead. */
export interface LeadDetail extends LeadRecord {
  readonly deletedBy: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
}

/** The detail plus whether Delete would work for THIS caller (0086), so the
 *  page offers the button only when it works and otherwise shows the refusal. */
export interface LeadView extends LeadDetail {
  /** Null when Delete would work. Excludes the caller's `party:write`, which
   *  `/auth/me` already reports. */
  readonly deleteRefusal: { readonly code: LeadErrorCode; readonly message: string } | null;
}

export interface LeadRepository {
  create(l: NewLead): Promise<Lead>;
  /** Deleted or not: "it was deleted" is one of the answers every rule needs. */
  findById(tenantId: string, leadId: string): Promise<Lead | null>;
  /** The party's OPEN lead, the merge target. At most one exists because of the
   *  partial unique index (0007), not this query's ORDER BY. */
  findOpenForParty(tenantId: string, partyId: string): Promise<Lead | null>;
  /** Newest first, optionally one stage. Never a DELETED lead (0086). */
  list(tenantId: string, stage: LeadStage | null): Promise<readonly LeadRecord[]>;
  /** One lead with the same joins, deleted or not, so a link still opens. */
  findRecord(tenantId: string, leadId: string): Promise<LeadDetail | null>;
  /** Refs of the LIVE proposals drafted from this lead, which block deleting it
   *  (0086). A deleted proposal does not count. */
  liveProposalRefs(tenantId: string, leadId: string): Promise<readonly string[]>;
  /**
   * Mark deleted, or null when it already was. `AND deleted_at IS NULL` makes
   * the transition its own lock: two Deletes give one deletion and one refusal,
   * never two `lead.deleted` rows. The rest of the rule is `trg_lead_guard_deletion`.
   */
  markDeleted(
    tenantId: string,
    leadId: string,
    deletedByUserId: string | null,
  ): Promise<Lead | null>;
  /** Stage, closed_at and lost_reason in ONE write so they never disagree (the
   *  DB CHECKs are the backstop); a separate reason write could fail and leave a
   *  lost lead that never says why. */
  moveStage(
    tenantId: string,
    leadId: string,
    stage: LeadStage,
    closedAt: string | null,
    lostReason: string | null,
  ): Promise<Lead>;
  setOwner(tenantId: string, leadId: string, ownerUserId: string | null): Promise<Lead>;
  /** Replaces country and estimate together; null clears either. */
  setDetails(
    tenantId: string,
    leadId: string,
    jurisdiction: string | null,
    estimatedValue: LeadValue | null,
  ): Promise<Lead>;
}

/** The firm's reporting currency (0009), which estimates are written in so the
 *  value filter never compares currencies. Satisfied structurally by the
 *  dashboard adapter, so the fact has one query. */
export interface FirmCurrency {
  reportingCurrency(tenantId: string): Promise<string>;
}

/** Whether a user may hold a lead. Narrow on purpose; satisfied by the
 *  membership adapter. */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/**
 * Whose desk an unclaimed lead lands on. Takes the whole lead so any axis
 * (geography or industry via partyId, service line or campaign via source or a
 * new column) can plug in without touching callers.
 *
 * It CHOOSES AND RECORDS in one call: dividing work decides against shared state
 * (desk load, whose turn), and a choice written outside its critical section
 * lets two simultaneous captures pick identically. It writes only
 * `owner_user_id`; the service records `lead.captured` once, naming the policy.
 *
 * Returns the lead as it stands. `ownerUserId === null` means it DECLINED
 * (nobody active, or no rule covers the lead) and the lead stays in the
 * unassigned queue (0007). Declining is an answer; a capture is never lost to it.
 */
export interface AssignmentStrategy {
  assign(lead: Lead): Promise<AssignmentOutcome>;
}

/**
 * The lead and WHICH rule chose. Per lead, not per strategy: a first-match
 * (territory, then rotation) only knows afterwards, and "the rotation chose
 * Anand" and "the UK desk rule chose Anand" are different facts for
 * `ownerAssignedBy`. `policy: null` means nothing chose (unassigned queue).
 */
export interface AssignmentOutcome {
  readonly lead: Lead;
  readonly policy: AssignmentPolicy | null;
}

/** The firm's country-to-desk rules (T2.1b). Read LIVE, never pinned: a change
 *  applies that afternoon, and history is `lead.captured`'s `ownerAssignedBy`. */
export interface TerritoryRules {
  list(tenantId: string): Promise<readonly TerritoryRule[]>;
  /** Upsert by (tenant, jurisdiction): the schema allows one desk per country. */
  set(r: NewTerritoryRule): Promise<TerritoryRule>;
}

export interface NewTerritoryRule {
  readonly id: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly ownerUserId: string;
  readonly note: string | null;
}

/** The firm's zone (0071): "today" for a captured contact detail when the
 *  caller sends none. Satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`. */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

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

export interface ProspectRelationship {
  readonly tenantId: string;
  readonly fromPartyId: string;
  readonly toPartyId: string;
  readonly type: string;
  readonly validFrom: string;
}

/** The part of the party module's profile a capture reads. */
export interface ProspectProfile {
  readonly party: { readonly kind: PartyKind };
  readonly relationships: readonly {
    readonly relationship: { readonly type: string; readonly validTo: string | null };
    readonly counterparty: { readonly id: string; readonly kind: PartyKind };
    readonly direction: "outgoing" | "incoming";
  }[];
}

export interface ProspectIdentifier {
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly validFrom: string;
}

/**
 * Creating and finding the prospect party. Satisfied by `PartyService`, NOT a
 * repository: party creation owns display-name derivation, identifier
 * normalisation and validation, duplicate refusal, and its own `party.created`
 * and `party_identifier.added` events. Shapes are declared here and match
 * party's structurally, so drift fails to compile at the composition root.
 */
export interface ProspectDirectory {
  createOrganization(input: ProspectOrganization, actor: Actor): Promise<Organization>;
  createPerson(input: ProspectPerson, actor: Actor): Promise<Person>;
  addIdentifier(input: ProspectIdentifier, actor: Actor): Promise<PartyIdentifier>;
  /** Link the contact person to the company in the given role (CA#20); party
   *  records `party_relationship.added`. */
  addRelationship(input: ProspectRelationship, actor: Actor): Promise<unknown>;
  /** Kind and relationships both ways: how a capture finds the company a
   *  contact's email belongs to (CA#20). */
  partyProfile(tenantId: string, partyId: string, asOf?: string): Promise<ProspectProfile>;
  /** The dedup lookup. Normalises the value itself, matching how it was stored. */
  findByIdentifier(
    tenantId: string,
    type: IdentifierType,
    value: string,
  ): Promise<PartyIdentifier | null>;
  /** The matched party, archived or not, so a match on an archived client is
   *  refused by name rather than given a lead (0305). */
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
