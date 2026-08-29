// In-memory fakes for the dunning ladder (T3.5). `implements` each port, so the
// sweep's rules are testable with a fixed clock and no database.
//
// WHAT IS FAITHFULLY MODELLED, because it is a rule and not an implementation
// detail: `take` returns NULL when the rung was already climbed. That null is
// the whole idempotency contract — it is what stops a second `dunning.escalated`
// event — and a fake that returned a row every time would let the sweep's tests
// pass while the product chased clients twice.
//
// WHAT IS NOT: the row lock under `decide`. Two partners approving one credit
// hold at the same instant is a property of `WHERE state = 'pending_approval'`
// in Postgres, and asserting it here would be asserting this file's behaviour.
// tests/invoice/dunning.integration.test.ts proves it against a real database.
import type { DunningBody } from "../domain/config/model";
import type {
  DunningActionRecord,
  DunningLadderSource,
  DunningRepository,
  NewDunningAction,
  PendingDunningRecord,
} from "../usecase/invoice/ports";

export class FakeDunningRepo implements DunningRepository {
  readonly rows: DunningActionRecord[] = [];

  take(a: NewDunningAction): Promise<DunningActionRecord | null> {
    const already = this.rows.some(
      (r) => r.tenantId === a.tenantId && r.invoiceId === a.invoiceId && r.step === a.step,
    );
    // THE UNIQUE KEY, as a fake can express it. Null, not a throw: a rung
    // already climbed is the ordinary redelivery case.
    if (already) return Promise.resolve(null);
    const row: DunningActionRecord = { ...a, approvedBy: null, decidedAt: null, note: null };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  taken(tenantId: string, invoiceId: string): Promise<readonly string[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.invoiceId === invoiceId).map((r) => r.step),
    );
  }

  /**
   * The queue, joined the way the adapter joins it.
   *
   * The names come from `invoiceFacts`, which a test fills in — a fake that
   * returned bare rows would let a screen test pass while the real queue showed
   * a partner a uuid and asked them to approve a credit hold.
   */
  pending(tenantId: string): Promise<readonly PendingDunningRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.state === "pending_approval")
        .map((action) => {
          const facts = this.invoiceFacts.get(action.invoiceId);
          return {
            action,
            invoiceNumber: facts?.number ?? action.invoiceId,
            party: facts?.party ?? { id: "", displayName: "" },
            outstanding: facts?.outstanding ?? "0",
            currency: facts?.currency ?? "INR",
            dueOn: facts?.dueOn ?? null,
          };
        }),
    );
  }

  /** What the queue's join would find, as a test sets it. */
  readonly invoiceFacts = new Map<
    string,
    {
      number: string;
      party: { id: string; displayName: string };
      outstanding: string;
      currency: string;
      dueOn: string | null;
    }
  >();

  find(tenantId: string, actionId: string): Promise<DunningActionRecord | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === actionId) ?? null,
    );
  }

  listFor(tenantId: string, invoiceId: string): Promise<readonly DunningActionRecord[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.invoiceId === invoiceId),
    );
  }

  decide(
    tenantId: string,
    actionId: string,
    state: "approved" | "rejected",
    approvedBy: string,
    at: string,
    note: string | null,
  ): Promise<DunningActionRecord | null> {
    const at_ = this.rows.findIndex(
      (r) => r.tenantId === tenantId && r.id === actionId && r.state === "pending_approval",
    );
    const existing = this.rows[at_];
    // The guarded UPDATE finding no row — somebody decided it first.
    if (existing === undefined) return Promise.resolve(null);
    const row: DunningActionRecord = {
      ...existing,
      state,
      approvedBy,
      decidedAt: at,
      note: note ?? existing.note,
    };
    this.rows[at_] = row;
    return Promise.resolve(row);
  }
}

/** The ladder a test publishes. Starts EMPTY, because that is the state every
 *  firm is in until a partner writes one — and a firm with no ladder chases
 *  nobody, which is the behaviour worth having a fake for. */
export class FakeDunningLadder implements DunningLadderSource {
  readonly ladders = new Map<string, DunningBody>();

  ladderFor(tenantId: string): Promise<DunningBody | null> {
    return Promise.resolve(this.ladders.get(tenantId) ?? null);
  }
}

// NO `FakeTenantDirectory` here: `testfakes/scheduler.ts` already has one, and
// two fakes answering "which firms exist" is the same duplication the real
// adapters nearly shipped. Import it from there.
