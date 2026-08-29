// In-memory port fakes for the lead use case. `implements` each port (a
// compile-time assertion that they stay in step with the real adapters), so the
// pipeline's rules — dedup, merge, stage movement — can be tested with zero
// infrastructure.
//
// The one thing NOT faked is the party module. `makeLeadFakes` wires the REAL
// PartyService over in-memory party repositories, the same choice
// RecordingEventSink makes for the ledger: a lead test therefore fails if
// capture stops normalising an identifier, stops rejecting a malformed PAN, or
// stops recording party.created — none of which the lead use case implements,
// and all of which its correctness depends on.
//
// It does NOT enforce RLS, the one-open-lead-per-party index, or the CHECKs
// that hold a title non-blank and a lost reason to an unwon stage: those are
// database properties, proven against real Postgres in
// tests/lead/pipeline.integration.test.ts.
import { FakeClock } from "./clock";
import type { Lead, LeadStage, TerritoryRule } from "../domain/lead/model";
import type { PartyKind } from "../domain/party/model";
import { isOpen } from "../domain/lead/model";
import type {
  AssignmentOutcome,
  AssignmentStrategy,
  NewTerritoryRule,
  TerritoryRules,
  LeadRecord,
  LeadRepository,
  NewLead,
  StaffDirectory,
} from "../usecase/lead/ports";
import type { Deps } from "../usecase/lead/service";
import { PartyService } from "../usecase/party/service";
import { FakePartyRepo, makePartyFakes } from "./party";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

/** A fixed capture time, so a test can assert on ordering. */
const EPOCH = Date.parse("2026-03-01T10:00:00Z");

export class FakeLeadRepo implements LeadRepository {
  readonly rows: Lead[] = [];
  private tick = 0;

  create(l: NewLead): Promise<Lead> {
    const at = new Date(EPOCH + this.tick * 1000).toISOString();
    this.tick += 1;
    const row: Lead = {
      id: l.id,
      tenantId: l.tenantId,
      title: l.title,
      partyId: l.partyId,
      source: l.source,
      jurisdiction: l.jurisdiction,
      stage: "new",
      ownerUserId: l.ownerUserId,
      notes: l.notes,
      // A lead is captured OPEN, so it has nothing to explain yet. The real
      // table says the same with lead_lost_reason_scope_chk.
      lostReason: null,
      capturedAt: at,
      closedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findById(tenantId: string, leadId: string): Promise<Lead | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === leadId) ?? null,
    );
  }

  findOpenForParty(tenantId: string, partyId: string): Promise<Lead | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.partyId === partyId && isOpen(r.stage)) ??
        null,
    );
  }

  /** The people a lead refers to, for the joined reads. Populated by
   *  makeLeadFakes from the same in-memory party repo the real capture writes
   *  to, so a test sees the prospect it actually created. */
  parties: { find(partyId: string): { kind: PartyKind; displayName: string } | null } | null = null;
  staff: Map<string, { displayName: string | null; email: string }> = new Map();

  private record(lead: Lead): LeadRecord {
    const party = this.parties?.find(lead.partyId);
    const owner = lead.ownerUserId === null ? null : this.staff.get(lead.ownerUserId);
    return {
      lead,
      party: {
        id: lead.partyId,
        kind: party?.kind ?? "organization",
        displayName: party?.displayName ?? lead.partyId,
      },
      owner:
        lead.ownerUserId === null || owner === undefined || owner === null
          ? null
          : { userId: lead.ownerUserId, displayName: owner.displayName, email: owner.email },
    };
  }

  list(tenantId: string, stage: LeadStage | null): Promise<readonly LeadRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && (stage === null || r.stage === stage))
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .map((lead) => this.record(lead)),
    );
  }

  findRecord(tenantId: string, leadId: string): Promise<LeadRecord | null> {
    const lead = this.rows.find((r) => r.tenantId === tenantId && r.id === leadId);
    return Promise.resolve(lead ? this.record(lead) : null);
  }

  moveStage(
    tenantId: string,
    leadId: string,
    stage: LeadStage,
    closedAt: string | null,
    lostReason: string | null,
  ): Promise<Lead> {
    // All three together, exactly as the adapter's single UPDATE does — a fake
    // that let them drift apart would make the service look correct against a
    // shape the database would refuse.
    return Promise.resolve(
      this.replace(tenantId, leadId, (r) => ({ ...r, stage, closedAt, lostReason })),
    );
  }

  setOwner(tenantId: string, leadId: string, ownerUserId: string | null): Promise<Lead> {
    return Promise.resolve(this.replace(tenantId, leadId, (r) => ({ ...r, ownerUserId })));
  }

  private replace(tenantId: string, leadId: string, change: (r: Lead) => Lead): Lead {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === leadId);
    const current = this.rows[index];
    if (!current) throw new Error(`fake pipeline: no lead ${leadId}`);
    const next = change(current);
    this.rows[index] = next;
    return next;
  }
}

/** The firm's roster, as the lead use case sees it. Everybody added here is
 *  active STAFF; anybody else is not, which is the only distinction this port
 *  makes. */
export class FakeStaffDirectory implements StaffDirectory {
  private readonly staff = new Set<string>();

  add(tenantId: string, userId: string): this {
    this.staff.add(`${tenantId}:${userId}`);
    return this;
  }

  /** Somebody left, or had their access revoked. The fake's stand-in for
   *  `is_active` going false — one flag, so this port and the rotation cannot
   *  disagree about who works here, which is the property the real predicate
   *  has to hold too. */
  remove(tenantId: string, userId: string): this {
    this.staff.delete(`${tenantId}:${userId}`);
    return this;
  }

  isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.staff.has(`${tenantId}:${userId}`));
  }

  /**
   * The firm's roster, for the rotation to divide work between.
   *
   * NOT on the StaffDirectory port, deliberately. The real rotation never lists
   * anybody — it counts and claims in one statement, because listing and then
   * choosing is the race the port exists to close (see AssignmentStrategy).
   * Widening the port to fit this fake would put a method on the interface that
   * the production adapter has no use for and that a future strategy would be
   * tempted to reach for.
   */
  roster(tenantId: string): readonly string[] {
    const prefix = `${tenantId}:`;
    return [...this.staff]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
}

/**
 * The rotation, in memory: the emptiest desk wins, ties by user id.
 *
 * The SAME RULE as PostgresRoundRobinAssignment, written a second time, which
 * is a cost worth naming. It buys unit tests that can show the DISTRIBUTION
 * property — capture N, count the desks — without a database, and it cannot
 * show the two properties that only Postgres has: that the counts and the claim
 * are one atomic act, and that two simultaneous captures cannot land on the
 * same person. Those are proved in tests/lead/assignment.integration.test.ts,
 * against the real adapter. This fake is single-threaded and could never fail
 * that test, so it is never asked to.
 */
export class FakeRoundRobinAssignment implements AssignmentStrategy {
  constructor(
    private readonly leads: FakeLeadRepo,
    private readonly staff: FakeStaffDirectory,
  ) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    const roster = this.staff.roster(lead.tenantId);
    if (roster.length === 0) return { lead, policy: null };

    const current = await this.leads.findById(lead.tenantId, lead.id);
    // Somebody claimed it in between. A person's decision outranks a rotation,
    // exactly as `AND owner_user_id IS NULL` says in the adapter — and the
    // policy is null because the ROTATION did not choose, which is what keeps
    // the timeline from crediting it with a person's decision.
    if (current === null || current.ownerUserId !== null) {
      return { lead: current ?? lead, policy: null };
    }

    const load = new Map<string, number>(roster.map((userId) => [userId, 0]));
    for (const row of this.leads.rows) {
      if (row.tenantId !== lead.tenantId || row.ownerUserId === null) continue;
      if (!isOpen(row.stage)) continue;
      const held = load.get(row.ownerUserId);
      if (held !== undefined) load.set(row.ownerUserId, held + 1);
    }

    const chosen = [...load.entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    )[0];
    if (chosen === undefined) return { lead, policy: null };
    return {
      lead: await this.leads.setOwner(lead.tenantId, lead.id, chosen[0]),
      policy: "round_robin",
    };
  }
}

/**
 * TERRITORY, in memory — whose desk covers the prospect's country.
 *
 * It mirrors the adapter's three refusals rather than only the happy path,
 * because each of them is a rule and a fake that skipped one would let a test
 * pass on behaviour the database would not produce: an unknown country matches
 * nothing, a rule naming somebody who is no longer active staff DECLINES so the
 * lead falls through to the rotation, and a lead that acquired an owner in
 * between is left alone.
 */
export class FakeTerritoryAssignment implements AssignmentStrategy {
  /** jurisdiction → owner. The firm's rules, as a test sets them. */
  readonly rules = new Map<string, string>();

  constructor(
    private readonly leads: FakeLeadRepo,
    private readonly staff: FakeStaffDirectory,
  ) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    if (lead.jurisdiction === null) return { lead, policy: null };
    const owner = this.rules.get(lead.jurisdiction);
    if (owner === undefined) return { lead, policy: null };
    if (!this.staff.roster(lead.tenantId).includes(owner)) return { lead, policy: null };

    const current = await this.leads.findById(lead.tenantId, lead.id);
    if (current === null || current.ownerUserId !== null) {
      return { lead: current ?? lead, policy: null };
    }
    return {
      lead: await this.leads.setOwner(lead.tenantId, lead.id, owner),
      policy: "territory",
    };
  }
}

/** Territory first, rotation second — the same first-match the composition root
 *  wires, so a test asserts the ORDER and not just the two rules. */
export class FakeFirstMatchAssignment implements AssignmentStrategy {
  constructor(private readonly strategies: readonly AssignmentStrategy[]) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    for (const strategy of this.strategies) {
      const outcome = await strategy.assign(lead);
      if (outcome.policy !== null) return outcome;
    }
    return { lead, policy: null };
  }
}

/**
 * The rules a firm maintains, in memory — and it writes THROUGH the strategy's
 * own map rather than keeping a second one.
 *
 * That is deliberate. Two collections would let a test set a rule the strategy
 * cannot see, and every assertion about "the firm published a rule and the next
 * lead went to that desk" would pass against a fake that had quietly stopped
 * modelling the thing under test. One source of truth here, as in the database.
 */
export class FakeTerritoryRules implements TerritoryRules {
  private readonly rows: TerritoryRule[] = [];

  constructor(private readonly strategy: FakeTerritoryAssignment) {}

  list(tenantId: string): Promise<readonly TerritoryRule[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId).slice()
        .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction)),
    );
  }

  set(r: NewTerritoryRule): Promise<TerritoryRule> {
    const at = this.rows.findIndex(
      (x) => x.tenantId === r.tenantId && x.jurisdiction === r.jurisdiction,
    );
    const row: TerritoryRule = { ...r, id: at === -1 ? r.id : (this.rows[at]?.id ?? r.id) };
    if (at === -1) this.rows.push(row);
    else this.rows[at] = row;
    this.strategy.rules.set(r.jurisdiction, r.ownerUserId);
    return Promise.resolve(row);
  }
}

/** A ready-made dependency set for LeadService, with the handles a test needs
 *  to look at what happened. */
export function makeLeadFakes(): Deps & {
  leads: FakeLeadRepo;
  staff: FakeStaffDirectory;
  assignment: FakeFirstMatchAssignment;
  /** The two rules behind the composite, so a test can set a territory rule or
   *  assert which of them chose. */
  rotation: FakeRoundRobinAssignment;
  territory: FakeTerritoryAssignment;
  territories: FakeTerritoryRules;
  events: RecordingEventSink;
  /** The real party module the pipeline is built on, for a test that wants to
   *  read back the prospect capture created. */
  party: PartyService;
} {
  const ids = new FakeIds();
  const events = new RecordingEventSink();
  // One ledger and one id source across both modules, so the timeline a test
  // reads is the single timeline the product actually writes.
  const partyFakes = makePartyFakes();
  const party = new PartyService({ ...partyFakes, ids, events });

  const leads = new FakeLeadRepo();
  // The fake reads prospects out of the same in-memory party repo capture wrote
  // them to, so a joined read returns the display name the party module derived
  // rather than one this fake invented.
  leads.parties = {
    find: (partyId) => {
      const party = partyFakes.parties instanceof FakePartyRepo
        ? partyFakes.parties.parties.find((p) => p.id === partyId)
        : undefined;
      return party ? { kind: party.kind, displayName: party.displayName } : null;
    },
  };
  const staff = new FakeStaffDirectory();
  const rotation = new FakeRoundRobinAssignment(leads, staff);
  const territory = new FakeTerritoryAssignment(leads, staff);
  const assignment = new FakeFirstMatchAssignment([territory, rotation]);
  const territories = new FakeTerritoryRules(territory);
  return {
    leads,
    prospects: party,
    staff,
    // Rotates over whoever the test registered on `staff`. A test that has
    // registered nobody therefore captures leads into the unassigned queue,
    // which is why the tests written before T2.1b still mean what they meant.
    //
    // The COMPOSITE is what the service gets, in the same order the composition
    // root wires — territory first, rotation second. A test that sets no
    // territory rule sees exactly the rotation it always saw, because territory
    // declines on every lead, which is the property that makes this override
    // safe to add underneath every existing test.
    assignment,
    rotation,
    territory,
    territories,
    ids,
    clock: new FakeClock(new Date("2026-03-01T10:00:00Z")),
    events,
    party,
  };
}
