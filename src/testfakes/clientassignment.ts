// In-memory port fakes for client ownership (G3.2). `implements` the ports the
// Postgres adapters carry, so a compile error here is the same compile error
// production would get.
import type { Actor } from "../domain/ledger/model";
import type {
  AssignmentRole,
  ClientAssignment,
  ClientAssignmentRecord,
  OwnedClient,
} from "../domain/clientassignment/model";
import { isInForceOn } from "../domain/clientassignment/model";
import type {
  AssignableAxisDirectory,
  AssignableAxisRow,
  CaughtUpWork,
  ClientAssignmentRepository,
  ClientDirectory,
  ClientPartyRow,
  ClientWorkCatchUp,
  HandoverClose,
  NewClientAssignment,
  StaffDirectory,
} from "../usecase/clientassignment/ports";

interface Holder {
  readonly email: string;
  readonly displayName: string | null;
  /** Whether they are still active staff, as the membership join answers.
   *  Optional and true by default: almost every test is about somebody who
   *  works here, and only the stale-assignment cases say otherwise. */
  readonly isActiveStaff?: boolean;
}

/**
 * The assignment table, in memory — rows plus the two joins the real query
 * makes, because a read model that lost its names in the fake would let a test
 * pass on a shape the screen cannot render.
 */
export class FakeClientAssignmentRepo implements ClientAssignmentRepository {
  readonly rows: ClientAssignment[] = [];
  private readonly holders = new Map<string, Holder>();
  private readonly axes = new Map<string, AssignableAxisRow>();

  /** Give a user id a name and an email, as the `user_account` join would. An
   *  unknown holder still resolves — to their id — rather than throwing, so a
   *  test that does not care about names does not have to set them up. */
  withHolder(userId: string, holder: Holder): this {
    this.holders.set(userId, holder);
    return this;
  }

  withAxis(axis: AssignableAxisRow): this {
    this.axes.set(axis.id, axis);
    return this;
  }

  seed(row: ClientAssignment): ClientAssignment {
    this.rows.push(row);
    return row;
  }

  private record(a: ClientAssignment): ClientAssignmentRecord {
    const holder = this.holders.get(a.userId);
    const axis = a.axisId === null ? null : (this.axes.get(a.axisId) ?? null);
    return {
      assignment: a,
      holder: {
        userId: a.userId,
        email: holder?.email ?? `${a.userId}@example.test`,
        displayName: holder?.displayName ?? null,
        isActiveStaff: holder?.isActiveStaff ?? true,
      },
      axis:
        axis === null
          ? null
          : {
              id: axis.id,
              axis: axis.axis,
              code: axis.code,
              name: axis.name,
              isActive: axis.isActive,
            },
    };
  }

  listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly ClientAssignmentRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.clientPartyId === clientPartyId)
        .map((r) => this.record(r)),
    );
  }

  findById(tenantId: string, assignmentId: string): Promise<ClientAssignment | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === assignmentId) ?? null,
    );
  }

  /** Not already over by `onDate`, and NEWEST FIRST — the adapter's order, and
   *  what makes `open[0]` the incumbent in the service. A fake that returned
   *  them in insertion order would let the handover close the wrong row and
   *  still look green. */
  listOpenForClient(
    tenantId: string,
    clientPartyId: string,
    role: AssignmentRole,
    onDate: string,
  ): Promise<readonly ClientAssignment[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            r.clientPartyId === clientPartyId &&
            r.role === role &&
            (r.validTo === null || r.validTo > onDate),
        )
        .sort((a, b) => b.validFrom.localeCompare(a.validFrom)),
    );
  }

  /**
   * The close and the insert together, as the adapter does them in one
   * transaction.
   *
   * The fake models the ORDER too — close first, then insert — because that
   * order is what the database's exclusion constraint forces, and a fake that
   * inserted first would let a test pass on a sequence Postgres refuses.
   */
  create(row: NewClientAssignment, handover: HandoverClose | null): Promise<ClientAssignment> {
    if (handover) {
      const i = this.rows.findIndex((r) => r.id === handover.assignmentId);
      const current = this.rows[i];
      if (i < 0 || !current) throw new Error(`assignment ${handover.assignmentId} not in the fake`);
      if (current.validTo !== null) {
        throw new Error(`assignment ${handover.assignmentId} was already closed`);
      }
      this.rows[i] = { ...current, validTo: handover.validTo };
    }
    const created: ClientAssignment = { ...row, validTo: null };
    this.rows.push(created);
    return Promise.resolve(created);
  }

  end(tenantId: string, assignmentId: string, validTo: string): Promise<ClientAssignment> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === assignmentId);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`assignment ${assignmentId} not in the fake`);
    const next: ClientAssignment = { ...current, validTo };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  listForUser(
    tenantId: string,
    userId: string,
    onDate: string,
  ): Promise<readonly OwnedClient[]> {
    const byClient = new Map<string, AssignmentRole[]>();
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || r.userId !== userId) continue;
      if (!isInForceOn(r, onDate)) continue;
      const roles = byClient.get(r.clientPartyId) ?? [];
      if (!roles.includes(r.role)) roles.push(r.role);
      byClient.set(r.clientPartyId, roles);
    }
    return Promise.resolve(
      [...byClient].map(([clientPartyId, roles]) => ({
        clientPartyId,
        displayName: clientPartyId,
        archivedAt: null,
        roles,
      })),
    );
  }
}

/** The party lookup this use case needs — enough to be missing, and enough to
 *  be archived. */
export class FakeClientDirectory implements ClientDirectory {
  private readonly parties = new Map<string, ClientPartyRow>();

  with(party: ClientPartyRow): this {
    this.parties.set(party.id, party);
    return this;
  }

  findParty(_tenantId: string, partyId: string): Promise<ClientPartyRow | null> {
    return Promise.resolve(this.parties.get(partyId) ?? null);
  }
}

/** The roster, reduced to the one question this use case asks it. A user not
 *  added is not staff — which is the default that matters, because the
 *  foreign key would have accepted them. */
export class FakeAssignmentStaff implements StaffDirectory {
  private readonly staff = new Set<string>();

  with(tenantId: string, userId: string): this {
    this.staff.add(`${tenantId}:${userId}`);
    return this;
  }

  isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.staff.has(`${tenantId}:${userId}`));
  }
}

/** The firm's Depts and delivery teams, asked one at a time. */
export class FakeAssignableAxes implements AssignableAxisDirectory {
  private readonly rows = new Map<string, AssignableAxisRow>();

  with(axis: AssignableAxisRow): this {
    this.rows.set(axis.id, axis);
    return this;
  }

  findById(_tenantId: string, axisId: string): Promise<AssignableAxisRow | null> {
    return Promise.resolve(this.rows.get(axisId) ?? null);
  }
}

/**
 * The catch-up (T6.17), faked: it records who asked about which client and
 * answers with whatever the test put in `answer`, or throws `failWith` so a
 * test can see the assignment stand when moving the old work fails.
 */
export class FakeClientWorkCatchUp implements ClientWorkCatchUp {
  readonly calls: { tenantId: string; clientPartyId: string }[] = [];
  answer: CaughtUpWork = { moves: [] };
  failWith: Error | null = null;

  catchUp(tenantId: string, clientPartyId: string, _actor: Actor): Promise<CaughtUpWork> {
    this.calls.push({ tenantId, clientPartyId });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve(this.answer);
  }
}
