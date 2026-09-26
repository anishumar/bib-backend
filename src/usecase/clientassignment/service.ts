// The client-assignment use case (G3.2) — who at the firm owns a client, and
// who the client talks to. No I/O, no SQL, no HTTP: everything outside arrives
// as an injected port, so this reads as a description of what the business does
// and is testable with in-memory fakes.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
//
// Nothing in this product could answer "who at the firm looks after this
// client". The demo records what happened while its own table went unread: an
// email from a five-year-old client was routed by the same generic rules as a
// stranger's, and a calendar-generated filing was created with NO ASSIGNEE AT
// ALL. Both are one failure — a fact the firm gave at signature, asked for again
// later because nowhere held it.
//
// ── THE RULE THAT SHAPES EVERY WRITE HERE ──────────────────────────────────
//
// **A handover is two rows, never an edit.** The outgoing row is closed on the
// day the incoming one starts; `userId` is never updated. Overwriting who the
// SPOC is destroys the only record of who it WAS, and "who was the SPOC when
// this went wrong" is the entire reason these rows are dated.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import { dayInZone } from "../../domain/scheduler/zone";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  AssignmentRole,
  ClientAssignment,
  ClientAssignmentRecord,
  OwnedClient,
} from "../../domain/clientassignment/model";
import {
  ASSIGNMENT_ROLES,
  accountTeamOn,
  accountTeamOrder,
  isAssignmentRole,
  isIsoDate,
  isValidDateRange,
} from "../../domain/clientassignment/model";
import {
  AssignmentAlreadyEnded,
  AssignmentAxisNotFound,
  AssignmentAxisRetired,
  AssignmentClientArchived,
  AssignmentClientNotFound,
  AssignmentDuplicate,
  AssignmentHolderNotStaff,
  AssignmentNotFound,
  AssignmentPredatesIncumbent,
  AxisNotAllowedForKeyManager,
  AxisRequiredForSpoc,
  InvalidAssignmentDates,
  InvalidAssignmentRole,
} from "../../domain/clientassignment/errors";
import type {
  AssignableAxisDirectory,
  CaughtUpWork,
  ClientAssignmentRepository,
  ClientDirectory,
  ClientWorkCatchUp,
  HandoverClose,
  NewClientAssignment,
  StaffDirectory,
} from "./ports";

export interface Deps {
  readonly assignments: ClientAssignmentRepository;
  readonly clients: ClientDirectory;
  readonly staff: StaffDirectory;
  readonly axes: AssignableAxisDirectory;
  readonly ids: IdGen;
  readonly clock: Clock;
  /** The firm's own zone: an assignment "from today" begins on the firm's
   *  day, not the server's UTC day. Structural: `PostgresFirmTimeZone`. */
  readonly timeZones: { timeZoneFor(tenantId: string): Promise<string> };
  readonly events: EventSink;
  /** The work already created for the client, moved to the team just named
   *  (T6.17). See `assign`. */
  readonly work: ClientWorkCatchUp;
}

/** An assignment, and what naming it moved of the client's existing work. */
export interface AssignOutcome {
  readonly assignment: ClientAssignment;
  /**
   * What the catch-up moved (T6.17). NULL when moving it failed: the
   * assignment stands either way, because it is the firm's record of who
   * looks after the client, and a failure to tidy the work already created
   * must not undo it. The screen says the old work did not move, so somebody
   * hands it out by hand.
   */
  readonly caughtUp: CaughtUpWork | null;
}

export interface AssignInput {
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly role: string;
  readonly axisId?: string | null | undefined;
  readonly userId: string;
  /** Absent means today. Backdating is allowed — a firm records a handover that
   *  happened last week, and refusing it would only mean the record says the
   *  wrong day. */
  readonly validFrom?: string | undefined;
}

export interface EndAssignmentInput {
  readonly tenantId: string;
  readonly assignmentId: string;
  /** The FIRST DAY NOT IN FORCE. Absent means today, which reads as "they stop
   *  being the SPOC from today" — the half-open convention, applied. */
  readonly validTo?: string | undefined;
}

/** The account team, and the day it is being asked about. The date rides along
 *  because a screen showing March has to be able to SAY it is showing March. */
export interface AccountTeamView {
  readonly onDate: string;
  /** In force on `onDate`, in reading order. */
  readonly inForce: readonly ClientAssignmentRecord[];
  /** Every row the client has ever had, in the same order. The history a screen
   *  puts below the live list — and the thing that makes an "as of" box worth
   *  offering at all. */
  readonly all: readonly ClientAssignmentRecord[];
}

export class ClientAssignmentService {
  constructor(private readonly deps: Deps) {}

  /**
   * The account team, as it stood on one day.
   *
   * Everything is read and the date filter is applied in the DOMAIN. That is
   * the whole "who was the SPOC in March" answer, and it costs one query
   * whatever date the screen asks about.
   */
  async accountTeam(
    tenantId: string,
    clientPartyId: string,
    onDate?: string,
  ): Promise<AccountTeamView> {
    const on = onDate ?? (await this.today(tenantId));
    if (!isIsoDate(on)) throw new InvalidAssignmentDates(on, null);

    // The client is resolved first so an unknown id is a 404 rather than an
    // empty account team, which reads as "nobody is assigned" and is a
    // different and much worse answer.
    await this.requireClient(tenantId, clientPartyId);

    const all = accountTeamOrder(
      await this.deps.assignments.listForClient(tenantId, clientPartyId),
    );
    return { onDate: on, inForce: accountTeamOn(all, on), all };
  }

  /**
   * One person's book of clients on a day — today unless the caller says
   * otherwise.
   *
   * `onDate` is a parameter for the same reason `accountTeam` has one, and it
   * is not symmetry for its own sake: THE SERVER'S "TODAY" IS NOT THE FIRM'S.
   * The clock here is the process's, which in production is UTC, and a firm in
   * India is a day ahead of it every morning until half past five. Opening this
   * page after assigning somebody found exactly that — a client handed over at
   * 04:11 was absent from the holder's own book, because the row started
   * "tomorrow" as far as the server was concerned.
   *
   * A calendar day is the CALLER's fact and cannot be derived here, so the
   * screen sends its own. The default stays the server's day, which is the only
   * honest fallback for an API caller that did not say.
   */
  async clientsOf(
    tenantId: string,
    userId: string,
    onDate?: string,
  ): Promise<readonly OwnedClient[]> {
    const on = onDate ?? (await this.today(tenantId));
    if (!isIsoDate(on)) throw new InvalidAssignmentDates(on, null);
    return this.deps.assignments.listForUser(tenantId, userId, on);
  }

  /**
   * Put somebody in charge of a client.
   *
   * For a **Key Manager** this is a HANDOVER when the client already has one:
   * the incumbent is closed on the day the new one starts and both rows survive.
   * Only one is in force at a time, which the database also enforces.
   *
   * For a **SPOC** it is an addition. A Dept may have more than one — leave
   * cover, a joint SPOC on a large group, a fortnight's parallel handover — so
   * nothing is closed on the firm's behalf. Ending the outgoing SPOC is a
   * separate, deliberate call, and that asymmetry is the point: the firm is the
   * one that knows whether this is a replacement or a second pair of hands.
   *
   * AND THE CLIENT'S WAITING WORK CATCHES UP (T6.17, Shrestha 2026-09-27). The
   * engine asked who owns each task once, when it created it; a team named
   * afterwards (the book import names it after the paper letter, every time)
   * found that work with the Key Manager or the signing partner to hand out,
   * or with nobody. Naming somebody now asks the owner rule again for the
   * work nobody has decided about (`ClientWorkCatchUp`), and the answer says
   * how much moved. After the assignment and its event are written, and
   * outside them: a catch-up that fails leaves the assignment standing and
   * says so with `caughtUp: null`.
   */
  async assign(input: AssignInput, actor: Actor): Promise<AssignOutcome> {
    if (!isAssignmentRole(input.role)) {
      throw new InvalidAssignmentRole(input.role, ASSIGNMENT_ROLES);
    }
    const role: AssignmentRole = input.role;

    const validFrom = input.validFrom ?? (await this.today(input.tenantId));
    if (!isValidDateRange(validFrom, null)) throw new InvalidAssignmentDates(validFrom, null);

    const client = await this.requireClient(input.tenantId, input.clientPartyId);
    if (client.archivedAt !== null) throw new AssignmentClientArchived(client.displayName);

    // The FK points at a GLOBAL table, so this is the only thing that can say
    // the person works at THIS firm. Same shape and same reason as the
    // reporting-line check.
    if (!(await this.deps.staff.isActiveStaff(input.tenantId, input.userId))) {
      throw new AssignmentHolderNotStaff(input.userId);
    }

    const axisId = await this.resolveAxis(input.tenantId, role, input.axisId ?? null);

    // Asked as of the day the NEW row starts, not "today". Backdating a
    // handover to June has to see who held it in June — and the server's own
    // today is the wrong date for this in a way that is invisible until
    // somebody in another timezone uses it.
    const open = await this.deps.assignments.listOpenForClient(
      input.tenantId,
      input.clientPartyId,
      role,
      validFrom,
    );

    // The same person, twice, in the same place, still in force. A double
    // click or a re-import — not a second SPOC, and the database refuses it
    // too. Checked here so the answer is a sentence rather than a constraint
    // violation surfacing as a 500.
    const duplicate = open.find((a) => a.userId === input.userId && a.axisId === axisId);
    if (duplicate) throw new AssignmentDuplicate(role, duplicate.validFrom);

    const handover = role === "key_manager" ? this.closeIncumbent(open, validFrom) : null;

    const created = await this.deps.assignments.create(
      {
        id: this.deps.ids.newId(),
        tenantId: input.tenantId,
        clientPartyId: input.clientPartyId,
        role,
        axisId,
        userId: input.userId,
        validFrom,
      } satisfies NewClientAssignment,
      handover,
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_assignment.created",
      objectId: created.id,
      actor,
      // Ids and machine facts only — no name, no email. `handedOverFrom` is what
      // makes a timeline readable: without it a handover looks like two
      // unrelated events on the same day and nothing says they were one act.
      payload: {
        clientPartyId: created.clientPartyId,
        role: created.role,
        axisId: created.axisId,
        userId: created.userId,
        validFrom: created.validFrom,
        ...(handover ? { handedOverFrom: handover.assignmentId } : {}),
      },
    });

    let caughtUp: CaughtUpWork | null = null;
    try {
      caughtUp = await this.deps.work.catchUp(input.tenantId, input.clientPartyId, actor);
    } catch {
      // Deliberately swallowed, and reported as `null` rather than a zero
      // nobody measured: see `AssignOutcome.caughtUp`. Each task the catch-up
      // did move before failing is on its own row and its own ledger event.
      caughtUp = null;
    }
    return { assignment: created, caughtUp };
  }

  /**
   * End an assignment — somebody stops being the SPOC, and nobody replaces them
   * yet.
   *
   * `validTo` is the FIRST DAY NOT IN FORCE, so ending "today" means they were
   * the SPOC up to and including yesterday. Never a delete: the row is what
   * says who it used to be.
   */
  async end(input: EndAssignmentInput, actor: Actor): Promise<ClientAssignment> {
    const existing = await this.deps.assignments.findById(
      input.tenantId,
      input.assignmentId,
    );
    if (!existing) throw new AssignmentNotFound(input.assignmentId);
    if (existing.validTo !== null) throw new AssignmentAlreadyEnded(existing.validTo);

    const validTo = input.validTo ?? (await this.today(input.tenantId));
    if (!isValidDateRange(existing.validFrom, validTo)) {
      throw new InvalidAssignmentDates(existing.validFrom, validTo);
    }

    const ended = await this.deps.assignments.end(
      input.tenantId,
      input.assignmentId,
      validTo,
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_assignment.ended",
      objectId: ended.id,
      actor,
      payload: {
        clientPartyId: ended.clientPartyId,
        role: ended.role,
        axisId: ended.axisId,
        userId: ended.userId,
        validTo,
      },
    });
    return ended;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The firm's calendar day, never the server's UTC day. */
  private async today(tenantId: string): Promise<string> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    return dayInZone(this.deps.clock.now().toISOString(), zone);
  }

  private async requireClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<{ displayName: string; archivedAt: string | null }> {
    const party = await this.deps.clients.findParty(tenantId, clientPartyId);
    if (!party) throw new AssignmentClientNotFound(clientPartyId);
    return { displayName: party.displayName, archivedAt: party.archivedAt };
  }

  /**
   * A SPOC's axis, resolved and checked; null for a key manager.
   *
   * Both halves of the role rule are refused, and the second is the one worth
   * having: a SPOC with no axis would quietly become a second key manager under
   * another name, and nothing downstream would be able to tell them apart.
   */
  private async resolveAxis(
    tenantId: string,
    role: AssignmentRole,
    axisId: string | null,
  ): Promise<string | null> {
    if (role === "key_manager") {
      if (axisId !== null) throw new AxisNotAllowedForKeyManager();
      return null;
    }
    if (axisId === null) throw new AxisRequiredForSpoc();

    const axis = await this.deps.axes.findById(tenantId, axisId);
    if (!axis) throw new AssignmentAxisNotFound(axisId);
    if (!axis.isActive) throw new AssignmentAxisRetired(axis.code);
    return axis.id;
  }

  /**
   * The outgoing Key Manager, closed on the day the new one starts.
   *
   * Contiguous by construction — the ranges are half-open, so closing at `from`
   * and opening at `from` leaves no gap and no overlap, and the exclusion
   * constraint accepts exactly that pair.
   *
   * A new Key Manager starting on or before the incumbent's own start date is
   * refused rather than attempted: the close would produce a period that is in
   * force on no day at all, which the CHECK forbids, and the caller needs to be
   * told which date is in the way rather than shown a constraint violation.
   */
  private closeIncumbent(
    open: readonly ClientAssignment[],
    from: string,
  ): HandoverClose | null {
    const incumbent = open[0];
    if (!incumbent) return null;
    if (from <= incumbent.validFrom) throw new AssignmentPredatesIncumbent(incumbent.validFrom);
    return { assignmentId: incumbent.id, validTo: from };
  }
}
