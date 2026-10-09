// Client assignment use case (G3.2): "who at the firm looks after this client". Without it
// the demo routed a five-year-old client's email like a stranger's and created calendar
// filings with NO assignee. Model and rules: domain/clientassignment/model.ts.
// A handover is two rows, never an edit: the outgoing row closes the day the incoming one
// starts and `userId` is never updated, or "who was the SPOC when this went wrong" is lost.
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
  /** The firm's zone: "from today" is the firm's day, not the server's UTC day.
   *  Structural: `PostgresFirmTimeZone`. */
  readonly timeZones: { timeZoneFor(tenantId: string): Promise<string> };
  readonly events: EventSink;
  /** Moves the client's existing work to the team just named (T6.17). See `assign`. */
  readonly work: ClientWorkCatchUp;
}

/** An assignment, and what naming it moved of the client's existing work. */
export interface AssignOutcome {
  readonly assignment: ClientAssignment;
  /** What the catch-up moved (T6.17), or NULL when it failed. The assignment stands either
   *  way; the screen says the old work did not move, so somebody hands it out by hand. */
  readonly caughtUp: CaughtUpWork | null;
}

export interface AssignInput {
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly role: string;
  readonly axisId?: string | null | undefined;
  readonly userId: string;
  /** Absent means today. Backdating is allowed: a firm records last week's handover. */
  readonly validFrom?: string | undefined;
}

export interface EndAssignmentInput {
  readonly tenantId: string;
  readonly assignmentId: string;
  /** The FIRST DAY NOT IN FORCE; absent means today ("not the SPOC from today"). */
  readonly validTo?: string | undefined;
}

/** The account team and the day asked about, so a screen showing March can say so. */
export interface AccountTeamView {
  readonly onDate: string;
  /** In force on `onDate`, in reading order. */
  readonly inForce: readonly ClientAssignmentRecord[];
  /** Every row the client ever had, same order: the history below the live list. */
  readonly all: readonly ClientAssignmentRecord[];
}

export class ClientAssignmentService {
  constructor(private readonly deps: Deps) {}

  /** The account team on one day: everything read, filtered by date in the domain, so any
   *  date costs one query. */
  async accountTeam(
    tenantId: string,
    clientPartyId: string,
    onDate?: string,
  ): Promise<AccountTeamView> {
    const on = onDate ?? (await this.today(tenantId));
    if (!isIsoDate(on)) throw new InvalidAssignmentDates(on, null);

    // An unknown client is a 404, not an empty team that reads as "nobody is assigned".
    await this.requireClient(tenantId, clientPartyId);

    const all = accountTeamOrder(
      await this.deps.assignments.listForClient(tenantId, clientPartyId),
    );
    return { onDate: on, inForce: accountTeamOn(all, on), all };
  }

  /**
   * One person's book of clients on a day. The caller may send `onDate` because the server's
   * today is not the firm's: production runs UTC, India is a day ahead until 05:30, and a
   * client handed over at 04:11 was missing from the holder's own book. Absent, the firm's day.
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
   * Put somebody in charge of a client. A Key Manager is a HANDOVER when one exists: the
   * incumbent closes the day the new one starts (the DB also allows one in force). A SPOC is
   * an addition: nothing is closed, as only the firm knows a replacement from a second pair
   * of hands; ending the old SPOC is a separate call.
   * Then the client's undecided work catches up (T6.17, Shrestha 2026-09-27): the owner rule
   * ran once at task creation, and a team named later (the book import always does) left work
   * with the KM, the signing partner or nobody. It runs after the assignment and its event,
   * outside them; a failure leaves the assignment standing with `caughtUp: null`.
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

    // The FK points at a GLOBAL table, so only this proves the person works at THIS firm
    // (as the reporting-line check).
    if (!(await this.deps.staff.isActiveStaff(input.tenantId, input.userId))) {
      throw new AssignmentHolderNotStaff(input.userId);
    }

    const axisId = await this.resolveAxis(input.tenantId, role, input.axisId ?? null);

    // As of the day the NEW row starts, not today: a handover backdated to June must see
    // who held it in June.
    const open = await this.deps.assignments.listOpenForClient(
      input.tenantId,
      input.clientPartyId,
      role,
      validFrom,
    );

    // Same person, same place, still in force: a double click or re-import. The DB refuses
    // it too; checked here so the answer is a sentence, not a 500.
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
      // Ids and machine facts only. `handedOverFrom` ties a handover's two events into one act.
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
      // Reported as `null`, not an unmeasured zero (see `AssignOutcome.caughtUp`). Tasks moved
      // before the failure keep their rows and events; it is logged in `setup/server.ts`.
      caughtUp = null;
    }
    return { assignment: created, caughtUp };
  }

  /** End an assignment with no replacement. `validTo` is the first day NOT in force, so
   *  ending today means they held it through yesterday. Never a delete. */
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

  // internals

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

  /** A SPOC's axis, resolved and checked; null for a key manager. A SPOC with no axis would
   *  be a second key manager nothing downstream could tell apart. */
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
   * The outgoing Key Manager, closed the day the new one starts: half-open, so no gap and no
   * overlap. A start on or before the incumbent's own start is refused by date, since the
   * close would be in force on no day (the CHECK forbids it).
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
