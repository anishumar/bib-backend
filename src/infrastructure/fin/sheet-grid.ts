// A spreadsheet's cells for the sheet reader (docs/FIN_BUILD_PLAN.md F2.6),
// through core's dependency-free reader (`infrastructure/sheet/grid-reader.ts`,
// the client import's), so fin reads a workbook exactly the way the product
// already does: dates from the cell's style, formulas as their saved values,
// the size bounds of F-9-2.
//
// The core reader picks CSV or workbook by the filename, and a client's file
// is named whatever the client named it ("Statement", "export.tsv"). So the
// bytes decide: a zip signature is a workbook (xlsx, xlsm), anything else is
// read as delimited text, whose delimiter the core reader sniffs (comma,
// semicolon or tab). An `.xls` from Excel 2003 is neither and is refused
// honestly, as the core reader refuses it.
import { SheetUnreadable } from "../../domain/clientimport/errors";
import type { SheetGrid, SheetGridReader } from "../../usecase/fin/read-ports";
import { NodeSheetReader } from "../sheet/grid-reader";

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** An OLE2 compound file: the `.xls` of Excel 97 to 2003. */
function isLegacyWorkbook(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

export class FinSheetGrid implements SheetGridReader {
  private readonly reader = new NodeSheetReader();

  grid(bytes: Uint8Array, filename: string): SheetGrid {
    if (isLegacyWorkbook(bytes)) {
      return { ok: false, why: `"${filename}" is an Excel 97-2003 workbook (.xls), which this reader does not open; saved as .xlsx or .csv it reads.` };
    }
    const zip = isZip(bytes);
    try {
      return {
        ok: true,
        grid: this.reader.grid(bytes, zip ? "sheet.xlsx" : "sheet.csv"),
        container: zip ? "xlsx" : "csv",
      };
    } catch (err) {
      if (err instanceof SheetUnreadable) return { ok: false, why: err.message.replace('"sheet.xlsx"', `"${filename}"`) };
      throw err;
    }
  }
}
