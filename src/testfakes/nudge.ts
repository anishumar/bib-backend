// In-memory port fakes for the proactive nudge (T6.7).
//
// `implements` the ports the Postgres adapters implement, which is a
// compile-time assertion that the fakes and the real thing stay in step.
//
// ── WHAT THESE DO NOT REPRODUCE ──────────────────────────────────────────
//
// The at-least-once UNIQUE index, RLS, gate 4, and the day arithmetic. All four
// are database properties. `FakeNudgeRepo` refuses a duplicate rung with a Set,
// which is the same OUTCOME by a completely different mechanism — so a green
// test here says the SERVICE does not try twice, and nothing about whether
// `obligation_nudge_once` would refuse it if it did. That is proven in
// `tests/nudge/sweep.integration.test.ts` against real Postgres.
import type {
  NudgeCandidate,
  NudgeRung,
  NudgeToSend,
} from "../domain/nudge/model";
import type {
  IsoDate,
  NudgeCandidateSource,
  NudgeLadderSource,
  NudgeRepository,
  NudgeTenantDirectory,
} from "../usecase/nudge/ports";

export class FakeNudgeTenants implements NudgeTenantDirectory {
  constructor(private readonly ids: readonly string[]) {}
  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

/** Nothing published is the SHIPPED STATE, so this starts empty and a test has
 *  to opt a firm in — the same shape `FakeChaserLadder` has. */
export class FakeNudgeLadder implements NudgeLadderSource {
  private readonly byTenant = new Map<string, readonly NudgeRung[]>();

  publish(tenantId: string, rungs: readonly NudgeRung[]): this {
    this.byTenant.set(tenantId, rungs);
    return this;
  }

  ladderFor(tenantId: string): Promise<readonly NudgeRung[]> {
    return Promise.resolve(this.byTenant.get(tenantId) ?? []);
  }
}

export class FakeNudgeCandidates implements NudgeCandidateSource {
  private readonly rows: NudgeCandidate[] = [];

  upcoming(candidate: NudgeCandidate): this {
    this.rows.push(candidate);
    return this;
  }

  upcomingFilings(
    _tenantId: string,
    _asOf: IsoDate,
    horizonDays: number,
  ): Promise<readonly NudgeCandidate[]> {
    // THE WINDOW IS APPLIED HERE TOO, because it is applied in the real query
    // and a fake that ignored it would let a test pass that the database would
    // answer with nothing. `horizonDays` comes from the ladder, so this is also
    // what catches a service that stopped deriving it.
    return Promise.resolve(this.rows.filter((r) => r.daysUntil <= horizonDays));
  }
}

export class FakeNudgeRepo implements NudgeRepository {
  readonly written: NudgeToSend[] = [];
  private readonly taken = new Set<string>();

  record(_tenantId: string, nudges: readonly NudgeToSend[]): Promise<readonly NudgeToSend[]> {
    const created: NudgeToSend[] = [];
    for (const nudge of nudges) {
      const key = `${nudge.obligationId}:${nudge.rungKey}`;
      if (this.taken.has(key)) continue;
      this.taken.add(key);
      this.written.push(nudge);
      created.push(nudge);
    }
    return Promise.resolve(created);
  }
}
