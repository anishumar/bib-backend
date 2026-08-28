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
import type { Lead, LeadSource, LeadStage, OwnerSource } from "../../domain/lead/model";
import {
  DEDUP_IDENTIFIER_TYPES,
  LEAD_SOURCES,
  LEAD_STAGES,
  CLOSED_UNWON_STAGES,
  canMoveStage,
  isAmbiguous,
  isDedupIdentifier,
  isLeadSource,
  isLeadStage,
  isTerminalStage,
  matchedParty,
  recordsLostReason,
} from "../../domain/lead/model";
import type { DedupMatch } from "../../domain/lead/model";
import {
  AmbiguousMatch,
  BlankTitle,
  InvalidSource,
  InvalidStage,
  LeadClosed,
  LeadNotFound,
  LostReasonNotApplicable,
  LostReasonRequired,
  NoContactDetail,
  OwnerNotStaff,
  SameStage,
} from "../../domain/lead/errors";
import type {
  AssignmentStrategy,
  LeadRecord,
  LeadRepository,
  ProspectDirectory,
  StaffDirectory,
} from "./ports";

export interface Deps {
  readonly leads: LeadRepository;
  /** The party module, behind this use case's own narrow interface. */
  readonly prospects: ProspectDirectory;
  readonly staff: StaffDirectory;
  /** Whose desk an unclaimed lead lands on. A port, so the rule a firm actually
   *  wants — rotation today, territory once its axis is chosen — is a wiring
   *  change at the composition root rather than an edit to this file. */
  readonly assignment: AssignmentStrategy;
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
  /**
   * What to call this opportunity — "FY27 statutory audit", "GST registration
   * for the Pune plant".
   *
   * REQUIRED, and not derived from the party's name when it is missing. A
   * derived title would be identical for every opportunity a client ever has,
   * which is the state before 0030 with a NOT NULL column in front of it: the
   * read model already carries `party.displayName`, so a title that repeated it
   * would add a column and no information. Somebody capturing a lead knows what
   * it is for; the field asks them to say it once.
   */
  readonly title: string;
  /** Whether the prospect is a company or a human being. */
  readonly kind: PartyKind;
  /** The legal name of the organization, or the person's full name. */
  readonly name: string;
  /** How to reach them. At least one must be a dedup identifier. */
  readonly identifiers: readonly CaptureIdentifier[];
  readonly tradeName?: string | undefined;
  readonly industry?: string | undefined;
  readonly website?: string | undefined;
  /**
   * Whose desk to put it on. THREE meanings, and they are genuinely different
   * instructions rather than two spellings of one:
   *
   *   absent  — nobody was named, so the firm's assignment strategy chooses.
   *             This is the everyday web-form capture, and the case the
   *             acceptance is about: leads arriving with no owner distribute
   *             evenly instead of piling up in a queue nobody watches.
   *   null    — an explicit instruction to leave it in the UNASSIGNED QUEUE.
   *             Triage-first firms work that way, and 0007 called that queue a
   *             real and useful state; auto-assigning unconditionally would
   *             quietly abolish it.
   *   a uuid  — that person, checked as active staff here. No strategy runs: a
   *             human made the decision and a rotation does not overrule one.
   *
   * The same null-vs-absent distinction `AssignOwnerInput` already draws, for
   * the same reason — one spelling per meaning keeps the generated client
   * honest.
   */
  readonly ownerUserId?: string | null | undefined;
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
  /**
   * Why it did not close won. Required moving to `lost` or `abandoned`, refused
   * on every other stage.
   *
   * REQUIRED for BOTH unwon stages, symmetrically and on purpose. Making it
   * optional on `abandoned` — "went quiet is its own reason" — would put a
   * friction gradient between the two, and the cheapest way past a text box is
   * to file a competitor loss as "went quiet". That is the exact signal G3.1
   * exists to protect, so neither stage is the easy one.
   */
  readonly lostReason?: string | undefined;
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
    const title = this.parseTitle(input.title);

    // Everything that can be refused without writing is refused first — a
    // capture that fails halfway leaves a party nobody asked for.
    if (!input.identifiers.some((i) => isDedupIdentifier(i.type))) {
      throw new NoContactDetail(DEDUP_IDENTIFIER_TYPES);
    }
    // `undefined` and `null` part company here and stay parted for the rest of
    // the method: one asks the strategy to choose, the other says do not.
    const requestedOwner = input.ownerUserId;
    if (requestedOwner !== undefined && requestedOwner !== null) {
      await this.requireStaff(input.tenantId, requestedOwner);
    }

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
      // THE MERGE. Nothing is overwritten: the title, source, owner and notes on
      // the live opportunity were somebody's decision, and a duplicate web-form
      // submission is not grounds to undo it. What the second capture brought
      // goes into the timeline, where it can be read and acted on.
      //
      // The discarded TITLE is the one real cost of the merge, and it is the
      // sharp end of the open-question on lead_one_open_per_party (see below):
      // if the second capture was genuinely a second piece of work rather than a
      // duplicate form submission, its name is what gets thrown away here. That
      // is an argument about the index, not about this branch — with one open
      // lead per party, appending is the only correct thing to do.
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

    const created = await this.deps.leads.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      title,
      partyId,
      source,
      ownerUserId: requestedOwner ?? null,
      notes: input.notes ?? null,
    });

    // ASSIGNMENT, and only when nobody named an owner. It runs AFTER the insert
    // rather than before it because the strategy has to record its own choice
    // (see AssignmentStrategy): it cannot claim a desk for a row that does not
    // exist yet. The cost is that a lead exists unowned for the width of one
    // statement; the alternative — choose, then write in a second transaction —
    // is the race the port exists to close.
    const lead =
      requestedOwner === undefined ? await this.deps.assignment.assign(created) : created;
    const ownerAssignedBy = this.ownerSource(requestedOwner, lead);
    // The owner is part of this event rather than a second `lead.owner_assigned`
    // beside it: one action by one person is one row in the timeline.
    //
    // THE TITLE IS NOT IN THIS PAYLOAD, and that was a decision, not an
    // omission. A title names the counterparty — "Priya Menon — personal tax",
    // for a lead whose `kind` is `person` — so it is sometimes personal data
    // and the ledger cannot tell which times. `findPiiKey` cannot help: it
    // denies KEYS, and `title` is not one, so nothing would have stopped it.
    // The rule is the one the event contract states (§3.4): the payload carries
    // ids and machine facts, the erasable row carries the words. `partyId` is
    // already here and resolves to the name for anyone entitled to it.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.captured",
      objectId: lead.id,
      actor,
      payload: {
        partyId,
        source,
        ownerUserId: lead.ownerUserId,
        // HOW the owner got there, never just who. "The rotation chose Anand"
        // and "the partner chose Anand" are different facts, and only the first
        // is evidence about whether assignment is working. A machine fact, so
        // it belongs in a log that cannot be erased.
        ownerAssignedBy,
        matchedExistingParty: existingPartyId !== null,
        identifierTypes: input.identifiers.map((i) => i.type),
      },
    });
    return { lead, merged: false, matchedExistingParty: existingPartyId !== null };
  }

  /**
   * Move a lead through the pipeline. Reaching a terminal stage closes it, and
   * an unwon close records why.
   *
   * `lost` and `abandoned` are the two ways an opportunity ends without a win
   * and they are NOT the same finding: went quiet is a follow-up problem, chose
   * a competitor is a pricing problem, and a firm that cannot tell them apart
   * cannot tell which of its two fixable failures it has.
   */
  async moveStage(input: MoveStageInput, actor: Actor): Promise<Lead> {
    const to = this.parseStage(input.stage);
    const lostReason = this.parseLostReason(to, input.lostReason);
    const lead = await this.leadOrThrow(input.tenantId, input.leadId);
    if (lead.stage === to) throw new SameStage(lead.stage);
    if (!canMoveStage(lead.stage, to)) throw new LeadClosed(lead.id, lead.stage);

    const closedAt = isTerminalStage(to) ? this.deps.clock.now().toISOString() : null;
    const moved = await this.deps.leads.moveStage(
      input.tenantId,
      lead.id,
      to,
      closedAt,
      lostReason,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.stage_changed",
      objectId: lead.id,
      actor,
      payload: {
        from: lead.stage,
        to,
        closed: closedAt !== null,
        partyId: lead.partyId,
        // WHETHER a reason was recorded, never the reason itself. A closer
        // writes "their CFO went with his old audit partner" — a sentence about
        // a named human being — into a column that can be erased on request,
        // and this log cannot be. The machine fact ("did anybody explain this
        // loss?") is what a timeline needs; the sentence lives on crm.lead.
        lostReasonRecorded: lostReason !== null,
      },
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

  /**
   * The pipeline, newest first, optionally one stage of it.
   *
   * Returns the READ MODEL — each lead with the prospect it is about and the
   * colleague who owns it. The aggregate alone carries two uuids, which is right
   * for a lead and useless for anything that has to show one.
   */
  async list(tenantId: string, stage?: string): Promise<readonly LeadRecord[]> {
    return this.deps.leads.list(tenantId, stage === undefined ? null : this.parseStage(stage));
  }

  async get(tenantId: string, leadId: string): Promise<LeadRecord> {
    const record = await this.deps.leads.findRecord(tenantId, leadId);
    if (!record) throw new LeadNotFound(leadId);
    return record;
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

  /** Trimmed here rather than at the door, so every caller — the handler, a
   *  future importer, a test — stores the same thing. `lead_title_present_chk`
   *  is the backstop for the paths that do not come through here at all. */
  private parseTitle(title: string): string {
    const trimmed = title.trim();
    if (trimmed === "") throw new BlankTitle();
    return trimmed;
  }

  /**
   * The reason, checked against the stage it is being written with.
   *
   * Both directions are refused, because both are silent data loss: an unwon
   * close with no reason is the gap this field was added to close, and a reason
   * on any other stage is a sentence in a column nothing reads. The database
   * agrees on the second half (`lead_lost_reason_scope_chk`) and deliberately
   * not on the first — leads closed before 0030 have no honest reason to
   * backfill, so NULL there means "nobody was asked", which is true.
   */
  private parseLostReason(to: LeadStage, reason: string | undefined): string | null {
    const trimmed = reason?.trim() ?? "";
    if (!recordsLostReason(to)) {
      if (trimmed !== "") throw new LostReasonNotApplicable(to, CLOSED_UNWON_STAGES);
      return null;
    }
    if (trimmed === "") throw new LostReasonRequired(to);
    return trimmed;
  }

  private async leadOrThrow(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.deps.leads.findById(tenantId, leadId);
    if (!lead) throw new LeadNotFound(leadId);
    return lead;
  }

  /**
   * How the owner on this lead got there, for the timeline.
   *
   * Null is not "unknown" — it is the unassigned queue, which is what both a
   * deliberate `null` at capture and a strategy that declined leave behind. A
   * reader asking "was this assigned automatically?" gets yes-by-which-rule, no
   * because a person said so, or no because nobody is on it.
   */
  private ownerSource(requested: string | null | undefined, lead: Lead): OwnerSource | null {
    if (lead.ownerUserId === null) return null;
    return requested === undefined ? this.deps.assignment.policy : "requested";
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
