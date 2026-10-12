// The lane-`rule` checks run on the training pack's ANSWER-KEY lines
// (docs/FIN_BUILD_PLAN.md F4.3, F4.5, S.5): "run on answer-key lines first".
//
// What this proves is the CHECKS, not the readers. Every document line comes
// from `99_Ground_Truth/documents_manifest.csv` and every payroll line from
// `payroll_truth.csv`, so the input is what a perfect reader would have read;
// the expected result is `seeded_exceptions.csv`. Bank exceptions (short
// payment, unmatched payment, unidentified receipt) need reconciliation (F3.5,
// F4.4) and are out of scope here.
//
// ── WHERE A LINE'S FIELDS COME FROM, AND WHAT IS NOT FED IN ─────────────────
//
// The manifest has no column for some of a line's fields, so the mapping fills
// them from what the PACK says about the document, and never from the answer:
//
//   counterparty  the issuer, or the recipient on the company's own documents
//   UEN           the vendor or customer master (00_Reference, an input)
//   GST number    the master's; null where the manifest records the document
//                 prints none (its `no_supplier_gst_reg` flag, a fact about
//                 the paper); a receipt from a supplier the master does not
//                 list prints one (every receipt in the pack does) that the
//                 answer key does not copy, so it is marked present
//   net           the subtotal as printed (customs: none)
//   printed rate, service period, credit-note reference
//                 not in the manifest, so null: the checks must do without
//   payroll age   whole years on the last day of the month before the month
//                 paid, from the date of birth (see checks-payroll.ts)
//
// Nothing else in the flags or the expected handling reaches a line, and the
// checks never read this file's expectations.
//
// ── THE PERIOD ──────────────────────────────────────────────────────────────
//
// The pack's exceptions are stated for the year ("received in the FY2025
// folder"), so each company is checked as ONE period, 1 January to 31
// December 2025, with every line in its folders. Run month by month, the one
// aggregate finding (`doc.gst_not_claimable`) would be raised once a month by
// design.
//
// Skipped when the pack is not on this machine.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ruleChecks } from "../../src/domain/fin/checks";
import type { CheckedDocumentLine, CheckedPayrollLine, ClientFacts } from "../../src/domain/fin/checks";
import type { FindingDraft } from "../../src/domain/fin/finding";
import type { PassType } from "../../src/domain/fin/lines";
import { RuleParameters } from "../../src/domain/fin/parameters";
import { fromCents, toCents } from "../../src/domain/fin/checks-money";
import { SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";

const PACK = [
  resolve("../fincompliace/SG_BiB_Training_Data_Pack"),
  resolve("../../fincompliace/SG_BiB_Training_Data_Pack"),
].find((p) => existsSync(p));

// ── A CSV reader for the pack's files: quoted fields, doubled quotes ─────────

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
  if (header === undefined) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const read = (path: string) => parseCsv(readFileSync(path, "utf8"));

// ── Mapping answer-key rows to lines ─────────────────────────────────────────

const DOC_TYPES: Readonly<Record<string, CheckedDocumentLine["docType"]>> = {
  purchase_invoice: "purchase_invoice",
  sales_invoice: "sales_invoice",
  receipt: "receipt",
  credit_note_out: "credit_note",
  credit_note_in: "credit_note",
  customs_payment: "customs_permit",
  pos_daily_sales: "pos_summary",
};

const PASSES: Readonly<Record<string, PassType>> = {
  SC: "citizen",
  PR: "pr",
  EP: "employment_pass",
  SP: "s_pass",
  WP: "work_permit",
};

/** The pack's own payroll error codes, and the check each is for. */
const PAYROLL_CHECK: Readonly<Record<string, string>> = {
  CPF_CEILING_IGNORED: "payroll.cpf_ow_ceiling",
  WRONG_AGE_BAND: "payroll.cpf_age_band",
  CPF_ON_WORK_PERMIT: "payroll.cpf_work_permit",
  CPF_ON_EP: "payroll.cpf_employment_pass",
  SDL_MISSING: "payroll.sdl_missing",
};

/** The pack's document exception types, and the check each is for. */
const DOCUMENT_CHECK: Readonly<Record<string, string>> = {
  duplicate_invoice: "doc.duplicate_invoice",
  gst_error: "doc.gst_rate",
  invalid_tax_invoice: "doc.invalid_tax_invoice",
  out_of_period: "doc.out_of_period",
  cutoff: "doc.cutoff",
  non_gst_registered: "doc.gst_not_claimable",
  credit_note: "doc.credit_note",
};

const BANK_TYPES = new Set(["short_payment", "unmatched_payment", "unidentified_receipt"]);

const amount = (v: string | undefined): string | null => (v === undefined || v.trim() === "" ? null : v.trim());

/** Completed years on the last day of the month before `month` (YYYY-MM). */
function ageFor(dob: string, month: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (m === null) return null;
  let year = Number(month.slice(0, 4));
  let mo = Number(month.slice(5, 7)) - 1;
  if (mo === 0) {
    mo = 12;
    year -= 1;
  }
  const lastDay = new Date(Date.UTC(year, mo, 0)).getUTCDate();
  const born = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  let age = year - born.y;
  if (mo < born.m || (mo === born.m && lastDay < born.d)) age -= 1;
  return age;
}

interface Company {
  readonly key: string;
  readonly client: ClientFacts;
  readonly documents: CheckedDocumentLine[];
  readonly payroll: CheckedPayrollLine[];
  /** The seeded payroll error's line, by the month the exception names. */
  readonly payrollErrorLine: Map<string, { lineId: string; check: string }>;
  readonly seeded: Record<string, string>[];
}

function loadCompany(dir: string): Company {
  const key = basename(dir).split("_")[1] ?? "?";
  const ref = join(dir, "00_Reference");
  const truth = join(dir, "99_Ground_Truth");
  const profile = JSON.parse(readFileSync(join(ref, "company_profile.json"), "utf8")) as {
    legal_name: string;
    gst_registered: boolean;
  };
  const client: ClientFacts = {
    clientPartyId: `client-${key}`,
    // The pack is registered throughout or not at all; its first day of GST
    // in Singapore stands for "throughout".
    gstRegisteredFrom: profile.gst_registered ? "1994-04-01" : null,
    fiscalYearStartMonth: 1,
  };
  const master = new Map<string, { uen: string; gst: string }>();
  for (const file of ["vendor_master.csv", "customer_master.csv"]) {
    for (const r of read(join(ref, file))) {
      master.set(r["Vendor"] ?? r["Customer"] ?? "", { uen: r["UEN"] ?? "", gst: r["GST_Reg_No"] ?? "" });
    }
  }

  const documents: CheckedDocumentLine[] = [];
  for (const r of read(join(truth, "documents_manifest.csv"))) {
    const docType = DOC_TYPES[r["doc_type"] ?? ""];
    if (docType === undefined) continue;
    const own = r["issuer"] === profile.legal_name;
    const counterparty = (own ? r["recipient"] : r["issuer"]) ?? "";
    const known = master.get(counterparty);
    const gst = amount(r["gst"]);
    const flags = (r["flags"] ?? "").split(";");
    const gstNo = flags.includes("no_supplier_gst_reg")
      ? null
      : known !== undefined && known.gst !== ""
        ? known.gst
        : !own && gst !== null && Number(gst) !== 0 && docType !== "customs_permit"
          ? "printed, not in the answer key"
          : null;
    documents.push({
      id: r["doc_id"] ?? "",
      clientPartyId: client.clientPartyId,
      kind: "document",
      docType,
      counterpartyName: counterparty === "" ? null : counterparty,
      counterpartyUen: known !== undefined && known.uen !== "" ? known.uen : null,
      counterpartyGstNo: gstNo,
      docNumber: amount(r["doc_number"]),
      docDate: amount(r["doc_date"]),
      currency: amount(r["currency"]),
      fxRate: amount(r["fx_rate"]),
      net: amount(r["subtotal"]),
      gstRate: null,
      gst,
      total: amount(r["total"]),
      servicePeriodFrom: null,
      servicePeriodTo: null,
      creditNoteRef: null,
      provenance: { documentVersionId: r["doc_id"] ?? "", page: null, row: null },
      uncertain: [],
    });
  }

  const payroll: CheckedPayrollLine[] = [];
  const payrollErrorLine = new Map<string, { lineId: string; check: string }>();
  for (const r of read(join(truth, "payroll_truth.csv"))) {
    const month = r["month"] ?? "";
    const id = `${month}:${r["emp_id"] ?? ""}`;
    // The sheet's three ordinary parts added, exactly, in cents.
    const ordinary = ["basic", "allowance", "overtime"].reduce((sum, k) => sum + (toCents(amount(r[k]) ?? "0") ?? 0n), 0n);
    payroll.push({
      id,
      clientPartyId: client.clientPartyId,
      kind: "payroll",
      period: month,
      employeeRef: r["emp_id"] ?? "",
      employeeName: null,
      passType: PASSES[r["status"] ?? ""] ?? null,
      age: ageFor(r["dob"] ?? "", month),
      ordinaryWage: fromCents(ordinary),
      additionalWage: amount(r["bonus"]),
      grossPay: amount(r["gross"]),
      cpfEmployee: amount(r["employee_cpf"]),
      cpfEmployer: amount(r["employer_cpf"]),
      sdl: amount(r["sdl"]),
      fwl: amount(r["foreign_worker_levy"]),
      netPay: amount(r["net_pay"]),
      provenance: { documentVersionId: `payroll-${month}`, page: null, row: null },
      uncertain: [],
    });
    const seededError = r["seeded_error"] ?? "";
    const check = PAYROLL_CHECK[seededError];
    if (seededError !== "" && check !== undefined) payrollErrorLine.set(`PR-${month}`, { lineId: id, check });
  }

  return { key, client, documents, payroll, payrollErrorLine, seeded: read(join(truth, "seeded_exceptions.csv")) };
}

// ── The run and its scorecard ────────────────────────────────────────────────

interface Score {
  readonly company: string;
  readonly caught: { excId: string; check: string }[];
  readonly missed: { excId: string; type: string; why: string }[];
  readonly extras: FindingDraft[];
  readonly outOfScope: number;
}

function score(company: Company): Score {
  const parameters = RuleParameters.from("SG", SINGAPORE_PARAMETERS);
  const findings = ruleChecks({
    client: company.client,
    period: { start: "2025-01-01", end: "2025-12-31" },
    documents: company.documents,
    payroll: company.payroll,
    parameters,
  });
  const used = new Set<FindingDraft>();
  const caught: Score["caught"] = [];
  const missed: Score["missed"] = [];
  let outOfScope = 0;
  for (const exc of company.seeded) {
    const type = exc["type"] ?? "";
    const excId = exc["exc_id"] ?? "";
    if (BANK_TYPES.has(type)) {
      outOfScope += 1;
      continue;
    }
    const target =
      type.startsWith("payroll_")
        ? company.payrollErrorLine.get(exc["doc_id"] ?? "")
        : DOCUMENT_CHECK[type] === undefined
          ? undefined
          : { lineId: exc["doc_id"] ?? "", check: DOCUMENT_CHECK[type] ?? "" };
    if (target === undefined) {
      missed.push({ excId, type, why: "no check is mapped to this exception type" });
      continue;
    }
    const hit = findings.find((f) => f.checkKey === target.check && f.lineIds.includes(target.lineId));
    if (hit === undefined) {
      missed.push({ excId, type, why: `no ${target.check} finding names ${target.lineId}` });
      continue;
    }
    used.add(hit);
    caught.push({ excId, check: target.check });
  }
  return { company: company.key, caught, missed, extras: findings.filter((f) => !used.has(f)), outOfScope };
}

const companies = PACK === undefined
  ? []
  : readdirSync(PACK)
      .filter((d) => d.startsWith("Company_"))
      .sort()
      .map((d) => loadCompany(join(PACK, d)));

const scores = companies.map(score);

/** Every extra flag, by company, check and line, with WHY it is raised. Each
 *  is a finding the law supports that the pack did not seed (see the report). */
const EXPECTED_EXTRAS: Readonly<Record<string, string>> = {
  // The pack prices B's E004 (born 11 Nov 1964) at the "above 55 to 60" rates
  // all of 2025 until December. The CPF Board moves an employee to "above 60
  // to 65" from the month AFTER the 60th birthday month, so from December
  // 2024; the pack's own B-X05 calls her "aged 60-65". Ten months.
  ...Object.fromEntries(
    ["01", "02", "03", "04", "05", "06", "07", "08", "10", "11"].map((m) => [
      `B payroll.cpf_age_band 2025-${m}:E004`,
      "above 60 since December 2024 (the Board's rule), priced at the above-55 rates",
    ]),
  ),
  // A's E014 (born 18 Jun 1960) turned 65 in June 2025, so is "above 65 to 70"
  // from July; the pack keeps the "above 60 to 65" rates to December.
  ...Object.fromEntries(
    ["07", "08", "09", "10", "11", "12"].map((m) => [
      `A payroll.cpf_age_band 2025-${m}:E014`,
      "above 65 from July 2025 (the Board's rule), priced at the above-60 rates",
    ]),
  ),
};

const describePack = PACK === undefined ? describe.skip : describe;

describePack("the rule checks on the training pack's answer-key lines", () => {
  it("reads all five companies", () => {
    expect(companies.map((c) => c.key)).toEqual(["A", "B", "C", "D", "E"]);
    for (const c of companies) {
      expect(c.documents.length, c.key).toBeGreaterThan(100);
      expect(c.payroll.length, c.key).toBeGreaterThan(40);
    }
  });

  it("catches every seeded document and payroll exception (32 of 32)", () => {
    const missed = scores.flatMap((s) => s.missed.map((m) => `${s.company} ${m.excId} ${m.type}: ${m.why}`));
    expect(missed).toEqual([]);
    expect(scores.reduce((n, s) => n + s.caught.length, 0)).toBe(32);
    expect(scores.reduce((n, s) => n + s.outOfScope, 0)).toBe(15);
  });

  it("raises no extra flag it cannot explain, and lists every one", () => {
    const extras = scores.flatMap((s) => s.extras.map((f) => `${s.company} ${f.checkKey} ${f.lineIds.join(",")}`));
    expect(extras.sort()).toEqual(Object.keys(EXPECTED_EXTRAS).sort());
  });

  it("prints the scorecard", () => {
    const lines = ["", "Rule checks on answer-key lines, FY2025 (bank exceptions out of scope):", ""];
    lines.push("company  seeded(in scope)  caught  missed  extra  bank(out of scope)");
    for (const s of scores) {
      lines.push(
        `${s.company.padEnd(8)} ${String(s.caught.length + s.missed.length).padStart(16)}  ${String(s.caught.length).padStart(6)}  ${String(s.missed.length).padStart(6)}  ${String(s.extras.length).padStart(5)}  ${String(s.outOfScope).padStart(18)}`,
      );
    }
    const byCheck = new Map<string, { caught: number; extra: number }>();
    for (const s of scores) {
      for (const c of s.caught) {
        const e = byCheck.get(c.check) ?? { caught: 0, extra: 0 };
        e.caught += 1;
        byCheck.set(c.check, e);
      }
      for (const f of s.extras) {
        const e = byCheck.get(f.checkKey) ?? { caught: 0, extra: 0 };
        e.extra += 1;
        byCheck.set(f.checkKey, e);
      }
    }
    lines.push("", "check                          caught  extra");
    for (const [check, e] of [...byCheck].sort()) {
      lines.push(`${check.padEnd(30)} ${String(e.caught).padStart(6)}  ${String(e.extra).padStart(5)}`);
    }
    lines.push("", "extra flags:");
    for (const s of scores) {
      for (const f of s.extras) {
        const key = `${s.company} ${f.checkKey} ${f.lineIds.join(",")}`;
        lines.push(`  ${key}: ${EXPECTED_EXTRAS[key] ?? "UNEXPLAINED"}`);
      }
    }
    console.log(lines.join("\n"));
    expect(lines.length).toBeGreaterThan(5);
  });
});
