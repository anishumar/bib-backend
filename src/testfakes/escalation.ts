// In-memory fakes for the escalation ladder (T4.5). `implements` each port, so
// the sweep's rules are testable with a fixed clock and no database.
//
// WHAT IS FAITHFULLY MODELLED, because each is a RULE and not an implementation
// detail:
//
//   `raise` returns NULL when the rung has already been climbed on that
//   subject. That null is the whole idempotency contract — it is what stops a
//   second `work_item.escalated` event — and a fake that returned a row every
//   time would let the sweep's tests pass while a partner was told the same
//   thing every morning until somebody stopped reading the queue.
//
//   `listFor` applies the STILL-LIVE rule and the Mine filter, because both are
//   decisions rather than SQL: migration 0058 chose a join over a `cleared_at`
//   column, and a fake that returned every notice ever raised would let a queue
//   test pass while the screen showed work finished last March.
//
// WHAT IS NOT: the two partial unique indexes as Postgres enforces them under
// concurrency. Two workers inserting the same rung in the same instant is a
// property of the database, and asserting it here would be asserting this
// file's behaviour. `tests/escalation/notice.integration.test.ts` proves it
// against a real one.
import type {
  ClimbedRung,
  EscalatableObligation,
  EscalatableWorkItem,
  EscalationLadderSource,
  EscalationNoticeRepository,
  EscalationNoticeRow,
  EscalationPerson,
  EscalationRecord,
  EscalationStaffDirectory,
  EscalationStaffRow,
  EscalationSubjectSource,
  EscalationTenantDirectory,
  EscalationViewer,
  NewEscalationNotice,
} from "../usecase/escalation/ports";
import type { EscalationBody } from "../domain/config/model";

/** The ladder a test publishes. Starts EMPTY, because that is the state every
 *  firm is in until a partner writes one — and a firm with no ladder escalates
 *  nobody, which is the behaviour most worth having a fake for. */
export class FakeEscalationLadder implements EscalationLadderSource {
  readonly ladders = new Map<string, EscalationBody>();

  ladderFor(tenantId: string): Promise<EscalationBody | null> {
    return Promise.resolve(this.ladders.get(tenantId) ?? null);
  }
}

export class FakeEscalationSubjects implements EscalationSubjectSource {
  readonly workItems = new Map<string, EscalatableWorkItem[]>();
  readonly obligations = new Map<string, EscalatableObligation[]>();

  openWorkItems(tenantId: string): Promise<readonly EscalatableWorkItem[]> {
    return Promise.resolve(this.workItems.get(tenantId) ?? []);
  }

  openObligations(tenantId: string): Promise<readonly EscalatableObligation[]> {
    return Promise.resolve(this.obligations.get(tenantId) ?? []);
  }
}

export class FakeEscalationStaff implements EscalationStaffDirectory {
  readonly staff = new Map<string, EscalationStaffRow[]>();

  activeStaff(tenantId: string): Promise<readonly EscalationStaffRow[]> {
    return Promise.resolve(this.staff.get(tenantId) ?? []);
  }
}

export class FakeEscalationTenants implements EscalationTenantDirectory {
  constructor(private readonly ids: readonly string[] = []) {}

  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

interface StoredNotice extends EscalationNoticeRow {
  readonly tenantId: string;
}

export class FakeEscalationNotices implements EscalationNoticeRepository {
  readonly rows: StoredNotice[] = [];

  /**
   * What the queue's join would find, as a test sets it — keyed by subject id.
   *
   * `open` is the half that matters: the real `listFor` drops a notice whose
   * work has finished, and a fake without it would let a screen test pass while
   * the queue showed a partner tasks completed last month.
   */
  readonly subjectFacts = new Map<
    string,
    {
      open: boolean;
      title: string;
      clientName: string | null;
      entityName: string | null;
      holderUserId: string | null;
      holderName: string | null;
      holderEmail: string | null;
      dueOn: string | null;
      stateName: string | null;
    }
  >();

  /** Who each id resolves to, so a test can prove the queue renders a PERSON
   *  and not a uuid — the read-model rule this codebase has been caught by five
   *  times. `displayName` is nullable here because it is nullable in the
   *  database and empty at real firms, which is what made the email necessary. */
  readonly people = new Map<string, { displayName: string | null; email: string }>();

  /** One id resolved, the way the adapter's LEFT JOIN resolves it — null when
   *  nothing was addressed, and null again when the account does not resolve.
   *  Both are real states and the row's `note` is what tells them apart. */
  private person(userId: string | null): EscalationPerson | null {
    if (userId === null) return null;
    const found = this.people.get(userId);
    return found === undefined ? null : { userId, ...found };
  }

  climbed(tenantId: string): Promise<readonly ClimbedRung[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({
          workItemId: r.workItemId,
          obligationInstanceId: r.obligationInstanceId,
          rungKey: r.rungKey,
        })),
    );
  }

  raise(n: NewEscalationNotice): Promise<EscalationNoticeRow | null> {
    const subject = n.workItemId ?? n.obligationInstanceId;
    const already = this.rows.some(
      (r) =>
        r.tenantId === n.tenantId &&
        (r.workItemId ?? r.obligationInstanceId) === subject &&
        r.rungKey === n.rungKey,
    );
    // THE UNIQUE INDEX, as a fake can express it. Null, not a throw: a rung
    // already climbed is the ordinary redelivery case.
    if (already) return Promise.resolve(null);
    const row: StoredNotice = {
      tenantId: n.tenantId,
      id: n.id,
      workItemId: n.workItemId,
      obligationInstanceId: n.obligationInstanceId,
      rungKey: n.rungKey,
      watch: n.watch,
      afterDays: n.afterDays,
      target: n.target,
      raisedToUserId: n.raisedToUserId,
      minGradeRank: n.minGradeRank,
      note: n.note,
      raisedOn: n.raisedOn,
      daysPast: n.daysPast,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listFor(
    tenantId: string,
    viewer: EscalationViewer | null,
  ): Promise<readonly EscalationRecord[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => {
        const subject = r.workItemId ?? r.obligationInstanceId ?? "";
        const facts = this.subjectFacts.get(subject);
        if (facts === undefined) return false;
        if (!facts.open) return false;
        // An unassigned-work notice ends the moment somebody picks the work up,
        // which no state change records. The real query says the same thing in
        // its WHERE clause.
        if (r.watch === "work_item_unassigned" && facts.holderUserId !== null) return false;
        return true;
      })
      .filter((r) => {
        if (viewer === null) return true;
        if (r.raisedToUserId !== null) return r.raisedToUserId === viewer.userId;
        if (r.minGradeRank !== null) {
          return viewer.gradeRank !== null && viewer.gradeRank >= r.minGradeRank;
        }
        // Addressed to nobody: the whole firm's queue, and nobody's own.
        return false;
      })
      .sort((a, b) => b.daysPast - a.daysPast || a.raisedOn.localeCompare(b.raisedOn))
      .map((r): EscalationRecord => {
        const facts = this.subjectFacts.get(r.workItemId ?? r.obligationInstanceId ?? "");
        return {
          id: r.id,
          workItemId: r.workItemId,
          obligationInstanceId: r.obligationInstanceId,
          rungKey: r.rungKey,
          watch: r.watch,
          afterDays: r.afterDays,
          target: r.target,
          raisedToUserId: r.raisedToUserId,
          minGradeRank: r.minGradeRank,
          note: r.note,
          raisedOn: r.raisedOn,
          daysPast: r.daysPast,
          subjectTitle: facts?.title ?? "",
          clientName: facts?.clientName ?? null,
          entityName: facts?.entityName ?? null,
          raisedTo: this.person(r.raisedToUserId),
          holder:
            facts?.holderUserId !== undefined &&
            facts.holderUserId !== null &&
            facts.holderEmail !== null
              ? {
                  userId: facts.holderUserId,
                  displayName: facts.holderName,
                  email: facts.holderEmail,
                }
              : null,
          dueOn: facts?.dueOn ?? null,
          stateName: facts?.stateName ?? null,
        };
      });
    return Promise.resolve(rows);
  }
}
