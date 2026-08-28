// The lead use case — the commercial pipeline's rules against ports. No I/O, no
// SQL, no HTTP.
//
// Capture is the whole task, and it happens in this order for a reason:
//
//   1. resolve the PARTY, by identifier, BEFORE anything is written
//   2. attach only the identifiers that are genuinely new
//   3. append to the party's open lead if it has one, else start a lead
//
// Doing the dedup lookup first is what the board means by "dedupe before
// create". The alternative — create, then reconcile — leaves a duplicate party
// in the tables for as long as the reconciliation takes, and every duplicate
// found later is one somebody has already emailed.
//
// There is no timeline table. The timeline IS the ledger: capture, merge, stage
// moves and reassignment all write events against the lead's id, so its history
// is already immutable, already tenant-scoped, and already free of personal
// data. `GET /api/v1/objects/lead/{id}/events` is the "appends timeline" half
// of this task's acceptance.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { IdentifierType, PartyKind } from "../../domain/party/model";
import type { Lead, LeadSource, LeadStage } from "../../domain/lead/model";
import {
  DEDUP_IDENTIFIER_TYPES,
  LEAD_SOURCES,
  LEAD_STAGES,
  canMoveStage,
  isAmbiguous,
  isDedupIdentifier,
  isLeadSource,
  isLeadStage,
  isTerminalStage,
  matchedParty,
} from "../../domain/lead/model";
import type { DedupMatch } from "../../domain/lead/model";
import {
  AmbiguousMatch,
  InvalidSource,
  InvalidStage,
  LeadClosed,
  LeadNotFound,
  NoContactDetail,
  OwnerNotStaff,
  SameStage,
} from "../../domain/lead/errors";
import type {
  LeadRepository,
  ProspectDirectory,
  StaffDirectory,
} from "./ports";

export interface Deps {
  readonly leads: LeadRepository;
  /** The party module, behind this use case's own narrow interface. */
  readonly prospects: ProspectDirectory;
  readonly staff: StaffDirectory;
  readonly ids: IdGen;
  /** For the identifier's valid-from date. Time is a port here for the same
   *  reason it is in identity: a test must be able to fix "today". */
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface CaptureIdentifier {
  readonly type: IdentifierType;
  readonly value: string;
}

// Optional fields are `?: T | undefined` because the project runs
// exactOptionalPropertyTypes and these are spread from zod-parsed bodies where
// an absent field IS `undefined`.
export interface CaptureLeadInput {
  readonly tenantId: string;
  readonly source: string;
  /** Whether the prospect is a company or a human being. */
  readonly kind: PartyKind;
  /** The legal name of the organization, or the person's full name. */
  readonly name: string;
  /** How to reach them. At least one must be a dedup identifier. */
  readonly identifiers: readonly CaptureIdentifier[];
  readonly tradeName?: string | undefined;
  readonly industry?: string | undefined;
  readonly website?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly notes?: string | undefined;
}

export interface CaptureResult {
  readonly lead: Lead;
  /**
   * True when this capture landed on a lead that already existed. The caller
   * answers 200 rather than 201 for it — a duplicate submission did not create
   * anything, and saying it did is how a form ends up submitted twice on
   * purpose.
   */
  readonly merged: boolean;
  /** True when the prospect was already in the firm's records. */
  readonly matchedExistingParty: boolean;
}

export interface MoveStageInput {
  readonly tenantId: string;
  readonly leadId: string;
  readonly stage: string;
}

export interface AssignOwnerInput {
  readonly tenantId: string;
  readonly leadId: string;
  /** null takes the lead off a desk and back into the unassigned queue. */
  readonly ownerUserId: string | null;
}

export class LeadService {
  constructor(private readonly deps: Deps) {}

  /**
   * Capture a lead, deduplicating on phone + PAN + email first.
   *
   * Three outcomes, and they are genuinely different things that a caller acts
   * on differently:
   *
   *   new party      — nobody had heard of them. Party created, lead created.
   *   known party,   — they are in the records but have no live opportunity
   *   no open lead     (a past client, a lead lost in March). A NEW lead, so
   *                    the conversion rate counts two attempts, not one.
   *   known party,   — there is already a live opportunity. The capture appends
   *   open lead        to it and creates nothing. This is the merge.
   */
  async capture(input: CaptureLeadInput, actor: Actor): Promise<CaptureResult> {
    const source = this.parseSource(input.source);

    // Everything that can be refused without writing is refused first — a
    // capture that fails halfway leaves a party nobody asked for.
    if (!input.identifiers.some((i) => isDedupIdentifier(i.type))) {
      throw new NoContactDetail(DEDUP_IDENTIFIER_TYPES);
    }
    const ownerUserId = input.ownerUserId ?? null;
    if (ownerUserId !== null) await this.requireStaff(input.tenantId, ownerUserId);

    const match = await this.resolve(input.tenantId, input.identifiers);
    if (isAmbiguous(match)) throw new AmbiguousMatch(match.parties);

    const existingPartyId = matchedParty(match);
    const partyId = existingPartyId ?? (await this.createProspect(input, actor));

    // Only the identifiers nobody has yet. Re-adding one would be refused by
    // the party module as a duplicate, and rightly — it is the same fact.
    const added = await this.attachNewIdentifiers(input, partyId, match, actor);

    const open = existingPartyId === null
      ? null
      : await this.deps.leads.findOpenForParty(input.tenantId, existingPartyId);

    if (open) {
      // THE MERGE. Nothing is overwritten: the source, owner and notes on the
      // live opportunity were somebody's decision, and a duplicate web-form
      // submission is not grounds to undo it. What the second capture brought
      // goes into the timeline, where it can be read and acted on.
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "lead.merged",
        objectId: open.id,
        actor,
        payload: {
          partyId,
          capturedSource: source,
          matchedIdentifierTypes: this.typesAt(input, [...match.existingByIndex.keys()]),
          addedIdentifierTypes: added,
        },
      });
      return { lead: open, merged: true, matchedExistingParty: true };
    }

    const lead = await this.deps.leads.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId,
      source,
      ownerUserId,
      notes: input.notes ?? null,
    });
    // The owner is part of this event rather than a second `lead.owner_assigned`
    // beside it: one action by one person is one row in the timeline.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.captured",
      objectId: lead.id,
      actor,
      payload: {
        partyId,
        source,
        ownerUserId,
        matchedExistingParty: existingPartyId !== null,
        identifierTypes: input.identifiers.map((i) => i.type),
      },
    });
    return { lead, merged: false, matchedExistingParty: existingPartyId !== null };
  }

  /** Move a lead through the pipeline. Reaching a terminal stage closes it. */
  async moveStage(input: MoveStageInput, actor: Actor): Promise<Lead> {
    const to = this.parseStage(input.stage);
    const lead = await this.leadOrThrow(input.tenantId, input.leadId);
    if (lead.stage === to) throw new SameStage(lead.stage);
    if (!canMoveStage(lead.stage, to)) throw new LeadClosed(lead.id, lead.stage);

    const closedAt = isTerminalStage(to) ? this.deps.clock.now().toISOString() : null;
    const moved = await this.deps.leads.moveStage(input.tenantId, lead.id, to, closedAt);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.stage_changed",
      objectId: lead.id,
      actor,
      payload: { from: lead.stage, to, closed: closedAt !== null, partyId: lead.partyId },
    });
    return moved;
  }

  /**
   * Put a lead on somebody's desk, or take it off.
   *
   * Idempotent: assigning the owner a lead already has changes nothing and
   * records nothing, because a screen that PUTs its current state should not
   * write a reassignment nobody performed. Allowed on a CLOSED lead too —
   * ownership is attribution, and correcting who gets credit for a won deal is
   * a legitimate act that changes no pipeline state.
   */
  async assignOwner(input: AssignOwnerInput, actor: Actor): Promise<Lead> {
    const lead = await this.leadOrThrow(input.tenantId, input.leadId);
    if (lead.ownerUserId === input.ownerUserId) return lead;
    if (input.ownerUserId !== null) await this.requireStaff(input.tenantId, input.ownerUserId);

    const assigned = await this.deps.leads.setOwner(input.tenantId, lead.id, input.ownerUserId);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.owner_assigned",
      objectId: lead.id,
      actor,
      payload: {
        ownerUserId: input.ownerUserId,
        previousOwnerUserId: lead.ownerUserId,
        partyId: lead.partyId,
      },
    });
    return assigned;
  }

  /** The pipeline, newest first, optionally one stage of it. */
  async list(tenantId: string, stage?: string): Promise<readonly Lead[]> {
    return this.deps.leads.list(tenantId, stage === undefined ? null : this.parseStage(stage));
  }

  async get(tenantId: string, leadId: string): Promise<Lead> {
    return this.leadOrThrow(tenantId, leadId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private parseSource(source: string): LeadSource {
    if (!isLeadSource(source)) throw new InvalidSource(source, LEAD_SOURCES);
    return source;
  }

  private parseStage(stage: string): LeadStage {
    if (!isLeadStage(stage)) throw new InvalidStage(stage, LEAD_STAGES);
    return stage;
  }

  private async leadOrThrow(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.deps.leads.findById(tenantId, leadId);
    if (!lead) throw new LeadNotFound(leadId);
    return lead;
  }

  private async requireStaff(tenantId: string, userId: string): Promise<void> {
    if (!(await this.deps.staff.isActiveStaff(tenantId, userId))) {
      throw new OwnerNotStaff(userId);
    }
  }

  /**
   * Look every supplied identifier up, and work out which party — if any — this
   * capture is about.
   *
   * Only the dedup types (phone, PAN, email) vote on WHICH party. The rest are
   * still looked up, because the answer decides whether to attach them, and
   * attaching one that already exists would be refused as a duplicate.
   */
  private async resolve(
    tenantId: string,
    identifiers: readonly CaptureIdentifier[],
  ): Promise<DedupMatch> {
    const found = await Promise.all(
      identifiers.map((i) => this.deps.prospects.findByIdentifier(tenantId, i.type, i.value)),
    );

    const existingByIndex = new Map<number, string>();
    const parties = new Set<string>();
    for (const [index, hit] of found.entries()) {
      if (!hit) continue;
      existingByIndex.set(index, hit.id);
      const identifier = identifiers[index];
      if (identifier && isDedupIdentifier(identifier.type)) parties.add(hit.partyId);
    }
    return { parties: [...parties], existingByIndex };
  }

  private async createProspect(input: CaptureLeadInput, actor: Actor): Promise<string> {
    if (input.kind === "organization") {
      const org = await this.deps.prospects.createOrganization(
        {
          tenantId: input.tenantId,
          legalName: input.name,
          tradeName: input.tradeName,
          industry: input.industry,
          website: input.website,
        },
        actor,
      );
      return org.partyId;
    }
    const person = await this.deps.prospects.createPerson(
      { tenantId: input.tenantId, fullName: input.name },
      actor,
    );
    return person.partyId;
  }

  /** Attaches the identifiers that did not already exist, and returns their
   *  types for the timeline. Dated today: a contact detail is in force from the
   *  moment the firm learned it. */
  private async attachNewIdentifiers(
    input: CaptureLeadInput,
    partyId: string,
    match: DedupMatch,
    actor: Actor,
  ): Promise<readonly IdentifierType[]> {
    const validFrom = this.deps.clock.now().toISOString().slice(0, 10);
    const attached: IdentifierType[] = [];
    for (const [index, identifier] of input.identifiers.entries()) {
      if (match.existingByIndex.has(index)) continue;
      await this.deps.prospects.addIdentifier(
        {
          tenantId: input.tenantId,
          partyId,
          type: identifier.type,
          value: identifier.value,
          validFrom,
        },
        actor,
      );
      attached.push(identifier.type);
    }
    return attached;
  }

  /** The TYPES of the identifiers at these positions — never their values. A
   *  PAN or an email address in a log that cannot be erased is exactly what the
   *  event contract's no-personal-data rule exists to prevent. */
  private typesAt(
    input: CaptureLeadInput,
    indexes: readonly number[],
  ): readonly IdentifierType[] {
    return indexes.flatMap((i) => {
      const identifier = input.identifiers[i];
      return identifier ? [identifier.type] : [];
    });
  }
}
