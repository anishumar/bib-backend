// The firm's OWN companies (T6.18) — the ones that issue its documents.
//
// 10x Global has four: India, UAE, Singapore, US. Until this there was no way
// to add the second one from a screen: a company became "the firm's" only by
// being named in a `crm.firm_entity_preference` row (`crm.is_firm_entity`,
// 0306), and creating one meant three calls to three routes that a browser
// could stop half-way through — leaving an organization with no country, or
// one no rule names, sitting in the CLIENT list.
//
// Its own service beside `DocumentService` rather than more methods on it: this
// is the screen's write path, and `DocumentService` is composed in sixteen
// places that have no business knowing about it.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { RegisteredAddress } from "../../domain/document/model";
import {
  ANY_JURISDICTION,
  defaultCurrencyFor,
  isJurisdiction,
  normalizeJurisdiction,
  registeredAddressProblem,
} from "../../domain/document/model";
import {
  CountryAlreadyServed,
  FirmEntityNotFound,
  InvalidFirmEntity,
  JurisdictionFixed,
  NotAFirmEntity,
  NothingToChangeOnEntity,
} from "../../domain/document/errors";
import type { FirmEntityChange, FirmEntityRecord, FirmEntityRepository } from "./ports";

export interface FirmEntityDeps {
  readonly firmEntities: FirmEntityRepository;
  readonly ids: IdGen;
  readonly events: EventSink;
}

/** A company as the screens read it: the record, and the currency a document
 *  it issues starts in (D1) — from `defaultCurrencyFor`, the one copy. */
export interface FirmEntityView extends FirmEntityRecord {
  readonly defaultCurrency: string;
}

export interface CreateFirmEntityInput {
  readonly tenantId: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly registeredAddress?: { readonly lines: readonly string[] } | undefined;
}

export interface EditFirmEntityInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly name?: string | undefined;
  readonly entityType?: string | undefined;
  /** Null clears it. */
  readonly registeredAddress?: { readonly lines: readonly string[] } | null | undefined;
  /** Only for a company with no country recorded yet — the seeded one. */
  readonly jurisdiction?: string | undefined;
}

const NAME_MAX = 300;
const TYPE_MAX = 100;

export class FirmEntityService {
  constructor(private readonly deps: FirmEntityDeps) {}

  /** Every company of the firm's, with the firm's reporting currency beside
   *  them — the builder shows an exchange rate only when a document's currency
   *  is not that one. */
  async list(
    tenantId: string,
  ): Promise<{ readonly reportingCurrency: string; readonly entities: readonly FirmEntityView[] }> {
    const [reportingCurrency, rows] = await Promise.all([
      this.deps.firmEntities.reportingCurrency(tenantId),
      this.deps.firmEntities.list(tenantId),
    ]);
    return { reportingCurrency, entities: rows.map((r) => this.view(r, reportingCurrency)) };
  }

  /**
   * Add a company of the firm's, registered in a country, and make it the one
   * that issues to clients in that country — in ONE transaction, with the
   * events each of those three writes records on its own: `party.created`,
   * `legal_entity.registered`, `firm_entity_preference.set`.
   *
   * Refused while another of the firm's companies already issues for that
   * country (`COUNTRY_ALREADY_SERVED`): creating this one would move every
   * future client there without anybody deciding it. The fallback (`*`) is
   * not a country, and a company answering it does not block its own.
   */
  async create(input: CreateFirmEntityInput, actor: Actor): Promise<FirmEntityView> {
    const name = this.nameOrThrow(input.name);
    const entityType = this.typeOrThrow(input.entityType);
    const jurisdiction = this.countryOrThrow(input.jurisdiction);
    const registeredAddress = this.addressOrThrow(input.registeredAddress ?? null);

    const serving = await this.deps.firmEntities.issuerForCountry(input.tenantId, jurisdiction);
    if (serving !== null) throw new CountryAlreadyServed(jurisdiction, serving.name);

    const partyId = this.deps.ids.newId();
    const preferenceId = this.deps.ids.newId();
    const created = await this.deps.firmEntities.create({
      partyId,
      tenantId: input.tenantId,
      name,
      jurisdiction,
      entityType,
      registeredAddress,
      preferenceId,
    });
    if (!created) {
      // Another company took the country between the check and the write; the
      // transaction wrote nothing.
      const now = await this.deps.firmEntities.issuerForCountry(input.tenantId, jurisdiction);
      throw new CountryAlreadyServed(jurisdiction, now?.name ?? "Another of the firm's companies");
    }

    // The three events the three writes record when they happen one by one —
    // ids and machine facts, never the name or the address.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.created",
      objectId: partyId,
      actor,
      payload: { kind: "organization" },
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "legal_entity.registered",
      objectId: partyId,
      actor,
      payload: { jurisdiction, entityType },
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "firm_entity_preference.set",
      objectId: preferenceId,
      actor,
      payload: { clientJurisdiction: jurisdiction, firmEntityPartyId: partyId, isFallback: false },
    });
    return this.findOrThrow(input.tenantId, partyId);
  }

  /**
   * Change a company's name, type or registered address — and, for a company
   * with no country recorded (every firm's seeded one), record where it is
   * registered. A country already recorded does not change
   * (`JURISDICTION_FIXED`): the company's documents, law and currency follow
   * from it.
   */
  async edit(input: EditFirmEntityInput, actor: Actor): Promise<FirmEntityView> {
    const current = await this.deps.firmEntities.find(input.tenantId, input.partyId);
    if (current === null) {
      const name = await this.deps.firmEntities.partyName(input.tenantId, input.partyId);
      throw name === null ? new FirmEntityNotFound(input.partyId) : new NotAFirmEntity(name);
    }

    const change: {
      name?: string;
      entityType?: string;
      registeredAddress?: RegisteredAddress | null;
      register?: { jurisdiction: string; entityType: string };
    } = {};
    const fields: string[] = [];
    if (input.name !== undefined) {
      change.name = this.nameOrThrow(input.name);
      fields.push("name");
    }
    const entityType = input.entityType === undefined ? undefined : this.typeOrThrow(input.entityType);

    if (input.jurisdiction !== undefined) {
      const jurisdiction = this.countryOrThrow(input.jurisdiction);
      if (current.jurisdiction !== null && current.jurisdiction !== jurisdiction) {
        throw new JurisdictionFixed(current.name, current.jurisdiction);
      }
      if (current.jurisdiction === null) {
        if (entityType === undefined) {
          throw new InvalidFirmEntity(
            "recording where a company is registered needs its entity type too (entityType)",
          );
        }
        change.register = { jurisdiction, entityType };
      }
    }
    if (entityType !== undefined && change.register === undefined) {
      if (current.jurisdiction === null) {
        throw new InvalidFirmEntity(
          `${current.name} is not registered in any country yet; send jurisdiction with the type`,
        );
      }
      change.entityType = entityType;
      fields.push("entityType");
    }
    if (input.registeredAddress !== undefined) {
      if (current.jurisdiction === null && change.register === undefined) {
        throw new InvalidFirmEntity(
          `${current.name} is not registered in any country yet; send jurisdiction and entityType ` +
            `with the address`,
        );
      }
      change.registeredAddress =
        input.registeredAddress === null ? null : this.addressOrThrow(input.registeredAddress);
      fields.push("registeredAddress");
    }
    if (Object.keys(change).length === 0) throw new NothingToChangeOnEntity();

    const revised: FirmEntityChange = change;
    await this.deps.firmEntities.edit(input.tenantId, input.partyId, revised);

    if (change.register !== undefined) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "legal_entity.registered",
        objectId: input.partyId,
        actor,
        payload: { jurisdiction: change.register.jurisdiction, entityType: change.register.entityType },
      });
    }
    if (fields.length > 0) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "firm_entity.edited",
        objectId: input.partyId,
        actor,
        payload: { fields },
      });
    }
    return this.findOrThrow(input.tenantId, input.partyId);
  }

  private async findOrThrow(tenantId: string, partyId: string): Promise<FirmEntityView> {
    const [record, reportingCurrency] = await Promise.all([
      this.deps.firmEntities.find(tenantId, partyId),
      this.deps.firmEntities.reportingCurrency(tenantId),
    ]);
    if (record === null) throw new FirmEntityNotFound(partyId);
    return this.view(record, reportingCurrency);
  }

  private view(record: FirmEntityRecord, reportingCurrency: string): FirmEntityView {
    return { ...record, defaultCurrency: defaultCurrencyFor(record.jurisdiction, reportingCurrency) };
  }

  private nameOrThrow(raw: string): string {
    const name = raw.trim();
    if (name === "") throw new InvalidFirmEntity("the name is blank");
    if (name.length > NAME_MAX) {
      throw new InvalidFirmEntity(`the name is longer than ${String(NAME_MAX)} characters`);
    }
    return name;
  }

  private typeOrThrow(raw: string): string {
    const type = raw.trim();
    if (type === "") throw new InvalidFirmEntity("the entity type is blank");
    if (type.length > TYPE_MAX) {
      throw new InvalidFirmEntity(`the entity type is longer than ${String(TYPE_MAX)} characters`);
    }
    return type;
  }

  /** A real country: the fallback `*` is a rule, not somewhere a company can
   *  be registered. */
  private countryOrThrow(raw: string): string {
    const code = normalizeJurisdiction(raw);
    if (code === ANY_JURISDICTION || !isJurisdiction(code)) {
      throw new InvalidFirmEntity(
        `${JSON.stringify(raw)} is not a country code; use two letters, like IN, AE, SG or US`,
      );
    }
    return code;
  }

  /** Lines trimmed and blank ones dropped; nothing left is no address. */
  private addressOrThrow(
    raw: { readonly lines: readonly string[] } | null,
  ): RegisteredAddress | null {
    if (raw === null) return null;
    const lines = raw.lines.map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) return null;
    const address = { lines };
    const problem = registeredAddressProblem(address);
    if (problem !== null) throw new InvalidFirmEntity(problem);
    return address;
  }
}
