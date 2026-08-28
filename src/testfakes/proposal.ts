// In-memory port fakes for the proposal use case. `implements` each port — the
// compile-time assertion that they stay in step with the real adapters — so
// quoting's rules can be tested with zero infrastructure.
//
// What is NOT faked, and where the real answers live:
//
//   THE TOTALS. This fake computes them with scaled-integer arithmetic below,
//   which is exact for the same reason `numeric` is: it never touches a float.
//   It is still a SECOND implementation of a formula that lives in
//   crm.proposal_line_amount (0013), and the migration is the authority — so
//   tests/proposal/pricing.integration.test.ts checks the two agree on the
//   awkward numbers rather than trusting this one.
//
//   RLS, the one-line-per-position index, and the composite key that holds a
//   line to its proposal's currency. All database properties, proven against
//   real Postgres.
import type { Proposal, ProposalLine, ProposalStatus } from "../domain/proposal/model";
import type {
  NewProposal,
  NewProposalLine,
  PolicyDirectory,
  ProposalFilters,
  ProposalRecord,
  ProposalRepository,
  ProposalSummary,
  ServiceCatalogue,
} from "../usecase/proposal/ports";
import type { Deps } from "../usecase/proposal/service";
import { FakeIds } from "./ids";
import { FakeClock } from "./identity";
import { RecordingEventSink } from "./ledger";

export class FakeProposalRepo implements ProposalRepository {
  readonly rows: Proposal[] = [];
  readonly lines: (ProposalLine & { removed: boolean })[] = [];
  /** Display names for the parties a test quotes, so a joined read returns
   *  something a screen could render rather than a uuid. */
  partyNames = new Map<string, string>();

  create(p: NewProposal): Promise<Proposal> {
    const row: Proposal = {
      id: p.id,
      tenantId: p.tenantId,
      partyId: p.partyId,
      leadId: p.leadId,
      title: p.title,
      status: "draft",
      currency: p.currency,
      fxRate: p.fxRate,
      fxRateDate: p.fxRateDate,
      validUntil: p.validUntil,
      sentAt: null,
      decidedAt: null,
      discountApprovedBy: null,
      discountApprovedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findById(tenantId: string, proposalId: string): Promise<Proposal | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === proposalId) ?? null,
    );
  }

  addLine(l: NewProposalLine): Promise<ProposalLine> {
    const live = this.lines.filter((x) => x.proposalId === l.proposalId && !x.removed);
    const row = {
      id: l.id,
      tenantId: l.tenantId,
      proposalId: l.proposalId,
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
    return Promise.resolve(stripRemoved(row));
  }

  removeLine(_tenantId: string, proposalId: string, lineId: string): Promise<void> {
    const line = this.lines.find((l) => l.id === lineId && l.proposalId === proposalId);
    if (line) line.removed = true;
    return Promise.resolve();
  }

  listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]> {
    return Promise.resolve(this.liveLines(tenantId, proposalId).map(stripRemoved));
  }

  setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
  ): Promise<Proposal> {
    return Promise.resolve(
      this.replace(tenantId, proposalId, (p) => ({
        ...p,
        status,
        sentAt: status === "draft" ? null : (p.sentAt ?? at),
        decidedAt: ["accepted", "rejected", "expired"].includes(status) ? at : null,
      })),
    );
  }

  recordDiscountApproval(
    tenantId: string,
    proposalId: string,
    approvedByUserId: string,
    at: string,
  ): Promise<Proposal> {
    return Promise.resolve(
      this.replace(tenantId, proposalId, (p) => ({
        ...p,
        discountApprovedBy: approvedByUserId,
        discountApprovedAt: at,
      })),
    );
  }

  async describe(tenantId: string, proposalId: string): Promise<ProposalRecord | null> {
    const proposal = await this.findById(tenantId, proposalId);
    if (proposal === null) return null;
    const lines = this.liveLines(tenantId, proposalId);
    return {
      proposal,
      party: {
        id: proposal.partyId,
        displayName: this.partyNames.get(proposal.partyId) ?? proposal.partyId,
      },
      lines: lines.map((l) => ({
        line: stripRemoved(l),
        service: null,
        net: netOf(l),
      })),
      totals: totalsOf(lines, proposal.currency),
      approvedBy: null,
    };
  }

  list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]> {
    const matching = this.rows.filter(
      (p) =>
        p.tenantId === tenantId &&
        (filters.status === undefined || p.status === filters.status) &&
        (filters.partyId === undefined || p.partyId === filters.partyId),
    );
    return Promise.resolve(
      matching.map((proposal) => {
        const lines = this.liveLines(tenantId, proposal.id);
        return {
          proposal,
          party: {
            id: proposal.partyId,
            displayName: this.partyNames.get(proposal.partyId) ?? proposal.partyId,
          },
          totals: totalsOf(lines, proposal.currency),
          lineCount: lines.length,
        };
      }),
    );
  }

  private liveLines(
    tenantId: string,
    proposalId: string,
  ): (ProposalLine & { removed: boolean })[] {
    return this.lines
      .filter((l) => l.tenantId === tenantId && l.proposalId === proposalId && !l.removed)
      .sort((a, b) => a.position - b.position);
  }

  private replace(
    tenantId: string,
    proposalId: string,
    change: (p: Proposal) => Proposal,
  ): Proposal {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === proposalId);
    const current = this.rows[index];
    if (index === -1 || current === undefined) {
      throw new Error(`fake: no proposal ${proposalId}`);
    }
    const updated = change(current);
    this.rows[index] = updated;
    return updated;
  }
}

/** A catalogue a test controls: register the versions it wants quotable. */
export class FakeServiceCatalogue implements ServiceCatalogue {
  private readonly versions = new Map<
    string,
    { kind: string; status: string; key: string; version: number; body: Record<string, unknown> }
  >();

  /** Add a published service. Returns the version id, which is what a proposal
   *  line pins. */
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

  readPinnedService(
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

/** The firm's discount limit. Starts as null — no policy published — because
 *  that is the state every firm is in until somebody sets one, and the
 *  fail-closed reading of it is the rule most worth testing. */
export class FakePolicyDirectory implements PolicyDirectory {
  maxPercent: string | null = null;

  maxDiscountPercent(_tenantId: string): Promise<string | null> {
    return Promise.resolve(this.maxPercent);
  }
}

export function makeProposalFakes(): Deps & {
  proposals: FakeProposalRepo;
  catalogue: FakeServiceCatalogue;
  policies: FakePolicyDirectory;
  events: RecordingEventSink;
} {
  return {
    proposals: new FakeProposalRepo(),
    catalogue: new FakeServiceCatalogue(),
    policies: new FakePolicyDirectory(),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-06-01T09:00:00Z")),
    events: new RecordingEventSink(),
  };
}

// ── Exact decimal arithmetic, for the fake only ─────────────────────────────
//
// Scaled integers via BigInt, at the same four decimal places the columns use.
// A float would make this fake disagree with Postgres on exactly the numbers
// worth testing, which would be worse than not computing totals at all.

const SCALE = 4n;
const UNIT = 10n ** SCALE;

function toScaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  const padded = (fraction + "0000").slice(0, 4);
  return BigInt(whole) * UNIT + BigInt(padded);
}

function fromScaled(v: bigint): string {
  const whole = v / UNIT;
  const fraction = (v % UNIT).toString().padStart(4, "0");
  return `${whole.toString()}.${fraction}`;
}

/** round(a * b, 4) over scaled integers — half-up, matching Postgres `round`. */
function mulRound(a: bigint, b: bigint): bigint {
  const product = a * b;
  const half = UNIT / 2n;
  return (product + half) / UNIT;
}

function grossOf(l: Pick<ProposalLine, "unitAmount" | "quantity">): bigint {
  return mulRound(toScaled(l.unitAmount), toScaled(l.quantity));
}

function netScaled(
  l: Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">,
): bigint {
  const keep = toScaled("100") - toScaled(l.discountPercent);
  return mulRound(mulRound(grossOf(l), keep), toScaled("0.01"));
}

function netOf(l: Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">): string {
  return fromScaled(netScaled(l));
}

function totalsOf(
  lines: readonly Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">[],
  currency: string,
): ProposalRecord["totals"] {
  let gross = 0n;
  let net = 0n;
  for (const line of lines) {
    gross += grossOf(line);
    net += netScaled(line);
  }
  return {
    gross: fromScaled(gross),
    discount: fromScaled(gross - net),
    net: fromScaled(net),
    currency,
  };
}

function stripRemoved(l: ProposalLine & { removed: boolean }): ProposalLine {
  const { removed: _removed, ...line } = l;
  return line;
}
