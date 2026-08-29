// In-memory port fakes for the document use case — the reference series and the
// firm's rule for which of its own entities issues. `implements` each port, so
// the rules can be tested with zero infrastructure.
//
// What is NOT faked, and where the real answers live: the ALLOCATION SEMANTICS.
// The Postgres adapter advances the counter in its own committed transaction,
// so a number handed to a draft that then fails is burnt; that is a property of
// a transaction boundary, and a fake asserting it would be asserting its own
// behaviour. tests/document/reference.integration.test.ts proves it against
// real Postgres, along with `UNIQUE (tenant_id, ref)`.
import type {
  DocumentBlock,
  DocumentType,
  FirmEntityPreference,
  StandardBlock,
} from "../domain/document/model";
import { ANY_JURISDICTION } from "../domain/document/model";
import type {
  BlockOwner,
  DocumentBlockEdit,
  DocumentBlockRepository,
  DocumentReferences,
  FirmEntity,
  FirmEntityPreferenceRecord,
  FirmEntityPreferenceRepository,
  NewDocumentBlock,
  NewFirmEntityPreference,
  NewStandardBlock,
  StandardBlockEdit,
  StandardBlockRepository,
} from "../usecase/document/ports";
import type { Deps } from "../usecase/document/service";
import { DocumentService } from "../usecase/document/service";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

/** The entity every firm is seeded with — see the note on `FakePreferenceRepo`. */
export const SEEDED_FIRM_ENTITY = "00000000-0000-0000-0000-0000000000f1";

export class FakePreferenceRepo implements FirmEntityPreferenceRepository {
  readonly rows: FirmEntityPreference[] = [];
  /** Display names, so a joined read returns something a screen could render. */
  readonly partyNames = new Map<string, string>([[SEEDED_FIRM_ENTITY, "The Firm Itself"]]);
  /**
   * Where each entity is REGISTERED, and the seeded one is DELIBERATELY absent.
   *
   * `seedFirmEntity` writes a `core.organization` and no `core.legal_entity`
   * row — nothing knows the firm's country at `createTenant` — so an
   * unregistered default issuer is the real state of every tenant, and a fake
   * that handed one out would make G1.8's fail-closed refusal untestable and
   * every drafting test quietly wrong about which firms are safe.
   */
  readonly partyJurisdictions = new Map<string, string>();

  /**
   * The fallback every tenant owns from the moment it exists.
   *
   * Not an invention: `createTenant` seeds exactly this row through the
   * `IssuingEntitySeeder` port, and migration 0021 backfilled the firms that
   * predate it, so "this tenant has a wildcard preference" is the real state of
   * every tenant in the product. Modelling it here keeps every drafting test
   * from having to provision a firm by hand.
   *
   * Set it to null to test the firm that somehow has none — which is what
   * `NoIssuingEntity` exists to refuse.
   */
  seededFallbackPartyId: string | null = SEEDED_FIRM_ENTITY;

  preferences(tenantId: string): Promise<readonly FirmEntityPreference[]> {
    return Promise.resolve(this.rowsFor(tenantId));
  }

  list(tenantId: string): Promise<readonly FirmEntityPreferenceRecord[]> {
    return Promise.resolve(
      this.rowsFor(tenantId).map((preference) => ({
        preference,
        entity: this.entityOf(preference.firmEntityPartyId),
      })),
    );
  }

  set(p: NewFirmEntityPreference): Promise<FirmEntityPreference> {
    const at = this.rows.findIndex(
      (r) => r.tenantId === p.tenantId && r.clientJurisdiction === p.clientJurisdiction,
    );
    const row: FirmEntityPreference = {
      id: at === -1 ? p.id : (this.rows[at]?.id ?? p.id),
      tenantId: p.tenantId,
      clientJurisdiction: p.clientJurisdiction,
      firmEntityPartyId: p.firmEntityPartyId,
      note: p.note,
    };
    if (at === -1) this.rows.push(row);
    else this.rows[at] = row;
    return Promise.resolve(row);
  }

  findEntity(_tenantId: string, partyId: string): Promise<FirmEntity | null> {
    const name = this.partyNames.get(partyId);
    return Promise.resolve(name === undefined ? null : this.entityOf(partyId));
  }

  /** One place the two maps are read together, so a name without a
   *  jurisdiction reads the same way through every method. */
  private entityOf(partyId: string): FirmEntity {
    return {
      id: partyId,
      displayName: this.partyNames.get(partyId) ?? partyId,
      jurisdiction: this.partyJurisdictions.get(partyId) ?? null,
    };
  }

  private rowsFor(tenantId: string): FirmEntityPreference[] {
    const stored = this.rows.filter((r) => r.tenantId === tenantId);
    if (
      this.seededFallbackPartyId !== null &&
      !stored.some((r) => r.clientJurisdiction === ANY_JURISDICTION)
    ) {
      stored.push({
        id: `${tenantId}-fallback`,
        tenantId,
        clientJurisdiction: ANY_JURISDICTION,
        firmEntityPartyId: this.seededFallbackPartyId,
        note: "Seeded when the firm was created.",
      });
    }
    return stored;
  }
}

/** A counter per (tenant, type, year) that never gives the same number twice —
 *  which is the only thing the service asks of it. */
export class FakeDocumentReferences implements DocumentReferences {
  private readonly counters = new Map<string, number>();

  next(tenantId: string, type: DocumentType, year: number): Promise<number> {
    const key = `${tenantId} ${type} ${String(year)}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
}

/**
 * The firm's standard prose set, in memory.
 *
 * STARTS EMPTY, and that is the honest default rather than a convenience: no
 * migration seeds these, so a firm has no standard exclusions until somebody
 * writes them. A fake that handed out a set would make every drafting test
 * assert against prose nobody configured, and would hide the case a real firm
 * spends its first week in.
 */
export class FakeStandardBlockRepo implements StandardBlockRepository {
  readonly rows: StandardBlock[] = [];

  list(tenantId: string): Promise<readonly StandardBlock[]> {
    return Promise.resolve(
      this.rows
        .filter((b) => b.tenantId === tenantId)
        .slice()
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder),
    );
  }

  find(tenantId: string, id: string): Promise<StandardBlock | null> {
    return Promise.resolve(
      this.rows.find((b) => b.tenantId === tenantId && b.id === id) ?? null,
    );
  }

  add(b: NewStandardBlock): Promise<StandardBlock> {
    const row: StandardBlock = { ...b, isActive: true };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  edit(tenantId: string, id: string, e: StandardBlockEdit): Promise<StandardBlock> {
    const at = this.rows.findIndex((b) => b.tenantId === tenantId && b.id === id);
    const existing = this.rows[at];
    if (existing === undefined) throw new Error(`no standard block ${id}`);
    const row: StandardBlock = {
      ...existing,
      ...(e.body === undefined ? {} : { body: e.body }),
      ...(e.isHeading === undefined ? {} : { isHeading: e.isHeading }),
      ...(e.sortOrder === undefined ? {} : { sortOrder: e.sortOrder }),
      // `undefined` means unchanged and `null` means "print everywhere" — the
      // same distinction the adapter's CASE expression exists for, kept here so
      // the fake cannot disagree with it.
      ...(e.jurisdiction === undefined ? {} : { jurisdiction: e.jurisdiction }),
      ...(e.isActive === undefined ? {} : { isActive: e.isActive }),
    };
    this.rows[at] = row;
    return Promise.resolve(row);
  }
}

/** What each document says, in memory. Removal is `removed`, mirroring
 *  `removed_at` — `bib_app` holds no DELETE grant, and a fake that spliced the
 *  array would be modelling an operation the product cannot perform. */
export class FakeDocumentBlockRepo implements DocumentBlockRepository {
  readonly rows: (DocumentBlock & { owner: BlockOwner; removed: boolean })[] = [];

  list(tenantId: string, owner: BlockOwner): Promise<readonly DocumentBlock[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (b) =>
            b.tenantId === tenantId &&
            !b.removed &&
            b.owner.kind === owner.kind &&
            b.owner.id === owner.id,
        )
        .slice()
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder),
    );
  }

  find(tenantId: string, id: string): Promise<DocumentBlock | null> {
    return Promise.resolve(
      this.rows.find((b) => b.tenantId === tenantId && b.id === id && !b.removed) ?? null,
    );
  }

  addMany(blocks: readonly NewDocumentBlock[]): Promise<readonly DocumentBlock[]> {
    const saved = blocks.map((b) => ({ ...b, removed: false }));
    this.rows.push(...saved);
    return Promise.resolve(saved);
  }

  async add(b: NewDocumentBlock): Promise<DocumentBlock> {
    const [saved] = await this.addMany([b]);
    if (saved === undefined) throw new Error("document block insert returned no row");
    return saved;
  }

  edit(tenantId: string, id: string, e: DocumentBlockEdit): Promise<DocumentBlock> {
    const at = this.rows.findIndex((b) => b.tenantId === tenantId && b.id === id && !b.removed);
    const existing = this.rows[at];
    if (existing === undefined) throw new Error(`no document block ${id}`);
    const row = {
      ...existing,
      ...(e.body === undefined ? {} : { body: e.body }),
      ...(e.isHeading === undefined ? {} : { isHeading: e.isHeading }),
      ...(e.sortOrder === undefined ? {} : { sortOrder: e.sortOrder }),
    };
    this.rows[at] = row;
    return Promise.resolve(row);
  }

  remove(tenantId: string, id: string): Promise<void> {
    const at = this.rows.findIndex((b) => b.tenantId === tenantId && b.id === id);
    const existing = this.rows[at];
    if (existing !== undefined) this.rows[at] = { ...existing, removed: true };
    return Promise.resolve();
  }
}

export function makeDocumentFakes(): Deps & {
  preferences: FakePreferenceRepo;
  refs: FakeDocumentReferences;
  standardBlocks: FakeStandardBlockRepo;
  blocks: FakeDocumentBlockRepo;
  events: RecordingEventSink;
} {
  return {
    preferences: new FakePreferenceRepo(),
    refs: new FakeDocumentReferences(),
    standardBlocks: new FakeStandardBlockRepo(),
    blocks: new FakeDocumentBlockRepo(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
  };
}

/**
 * The REAL DocumentService over those fakes.
 *
 * The same choice `makeFakes` makes for the role registry: a stub that recorded
 * being asked would let quoting keep passing while the rule that picks an
 * issuing entity had stopped working. Proposals and engagement letters consume
 * this through their own narrow `DocumentIdentity` port, so a drift in what
 * either of them asks for fails at compile time, in one place.
 */
export function makeDocumentIdentity(): {
  documents: DocumentService;
  firmEntities: FakePreferenceRepo;
} {
  const fakes = makeDocumentFakes();
  return { documents: new DocumentService(fakes), firmEntities: fakes.preferences };
}
