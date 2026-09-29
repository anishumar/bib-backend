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
import { isJurisdiction } from "../../domain/document/model";
import type { TerritoryRule } from "../../domain/lead/model";
import type { EventSink } from "../ledger/ports";
import type { IdentifierType, PartyKind } from "../../domain/party/model";
import { isValidIdentifier, normalizeIdentifier } from "../../domain/party/model";
import { InvalidIdentifier } from "../../domain/party/errors";
import type {
  Lead,
  LeadSource,
  LeadStage,
  LeadValue,
  OwnerSource,
} from "../../domain/lead/model";
import {
  DEDUP_IDENTIFIER_TYPES,
  LEAD_SOURCES,
  LEAD_STAGES,
  CLOSED_UNWON_STAGES,
  canMoveStage,
  isAmbiguous,
  isDedupIdentifier,
  isEstimatedValue,
  isLeadSource,
  isLeadStage,
  isTerminalStage,
  leadDeletionBlock,
  matchedParty,
  normalizeEstimatedValue,
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
  InvalidLeadJurisdiction,
  InvalidEstimatedValue,
  LeadNotCallersToday,
  LeadPartyArchived,
  LeadMatchesOwnCompany,
  LeadDeleted,
  OwnerNotStaff,
  SameStage,
  leadDeletionRefusal,
} from "../../domain/lead/errors";
import type {
  AssignmentOutcome,
  AssignmentStrategy,
  FirmCurrency,
  TerritoryRules,
  LeadRecord,
  LeadRepository,
  LeadView,
  FirmTimeZone,
  ProspectDirectory,
  StaffDirectory,
} from "./ports";
import { dayInZone, isCallersToday } from "../../domain/scheduler/zone";

export interface Deps {
  readonly leads: LeadRepository;
  /** The party module, behind this use case's own narrow interface. */
  readonly prospects: ProspectDirectory;
  readonly staff: StaffDirectory;
  /** Whose desk an unclaimed lead lands on. A port, so the rule a firm actually
   *  wants — rotation today, territory once its axis is chosen — is a wiring
   *  change at the composition root rather than an edit to this file. */
  readonly assignment: AssignmentStrategy;
  /** The firm's territory rules — for the SCREEN that maintains them. The
   *  strategy reads the table itself, inside its own single statement. */
  readonly territories: TerritoryRules;
  readonly ids: IdGen;
  /** For the identifier's valid-from date. Time is a port here for the same
   *  reason it is in identity: a test must be able to fix "today". */
  readonly clock: Clock;
  /** The firm's zone — whose "today" a contact detail is dated from when the
   *  caller does not send its own. */
  readonly timeZones: FirmTimeZone;
  /** The firm's reporting currency — what an estimate is written in. */
  readonly currency: FirmCurrency;
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
  /** The caller's today — what the contact details it attaches are dated
   *  from. The firm's day when absent; never the server's. */
  readonly asOf?: string | undefined;
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
  /**
   * Where the PROSPECT is — the axis territory assignment matches on, and the
   * answer a proposal drafted from this lead needs for `clientJurisdiction`.
   *
   * OPTIONAL, and absent is ordinary: often nobody knows the country when
   * somebody phones in, and a capture must never be refused for it. An unknown
   * country matches no territory rule and falls through to the rotation, which
   * is why there is no wildcard rule.
   */
  readonly jurisdiction?: string | undefined;
  /**
   * What the opportunity could be worth, as a decimal string, in the firm's
   * reporting currency. OPTIONAL for the same reason the country is: a capture
   * is never refused for a number nobody knows yet. Like `notes`, a MERGE does
   * not apply it — the live opportunity's figure was somebody's estimate.
   */
  readonly estimatedValue?: string | undefined;
}

/**
 * The two facts the pipeline list sizes and filters on, set together. Both
 * are REPLACED: null clears either one, because "we no longer know" is a real
 * thing to say about a prospect's value.
 */
export interface SetLeadDetailsInput {
  readonly tenantId: string;
  readonly leadId: string;
  readonly jurisdiction: string | null;
  readonly estimatedValue: string | null;
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
  /**
   * The title this capture sent and the merge THREW AWAY — or null when nothing
   * was thrown away.
   *
   * `title` is the only input this API demands on every capture and then, on the
   * merge path, ignores. Someone types "Transfer pricing study", gets back a
   * lead called "FY26 statutory audit", and until this field existed there was
   * nothing anywhere in the response saying their words had been dropped or
   * why. The merge itself is right — `lead_one_open_per_party` means a firm
   * holds exactly one live opportunity per client, so appending is the only
   * correct thing to do — so the fix is to make the loss VISIBLE, not to stop
   * losing it. Only the caller can act on it: re-title the live lead, close it
   * first, or recognise their own duplicate submission.
   *
   * NULL WHEN THE TITLES MATCH, not merely when nothing merged. If the second
   * capture sent the words the lead already carries, nothing was lost and the
   * caller's title IS the lead's title; reporting a discard there would make
   * every honest duplicate submission look like data loss and teach callers to
   * ignore the field. Non-null means exactly one thing: words were dropped.
   *
   * It sits beside the lead rather than on it because it was never stored and
   * never will be — `lead.title` is the row, this is what the row refused.
   *
   * Only `title`. `source`, `notes` and `ownerUserId` are also not applied by a
   * merge, but each of them is optional on the wire and the route already says
   * the owner is never reassigned; this is the one the API insists on and then
   * discards.
   */
  readonly discardedTitle: string | null;
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

export interface DeleteLeadInput {
  readonly tenantId: string;
  readonly leadId: string;
  /**
   * Whether the caller holds `tenant:admin` — asked by the handler of the
   * authorisation service, the way fee visibility is. It decides one case only:
   * a lead already closed as lost or abandoned, which is in the pipeline's
   * numbers (see `leadDeletionBlock`).
   */
  readonly callerAdministers: boolean;
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
  async capture(typed: CaptureLeadInput, actor: Actor): Promise<CaptureResult> {
    const source = this.parseSource(typed.source);
    const title = this.parseTitle(typed.title);
    // Demanded in canonical UPPER CASE rather than normalised, the same rule
    // G1.8 applies to a clause's terms: this value is COMPARED — against a
    // territory rule — and "in" is what a comparison would get.
    const jurisdiction = this.parseJurisdiction(typed.jurisdiction);
    // Every contact detail normalised and shape-checked BEFORE the dedup
    // lookup and before anything is written: a bad phone used to be refused
    // by the party module only after the prospect had been created. A phone
    // typed without its calling code is completed with the lead's country.
    const input: CaptureLeadInput = {
      ...typed,
      identifiers: typed.identifiers.map((i) => this.parseIdentifier(i, jurisdiction)),
    };
    const estimate = this.parseEstimatedValue(input.estimatedValue ?? null);

    // Everything that can be refused without writing is refused first — a
    // capture that fails halfway leaves a party nobody asked for.
    const today = await this.today(input.tenantId, input.asOf);
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

    // AN ARCHIVED CLIENT IS REFUSED, NOT RESTORED (0305, Shrestha 2026-09-25).
    // Before anything is written: a web enquiry carrying an archived client's
    // PAN used to attach a fresh lead to a party the firm had put away, and
    // quietly un-archiving would let a form undo a person's decision unseen.
    // Restoring is its own act, on the client page, with its own ledger row.
    if (existingPartyId !== null) {
      const existing = await this.deps.prospects.findParty(input.tenantId, existingPartyId);
      if (existing !== null && existing.archivedAt !== null) {
        throw new LeadPartyArchived(existing.displayName);
      }
      // The firm's own company: its phone, email or PAN typed as the
      // prospect's. Refused before a contact detail is attached to it.
      if (existing !== null && existing.isOwnCompany) {
        throw new LeadMatchesOwnCompany(existing.displayName);
      }
    }

    const partyId = existingPartyId ?? (await this.createProspect(input, actor));

    // Only the identifiers nobody has yet. Re-adding one would be refused by
    // the party module as a duplicate, and rightly — it is the same fact.
    const added = await this.attachNewIdentifiers(input, partyId, match, today, actor);

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
      //
      // So it is thrown away OUT LOUD, in two places at once and deliberately
      // not the same way in both. `discardedTitle` on the result gives the
      // caller their own words back, because they are the only party who can do
      // anything about it. The ledger gets the machine fact and not the words —
      // see below.
      const discardedTitle = title === open.title ? null : title;
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
          // WHETHER a title was dropped, never the title itself — the same
          // shape as `lostReasonRecorded` on lead.stage_changed, for the same
          // reason and by the same rule. A lead title names the counterparty,
          // and a lead can be about a human being ("Priya Menon — personal
          // tax"), so the words are sometimes personal data and the ledger
          // cannot tell which times. EVENT-CONTRACT §3.4 refuses a person's
          // name at any depth in any casing, and this log cannot be erased: put
          // the words here and a DPDP erasure request forces the choice between
          // breaking the law and breaking the audit trail. `findPiiKey` would
          // NOT have stopped it — it denies KEYS and `title` is not one — which
          // is exactly why the rule has to be kept by whoever writes the
          // payload. lead.captured excludes the title for this reason already.
          //
          // The boolean is worth having on its own: it is the only record of
          // how often a merge loses a DISTINCT piece of work rather than
          // absorbing a duplicate form submission, which is the evidence
          // anybody revisiting lead_one_open_per_party would have to go and
          // reconstruct otherwise. The words themselves are in the response, to
          // the one person who can act on them, and nowhere else.
          titleDiscarded: discardedTitle !== null,
        },
      });
      return { lead: open, merged: true, matchedExistingParty: true, discardedTitle };
    }

    const created = await this.deps.leads.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      title,
      partyId,
      source,
      ownerUserId: requestedOwner ?? null,
      notes: input.notes ?? null,
      jurisdiction,
      estimatedValue: await this.priced(input.tenantId, estimate),
    });

    // ASSIGNMENT, and only when nobody named an owner. It runs AFTER the insert
    // rather than before it because the strategy has to record its own choice
    // (see AssignmentStrategy): it cannot claim a desk for a row that does not
    // exist yet. The cost is that a lead exists unowned for the width of one
    // statement; the alternative — choose, then write in a second transaction —
    // is the race the port exists to close.
    const assigned =
      requestedOwner === undefined
        ? await this.deps.assignment.assign(created)
        : { lead: created, policy: null };
    const lead = assigned.lead;
    const ownerAssignedBy = this.ownerSource(requestedOwner, assigned);
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
    // Nothing was discarded: this capture's title is on the lead it just made.
    return {
      lead,
      merged: false,
      matchedExistingParty: existingPartyId !== null,
      discardedTitle: null,
    };
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
    const lead = await this.liveLeadOrThrow(input.tenantId, input.leadId);
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
    const lead = await this.liveLeadOrThrow(input.tenantId, input.leadId);
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
   * Say where the prospect is and what the opportunity could be worth.
   *
   * Idempotent: a save that changes neither records nothing, because a form
   * that PUTs what it was shown should not write an edit nobody made. Allowed
   * on a CLOSED lead too, like the owner — correcting what a won deal was
   * worth changes no pipeline state, and a lost one's value is the size of
   * what got away, which is worth being right about.
   *
   * The COUNTRY does not re-run assignment. Territory decides whose desk a new
   * lead lands on at capture; moving a live lead is `PUT .../owner`, a person's
   * act, and a corrected country quietly reassigning somebody's prospect would
   * be the rotation overruling a human decision.
   */
  async setDetails(input: SetLeadDetailsInput, actor: Actor): Promise<Lead> {
    const jurisdiction =
      input.jurisdiction === null ? null : this.parseJurisdiction(input.jurisdiction);
    const estimate = this.parseEstimatedValue(input.estimatedValue);
    const lead = await this.liveLeadOrThrow(input.tenantId, input.leadId);
    const estimatedValue = await this.priced(input.tenantId, estimate);

    const sameCountry = lead.jurisdiction === jurisdiction;
    const sameValue =
      (lead.estimatedValue === null && estimatedValue === null) ||
      (lead.estimatedValue !== null &&
        estimatedValue !== null &&
        lead.estimatedValue.amount === estimatedValue.amount &&
        lead.estimatedValue.currency === estimatedValue.currency);
    if (sameCountry && sameValue) return lead;

    const saved = await this.deps.leads.setDetails(
      input.tenantId,
      lead.id,
      jurisdiction,
      estimatedValue,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.details_changed",
      objectId: lead.id,
      actor,
      // Machine facts only: a country code and an amount name nobody. Both
      // sides of each, so the timeline can say "value 3,00,000 -> 5,00,000"
      // without anybody reconstructing what it was before.
      payload: {
        partyId: lead.partyId,
        jurisdictionFrom: lead.jurisdiction,
        jurisdictionTo: jurisdiction,
        estimatedValueFrom: lead.estimatedValue?.amount ?? null,
        estimatedValueTo: estimatedValue?.amount ?? null,
        currency: estimatedValue?.currency ?? lead.estimatedValue?.currency ?? null,
      },
    });
    return saved;
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

  /**
   * One lead — deleted or not, because a link to it must still open — with
   * whether Delete would work for this caller, and if not, why (0086).
   */
  async get(tenantId: string, leadId: string, callerAdministers: boolean): Promise<LeadView> {
    const record = await this.deps.leads.findRecord(tenantId, leadId);
    if (!record) throw new LeadNotFound(leadId);
    const block = leadDeletionBlock(
      record.lead,
      record.lead.deletedAt === null
        ? await this.deps.leads.liveProposalRefs(tenantId, leadId)
        : [],
      callerAdministers,
    );
    const refusal = block === null ? null : leadDeletionRefusal(block);
    return {
      ...record,
      deleteRefusal: refusal === null ? null : { code: refusal.code, message: refusal.message },
    };
  }

  /**
   * Delete a lead ENTERED BY MISTAKE (0086) — out of the pipeline and every
   * count, still readable by id, and final.
   *
   * Not a stage, and deliberately not reachable through `moveStage`: `lost` and
   * `abandoned` are what happened to a real prospect, and this says there was
   * none. Refused once converted, while a live proposal was drafted from it,
   * and — for anybody but an administrator — once it has been closed. The
   * trigger under this (`trg_lead_guard_deletion`) holds the same rule for the
   * writers that do not come through here.
   */
  async delete(input: DeleteLeadInput, actor: Actor): Promise<Lead> {
    const lead = await this.leadOrThrow(input.tenantId, input.leadId);
    const refs =
      lead.deletedAt === null
        ? await this.deps.leads.liveProposalRefs(input.tenantId, lead.id)
        : [];
    const block = leadDeletionBlock(lead, refs, input.callerAdministers);
    if (block !== null) throw leadDeletionRefusal(block);

    const deleted = await this.deps.leads.markDeleted(
      input.tenantId,
      lead.id,
      actor.type === "human" ? actor.id : null,
    );
    // Somebody else deleted it between the read and the write: theirs stands,
    // and one `lead.deleted` is all the log may ever hold.
    if (deleted === null) throw new LeadDeleted();

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "lead.deleted",
      objectId: lead.id,
      actor,
      // The party and how far it had got — machine facts. Never the title,
      // which names the counterparty and can be a person's name (§3.4).
      payload: { partyId: lead.partyId, stage: lead.stage },
    });
    return deleted;
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

  /** Every CHANGE to a lead goes through here, so a method added later cannot
   *  forget that a deleted lead is final (0086). */
  private async liveLeadOrThrow(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.leadOrThrow(tenantId, leadId);
    if (lead.deletedAt !== null) throw new LeadDeleted();
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
  /**
   * WHICH rule put the owner there — read off what assignment actually did.
   *
   * It used to read `deps.assignment.policy`, a field on the strategy. That was
   * right while there was one rule and became a lie the moment there were two:
   * a strategy that tries territory and falls through to the rotation answers
   * per lead, not per wiring, and the field would have labelled every
   * territory-decided capture `round_robin`. The whole point of this value is
   * that "the rotation chose Anand" and "the UK desk rule chose Anand" are
   * different facts.
   */
  private ownerSource(
    requested: string | null | undefined,
    assigned: AssignmentOutcome,
  ): OwnerSource | null {
    if (assigned.lead.ownerUserId === null) return null;
    if (requested !== undefined) return "requested";
    // A policy is present whenever a strategy chose, and the owner is non-null
    // here — so a null policy would mean a strategy wrote an owner without
    // saying which rule did it, which is a bug in that adapter rather than a
    // state to paper over.
    return assigned.policy ?? "round_robin";
  }

  /** Absent stays absent — an unknown country is a real state and the rotation
   *  answers for it. A malformed one is refused rather than dropped, so a
   *  caller sending "India" learns it, instead of quietly getting the rotation
   *  and wondering why the UK desk rule never fires. */
  private parseIdentifier(identifier: CaptureIdentifier, jurisdiction: string | null): CaptureIdentifier {
    const value = normalizeIdentifier(identifier.type, identifier.value, jurisdiction);
    if (!isValidIdentifier(identifier.type, value)) throw new InvalidIdentifier(identifier.type, identifier.value);
    return { ...identifier, value };
  }

  private parseJurisdiction(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    if (!isJurisdiction(raw)) throw new InvalidLeadJurisdiction(raw);
    return raw;
  }

  /** Absent stays absent; a malformed amount is refused rather than guessed
   *  at, and a valid one is stored in its one canonical spelling. */
  private parseEstimatedValue(raw: string | null): string | null {
    if (raw === null) return null;
    if (!isEstimatedValue(raw)) throw new InvalidEstimatedValue(raw);
    return normalizeEstimatedValue(raw);
  }

  /** An amount becomes money: it is written in the firm's reporting currency,
   *  so every estimate in a firm compares with every other. */
  private async priced(tenantId: string, amount: string | null): Promise<LeadValue | null> {
    if (amount === null) return null;
    return { amount, currency: await this.deps.currency.reportingCurrency(tenantId) };
  }

  /** Whose desk covers where — the rule as a screen shows it. */
  async listTerritoryRules(tenantId: string): Promise<readonly TerritoryRule[]> {
    return this.deps.territories.list(tenantId);
  }

  /**
   * Say whose desk covers a country.
   *
   * An upsert, because the schema allows exactly one desk per country and "add
   * a second opinion about IN" is not an operation anybody wants — it is an
   * ambiguity the strategy would have to break arbitrarily, and arbitrary is
   * the one thing an assignment rule must never be.
   *
   * The owner is checked as ACTIVE STAFF here, so naming somebody who left is
   * a refusal now rather than leads quietly falling through to the rotation
   * later. The strategy checks it AGAIN at assignment time, and that is not
   * belt-and-braces: a membership is revoked long after the rule was written,
   * and only the second check sees that.
   */
  async setTerritoryRule(
    input: {
      readonly tenantId: string;
      readonly jurisdiction: string;
      readonly ownerUserId: string;
      readonly note?: string | undefined;
    },
    actor: Actor,
  ): Promise<TerritoryRule> {
    if (!isJurisdiction(input.jurisdiction)) {
      throw new InvalidLeadJurisdiction(input.jurisdiction);
    }
    await this.requireStaff(input.tenantId, input.ownerUserId);

    const saved = await this.deps.territories.set({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction,
      ownerUserId: input.ownerUserId,
      note: input.note ?? null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "territory_rule.set",
      objectId: saved.id,
      actor,
      // Ids and machine facts. The NOTE stays out: it is free text a person
      // wrote, this log cannot be erased, and the row keeps it where it can be
      // — the same reasoning `firm_entity_preference.set` gives.
      payload: { jurisdiction: saved.jurisdiction, ownerUserId: saved.ownerUserId },
    });
    return saved;
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
    validFrom: string,
    actor: Actor,
  ): Promise<readonly IdentifierType[]> {
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

  /**
   * The day a capture is dated from: the caller's, when it says, else the
   * FIRM's (0071). It was `toISOString().slice(0, 10)` — the server's UTC day,
   * so a PAN captured at 02:00 in Delhi was "in force from" the day before.
   * The caller's day is held to the firm's or one either side: it says what
   * day it is, it does not backdate a contact detail.
   */
  private async today(tenantId: string, asOf?: string): Promise<string> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    const firmDay = dayInZone(this.deps.clock.now().toISOString(), zone);
    if (asOf === undefined) return firmDay;
    if (!isCallersToday(asOf, firmDay)) throw new LeadNotCallersToday(asOf, firmDay);
    return asOf;
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
