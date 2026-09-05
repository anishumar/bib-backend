// The party use case — orchestration + business rules against ports. No I/O, no
// SQL, no HTTP: every outside thing is an injected port, so this reads like a
// description of what the business does and is testable with in-memory fakes.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  IdentifierType,
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
} from "../../domain/party/model";
import {
  isArchived,
  isInForceOn,
  isValidDateRange,
  isValidIdentifier,
  normalizeIdentifier,
} from "../../domain/party/model";
import {
  DuplicateIdentifier,
  InvalidDateRange,
  InvalidIdentifier,
  InvalidRelationshipType,
  NotAnOrganization,
  PartyAlreadyArchived,
  PartyNotArchived,
  PartyNotFound,
  RelationshipAlreadyEnded,
  RelationshipEndsBeforeItBegan,
  RelationshipNotFound,
  SelfRelationship,
} from "../../domain/party/errors";
import type {
  IdentifierRepository,
  PartyRepository,
  RelationshipRecord,
  RelationshipType,
  RelationshipRepository,
} from "./ports";

export interface Deps {
  readonly parties: PartyRepository;
  readonly identifiers: IdentifierRepository;
  readonly relationships: RelationshipRepository;
  readonly ids: IdGen;
  /** The audit trail. Every write below records one event naming its actor —
   *  the port, never the ledger service or an adapter (docs/EVENT-CONTRACT.md). */
  readonly events: EventSink;
}

// Optional fields are written `?: T | undefined` on purpose: the project runs
// exactOptionalPropertyTypes, and these inputs are spread straight from
// zod-parsed request bodies where an absent field IS `undefined`.
export interface CreateOrganizationInput {
  readonly tenantId: string;
  readonly legalName: string;
  readonly tradeName?: string | undefined;
  readonly industry?: string | undefined;
  readonly website?: string | undefined;
}

export interface CreatePersonInput {
  readonly tenantId: string;
  readonly fullName: string;
  readonly nationality?: string | undefined;
  readonly dateOfBirth?: string | undefined;
}

export interface RegisterLegalEntityInput {
  readonly tenantId: string;
  readonly organizationPartyId: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly incorporatedOn?: string | undefined;
  readonly financialYearEnd?: string | undefined;
  readonly registeredAddress?: Record<string, unknown> | undefined;
}

export interface AddIdentifierInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly jurisdiction?: string | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
}

export interface ArchivePartyInput {
  readonly tenantId: string;
  readonly partyId: string;
}

export interface EndRelationshipInput {
  readonly tenantId: string;
  readonly relationshipId: string;
  /** The first day the relationship is NOT in force — half-open, the same
   *  convention as `crm.portal_access`, `crm.client_assignment`,
   *  `crm.client_freeze` and `core.party_identifier`. A director who resigned
   *  on the 12th is ended on the 12th, and the 11th is her last day. */
  readonly validTo: string;
}

export interface AddRelationshipInput {
  readonly tenantId: string;
  readonly fromPartyId: string;
  readonly toPartyId: string;
  readonly type: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly attributes?: Record<string, unknown> | undefined;
}

/**
 * Party 360 — everything the firm knows about one counterparty.
 *
 * `organization` and `person` are the subtype detail, and exactly one is set,
 * by kind. They were absent until a screen had to render this: the legal name,
 * the trade name, the industry, the date of birth were all captured at creation
 * and then unreachable through any read, so the detail page could show a
 * display name and nothing else.
 *
 * `legalEntities` is the same story with a sharper edge — `registerLegalEntity`
 * had no counterpart at all, so a jurisdiction and a financial-year end could be
 * written and never read back. A write with no read is not a stored fact.
 */
export interface PartyProfile {
  readonly party: Party;
  readonly organization: Organization | null;
  readonly person: Person | null;
  readonly legalEntities: readonly LegalEntity[];
  readonly identifiers: readonly PartyIdentifier[];
  /** Joined to the party at the other end — see RelationshipRecord. */
  readonly relationships: readonly RelationshipRecord[];
}

export class PartyService {
  constructor(private readonly deps: Deps) {}

  // Every mutating method takes the actor as a second argument rather than
  // folding it into the input DTO: WHO is doing this is orthogonal to WHAT is
  // being done, and keeping it separate means the request shapes stay the
  // shapes the API documents.
  //
  // The event is recorded AFTER the change commits, per the contract — an event
  // must never claim something that was rolled back. If the ledger write then
  // fails the call fails with it, deliberately: a silent gap in an audit trail
  // is the kind of thing discovered in a regulator's meeting, so it is louder
  // to break here than to quietly stop recording.

  /** Create an organization party. Display name prefers the trade name, falling
   *  back to the legal name. */
  async createOrganization(input: CreateOrganizationInput, actor: Actor): Promise<Organization> {
    const org = await this.deps.parties.createOrganization({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      industry: input.industry ?? null,
      website: input.website ?? null,
      displayName: input.tradeName?.trim() || input.legalName,
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.created",
      objectId: org.partyId,
      actor,
      payload: { kind: "organization" },
    });
    return org;
  }

  /** Create a person party. */
  async createPerson(input: CreatePersonInput, actor: Actor): Promise<Person> {
    const person = await this.deps.parties.createPerson({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fullName: input.fullName,
      nationality: input.nationality ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      displayName: input.fullName,
    });
    // The payload names the KIND, never the person. A name is personal data and
    // the ledger cannot be erased; the row it points at can.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.created",
      objectId: person.partyId,
      actor,
      payload: { kind: "person" },
    });
    return person;
  }

  /** Register a legal entity against an existing organization party. Enforced
   *  here and by the DB FK to organization — a person can never be one. */
  async registerLegalEntity(
    input: RegisterLegalEntityInput,
    actor: Actor,
  ): Promise<LegalEntity> {
    const org = await this.deps.parties.findOrganization(input.tenantId, input.organizationPartyId);
    if (!org) throw new NotAnOrganization(input.organizationPartyId);
    const entity = await this.deps.parties.addLegalEntity({
      partyId: input.organizationPartyId,
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction.trim().toUpperCase(),
      entityType: input.entityType,
      incorporatedOn: input.incorporatedOn ?? null,
      financialYearEnd: input.financialYearEnd ?? null,
      registeredAddress: input.registeredAddress ?? null,
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "legal_entity.registered",
      objectId: entity.partyId,
      actor,
      payload: { jurisdiction: entity.jurisdiction, entityType: entity.entityType },
    });
    return entity;
  }

  /** Attach an identifier (PAN, GSTIN, email…) to a party. Normalises and
   *  shape-validates the value, and rejects a duplicate within the tenant so
   *  the dedup key stays trustworthy. */
  async addIdentifier(input: AddIdentifierInput, actor: Actor): Promise<PartyIdentifier> {
    const party = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (!party) throw new PartyNotFound(input.partyId);

    const value = normalizeIdentifier(input.type, input.value);
    if (!isValidIdentifier(input.type, value)) throw new InvalidIdentifier(input.type, input.value);
    if (!isValidDateRange(input.validFrom, input.validTo ?? null)) {
      throw new InvalidDateRange(input.validFrom, input.validTo ?? null);
    }

    const existing = await this.deps.identifiers.findByValue(input.tenantId, input.type, value);
    if (existing) throw new DuplicateIdentifier(input.type, value);

    const identifier = await this.deps.identifiers.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId: input.partyId,
      type: input.type,
      value,
      jurisdiction: input.jurisdiction ?? null,
      isPrimary: input.isPrimary ?? false,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    });
    // The TYPE of identifier, never the value. A PAN or a passport number in an
    // un-erasable log is precisely what the contract's no-PII rule is about —
    // and note the denylist would not have caught it under the key "value".
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party_identifier.added",
      objectId: identifier.id,
      actor,
      payload: { partyId: input.partyId, identifierType: input.type },
    });
    return identifier;
  }

  /**
   * The relationship vocabulary — six product-owned codes, with the sentence
   * each one reads as from either end.
   *
   * A read with no tenant and no permission of its own beyond `party:read`,
   * because there is nothing here belonging to anybody: it is the same list for
   * every firm on the platform. It exists because the screen that RECORDS a
   * relationship had to hardcode the codes and their English to offer them, and
   * a copy of a migration's seed data living in a component is a copy that goes
   * stale the first time the product adds a code.
   */
  async relationshipTypes(): Promise<readonly RelationshipType[]> {
    return this.deps.relationships.listRelationshipTypes();
  }

  /** Record an effective-dated relationship between two parties. */
  async addRelationship(input: AddRelationshipInput, actor: Actor): Promise<PartyRelationship> {
    if (input.fromPartyId === input.toPartyId) throw new SelfRelationship();
    if (!isValidDateRange(input.validFrom, input.validTo ?? null)) {
      throw new InvalidDateRange(input.validFrom, input.validTo ?? null);
    }

    const [from, to, typeOk] = await Promise.all([
      this.deps.parties.findParty(input.tenantId, input.fromPartyId),
      this.deps.parties.findParty(input.tenantId, input.toPartyId),
      this.deps.relationships.relationshipTypeExists(input.type),
    ]);
    if (!from) throw new PartyNotFound(input.fromPartyId);
    if (!to) throw new PartyNotFound(input.toPartyId);
    if (!typeOk) throw new InvalidRelationshipType(input.type);

    const relationship = await this.deps.relationships.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fromPartyId: input.fromPartyId,
      toPartyId: input.toPartyId,
      type: input.type,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      attributes: input.attributes ?? {},
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party_relationship.recorded",
      objectId: relationship.id,
      actor,
      payload: {
        fromPartyId: relationship.fromPartyId,
        toPartyId: relationship.toPartyId,
        relationshipType: relationship.type,
        validFrom: relationship.validFrom,
      },
    });
    return relationship;
  }

  /**
   * Close an open relationship (`party_relationship.ended`).
   *
   * ── THE VERB WAS DECLARED AND NOTHING RAISED IT ─────────────────────────
   *
   * `party_relationship.ended` has been in the ledger vocabulary since the
   * module was built, with no route, no service method and no repository
   * method behind it — the screen that records a relationship said so in prose
   * and asked a partner to type an end date at the moment of RECORDING, which
   * only works for a relationship that was already over when the firm heard
   * about it. A directorship that ends while the product is watching had
   * nowhere to be written down.
   *
   * ── A DATE, NOT "TODAY" ─────────────────────────────────────────────────
   *
   * `endAccountTeamAssignment` ends on the caller's own day because that is an
   * operational fact the firm controls as it happens. This is not: a
   * resignation has a date the registrar recorded, the firm hears about it
   * afterwards, and ending it "today" would be wrong by however long the post
   * took. So the caller names the day and this refuses one that is not after
   * the day it began — which the database also refuses
   * (`party_relationship_dates_chk`), and which is why the check here is a
   * sentence a partner can read rather than the rule itself.
   *
   * ── AND IT IS NOT AN EDIT ───────────────────────────────────────────────
   *
   * A relationship that already carries an end date is refused rather than
   * moved. Correcting a date somebody has already been told about is a
   * different act and would need its own verb; quietly overwriting one would
   * leave the ledger saying it ended twice, on two different days, with
   * nothing to say which was true.
   */
  async endRelationship(input: EndRelationshipInput, actor: Actor): Promise<PartyRelationship> {
    const existing = await this.deps.relationships.find(input.tenantId, input.relationshipId);
    if (!existing) throw new RelationshipNotFound(input.relationshipId);
    if (existing.validTo !== null) {
      throw new RelationshipAlreadyEnded(input.relationshipId, existing.validTo);
    }
    if (!isValidDateRange(existing.validFrom, input.validTo)) {
      // NOT `InvalidDateRange`: this caller supplied one date, not two, and the
      // refusal has to say which day it must be after. See the error's own
      // comment — it was written after reading the other one on the screen.
      throw new RelationshipEndsBeforeItBegan(existing.validFrom, input.validTo);
    }

    const ended = await this.deps.relationships.endIfOpen(
      input.tenantId,
      input.relationshipId,
      input.validTo,
    );
    // The read above and this write are two statements. Losing the race reads
    // exactly like clicking twice, and both are refused rather than writing a
    // second `ended` event about the same relationship.
    if (!ended) throw new RelationshipAlreadyEnded(input.relationshipId, input.validTo);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party_relationship.ended",
      objectId: ended.id,
      actor,
      payload: {
        fromPartyId: ended.fromPartyId,
        toPartyId: ended.toPartyId,
        relationshipType: ended.type,
        validFrom: ended.validFrom,
        validTo: ended.validTo,
      },
    });
    return ended;
  }

  // ── The party lifecycle: archived, never deleted ──────────────────────────
  //
  // There is no delete on this service and there is no `deleted_at` in `core`
  // to build one on. A party is permanent, because a signed engagement letter
  // has to name a counterparty that still resolves years later; a real
  // company's lifecycle is answered by the ledger and by
  // `core.legal_entity.status`. `archived_at` says only "keep this out of the
  // pickers", and the two methods below are its whole surface.
  //
  // THE REFUSAL LIVES IN THE DATABASE, not here. `archive()` on the port is
  // refused by the trigger (0035, body replaced by 0036) while anything still
  // points at the party, so an import or an agent is stopped by the same rule
  // this call is. What this service owns is the state machine around it — the
  // party exists, and it is not already in the state being asked for — and the
  // event.
  //
  // The check below is the FRIENDLY answer, not the guarantee: it and the write
  // are two statements, so the port is required to make the transition itself
  // atomic and refuse the loser of a race. Otherwise two clicks put two
  // `party.archived` rows in a log that can never be corrected.

  /** Hide a party from pickers and lists. Refused by the database while a lead,
   *  proposal, engagement letter, letter line's entity or engagement still
   *  points at it; the port translates that into `PartyHasReferences`. */
  async archiveParty(input: ArchivePartyInput, actor: Actor): Promise<Party> {
    const party = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (!party) throw new PartyNotFound(input.partyId);
    if (isArchived(party)) throw new PartyAlreadyArchived(input.partyId);

    const archived = await this.deps.parties.archive(input.tenantId, input.partyId);
    // The KIND, never the display name — a party's display name routinely IS a
    // person's name, and the ledger cannot be erased.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.archived",
      objectId: archived.id,
      actor,
      payload: { kind: archived.kind },
    });
    return archived;
  }

  /** Bring an archived party back into the pickers and lists. Never refused:
   *  restoring a party cannot orphan anything. */
  async unarchiveParty(input: ArchivePartyInput, actor: Actor): Promise<Party> {
    const party = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (!party) throw new PartyNotFound(input.partyId);
    if (!isArchived(party)) throw new PartyNotArchived(input.partyId);

    const restored = await this.deps.parties.unarchive(input.tenantId, input.partyId);
    // How long it was away is a machine fact worth keeping: the ledger already
    // holds the archive event, and this closes the interval without a join.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.unarchived",
      objectId: restored.id,
      actor,
      payload: { kind: restored.kind, archivedAt: party.archivedAt },
    });
    return restored;
  }

  /** A small Party 360: the party, its identifiers, and its relationships —
   *  optionally filtered to those in force on `asOf` (the compliance question,
   *  "who was a director on 31 March").
   *
   *  READING ONE PARTY BY ID ALWAYS RESOLVES, archived or not. That asymmetry
   *  with `listParties` is deliberate and load-bearing: the list is a picker
   *  and an archived party has no business in it, but a proposal, a letter or
   *  an engagement pointing at this id has to render its counterparty, and a
   *  document whose client goes blank is worse than one nobody can tidy up. */
  async partyProfile(tenantId: string, partyId: string, asOf?: string): Promise<PartyProfile> {
    const party = await this.deps.parties.findParty(tenantId, partyId);
    if (!party) throw new PartyNotFound(partyId);

    // The subtype is fetched by KIND rather than both-and-discard: a person has
    // no organization row and asking for one is a query that can only ever
    // return nothing.
    const [organization, person, legalEntities, identifiers, relationships] = await Promise.all([
      party.kind === "organization"
        ? this.deps.parties.findOrganization(tenantId, partyId)
        : Promise.resolve(null),
      party.kind === "person"
        ? this.deps.parties.findPerson(tenantId, partyId)
        : Promise.resolve(null),
      party.kind === "organization"
        ? this.deps.parties.listLegalEntities(tenantId, partyId)
        : Promise.resolve([]),
      this.deps.identifiers.listForParty(tenantId, partyId),
      this.deps.relationships.listForParty(tenantId, partyId),
    ]);

    return {
      party,
      organization,
      person,
      legalEntities,
      identifiers,
      relationships: asOf
        ? relationships.filter((r) => isInForceOn(r.relationship, asOf))
        : relationships,
    };
  }

  /** The firm's parties. ARCHIVED ONES ARE HIDDEN unless explicitly asked for —
   *  the other half of the asymmetry `partyProfile` documents.
   *
   *  `includeArchived` has no default, deliberately, and the port says the same
   *  thing: a default is how "the archive is hidden" quietly stops being true,
   *  and every caller of this should have had to decide. */
  async listParties(tenantId: string, includeArchived: boolean): Promise<readonly Party[]> {
    return this.deps.parties.listParties(tenantId, includeArchived);
  }

  /** The dedup entry point (phone + PAN + email): find the party holding an
   *  identifier, matching on its normalised value. */
  async findByIdentifier(
    tenantId: string,
    type: IdentifierType,
    value: string,
  ): Promise<PartyIdentifier | null> {
    return this.deps.identifiers.findByValue(tenantId, type, normalizeIdentifier(type, value));
  }
}
