// A person confirming how a sheet layout is read (docs/FIN_BUILD_PLAN.md F2.6):
// the map fin learnt, or one the person sets for a layout fin could not map, or
// a correction.
//
// No route reaches this yet. Its permission is `books:write`, which arrives
// with staging (F2.8); a route a role cannot be given is a door with no key,
// so the route lands with the permission. The service is here so the rule is
// decided, tested and ready.
//
// ── A CONFIRMATION IS A NEW ROW, NEVER AN EDIT ───────────────────────────────
//
// `fin.source_format` is append-only by grant. Confirming the learnt map
// stores a confirmed copy of it (`based_on_format_id` names the learnt row);
// setting or correcting a map stores the person's. The reader reads with the
// NEWEST confirmed row for a fingerprint, so the machine's map and every
// person's stay readable, and each read names the row it was read with. Saving
// the map already in force changes nothing and records nothing.
//
// Confirming helps the NEXT file of the layout. A file that already went to a
// person as `unrecognised_layout` stays read as it was: a read is never read
// again by itself (re-reading one is a staging act, F2.8).
import type { IdGen } from "../../platform/ids";
import { FinFormatInvalid, FinFormatNotFound, FinNotEnabled } from "../../domain/fin/errors";
import { layoutKey, layoutProblem } from "../../domain/fin/sheet";
import type { AmountStyle, SheetContainer } from "../../domain/fin/sheet";
import { headerCells } from "../../domain/fin/sheet";
import type { SheetDocKind } from "../../domain/fin/sheet-kinds";
import type { DateFormat } from "../../domain/fin/sheet-values";
import type { ContentDigest } from "../filestore/ports";
import type { EventSink } from "../ledger/ports";
import type { FinFirms } from "./ports";
import type { NewSourceFormat, SourceFormat, SourceFormatStore } from "./read-ports";
import { fingerprintOf } from "./read-sheet";

export interface FormatDeps {
  readonly firms: FinFirms;
  readonly formats: SourceFormatStore;
  readonly digest: ContentDigest;
  readonly ids: IdGen;
  readonly events: EventSink;
}

/** A layout as a person states it. Checked here, not trusted: it arrives from
 *  a screen. */
export interface FormatInput {
  readonly container: string;
  /** The header row's cells as the file prints them. */
  readonly header: readonly string[];
  /** 1-based, in the file the person was looking at. */
  readonly headerRow: number;
  readonly docKind: string;
  /** Field name → 0-based column. */
  readonly columns: Readonly<Record<string, number>>;
  readonly dateFormat: string | null;
  readonly amountStyle: string;
}

export interface FormatSaved {
  readonly formatId: string;
  /** False when the map was already the one in force: nothing was written. */
  readonly created: boolean;
}

type FormatShape = Pick<SourceFormat, "docKind" | "columns" | "dateFormat" | "amountStyle">;

function sameMap(a: FormatShape, b: FormatShape): boolean {
  const keys = new Set([...Object.keys(a.columns), ...Object.keys(b.columns)]);
  return (
    a.docKind === b.docKind &&
    a.dateFormat === b.dateFormat &&
    a.amountStyle === b.amountStyle &&
    [...keys].every((k) => a.columns[k] === b.columns[k])
  );
}

export class FinFormatService {
  constructor(private readonly deps: FormatDeps) {}

  private async requireEnabled(tenantId: string): Promise<void> {
    if ((await this.deps.firms.enabledSince(tenantId)) === null) throw new FinNotEnabled();
  }

  /** A person says the map fin learnt is right. */
  async confirmFormat(tenantId: string, formatId: string, userId: string): Promise<FormatSaved> {
    await this.requireEnabled(tenantId);
    const learnt = await this.deps.formats.get(tenantId, formatId);
    if (learnt === null) throw new FinFormatNotFound(formatId);
    if (learnt.confirmedAt !== null) return { formatId: learnt.id, created: false };
    return this.store(tenantId, userId, {
      ...learnt,
      learntFromIntakeItemId: learnt.learntFromIntakeItemId,
      basedOnFormatId: learnt.id,
    });
  }

  /** A person sets the map for a layout: one fin could not map, or a
   *  correction of one it did. */
  async saveFormat(tenantId: string, input: FormatInput, userId: string): Promise<FormatSaved> {
    await this.requireEnabled(tenantId);
    if (input.container !== "csv" && input.container !== "xlsx") {
      throw new FinFormatInvalid(`A sheet is a "csv" or an "xlsx", not "${input.container}".`);
    }
    if (!Number.isInteger(input.headerRow) || input.headerRow < 1) {
      throw new FinFormatInvalid("The header row is counted from 1, as the sheet numbers its rows.");
    }
    const header = headerCells(input.header);
    const problem = layoutProblem({ ...input, header });
    if (problem !== null) throw new FinFormatInvalid(problem);
    const container: SheetContainer = input.container;
    const fingerprint = fingerprintOf(this.deps.digest, layoutKey(header, container));
    const [current] = await this.deps.formats.current(tenantId, [fingerprint]);
    return this.store(tenantId, userId, {
      fingerprint,
      container,
      header,
      headerRow: input.headerRow,
      docKind: input.docKind as SheetDocKind,
      columns: { ...input.columns },
      dateFormat: input.dateFormat as DateFormat | null,
      amountStyle: input.amountStyle as AmountStyle,
      learntFromIntakeItemId: null,
      // A person correcting what fin learnt: the row names what it replaces.
      basedOnFormatId: current !== undefined && current.confirmedAt === null ? current.id : null,
    });
  }

  private async store(
    tenantId: string,
    userId: string,
    shape: Omit<NewSourceFormat, "id" | "tenantId" | "confirmedByUserId">,
  ): Promise<FormatSaved> {
    const [current] = await this.deps.formats.current(tenantId, [shape.fingerprint]);
    if (current !== undefined && current.confirmedAt !== null && sameMap(current, shape)) {
      return { formatId: current.id, created: false };
    }
    const formatId = await this.deps.formats.confirm({
      id: this.deps.ids.newId(),
      tenantId,
      fingerprint: shape.fingerprint,
      container: shape.container,
      header: shape.header,
      headerRow: shape.headerRow,
      docKind: shape.docKind,
      columns: shape.columns,
      dateFormat: shape.dateFormat,
      amountStyle: shape.amountStyle,
      learntFromIntakeItemId: shape.learntFromIntakeItemId,
      basedOnFormatId: shape.basedOnFormatId,
      confirmedByUserId: userId,
    });
    const basedOnFormatId = shape.basedOnFormatId;
    const docKind = shape.docKind;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "fin.format_confirmed",
      objectId: formatId,
      actor: { type: "human", id: userId },
      payload: { formatId, basedOnFormatId, docKind },
    });
    return { formatId, created: true };
  }
}
