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
import type {
  BlockKind,
  DocumentBlock,
  StandardBlock,
} from "../../domain/document/model";
import {
  ANY_JURISDICTION,
  blockKindsFor,
  blocksFor,
  formatDocumentRef,
  isBlockKind,
  isJurisdiction,
  isJurisdictionKey,
  normalizeJurisdiction,
  normalizeJurisdictionKey,
  refYear,
  resolveIssuingEntity,
  BLOCK_KINDS,
} from "../../domain/document/model";
import {
  BlankBlockBody,
  BlocksAlreadySeeded,
  DocumentBlockNotFound,
  FirmEntityNotFound,
  InvalidBlockKind,
  InvalidJurisdictionKey,
  InvalidSortOrder,
  LetterOnlyBlockKind,
  NoIssuingEntity,
  NotAFirmEntity,
  StandardBlockNotFound,
} from "../../domain/document/errors";
import type {
  BlockOwner,
  DocumentBlockEdit,
  DocumentBlockRepository,
  DocumentReferences,
  FirmEntity,
  FirmEntityPreferenceRecord,
  FirmEntityPreferenceRepository,
  NewDocumentBlock,
  StandardBlockEdit,
  StandardBlockRepository,
} from "./ports";

export interface Deps {
  readonly preferences: FirmEntityPreferenceRepository;
  readonly refs: DocumentReferences;
  readonly standardBlocks: StandardBlockRepository;
  readonly blocks: DocumentBlockRepository;
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
   * Whether a party is one of the firm's own companies — asked before any
   * document names it as the issuer, or before an invoice bills it (F-10-1).
   *
   * Asked HERE, of the module that owns the issuing-entity rule, because the
   * answer is that rule's list plus the firm itself: a company that issues
   * nothing for any country is not one a new document should be issued by.
   */
  async isFirmEntity(tenantId: string, partyId: string): Promise<boolean> {
    return this.deps.preferences.isFirmEntity(tenantId, partyId);
  }

  /**
   * Where the entity issuing a document is REGISTERED — G1.8's other half.
   *
   * The engagement module holds an issuing entity's id (it stored one at
   * drafting) and needs the country to compare a clause's governing law
   * against. It asks here rather than reading `core.legal_entity` itself,
   * because "which of our companies, and where is it" is one question and this
   * is the module that answers it.
   *
   * Three answers, and the caller must tell them apart: a jurisdiction, `null`
   * for an entity that exists but has no registration recorded, and a throw for
   * an id that is not this firm's party at all. The middle one is the state of
   * every firm's seeded default entity, so it is ordinary and cannot be treated
   * as an error here — what it means is decided by whoever asked.
   */
  async issuerJurisdiction(tenantId: string, firmEntityPartyId: string): Promise<FirmEntity> {
    const entity = await this.deps.preferences.findEntity(tenantId, firmEntityPartyId);
    if (entity === null) throw new FirmEntityNotFound(firmEntityPartyId);
    return entity;
  }

  // ── The prose blocks (G1.7) ──────────────────────────────────────────────

  /** The firm's standard set, retired lines included — the screen that
   *  maintains it has to show what it stopped printing. With a company named
   *  (T6.18), that company's own lines only: the screen's tab for it. */
  async listStandardBlocks(
    tenantId: string,
    issuingEntityPartyId?: string,
  ): Promise<readonly StandardBlock[]> {
    const rows = await this.deps.standardBlocks.list(tenantId);
    if (issuingEntityPartyId === undefined) return rows;
    return rows.filter((b) => b.issuingEntityPartyId === issuingEntityPartyId);
  }

  async addStandardBlock(
    input: {
      readonly tenantId: string;
      readonly kind: string;
      readonly body: string;
      readonly isHeading?: boolean | undefined;
      readonly sortOrder: number;
      readonly jurisdiction?: string | null | undefined;
      /** One of the firm's companies (T6.18); absent or null is the default set. */
      readonly issuingEntityPartyId?: string | null | undefined;
    },
    actor: Actor,
  ): Promise<StandardBlock> {
    const kind = this.blockKindOrThrow(input.kind);
    const body = this.bodyOrThrow(input.body);
    this.sortOrderOrThrow(input.sortOrder);
    const jurisdiction = this.blockJurisdictionOrThrow(input.jurisdiction ?? null);
    const issuingEntityPartyId = await this.blockIssuerOrThrow(
      input.tenantId,
      input.issuingEntityPartyId ?? null,
    );

    const saved = await this.deps.standardBlocks.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      kind,
      body,
      isHeading: input.isHeading ?? false,
      sortOrder: input.sortOrder,
      jurisdiction,
      issuingEntityPartyId,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "standard_document_block.set",
      objectId: saved.id,
      actor,
      // Ids and machine facts. The BODY is deliberately absent: it is prose a
      // person wrote, this log cannot be erased, and the row keeps it where it
      // can be. What the log is for here is that the standard set CHANGED, when,
      // and by whom — the same reasoning `firm_entity_preference.set` gives for
      // omitting its note.
      payload: {
        kind: saved.kind,
        sortOrder: saved.sortOrder,
        jurisdiction: saved.jurisdiction,
        issuingEntityPartyId: saved.issuingEntityPartyId,
        isHeading: saved.isHeading,
        isActive: saved.isActive,
      },
    });
    return saved;
  }

  /**
   * Edit or retire one standard line.
   *
   * Retiring is `isActive: false` and never a delete — the same distinction
   * `staff_grade` draws. A line the firm has moved on from stays readable
   * because documents issued while it was in force copied it, and "where did
   * this line come from" has to resolve years later.
   */
  async editStandardBlock(
    tenantId: string,
    id: string,
    edit: StandardBlockEdit,
    actor: Actor,
  ): Promise<StandardBlock> {
    const existing = await this.deps.standardBlocks.find(tenantId, id);
    if (existing === null) throw new StandardBlockNotFound(id);

    const patch: StandardBlockEdit = {
      ...(edit.body === undefined ? {} : { body: this.bodyOrThrow(edit.body) }),
      ...(edit.isHeading === undefined ? {} : { isHeading: edit.isHeading }),
      ...(edit.sortOrder === undefined
        ? {}
        : { sortOrder: this.sortOrderOrThrow(edit.sortOrder) }),
      ...(edit.jurisdiction === undefined
        ? {}
        : { jurisdiction: this.blockJurisdictionOrThrow(edit.jurisdiction) }),
      ...(edit.issuingEntityPartyId === undefined
        ? {}
        : { issuingEntityPartyId: await this.blockIssuerOrThrow(tenantId, edit.issuingEntityPartyId) }),
      ...(edit.isActive === undefined ? {} : { isActive: edit.isActive }),
    };

    const saved = await this.deps.standardBlocks.edit(tenantId, id, patch);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "standard_document_block.set",
      objectId: saved.id,
      actor,
      payload: {
        kind: saved.kind,
        sortOrder: saved.sortOrder,
        jurisdiction: saved.jurisdiction,
        issuingEntityPartyId: saved.issuingEntityPartyId,
        isHeading: saved.isHeading,
        isActive: saved.isActive,
      },
    });
    return saved;
  }

  /**
   * A standard line's company (T6.18): one of the FIRM's own, or null for the
   * default set. A client named here would put the firm's terms under a
   * client's name, which is the mistake F-10-1 closed for issuers.
   */
  private async blockIssuerOrThrow(tenantId: string, partyId: string | null): Promise<string | null> {
    if (partyId === null) return null;
    if (await this.deps.preferences.isFirmEntity(tenantId, partyId)) return partyId;
    const party = await this.deps.preferences.findEntity(tenantId, partyId);
    throw party === null ? new FirmEntityNotFound(partyId) : new NotAFirmEntity(party.displayName);
  }

  /**
   * COPY the firm's standard set onto a new document — G1.7's acceptance.
   *
   * A copy, not a reference: editing the standard exclusions changes the NEXT
   * document and never one already issued. The filtering rule is the domain's
   * `blocksFor` — retired lines are not copied, and a line scoped to another
   * country is not copied while an unscoped one always is, which is what keeps
   * "All fees are exclusive of GST as applicable" off a UAE proposal.
   *
   * Refuses a second call rather than repeating or ignoring it: repeating would
   * print the firm's exclusions twice, and ignoring would make this method mean
   * two different things depending on what happened before.
   */
  async seedBlocks(
    tenantId: string,
    owner: BlockOwner,
    jurisdiction: string,
    /** The document's issuing company (T6.18): its own lines, per kind, where
     *  it has any. Null reads the default set alone. */
    issuingEntityPartyId: string | null = null,
  ): Promise<readonly DocumentBlock[]> {
    const existing = await this.deps.blocks.list(tenantId, owner);
    if (existing.length > 0) throw new BlocksAlreadySeeded(owner.id, existing.length);

    const rows = await this.standardProse(tenantId, owner, jurisdiction, issuingEntityPartyId);
    if (rows.length === 0) return [];
    return this.deps.blocks.addMany(rows);
  }

  /**
   * The firm's standard set as it would land on this document — chosen by
   * `blocksFor`, renumbered, given ids — WITHOUT writing it.
   *
   * The seam T6.18 needed: changing a draft's issuer replaces its prose, and
   * the proposal's own adapter writes that in the same transaction as the new
   * issuer (D9), so the rows are composed here, where the rule lives, and
   * written there.
   */
  async standardProse(
    tenantId: string,
    owner: BlockOwner,
    jurisdiction: string,
    issuingEntityPartyId: string | null = null,
  ): Promise<readonly NewDocumentBlock[]> {
    const standard = await this.deps.standardBlocks.list(tenantId);
    const chosen = blocksFor(
      standard,
      normalizeJurisdiction(jurisdiction),
      owner.kind,
      issuingEntityPartyId,
    );

    // Renumbered from 1 WITHIN EACH KIND rather than carrying the standard set's
    // own numbers across. The standard list is not contiguous — a firm inserts
    // between two lines and retires others — and a document that prints
    // exclusions 1, 4, 5 has a reader wondering what 2 and 3 said.
    const next = new Map<BlockKind, number>();
    return chosen.map((b): NewDocumentBlock => {
      const order = (next.get(b.kind) ?? 0) + 1;
      next.set(b.kind, order);
      return {
        id: this.deps.ids.newId(),
        tenantId,
        owner,
        kind: b.kind,
        body: b.body,
        isHeading: b.isHeading,
        sortOrder: order,
        sourceId: b.id,
      };
    });
  }

  listBlocks(tenantId: string, owner: BlockOwner): Promise<readonly DocumentBlock[]> {
    return this.deps.blocks.list(tenantId, owner);
  }

  /** A line written by hand on one document — a term this client negotiated
   *  that is not in the firm's standard set. `sourceId` is null, which is what
   *  lets a screen mark it as this document's own. */
  async addBlock(input: {
    readonly tenantId: string;
    readonly owner: BlockOwner;
    readonly kind: string;
    readonly body: string;
    readonly isHeading?: boolean | undefined;
    readonly sortOrder: number;
  }): Promise<DocumentBlock> {
    const kind = this.blockKindOrThrow(input.kind);
    // A proposal has no cover letter and no acceptance (0083). Refused by name
    // here; `document_block_letter_only_kinds_chk` refuses the row regardless.
    if (!blockKindsFor(input.owner.kind).includes(kind)) throw new LetterOnlyBlockKind(kind);
    const body = this.bodyOrThrow(input.body);
    this.sortOrderOrThrow(input.sortOrder);
    return this.deps.blocks.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      owner: input.owner,
      kind,
      body,
      isHeading: input.isHeading ?? false,
      sortOrder: input.sortOrder,
      sourceId: null,
    });
  }

  async editBlock(tenantId: string, id: string, edit: DocumentBlockEdit): Promise<DocumentBlock> {
    const existing = await this.deps.blocks.find(tenantId, id);
    if (existing === null) throw new DocumentBlockNotFound(id);
    return this.deps.blocks.edit(tenantId, id, {
      ...(edit.body === undefined ? {} : { body: this.bodyOrThrow(edit.body) }),
      ...(edit.isHeading === undefined ? {} : { isHeading: edit.isHeading }),
      ...(edit.sortOrder === undefined
        ? {}
        : { sortOrder: this.sortOrderOrThrow(edit.sortOrder) }),
    });
  }

  /** Strike a line off a document. `removed_at`, because `bib_app` holds no
   *  DELETE grant on any table in this database. */
  async removeBlock(tenantId: string, id: string): Promise<void> {
    const existing = await this.deps.blocks.find(tenantId, id);
    if (existing === null) throw new DocumentBlockNotFound(id);
    await this.deps.blocks.remove(tenantId, id);
  }

  private blockKindOrThrow(raw: string): BlockKind {
    if (!isBlockKind(raw)) throw new InvalidBlockKind(raw, BLOCK_KINDS);
    return raw;
  }

  /** Trimmed at the boundary, then refused if nothing is left. The database
   *  CHECKs `btrim(body) <> ''` too; both are wanted, because a whitespace-only
   *  line satisfies any NOT NULL and prints as a gap a reader takes for a term
   *  somebody forgot to write. */
  private bodyOrThrow(raw: string): string {
    const body = raw.trim();
    if (body === "") throw new BlankBlockBody();
    return body;
  }

  private sortOrderOrThrow(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new InvalidSortOrder(n);
    return n;
  }

  /** NULL means "print everywhere" and is the ordinary case. A code is demanded
   *  in canonical upper case for the reason G1.8 gives — the value is COMPARED,
   *  and "in" is what a comparison would get. */
  private blockJurisdictionOrThrow(raw: string | null): string | null {
    if (raw === null) return null;
    const j = normalizeJurisdiction(raw);
    if (!isJurisdiction(j) || j !== raw) throw new InvalidJurisdictionKey(raw);
    return j;
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
