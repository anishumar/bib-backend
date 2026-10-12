// Reading a sheet (docs/FIN_BUILD_PLAN.md F2.6, F2.9 CSV, F2.11 sheets, F2.12
// POS): finding the header past a preamble, telling the kinds apart, mapping
// columns by their words, and reading rows into lines, or saying why a person
// has to. Each fixture is shaped like one of the training pack's layouts.
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/infrastructure/sheet/grid-reader";
import { checkControl } from "../../src/domain/fin/control";
import { layoutKey, layoutProblem, readSheet, recogniseSheet } from "../../src/domain/fin/sheet";
import type { Grid, SheetLayout } from "../../src/domain/fin/sheet";
import type { DocumentLineDraft, PayrollLineDraft, StatementLineDraft } from "../../src/domain/fin/lines";

const ctx = { documentVersionId: "00000000-0000-4000-8000-0000000000a1", filename: "file.csv", defaultCurrency: "SGD" };

function grid(text: string): Grid {
  return parseCsv(text.replace(/^\n/, ""));
}

function layoutOf(g: Grid): SheetLayout {
  const r = recogniseSheet(g);
  if (r.kind !== "layout") throw new Error(`expected a layout, got ${JSON.stringify(r)}`);
  return r.layout;
}

function read(g: Grid, filename = "file.csv") {
  const r = readSheet(g, layoutOf(g), { ...ctx, filename });
  if (!r.ok) throw new Error(r.why);
  return r;
}

// Company A's payroll account: no preamble, separate debit and credit.
const DEBIT_CREDIT = `
Date,Description,Debit,Credit,Balance
10/01/2025,TRANSFER FROM OPERATING A/C 0967,,27800.00,112800.00
14/01/2025,CPF BOARD GIRO CPF + SDL DEC 2024,27739.38,,85060.62
31/01/2025,INTEREST CREDIT,,5.41,85066.03
`;

// Company B's: an account block, then the header on row 6.
const PREAMBLE = `
﻿Account Name:,Harbourline Trading Pte Ltd
Account Number:,4632198905
Period:,01/04/2025 - 30/04/2025
Opening Balance:,40373.69

Transaction Date,Value Date,Transaction Description,Withdrawal,Deposit,Running Balance,Client Ref
11 Apr 2025,11 Apr 2025,TRANSFER FROM OPERATING A/C 9094,,9100.00,49473.69,0204
14 Apr 2025,14 Apr 2025,CPF BOARD GIRO CPF + SDL MAR 2025,8589.26,,40884.43,0205
`;

describe("finding the header and the kind", () => {
  it("reads a debit/credit statement with no preamble", () => {
    const layout = layoutOf(grid(DEBIT_CREDIT));
    expect(layout).toMatchObject({
      docKind: "bank_statement",
      headerRow: 0,
      columns: { txnDate: 0, narration: 1, debit: 2, credit: 3, balance: 4 },
      dateFormat: "dmy",
      amountStyle: "debit_credit",
    });
  });

  it("finds the header past an account block, and every column by its words", () => {
    const layout = layoutOf(grid(PREAMBLE));
    expect(layout).toMatchObject({
      docKind: "bank_statement",
      headerRow: 5,
      columns: { txnDate: 0, valueDate: 1, narration: 2, debit: 3, credit: 4, balance: 5, reference: 6 },
      dateFormat: "d_mon_y",
      amountStyle: "debit_credit",
    });
  });

  it("reads a signed amount column (company C) and quoted, separated figures (company D)", () => {
    expect(layoutOf(grid(`
Posting Date,Details,Amount,Balance
2025-01-06,TRANSFER FROM OPERATING A/C 4648,+52600.00,82600.00
2025-01-07,BULK GIRO SALARY DEC 24 PAYEES,-52511.84,30088.16
`))).toMatchObject({ amountStyle: "signed", dateFormat: "iso", columns: { txnDate: 0, narration: 1, amount: 2, balance: 3 } });

    const d = grid(`
"Account Statement - Orchid Bank"
"Account","5154921819","Currency","SGD"

"Date","Narration","Dr Amount","Cr Amount","Closing Balance"
"11-Apr-25","TRANSFER FROM OPERATING A/C 6965","0.00","19,100.00","139,425.66"
"14-Apr-25","CPF BOARD GIRO CPF + SDL MAR 2025","17,726.61","0.00","121,699.05"
`);
    expect(layoutOf(d)).toMatchObject({ headerRow: 3, amountStyle: "debit_credit", dateFormat: "d_mon_y" });
    const r = read(d);
    expect(r.lines.map((l) => (l as StatementLineDraft).amount)).toEqual(["19100.00", "-17726.61"]);
    expect((r.lines[0] as StatementLineDraft).accountRef).toBe("1819");
  });

  it("reads days written without separators (company E)", () => {
    expect(layoutOf(grid(`
TxnDate,Desc,Dr,Cr,Bal,Type
10012025,TRANSFER FROM OPERATING A/C 5680,,6200.00,21200.00,CR
14012025,CPF BOARD GIRO CPF + SDL DEC 2024,6113.00,,15087.00,DR
`))).toMatchObject({ dateFormat: "ddmmyyyy", amountStyle: "debit_credit", columns: { drCr: 5 } });
  });

  it("tells payroll, a CPF submission and a POS day apart by their columns", () => {
    expect(layoutOf(grid(`
Emp ID,Name,NRIC/FIN,Basic Salary,Gross Pay,Employee CPF,Net Pay,Employer CPF,SDL
E001,Rahmah bin Osman,S4597193L,12000,12000,1480,10520,1258,11.25
`)).docKind).toBe("payroll");
    expect(layoutOf(grid(`
EmployerUEN,Month,NRIC_FIN,Name,OrdinaryWages,AdditionalWages,EmployeeCPF,EmployerCPF,TotalCPF
202134890G,2025-08,S4597193L,Rahmah bin Osman,12000.00,0.00,1480.00,2960.00,4440.00
`)).docKind).toBe("cpf_submission");
    expect(layoutOf(grid(`
BusinessDate,Outlet,Bills,NetSales,ServiceCharge10,GST9,GrossTotal,Card,NETS_PayNow,Cash
2025-03-01,OUTLET-1,117,3139.89,313.99,310.85,3764.73,1944.40,777.68,1042.65
`)).docKind).toBe("pos_summary");
  });

  it("calls a statement a card's when its words say card", () => {
    expect(layoutOf(grid(`
Corporate Card Statement
Date,Description,Amount
2025-01-05,CLOUD HOSTING,-120.00
`)).docKind).toBe("card_statement");
  });

  it("recognises the reference masters and reads them into nothing", () => {
    const masters: [string, string][] = [
      ["Account,Name,Type\n1000,Cash at bank,Asset", "chart_of_accounts"],
      ["Account,Name,Debit,Credit\n1000,Cash at bank,310000,", "trial_balance"],
      ["Vendor,Country,UEN,GST_Reg_No\nSinga Mobile,Singapore,200937950R,M2-6518956-4", "counterparty_master"],
      ["Customer,Country,UEN\nMarina Retail,Singapore,201540102T", "counterparty_master"],
      ["Emp_ID,Name,NRIC_FIN (synthetic),Status,DOB,Designation,Basic_Salary\nE001,A,S1,SC,1976-11-14,MD,12000", "employee_master"],
      ["Code,Meaning\nSR,Standard-rated supply", "gst_codes"],
    ];
    for (const [text, master] of masters) expect(recogniseSheet(grid(text)), master).toMatchObject({ kind: "master", master });
  });
});

describe("refusing to guess", () => {
  const why = (text: string): string => {
    const r = recogniseSheet(grid(text));
    if (r.kind !== "unrecognised") throw new Error(`expected unrecognised, got ${r.kind}`);
    return r.why;
  };

  it("sends a sheet with no header it knows to a person", () => {
    expect(why("Foo,Bar\n1,2")).toContain("No row");
  });

  it("refuses two columns that could be the same field", () => {
    expect(why("Date,Txn Date,Description,Amount\n2025-01-01,2025-01-01,X,1")).toContain("more than one column");
  });

  it("refuses an Amount column beside Debit and Credit columns", () => {
    expect(why("Date,Description,Debit,Credit,Amount\n2025-01-01,X,,1,1")).toContain("Amount column AND Debit/Credit");
  });

  it("refuses days that read two ways, and never picks one", () => {
    expect(why("Date,Description,Amount\n03/04/2025,X,1\n05/04/2025,Y,2")).toContain("more than one way");
  });

  it("refuses a block with a row it cannot read, rather than staging part of a file", () => {
    const g = grid("Date,Description,Amount\n2025-01-01,X,1\n2025-01-02,Y,lots\n");
    const r = readSheet(g, layoutOf(g), ctx);
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses a transaction below a blank line: the file may be in two parts", () => {
    const g = grid("Date,Description,Amount\n2025-01-01,X,1\n\n2025-01-02,Y,2\n");
    expect(readSheet(g, layoutOf(g), ctx)).toMatchObject({ ok: false, why: expect.stringContaining("below a blank line") });
  });
});

describe("reading a statement", () => {
  it("signs money out negative and in positive, and keeps every printed balance", () => {
    const r = read(grid(DEBIT_CREDIT));
    expect(r.lines.map((l) => [(l as StatementLineDraft).amount, (l as StatementLineDraft).balance])).toEqual([
      ["27800.00", "112800.00"],
      ["-27739.38", "85060.62"],
      ["5.41", "85066.03"],
    ]);
    expect(r.lines[0]).toMatchObject({
      kind: "statement",
      statementType: "bank",
      txnDate: "2025-01-10",
      currency: "SGD",
      provenance: { row: 2, page: null },
      uncertain: [],
    });
    expect(r.control).toBeNull();
    expect(checkControl(r).ok).toBe(true);
  });

  it("takes the opening balance the account block prints, and checks the lines against it", () => {
    const r = read(grid(PREAMBLE));
    expect(r.control).toEqual({ opening: "40373.69", closing: null, lineCount: null, declaredTotal: null });
    expect(r.lines[0]).toMatchObject({ accountRef: "8905", reference: "0204", valueDate: "2025-04-11" });
    expect(checkControl(r)).toMatchObject({ ok: true, checked: ["running_balance"] });
  });

  it("reads opening and closing rows, a total row and a narration carried onto a second line", () => {
    const r = read(grid(`
Date,Description,Debit,Credit,Balance
,Opening Balance,,,1000.00
15/01/2025,PAYMENT TO,50.00,,950.00
,ACME PTE LTD INV 42,,,
20/01/2025,RECEIPT,,200.00,1150.00
,Total,50.00,200.00,
,Closing Balance,,,1150.00
`));
    expect(r.lines).toHaveLength(2);
    expect((r.lines[0] as StatementLineDraft).narration).toBe("PAYMENT TO ACME PTE LTD INV 42");
    expect(r.control).toEqual({ opening: "1000.00", closing: "1150.00", lineCount: null, declaredTotal: "150.00" });
    expect(checkControl(r)).toMatchObject({ ok: true, checked: ["opening_closing", "running_balance", "declared_total"] });
  });

  it("reads CR/DR after the figures, and a DR/CR column beside unsigned ones", () => {
    const suffixed = grid("Date,Description,Amount,Balance\n2025-01-02,FEE,25.00 DR,975.00 CR\n2025-01-03,IN,100.00 CR,1075.00 CR\n");
    expect(layoutOf(suffixed).amountStyle).toBe("cr_dr_suffix");
    expect(read(suffixed).lines.map((l) => (l as StatementLineDraft).amount)).toEqual(["-25.00", "100.00"]);

    const column = grid("Date,Description,Amount,Type\n2025-01-02,FEE,25.00,DR\n2025-01-03,IN,100.00,CR\n");
    expect(layoutOf(column).amountStyle).toBe("dr_cr_column");
    expect(read(column).lines.map((l) => (l as StatementLineDraft).amount)).toEqual(["-25.00", "100.00"]);
  });

  it("never stores an NRIC whole, even in a narration", () => {
    const r = read(grid("Date,Description,Amount\n2025-01-02,PAYNOW S4597193L REFUND,25.00\n"));
    expect((r.lines[0] as StatementLineDraft).narration).toBe("PAYNOW *****193L REFUND");
  });

  it("takes the currency a statement prints, else the firm's", () => {
    const usd = grid('"Account","1234567890","Currency","USD"\nDate,Description,Amount\n2025-01-02,X,1.00\n');
    expect((read(usd).lines[0] as StatementLineDraft).currency).toBe("USD");
    expect((read(grid(DEBIT_CREDIT)).lines[0] as StatementLineDraft).currency).toBe("SGD");
  });
});

describe("reading a payroll", () => {
  it("reads each employee's month, the total row as the declared gross, and masks the NRIC", () => {
    const g = grid(`
HARBOURLINE TRADING PTE LTD
SALARY SHEET - SEPTEMBER 2025

Name,NRIC / FIN,Status,Basic,Allowances,Gross,EE CPF,Net,ER CPF,SDL,FWL
Goh Kai Xiang,S9444916T,SC,9000,0,9000,1480,7520,1258,11.25,0
Ananya Gupta,F3405778G,WP,1650,515.38,2165.38,0,2165.38,0,5.41,450
Total,,,10650,515.38,11165.38,1480,9685.38,1258,16.66,450

Prepared by: Admin,,Approved by: Director
`);
    const r = read(g);
    expect(r.lines).toHaveLength(2);
    const first = r.lines[0] as PayrollLineDraft;
    expect(first).toMatchObject({
      kind: "payroll",
      period: "2025-09",
      employeeRef: "*****916T",
      employeeName: "Goh Kai Xiang",
      passType: "citizen",
      grossPay: "9000",
      cpfEmployee: "1480",
      cpfEmployer: "1258",
      sdl: "11.25",
      fwl: "0",
      netPay: "7520",
      uncertain: [],
    });
    expect(JSON.stringify(r.lines)).not.toContain("S9444916T");
    expect((r.lines[1] as PayrollLineDraft).passType).toBe("work_permit");
    expect(r.control).toMatchObject({ declaredTotal: "11165.38" });
    expect(checkControl(r).ok).toBe(true);
  });

  it("prefers the sheet's employee id, and works out an age from a birth date at the month's start", () => {
    const r = read(grid(`
No.,Employee,Pass Type,Date of Birth,Basic,Total Wages,CPF (Employee),Net Wages,CPF (Employer),SDL,Levy
1,SURESH SUBRAMANIAM,Citizen,1981-06-06,4800,5100,1020,4080,867,11.25,0
`), "Wages_2025_03.xlsx");
    // No id, no NRIC: the serial is all the sheet gives, and it is not an
    // identity, so the reader says it is unsure. The month is the file's name.
    expect(r.lines[0]).toMatchObject({ employeeRef: "#1", age: 43, period: "2025-03", uncertain: ["period", "employeeRef"] });
  });

  it("takes the gross from its parts only when the sheet's own net agrees", () => {
    const r = read(grid(`
Month,Employee,IC,Basic,Bonus/Other,CPF (employee),Take home,CPF (company),SDL,Remarks
Jun-25,Chan Li Ting,S3547108Q,"S$6,200.00",0,1240,4960,1054,11.25,
Jun-25,Odd One,S6720208E,"S$5,400.00",0,1080,4000,918,11.25,
`));
    expect(r.lines.map((l) => [(l as PayrollLineDraft).grossPay, (l as PayrollLineDraft).uncertain])).toEqual([
      ["6200.00", []],
      [null, ["grossPay"]],
    ]);
  });

  it("refuses a payroll that names no month anywhere", () => {
    const g = grid("Name,Gross,Employee CPF,Net\nA,100,20,80\n");
    expect(readSheet(g, layoutOf(g), { ...ctx, filename: "salary jun.xlsx" })).toMatchObject({ ok: false });
  });

  it("refuses pay on a row with nobody's name", () => {
    const g = grid("Name,Gross,Employee CPF,Net\nA,100,20,80\n,50,10,40\n");
    expect(readSheet(g, layoutOf(g), { ...ctx, filename: "Payroll_Aug2025.xlsx" })).toMatchObject({ ok: false });
  });
});

describe("reading a POS day", () => {
  it("takes the amount before GST as sales plus service charge, when the file's total agrees", () => {
    const r = read(grid(`
BusinessDate,Outlet,Bills,NetSales,ServiceCharge10,GST9,GrossTotal,Card,NETS_PayNow,Cash
2025-03-01,OUTLET-1,117,3139.89,313.99,310.85,3764.73,1944.40,777.68,1042.65
2025-03-01,OUTLET-2,134,2013.35,201.34,199.32,2414.01,1229.35,665.03,519.63
`));
    const first = r.lines[0] as DocumentLineDraft;
    expect(first).toMatchObject({
      kind: "document",
      docType: "pos_summary",
      docDate: "2025-03-01",
      net: "3453.88",
      gst: "310.85",
      total: "3764.73",
      counterpartyName: null,
      docNumber: null,
      uncertain: [],
    });
  });
});

describe("a layout a person saves", () => {
  const header = ["Date", "Description", "Debit", "Credit", "Balance"];
  const ok = { docKind: "bank_statement", header, dateFormat: "dmy", amountStyle: "debit_credit" };

  it("is accepted when the reader could read with it", () => {
    expect(layoutProblem({ ...ok, columns: { txnDate: 0, narration: 1, debit: 2, credit: 3, balance: 4 } })).toBeNull();
  });

  it("is refused, in words, when it could not", () => {
    expect(layoutProblem({ ...ok, columns: { txnDate: 0, narration: 1, debit: 2, credit: 3, sparkle: 4 } })).toContain('"sparkle"');
    expect(layoutProblem({ ...ok, columns: { txnDate: 0, narration: 1, debit: 2, credit: 2 } })).toContain("two fields");
    expect(layoutProblem({ ...ok, columns: { txnDate: 0, narration: 1, debit: 9, credit: 3 } })).toContain("column 9");
    expect(layoutProblem({ ...ok, columns: { txnDate: 0, narration: 1 } })).toContain("enough columns");
    expect(layoutProblem({ ...ok, amountStyle: "signed", columns: { txnDate: 0, narration: 1, debit: 2, credit: 3 } })).toContain("does not fit");
    expect(layoutProblem({ ...ok, dateFormat: null, columns: { txnDate: 0, narration: 1, debit: 2, credit: 3 } })).toContain("days");
    expect(layoutProblem({ ...ok, docKind: "master", columns: {} })).toContain("not \"master\"");
  });

  it("is known by its words, not by how they are spelt", () => {
    expect(layoutKey(["Txn Date", "Desc"], "csv")).toBe(layoutKey(["TXN_DATE", " desc "], "csv"));
    expect(layoutKey(["Txn Date", "Desc"], "csv")).not.toBe(layoutKey(["Txn Date", "Desc"], "xlsx"));
  });
});
