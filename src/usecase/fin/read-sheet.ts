// The sheet reader (docs/FIN_BUILD_PLAN.md F2.6, the CSV half of F2.9, the
// sheet side of F2.11, F2.12's POS files): a `DocumentReader` for the `sheet`
// route.
//
// ── A KNOWN LAYOUT FIRST ─────────────────────────────────────────────────────
//
// "The second file of a known layout needs no mapping." Before working anything
// out, the reader fingerprints every row near the top of the sheet that could
// be a header and asks the firm's stored layouts (`fin.source_format`) for any
// of them. A layout a person confirmed wins over one fin learnt, and the newest
// confirmation over an older one. A file of a known layout is read with the
// stored map exactly, days and money style included, so a statement whose days
// were ambiguous on their own (03/04/2025) reads the way a person said.
//
// ── OTHERWISE, WORK IT OUT, AND LEARN IT ONLY WHEN THE FIGURES AGREE ────────
//
// `recogniseSheet` finds the header and maps the columns, or says why it cannot
// without guessing; that file goes to a person (`unrecognised_layout`). A
// layout it mapped is stored as LEARNT (unconfirmed) only when the file's own
// figures agree with the lines (`checkControl`): a map that reads a statement's
// running balance continuously is very unlikely to be the wrong map, and one
// that does not is not kept to read the next file with.
//
// ── MASTERS ──────────────────────────────────────────────────────────────────
//
// A chart of accounts, a vendor, customer or employee master, a GST code list
// or an opening trial balance is RECOGNISED as `master` and read into no lines:
// importing a firm's masters is F3.1's, through its own screen. The read is
// `staged` with nothing in it, not `needs_person`: nothing went wrong, no
// problem code would be true, and F3.1 finds them by `doc_kind = 'master'`.
import type { IdGen } from "../../platform/ids";
import { checkControl } from "../../domain/fin/control";
import type { ReadDraft } from "../../domain/fin/lines";
import { headerCandidates, layoutKey, readSheet, recogniseSheet } from "../../domain/fin/sheet";
import type { Grid, SheetContainer, SheetLayout } from "../../domain/fin/sheet";
import type { ContentDigest } from "../filestore/ports";
import type { DocumentReader, ReadInput, ReadOutcome } from "./reading";
import type { FirmCurrency, SheetGridReader, SourceFormat, SourceFormatStore } from "./read-ports";

export interface SheetReaderDeps {
  readonly grids: SheetGridReader;
  readonly formats: SourceFormatStore;
  readonly currency: FirmCurrency;
  /** sha256 of a layout's words, for its fingerprint. */
  readonly digest: ContentDigest;
  readonly ids: IdGen;
}

/** A layout's fingerprint: sha256 of its words (`layoutKey`). */
export function fingerprintOf(digest: ContentDigest, key: string): string {
  return digest.ofBytes(new TextEncoder().encode(key));
}

function layoutOf(format: SourceFormat, headerRow: number): SheetLayout {
  return {
    docKind: format.docKind,
    headerRow,
    header: format.header,
    columns: format.columns,
    dateFormat: format.dateFormat,
    amountStyle: format.amountStyle,
  };
}

/** The draft of a file that is a master: recognised, and no lines. */
function masterDraft(): ReadDraft {
  return {
    docKind: "master",
    reader: "sheet",
    lines: [],
    control: null,
    confidence: null,
    model: null,
    promptVersion: null,
    formatId: null,
  };
}

export class SheetDocumentReader implements DocumentReader {
  readonly name = "sheet" as const;

  constructor(private readonly deps: SheetReaderDeps) {}

  async read(input: ReadInput): Promise<ReadOutcome> {
    if (input.route !== "sheet") return { kind: "not_mine" };
    const sheet = this.deps.grids.grid(input.bytes, input.filename);
    if (!sheet.ok) return { kind: "needs_person", reader: "sheet", problem: "unreadable" };

    const candidates = headerCandidates(sheet.grid, sheet.container).map((c) => ({
      ...c,
      fingerprint: fingerprintOf(this.deps.digest, c.key),
    }));
    const known = await this.deps.formats.current(
      input.tenantId,
      [...new Set(candidates.map((c) => c.fingerprint))],
    );
    for (const c of candidates) {
      const format = known.find((k) => k.fingerprint === c.fingerprint);
      if (format !== undefined) return this.readWith(input, sheet.grid, layoutOf(format, c.row), format.id);
    }

    const recognised = recogniseSheet(sheet.grid);
    if (recognised.kind === "unrecognised") {
      return { kind: "needs_person", reader: "sheet", problem: "unrecognised_layout" };
    }
    if (recognised.kind === "master") return { kind: "read", draft: masterDraft() };

    const outcome = await this.readWith(input, sheet.grid, recognised.layout, null);
    if (outcome.kind !== "read" || !checkControl(outcome.draft).ok) return outcome;
    const formatId = await this.learn(input, sheet.container, recognised.layout);
    return { kind: "read", draft: { ...outcome.draft, formatId } };
  }

  private async readWith(
    input: ReadInput,
    grid: Grid,
    layout: SheetLayout,
    formatId: string | null,
  ): Promise<ReadOutcome> {
    const statement = layout.docKind === "bank_statement" || layout.docKind === "card_statement";
    const read = readSheet(grid, layout, {
      documentVersionId: input.documentVersionId,
      filename: input.filename,
      // Asked only for a statement: no other kind of line carries a currency
      // the file does not print.
      defaultCurrency: statement ? await this.deps.currency.reportingCurrency(input.tenantId) : "",
    });
    if (!read.ok) return { kind: "needs_person", reader: "sheet", problem: "unrecognised_layout" };
    return {
      kind: "read",
      draft: {
        docKind: layout.docKind,
        reader: "sheet",
        lines: read.lines,
        control: read.control,
        confidence: null,
        model: null,
        promptVersion: null,
        formatId,
      },
    };
  }

  private learn(input: ReadInput, container: SheetContainer, layout: SheetLayout): Promise<string> {
    const header = [...layout.header];
    return this.deps.formats.learn({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fingerprint: fingerprintOf(this.deps.digest, layoutKey(header, container)),
      container,
      header,
      headerRow: layout.headerRow + 1,
      docKind: layout.docKind,
      columns: layout.columns,
      dateFormat: layout.dateFormat,
      amountStyle: layout.amountStyle,
      learntFromIntakeItemId: input.intakeItemId,
      basedOnFormatId: null,
      confirmedByUserId: null,
    });
  }
}
