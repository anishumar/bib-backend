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
import type { Lead, LeadSource, LeadStage } from "../../domain/lead/model";

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

export interface LeadRepository {
  create(l: NewLead): Promise<Lead>;
  findById(tenantId: string, leadId: string): Promise<Lead | null>;
  /**
   * The party's OPEN lead, if it has one — the merge target.
   *
   * At most one can exist: the partial unique index in migration 0007 is what
   * makes that true, rather than this query's ORDER BY.
   */
  findOpenForParty(tenantId: string, partyId: string): Promise<Lead | null>;
  /** The pipeline, newest first, with the people each lead refers to. Filtered
   *  by stage when one is named. */
  list(tenantId: string, stage: LeadStage | null): Promise<readonly LeadRecord[]>;
  /** One lead, with the same joins. */
  findRecord(tenantId: string, leadId: string): Promise<LeadRecord | null>;
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
}
