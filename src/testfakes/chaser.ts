// In-memory port fakes for the chaser (T4.4).
//
// They reproduce the behaviours the business rules depend on — every DUE rung is
// taken, not just the next; a rung already climbed is never re-sent; a frozen
// client is skipped and COUNTED — and nothing else. The exclusion constraint,
// the unique index and RLS are database properties and are proven against real
// Postgres in `tests/chaser/freeze.integration.test.ts`.
import type {
  ChaseCandidate,
  ChaseRung,
  ChaseToSend,
} from "../domain/chaser/model";
import type {
  ChaseCandidateSource,
  ChaseRepository,
  ChaserLadderSource,
  ChaserTenantDirectory,
  ClientFreezeRecord,
  ClientFreezeRepository,
  IsoDate,
  NewFreeze,
} from "../usecase/chaser/ports";

export class FakeChaserTenants implements ChaserTenantDirectory {
  constructor(private readonly ids: readonly string[]) {}
  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

/** A firm's published ladder, or none. EMPTY IS THE SHIPPED STATE and the fake
 *  defaults to it, so a test that says nothing about a ladder gets the behaviour
 *  a firm gets on the day this feature lands: chase nobody. */
export class FakeChaserLadder implements ChaserLadderSource {
  private readonly byTenant = new Map<string, readonly ChaseRung[]>();

  publish(tenantId: string, rungs: readonly ChaseRung[]): this {
    this.byTenant.set(tenantId, rungs);
    return this;
  }

  ladderFor(tenantId: string): Promise<readonly ChaseRung[]> {
    return Promise.resolve(this.byTenant.get(tenantId) ?? []);
  }
}

export class FakeChaseCandidates implements ChaseCandidateSource {
  readonly candidates: ChaseCandidate[] = [];
  readonly frozen = new Set<string>();

  open(candidate: ChaseCandidate): this {
    this.candidates.push(candidate);
    return this;
  }

  freeze(clientPartyId: string): this {
    this.frozen.add(clientPartyId);
    return this;
  }

  openAsks(
    _tenantId: string,
    _asOf: IsoDate,
    // Ignored: this fake holds candidates directly rather than deriving
    // `daysOpen` from a clock, so there is no calendar for a zone to move.
    // `tests/portallibrary/digest.integration.test.ts` is where the zone has to
    // be real, because only a database can apply one.
    _timeZone?: string,
  ): Promise<{
    readonly candidates: readonly ChaseCandidate[];
    readonly frozenClients: readonly string[];
  }> {
    // The frozen list is RETURNED rather than applied, exactly as the real
    // adapter returns it — the service counts them, and a fake that filtered
    // here would make the `frozen` figure untestable.
    return Promise.resolve({ candidates: this.candidates, frozenClients: [...this.frozen] });
  }
}

export class FakeChaseRepo implements ChaseRepository {
  readonly written: ChaseToSend[] = [];
  /** Rungs the "unique index" refuses — set by a test to reproduce the race the
   *  real `ON CONFLICT DO NOTHING` absorbs. */
  private readonly taken = new Set<string>();

  alreadyTaken(askId: string, rungKey: string): this {
    this.taken.add(`${askId}:${rungKey}`);
    return this;
  }

  record(_tenantId: string, chases: readonly ChaseToSend[]): Promise<readonly ChaseToSend[]> {
    const created: ChaseToSend[] = [];
    for (const chase of chases) {
      const key = `${chase.askId}:${chase.rungKey}`;
      if (this.taken.has(key)) continue;
      this.taken.add(key);
      this.written.push(chase);
      created.push(chase);
    }
    return Promise.resolve(created);
  }
}

interface StoredFreeze {
  id: string;
  tenantId: string;
  clientPartyId: string;
  validFrom: string;
  validTo: string | null;
  reason: string;
}

export class FakeClientFreezeRepo implements ClientFreezeRepository {
  readonly rows: StoredFreeze[] = [];
  private readonly clients = new Set<string>();

  client(id: string): this {
    this.clients.add(id);
    return this;
  }

  set(freeze: NewFreeze): Promise<ClientFreezeRecord | null> {
    if (!this.clients.has(freeze.clientPartyId)) return Promise.resolve(null);
    const row: StoredFreeze = {
      id: freeze.id,
      tenantId: freeze.tenantId,
      clientPartyId: freeze.clientPartyId,
      validFrom: freeze.validFrom,
      validTo: freeze.validTo,
      reason: freeze.reason,
    };
    this.rows.push(row);
    return Promise.resolve(toRecord(row));
  }

  listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly ClientFreezeRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.clientPartyId === clientPartyId)
        .map(toRecord),
    );
  }

  findById(tenantId: string, freezeId: string): Promise<ClientFreezeRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === freezeId);
    return Promise.resolve(row ? toRecord(row) : null);
  }

  lift(input: {
    readonly tenantId: string;
    readonly freezeId: string;
    readonly on: IsoDate;
    readonly liftedBy: string;
  }): Promise<ClientFreezeRecord | null> {
    const row = this.rows.find((r) => r.tenantId === input.tenantId && r.id === input.freezeId);
    // `valid_to IS NULL` in the real UPDATE's WHERE — a double-click writes
    // nothing rather than moving the day chasing resumed.
    if (!row || row.validTo !== null) return Promise.resolve(null);
    row.validTo = input.on;
    return Promise.resolve(toRecord(row));
  }
}

function toRecord(r: StoredFreeze): ClientFreezeRecord {
  return {
    id: r.id,
    clientPartyId: r.clientPartyId,
    clientName: `Client ${r.clientPartyId.slice(0, 4)}`,
    validFrom: r.validFrom,
    validTo: r.validTo,
    reason: r.reason,
    setByName: "Siddharth Rao",
    liftedByName: r.validTo === null ? null : "Siddharth Rao",
    createdAt: "2026-09-01T09:00:00.000Z",
  };
}
