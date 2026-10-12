// The seams of the read sweep and the read screens (docs/FIN_BUILD_PLAN.md F2.5,
// F2.6, the wave 3 contract's "Reading flow"). Adapters live in
// `infrastructure/fin/`; no vendor type crosses these interfaces.
//
// The readers' own seam (`DocumentReader`) is the contract's, in `reading.ts`.
import type { DocKind, LineDraft, ReadProblem, Reader } from "../../domain/fin/lines";
import type { IntakeRoute } from "../../domain/fin/intake";
import type { LineStatus, ReadStatus, StoredControl } from "../../domain/fin/read";
import type { AmountStyle, Grid, SheetContainer } from "../../domain/fin/sheet";
import type { ColumnMap, SheetDocKind } from "../../domain/fin/sheet-kinds";
import type { DateFormat } from "../../domain/fin/sheet-values";

// ── The sweep's side ─────────────────────────────────────────────────────────

/** An intake item with no read yet, and what a reader needs besides its
 *  bytes. */
export interface UnreadItem {
  readonly intakeItemId: string;
  readonly documentVersionId: string;
  readonly clientPartyId: string | null;
  readonly route: IntakeRoute;
  readonly mediaType: string;
  readonly filename: string;
}

/** A read to write, with everything the row says. */
export interface NewRead {
  readonly id: string;
  readonly tenantId: string;
  readonly intakeItemId: string;
  readonly documentVersionId: string;
  readonly clientPartyId: string | null;
  readonly reader: Reader | null;
  readonly docKind: DocKind;
  readonly status: ReadStatus;
  readonly problem: ReadProblem | null;
  readonly formatId: string | null;
  readonly control: StoredControl | null;
  readonly controlOk: boolean | null;
  readonly confidence: number | null;
  readonly model: string | null;
  readonly promptVersion: string | null;
}

/** One line to write: its id, its place in the read, and the draft exactly as
 *  the reader produced it. */
export interface NewLine {
  readonly id: string;
  /** 1-based. */
  readonly position: number;
  readonly draft: LineDraft;
}

export interface ReadStore {
  /**
   * Intake items of these routes with no read, oldest first, after the item
   * `after` (null for the oldest), at most `limit`. The cursor lets one run
   * walk past items it leaves unread (`later`) instead of meeting them again
   * at the head of every page.
   */
  unread(
    tenantId: string,
    routes: readonly IntakeRoute[],
    after: string | null,
    limit: number,
  ): Promise<readonly UnreadItem[]>;
  /**
   * The read and its lines, in ONE transaction. True when the read was
   * created; false when another run read this item first (the read's unique
   * key), in which case nothing is written. Never throws for that case.
   */
  insert(read: NewRead, lines: readonly NewLine[]): Promise<boolean>;
}

/** A stored version's bytes, read under the firm's own scope. Null when the
 *  version is not this firm's or its bytes are missing from the store. */
export interface VersionBytes {
  fetch(tenantId: string, documentVersionId: string): Promise<Uint8Array | null>;
}

// ── The sheet reader's side ──────────────────────────────────────────────────

export type SheetGrid =
  | { readonly ok: true; readonly grid: Grid; readonly container: SheetContainer }
  /** Not a sheet this product reads: an `.xls` from Excel 2003, a damaged
   *  workbook, one past the size bounds. */
  | { readonly ok: false; readonly why: string };

/** A spreadsheet's cells as text. Wraps the core reader; never throws for a
 *  file it cannot read. */
export interface SheetGridReader {
  grid(bytes: Uint8Array, filename: string): SheetGrid;
}

/** The currency a statement that prints none is in. */
export interface FirmCurrency {
  reportingCurrency(tenantId: string): Promise<string>;
}

/** A sheet layout the firm has seen (`fin.source_format`). */
export interface SourceFormat {
  readonly id: string;
  readonly fingerprint: string;
  readonly container: SheetContainer;
  readonly header: readonly string[];
  /** 1-based, in the file it was first seen in. */
  readonly headerRow: number;
  readonly docKind: SheetDocKind;
  readonly columns: ColumnMap;
  readonly dateFormat: DateFormat | null;
  readonly amountStyle: AmountStyle;
  readonly learntFromIntakeItemId: string | null;
  readonly basedOnFormatId: string | null;
  /** Null when fin learnt it and no person has confirmed it. */
  readonly confirmedByUserId: string | null;
  /** ISO 8601 instant; null with `confirmedByUserId`. */
  readonly confirmedAt: string | null;
}

export interface NewSourceFormat {
  readonly id: string;
  readonly tenantId: string;
  readonly fingerprint: string;
  readonly container: SheetContainer;
  readonly header: readonly string[];
  readonly headerRow: number;
  readonly docKind: SheetDocKind;
  readonly columns: ColumnMap;
  readonly dateFormat: DateFormat | null;
  readonly amountStyle: AmountStyle;
  readonly learntFromIntakeItemId: string | null;
  readonly basedOnFormatId: string | null;
  readonly confirmedByUserId: string | null;
}

export interface SourceFormatStore {
  /** The layout each of these fingerprints is read with: the newest a person
   *  confirmed, else the one fin learnt. At most one per fingerprint. */
  current(tenantId: string, fingerprints: readonly string[]): Promise<readonly SourceFormat[]>;
  /** Stores a layout fin learnt, unconfirmed. Answers the id it is stored
   *  under: another run's, when that run learnt the same fingerprint first. */
  learn(format: NewSourceFormat): Promise<string>;
  /** Stores a person's layout (confirmed). Always a new row. */
  confirm(format: NewSourceFormat): Promise<string>;
  get(tenantId: string, formatId: string): Promise<SourceFormat | null>;
}

// ── The screens' side ────────────────────────────────────────────────────────

/** One read as the staff screen lists it: names, not just ids. */
export interface ReadView {
  readonly id: string;
  readonly intakeItemId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly title: string;
  readonly filename: string;
  readonly clientPartyId: string | null;
  readonly clientName: string | null;
  readonly reader: Reader | null;
  readonly docKind: DocKind;
  readonly status: ReadStatus;
  readonly problem: ReadProblem | null;
  readonly controlOk: boolean | null;
  readonly lineCount: number;
  readonly confidence: number | null;
  /** ISO 8601 instant. */
  readonly readAt: string;
}

export interface ReadFilter {
  readonly clientPartyId: string | null;
  readonly status: ReadStatus | null;
  readonly docKind: DocKind | null;
  /** The id of the last read on the previous page; null for the newest. */
  readonly before: string | null;
  readonly limit: number;
}

/** How many reads, by status and by kind, for one client or the firm. */
export interface ReadSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<ReadStatus, number>>;
  readonly byDocKind: Readonly<Record<DocKind, number>>;
}

/** A line as the read's screen shows it: its values as they stand, and what
 *  the reader proposed. The two are equal until a person corrects one (F2.8). */
export interface LineView {
  readonly id: string;
  readonly position: number;
  readonly status: LineStatus;
  readonly values: LineDraft;
  readonly proposed: LineDraft;
}

export interface ReadDetail extends ReadView {
  readonly control: StoredControl | null;
  readonly model: string | null;
  readonly promptVersion: string | null;
  /** The layout a sheet was read with, and whether a person has confirmed it. */
  readonly format: { readonly id: string; readonly docKind: SheetDocKind; readonly confirmed: boolean } | null;
  readonly lines: readonly LineView[];
}

export interface ReadQueries {
  list(tenantId: string, filter: ReadFilter): Promise<readonly ReadView[]>;
  summary(tenantId: string, clientPartyId: string | null): Promise<ReadSummary>;
  get(tenantId: string, readId: string): Promise<ReadDetail | null>;
}
