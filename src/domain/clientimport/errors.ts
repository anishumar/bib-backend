// Sentinel errors — the closed vocabulary of ways a client import fails as an
// ACT. A row that is wrong is not an error here: it is a finding in the report,
// and the report is the whole point of staging. These are the refusals of the
// operation itself — an unreadable file, a sheet with no header row, confirming
// what was never staged or was confirmed already.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`.

export class ClientImportError extends Error {
  constructor(
    readonly code: ClientImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ClientImportErrorCode =
  | "SHEET_UNREADABLE"
  | "SHEET_HEADER_MISSING"
  | "SHEET_EMPTY"
  | "CLIENT_SHEET_REQUIRED"
  | "CLIENT_IMPORT_NOT_FOUND"
  | "CLIENT_IMPORT_ALREADY_CONFIRMED"
  | "CLIENT_IMPORT_BLOCKED";

/** The bytes are not a spreadsheet this reads — not `.csv`, not `.xlsx`, or a
 *  workbook with no worksheet in it. */
export class SheetUnreadable extends ClientImportError {
  constructor(filename: string, why: string) {
    super(
      "SHEET_UNREADABLE",
      `"${filename}" is not a spreadsheet this reads: ${why}. Upload a .csv or a .xlsx.`,
    );
  }
}

/** No row of the sheet carries the column that marks its header. */
export class SheetHeaderMissing extends ClientImportError {
  constructor(filename: string, marker: string) {
    super(
      "SHEET_HEADER_MISSING",
      `"${filename}" has no header row: no row carries a column called "${marker}". Is this the right sheet?`,
    );
  }
}

/** A header row and nothing under it. */
export class SheetEmpty extends ClientImportError {
  constructor(filename: string) {
    super("SHEET_EMPTY", `"${filename}" has a header row and no rows under it`);
  }
}

/** The people and engagement sheets are optional; the client sheet is the import. */
export class ClientSheetRequired extends ClientImportError {
  constructor() {
    super("CLIENT_SHEET_REQUIRED", 'The "clients" file is required: it is the sheet the other two refer to');
  }
}

export class ClientImportNotFound extends ClientImportError {
  constructor(importId: string) {
    super("CLIENT_IMPORT_NOT_FOUND", `No client import ${importId} at this firm`);
  }
}

export class ClientImportAlreadyConfirmed extends ClientImportError {
  constructor(importId: string, confirmedAt: string) {
    super(
      "CLIENT_IMPORT_ALREADY_CONFIRMED",
      `Client import ${importId} was confirmed at ${confirmedAt}: upload the sheet again to load anything more`,
    );
  }
}

/** Confirm was asked while the report still carries a blocking finding — or
 *  the re-check at confirm time found one the staged report did not. */
export class ClientImportBlocked extends ClientImportError {
  constructor(blocking: number, staleSinceStaging: boolean) {
    super(
      "CLIENT_IMPORT_BLOCKED",
      staleSinceStaging
        ? `The firm's records changed since this sheet was checked and ${String(blocking)} row${blocking === 1 ? "" : "s"} would now be refused: upload it again to see the current report`
        : `${String(blocking)} blocking finding${blocking === 1 ? "" : "s"} remain${blocking === 1 ? "s" : ""}: fix the sheet and upload it again`,
    );
  }
}
