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
import type { DocumentType, FirmEntityPreference } from "../domain/document/model";
import { ANY_JURISDICTION } from "../domain/document/model";
import type {
  DocumentReferences,
  FirmEntity,
  FirmEntityPreferenceRecord,
  FirmEntityPreferenceRepository,
  NewFirmEntityPreference,
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

export function makeDocumentFakes(): Deps & {
  preferences: FakePreferenceRepo;
  refs: FakeDocumentReferences;
  events: RecordingEventSink;
} {
  return {
    preferences: new FakePreferenceRepo(),
    refs: new FakeDocumentReferences(),
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
