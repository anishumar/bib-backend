// The document use case — who issues the firm's documents, and what they are
// called. Business rules against ports; no I/O, no SQL, no HTTP.
//
// It exists because both documents ask the same two questions and neither of
// them is a quoting question. A proposal and an engagement letter each need a
// reference and each need an issuing entity, and answering that twice in two
// modules is how the two would end up disagreeing about which entity serves a
// UAE client.
//
// THE RULE IS DATA. "jahan ka client hota hai, wahan ki entity" — the entity of
// the country the client is in, with a fallback where the firm has none — lives
// in `crm.firm_entity_preference` as one row per country plus one wildcard row.
// The precedence between them is the domain's `resolveIssuingEntity`; this
// service is what fetches the rows and refuses when there is no answer. Nothing
// here branches on a country name, which is the whole point: the day the firm
// opens in Singapore, the change is a row.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { DocumentType } from "../../domain/document/model";
import {
  ANY_JURISDICTION,
  formatDocumentRef,
  isJurisdictionKey,
  normalizeJurisdictionKey,
  refYear,
  resolveIssuingEntity,
} from "../../domain/document/model";
import {
  FirmEntityNotFound,
  InvalidJurisdictionKey,
  NoIssuingEntity,
} from "../../domain/document/errors";
import type {
  DocumentReferences,
  FirmEntityPreferenceRecord,
  FirmEntityPreferenceRepository,
} from "./ports";

export interface Deps {
  readonly preferences: FirmEntityPreferenceRepository;
  readonly refs: DocumentReferences;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface SetPreferenceInput {
  readonly tenantId: string;
  /** The CLIENT's country, or `*` for the fallback. */
  readonly clientJurisdiction: string;
  readonly firmEntityPartyId: string;
  readonly note?: string | undefined;
}

export class DocumentService {
  constructor(private readonly deps: Deps) {}

  /** The rule as a screen shows it: country → which of our companies, and why. */
  async listPreferences(tenantId: string): Promise<readonly FirmEntityPreferenceRecord[]> {
    return this.deps.preferences.list(tenantId);
  }

  /**
   * Say which of the firm's own entities serves clients in a country.
   *
   * An upsert, because the schema allows exactly one answer per country and
   * "add a second opinion about AE" is not an operation anybody wants. The
   * entity is checked against the firm's own parties BEFORE anything is
   * written, so naming somebody else's company is a 404 naming the id rather
   * than a foreign-key violation surfacing as a 500.
   */
  async setPreference(
    input: SetPreferenceInput,
    actor: Actor,
  ): Promise<FirmEntityPreferenceRecord> {
    const key = normalizeJurisdictionKey(input.clientJurisdiction);
    if (!isJurisdictionKey(key)) throw new InvalidJurisdictionKey(input.clientJurisdiction);

    const entity = await this.deps.preferences.findEntity(input.tenantId, input.firmEntityPartyId);
    if (entity === null) throw new FirmEntityNotFound(input.firmEntityPartyId);

    const saved = await this.deps.preferences.set({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      clientJurisdiction: key,
      firmEntityPartyId: input.firmEntityPartyId,
      note: input.note ?? null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "firm_entity_preference.set",
      objectId: saved.id,
      actor,
      // Ids and machine facts. Which entity contracts with whom is a commercial
      // and legal decision, and WHO decided it is the reason this event exists —
      // the actor is already on the row. The NOTE is deliberately absent: it is
      // free text a person wrote, this log cannot be erased, and the row keeps
      // it where it can be.
      payload: {
        clientJurisdiction: saved.clientJurisdiction,
        firmEntityPartyId: saved.firmEntityPartyId,
        isFallback: saved.clientJurisdiction === ANY_JURISDICTION,
      },
    });
    // The entity's NAME comes back with the write, because the caller is a
    // screen that has to render the row it just changed and the join was
    // already made above. Fetching it again would be a second query for
    // something this method is holding.
    return { preference: saved, entity };
  }

  /**
   * Which of the firm's entities issues to a client in this country — the
   * question both document modules ask at drafting.
   *
   * `null` for the client's country is a real input: a proposal need not say
   * where the prospect is yet, and the fallback is the honest answer for it.
   * Refuses rather than guessing when the firm has published nothing at all,
   * because a document that cannot name who is contracting is not a document.
   */
  async issuerFor(tenantId: string, clientJurisdiction: string | null): Promise<string> {
    const rows = await this.deps.preferences.preferences(tenantId);
    const chosen = resolveIssuingEntity(rows, clientJurisdiction);
    if (chosen === null) throw new NoIssuingEntity(clientJurisdiction);
    return chosen.firmEntityPartyId;
  }

  /**
   * The next reference in this firm's series for this document type and year.
   *
   * Formatting is the domain's; the NUMBER comes from the port, which advances
   * the counter in its own committed transaction. A draft that fails after this
   * returns therefore burns its number, which is what a reference wants and
   * what an invoice number must never do — see migration 0020.
   */
  async nextRef(tenantId: string, type: DocumentType, now: Date): Promise<string> {
    const year = refYear(now);
    const number = await this.deps.refs.next(tenantId, type, year);
    return formatDocumentRef({ type, year, number });
  }
}
