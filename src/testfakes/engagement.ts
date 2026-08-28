// In-memory port fakes for the engagement use case. `implements` each port, so
// the rules can be tested with zero infrastructure.
//
// What is NOT faked, and where the real answers live: the signature FREEZE and
// the one-engagement-per-line constraint are triggers and indexes in migration
// 0017, proven against real Postgres in
// tests/engagement/letter.integration.test.ts. A fake that simulated them would
// be asserting its own behaviour.
import type {
  Engagement,
  EngagementLetter,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../domain/engagement/model";
import { readClauseBody } from "../domain/config/model";
import type {
  ClauseLibrary,
  ContentHasher,
  ESignProvider,
  EngagementRepository,
  LetterFilters,
  LetterRecord,
  LetterSummary,
  NewEngagement,
  NewLetter,
  NewLetterClause,
  NewLetterLine,
  SignatureRecord,
} from "../usecase/engagement/ports";
import type { Deps } from "../usecase/engagement/service";
import { FakeIds } from "./ids";
import { FakeClock } from "./identity";
import { RecordingEventSink } from "./ledger";

export class FakeEngagementRepo implements EngagementRepository {
  readonly letters: EngagementLetter[] = [];
  readonly lines: (LetterLine & { removed: boolean })[] = [];
  readonly clauses: LetterClause[] = [];
  readonly engagements: Engagement[] = [];
  /** Pinned clause bodies, so `describeLetter` returns the wording that was
   *  actually agreed rather than an empty string. Keyed by version id. */
  readonly clauseBodies = new Map<string, Record<string, unknown>>();
  partyNames = new Map<string, string>();

  create(l: NewLetter): Promise<EngagementLetter> {
    const row: EngagementLetter = {
      id: l.id,
      tenantId: l.tenantId,
      partyId: l.partyId,
      proposalId: l.proposalId,
      jurisdiction: l.jurisdiction,
      title: l.title,
      status: "draft",
      currency: l.currency,
      fxRate: l.fxRate,
      fxRateDate: l.fxRateDate,
      advanceRequired: l.advanceRequired,
      advanceAmount: l.advanceAmount,
      advanceRecordedAt: null,
      advanceRecordedBy: null,
      sentAt: null,
      signedAt: null,
      signedByName: null,
      signatureMethod: null,
      signatureReference: null,
      signedContentHash: null,
      withdrawnAt: null,
    };
    this.letters.push(row);
    return Promise.resolve(row);
  }

  findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return Promise.resolve(
      this.letters.find((l) => l.tenantId === tenantId && l.id === letterId) ?? null,
    );
  }

  addLine(l: NewLetterLine): Promise<LetterLine> {
    const live = this.lines.filter((x) => x.engagementLetterId === l.engagementLetterId && !x.removed);
    const row = {
      id: l.id,
      tenantId: l.tenantId,
      engagementLetterId: l.engagementLetterId,
      serviceVersionId: l.serviceVersionId,
      description: l.description,
      position: live.length + 1,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      currency: l.currency,
      discountPercent: l.discountPercent,
      removed: false,
    };
    this.lines.push(row);
    return Promise.resolve(strip(row));
  }

  removeLine(_tenantId: string, letterId: string, lineId: string): Promise<void> {
    const line = this.lines.find((l) => l.id === lineId && l.engagementLetterId === letterId);
    if (line) line.removed = true;
    return Promise.resolve();
  }

  listLines(tenantId: string, letterId: string): Promise<readonly LetterLine[]> {
    return Promise.resolve(this.liveLines(tenantId, letterId).map(strip));
  }

  addClause(c: NewLetterClause): Promise<LetterClause> {
    const row: LetterClause = {
      id: c.id,
      tenantId: c.tenantId,
      engagementLetterId: c.engagementLetterId,
      clauseVersionId: c.clauseVersionId,
      position: this.clauses.filter((x) => x.engagementLetterId === c.engagementLetterId).length + 1,
    };
    this.clauses.push(row);
    return Promise.resolve(row);
  }

  listClauses(tenantId: string, letterId: string): Promise<readonly LetterClause[]> {
    return Promise.resolve(
      this.clauses
        .filter((c) => c.tenantId === tenantId && c.engagementLetterId === letterId)
        .sort((a, b) => a.position - b.position),
    );
  }

  setStatus(
    tenantId: string,
    letterId: string,
    status: LetterStatus,
    at: string,
  ): Promise<EngagementLetter> {
    return Promise.resolve(
      this.replace(tenantId, letterId, (l) => ({
        ...l,
        status,
        sentAt: status === "draft" ? null : (l.sentAt ?? at),
        withdrawnAt: status === "withdrawn" ? at : null,
      })),
    );
  }

  signAndFanOut(
    tenantId: string,
    letterId: string,
    signature: SignatureRecord,
    engagements: readonly NewEngagement[],
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }> {
    const letter = this.replace(tenantId, letterId, (l) => ({
      ...l,
      status: "signed" as const,
      signedAt: signature.signedAt,
      signedByName: signature.signedByName,
      signatureMethod: signature.signatureMethod,
      signatureReference: signature.signatureReference,
      signedContentHash: signature.signedContentHash,
    }));
    const created = engagements.map((e) => {
      const row: Engagement = {
        id: e.id,
        tenantId: e.tenantId,
        engagementLetterId: e.engagementLetterId,
        engagementLetterLineId: e.engagementLetterLineId,
        partyId: e.partyId,
        status: e.status,
        activatedAt: e.activatedAt,
        endsOn: null,
      };
      this.engagements.push(row);
      return row;
    });
    return Promise.resolve({ letter, engagements: created });
  }

  recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    at: string,
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }> {
    const letter = this.replace(tenantId, letterId, (l) => ({
      ...l,
      advanceRecordedAt: at,
      advanceRecordedBy: recordedByUserId,
    }));
    const released: Engagement[] = [];
    this.engagements.forEach((e, i) => {
      if (e.engagementLetterId === letterId && e.status === "pending_advance") {
        const updated: Engagement = { ...e, status: "active", activatedAt: at };
        this.engagements[i] = updated;
        released.push(updated);
      }
    });
    return Promise.resolve({ letter, released });
  }

  listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]> {
    return Promise.resolve(
      this.engagements.filter((e) => e.tenantId === tenantId && e.engagementLetterId === letterId),
    );
  }

  async describeLetter(tenantId: string, letterId: string): Promise<LetterRecord | null> {
    const letter = await this.findLetter(tenantId, letterId);
    if (letter === null) return null;
    const lines = this.liveLines(tenantId, letterId);
    const clauses = await this.listClauses(tenantId, letterId);
    return {
      letter,
      party: {
        id: letter.partyId,
        displayName: this.partyNames.get(letter.partyId) ?? letter.partyId,
      },
      lines: lines.map((l) => ({ line: strip(l), service: null, net: net(l) })),
      clauses: clauses.map((c) => {
        const body = readClauseBody(this.clauseBodies.get(c.clauseVersionId) ?? {});
        return { clause: c, key: c.clauseVersionId, version: 1, title: body.title, text: body.text };
      }),
      totals: totals(lines, letter.currency),
      engagements: this.engagements.filter((e) => e.engagementLetterId === letterId),
    };
  }

  listLetters(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    const matching = this.letters.filter(
      (l) =>
        l.tenantId === tenantId &&
        (filters.status === undefined || l.status === filters.status) &&
        (filters.partyId === undefined || l.partyId === filters.partyId),
    );
    return Promise.resolve(
      matching.map((letter) => {
        const lines = this.liveLines(tenantId, letter.id);
        return {
          letter,
          party: {
            id: letter.partyId,
            displayName: this.partyNames.get(letter.partyId) ?? letter.partyId,
          },
          totals: totals(lines, letter.currency),
          lineCount: lines.length,
        };
      }),
    );
  }

  private liveLines(tenantId: string, letterId: string): (LetterLine & { removed: boolean })[] {
    return this.lines
      .filter((l) => l.tenantId === tenantId && l.engagementLetterId === letterId && !l.removed)
      .sort((a, b) => a.position - b.position);
  }

  private replace(
    tenantId: string,
    letterId: string,
    change: (l: EngagementLetter) => EngagementLetter,
  ): EngagementLetter {
    const index = this.letters.findIndex((l) => l.tenantId === tenantId && l.id === letterId);
    const current = this.letters[index];
    if (index === -1 || current === undefined) throw new Error(`fake: no letter ${letterId}`);
    const updated = change(current);
    this.letters[index] = updated;
    return updated;
  }
}

/** The library a test controls: register what it wants pinnable. */
export class FakeClauseLibrary implements ClauseLibrary {
  private readonly versions = new Map<
    string,
    { kind: string; status: string; key: string; version: number; body: Record<string, unknown> }
  >();

  publishClause(versionId: string, key: string, body: Record<string, unknown>): string {
    this.versions.set(versionId, { kind: "clause", status: "published", key, version: 1, body });
    return versionId;
  }

  publishService(versionId: string, key: string, body: Record<string, unknown>): string {
    this.versions.set(versionId, { kind: "service", status: "published", key, version: 1, body });
    return versionId;
  }

  add(
    versionId: string,
    row: { kind: string; status: string; key: string; version: number; body: Record<string, unknown> },
  ): void {
    this.versions.set(versionId, row);
  }

  readPinnedVersion(
    _tenantId: string,
    versionId: string,
  ): Promise<{
    readonly kind: string;
    readonly status: string;
    readonly key: string;
    readonly version: number;
    readonly body: Record<string, unknown>;
  } | null> {
    return Promise.resolve(this.versions.get(versionId) ?? null);
  }
}

/** A signer a test can make fail — because "the provider was down" must not
 *  leave a letter recorded as signed. */
export class FakeSigner implements ESignProvider {
  readonly method = "fake";
  failNext = false;
  readonly signed: { letterId: string; contentHash: string }[] = [];

  sign(input: {
    readonly letterId: string;
    readonly contentHash: string;
    readonly reference?: string | undefined;
  }): Promise<{ readonly reference: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("fake e-sign provider is unavailable"));
    }
    this.signed.push({ letterId: input.letterId, contentHash: input.contentHash });
    return Promise.resolve({ reference: input.reference ?? `fake-envelope-${input.letterId}` });
  }
}

/** Deterministic and content-sensitive: same content, same digest; a changed
 *  term, a different one. That is all the service asks of a hasher. */
export class FakeHasher implements ContentHasher {
  hash(content: string): string {
    let h = 0n;
    for (const ch of content) h = (h * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (2n ** 64n);
    return h.toString(16).padStart(64, "0");
  }
}

export function makeEngagementFakes(): Deps & {
  letters: FakeEngagementRepo;
  library: FakeClauseLibrary;
  esign: FakeSigner;
  events: RecordingEventSink;
} {
  return {
    letters: new FakeEngagementRepo(),
    library: new FakeClauseLibrary(),
    esign: new FakeSigner(),
    hasher: new FakeHasher(),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
    events: new RecordingEventSink(),
  };
}

// ── Exact decimal arithmetic, for the fake only. Same reasoning as the proposal
// fake: a float would make it disagree with Postgres on the numbers worth
// testing, and the migration is the authority either way.

const UNIT = 10000n;

function scaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  return BigInt(whole) * UNIT + BigInt((fraction + "0000").slice(0, 4));
}

function unscaled(v: bigint): string {
  return `${(v / UNIT).toString()}.${(v % UNIT).toString().padStart(4, "0")}`;
}

function mul(a: bigint, b: bigint): bigint {
  return (a * b + UNIT / 2n) / UNIT;
}

function grossOf(l: Pick<LetterLine, "unitAmount" | "quantity">): bigint {
  return mul(scaled(l.unitAmount), scaled(l.quantity));
}

function netScaled(
  l: Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent">,
): bigint {
  return mul(mul(grossOf(l), scaled("100") - scaled(l.discountPercent)), scaled("0.01"));
}

function net(l: Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent">): string {
  return unscaled(netScaled(l));
}

function totals(
  lines: readonly Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent">[],
  currency: string,
): LetterRecord["totals"] {
  let gross = 0n;
  let n = 0n;
  for (const line of lines) {
    gross += grossOf(line);
    n += netScaled(line);
  }
  return { gross: unscaled(gross), discount: unscaled(gross - n), net: unscaled(n), currency };
}

function strip(l: LetterLine & { removed: boolean }): LetterLine {
  const { removed: _removed, ...line } = l;
  return line;
}
