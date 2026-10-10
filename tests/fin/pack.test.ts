// The training-pack walk (docs/FIN_BUILD_PLAN.md F0.10): the answer key never
// enters the pipeline, and the rest of the pack does.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnswerKeyRefused, mediaTypeFor, packFiles } from "../../src/cmd/fin-pack";

function pack(): string {
  const root = mkdtempSync(join(tmpdir(), "fin-pack-"));
  const put = (rel: string): void => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  };
  put("Company_A_Lumen_Cloudworks/00_Reference/company_profile.json");
  put("Company_A_Lumen_Cloudworks/01_Purchase_Invoices/INV2500233.pdf");
  put("Company_A_Lumen_Cloudworks/03_Bank_Statements/Operating_Account_0967/Merlion_Bank_Statement_202501.pdf");
  put("Company_A_Lumen_Cloudworks/99_Ground_Truth/documents_manifest.csv");
  put("Company_A_Lumen_Cloudworks/.DS_Store");
  put("Company_E_Sprout_Labs/06_Expense_Receipts/IMG_20250609_101465.jpg");
  put("Company_E_Sprout_Labs/99_Ground_Truth/seeded_exceptions.csv");
  put("seeded_exceptions_all_companies.csv");
  put("README.md");
  return root;
}

describe("walking the training pack", () => {
  it("never yields a file from the answer key", () => {
    const files = packFiles(pack());
    expect(files.some((f) => f.relPath.includes("99_"))).toBe(false);
    expect(files.map((f) => `${f.company} ${f.relPath}`)).toEqual([
      "A 00_Reference/company_profile.json",
      "A 01_Purchase_Invoices/INV2500233.pdf",
      "A 03_Bank_Statements/Operating_Account_0967/Merlion_Bank_Statement_202501.pdf",
      "E 06_Expense_Receipts/IMG_20250609_101465.jpg",
    ]);
  });

  it("leaves out the pack's own top-level files, which belong to no company", () => {
    const files = packFiles(pack());
    expect(files.some((f) => f.relPath.endsWith("README.md"))).toBe(false);
    expect(files.some((f) => f.relPath.includes("seeded_exceptions"))).toBe(false);
  });

  it("refuses a root pointed inside the answer key", () => {
    const root = pack();
    expect(() => packFiles(join(root, "Company_A_Lumen_Cloudworks", "99_Ground_Truth"))).toThrow(AnswerKeyRefused);
  });

  it("can be narrowed to some companies", () => {
    expect(packFiles(pack(), ["E"]).map((f) => f.company)).toEqual(["E"]);
  });

  it("declares a media type the way a browser would, by extension", () => {
    expect(mediaTypeFor("x/Statement October 2025.csv")).toBe("text/csv");
    expect(mediaTypeFor("WhatsApp Image 2025-10-07 at 14.41.43.JPEG")).toBe("image/jpeg");
    expect(mediaTypeFor("Payroll_Aug2025.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mediaTypeFor("mystery")).toBe("application/octet-stream");
  });
});
