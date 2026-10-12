// Which header words mean which field, for each kind of sheet fin reads
// (docs/FIN_BUILD_PLAN.md F2.6, F2.9, F2.11, F2.12). Pure.
//
// ── EXACT WORDS, NOT A SIMILARITY SCORE ──────────────────────────────────────
//
// A header matches a field when its normalised words (`normaliseHeader`) are one
// of that field's synonyms, exactly. A fuzzy score would read "Closing Balance"
// as a closing balance figure, "Total Wages" as a total row and "Status" as
// anything at all; an exact list is a decision somebody can read, and a sheet
// it does not know goes to a person (`unrecognised_layout`), who can confirm a
// map for it once (`fin.source_format`). Adding a bank's wording is a line here.
//
// Within one kind the lists are disjoint, so a header names at most one field.
// Two COLUMNS naming one field ("Date" and "Txn Date") is ambiguity, and the
// recogniser refuses it rather than picking one.
import type { DocKind } from "./lines";

/** The kinds of file the sheet reader produces lines for. A learnt layout is
 *  one of these (0386's `source_format_doc_kind_check`). */
export type SheetDocKind = Extract<DocKind, "bank_statement" | "card_statement" | "payroll" | "cpf_submission" | "pos_summary">;

export const SHEET_DOC_KINDS: readonly SheetDocKind[] = [
  "bank_statement",
  "card_statement",
  "payroll",
  "cpf_submission",
  "pos_summary",
];

// ── Statements ───────────────────────────────────────────────────────────────

export const STATEMENT_FIELDS = {
  txnDate: ["date", "txn date", "transaction date", "trans date", "tran date", "posting date", "post date", "booking date", "entry date"],
  valueDate: ["value date", "val date", "effective date"],
  narration: ["description", "narration", "details", "particulars", "transaction description", "transaction details", "transaction particulars", "desc", "memo"],
  reference: ["reference", "ref", "ref no", "reference no", "reference number", "client ref", "customer ref", "bank ref", "transaction ref", "txn ref", "cheque no", "cheque number", "chq no", "your ref", "our ref"],
  debit: ["debit", "debits", "debit amount", "dr", "dr amount", "withdrawal", "withdrawals", "withdrawal amount", "money out", "paid out", "payments", "outflow"],
  credit: ["credit", "credits", "credit amount", "cr", "cr amount", "deposit", "deposits", "deposit amount", "money in", "paid in", "receipts", "inflow"],
  amount: ["amount", "amt", "transaction amount", "txn amount"],
  balance: ["balance", "bal", "running balance", "closing balance", "ledger balance", "book balance"],
  drCr: ["type", "dr cr", "cr dr", "drcr", "crdr", "debit credit", "d c", "dc"],
  currency: ["currency", "ccy", "curr"],
} as const;

export type StatementField = keyof typeof STATEMENT_FIELDS;

// ── Payroll and CPF submissions ──────────────────────────────────────────────

export const PAYROLL_FIELDS = {
  employeeRef: ["emp id", "employee id", "emp no", "employee no", "employee number", "emp code", "employee code", "staff id", "staff no", "staff code"],
  serial: ["no", "s n", "sn", "s no", "sl no", "serial", "serial no"],
  employeeName: ["name", "employee", "employee name", "emp name", "staff", "staff name", "full name"],
  nric: ["nric", "nric fin", "nric no", "nric number", "fin", "fin no", "ic", "ic no", "nric fin no"],
  passType: ["pass type", "status", "residency", "residency status", "residential status", "citizenship", "citizenship status", "work pass", "pass"],
  age: ["age"],
  birthDate: ["date of birth", "dob", "d o b", "birth date", "birthdate"],
  period: ["month", "period", "pay period", "payroll month", "salary month", "pay month"],
  ordinaryWage: ["ordinary wages", "ordinary wage", "ow"],
  additionalWage: ["additional wages", "additional wage", "aw"],
  grossPay: ["gross", "gross pay", "gross salary", "gross wages", "gross earnings", "total gross", "total wages", "total earnings"],
  basic: ["basic", "basic salary", "basic pay", "basic wage"],
  allowance: ["allowance", "allowances", "total allowance"],
  overtime: ["overtime", "overtime pay", "ot", "ot pay"],
  bonus: ["bonus", "bonuses", "bonus other"],
  cpfEmployee: ["employee cpf", "ee cpf", "emp cpf", "cpf employee", "cpf ee", "employee share", "employee cpf contribution"],
  cpfEmployer: ["employer cpf", "er cpf", "empr cpf", "cpf employer", "cpf er", "cpf company", "company cpf", "employer share", "employer cpf contribution"],
  totalCpf: ["total cpf", "cpf total"],
  sdl: ["sdl", "skills development levy"],
  fwl: ["fwl", "levy", "foreign worker levy", "fw levy", "worker levy"],
  netPay: ["net", "net pay", "net wages", "net salary", "take home", "take home pay"],
  employerUen: ["employer uen", "uen"],
} as const;

export type PayrollField = keyof typeof PAYROLL_FIELDS;

/** The payroll fields that are money, in the order a person reads a row. */
export const PAYROLL_MONEY: readonly PayrollField[] = [
  "ordinaryWage",
  "additionalWage",
  "basic",
  "allowance",
  "overtime",
  "bonus",
  "grossPay",
  "cpfEmployee",
  "cpfEmployer",
  "totalCpf",
  "sdl",
  "fwl",
  "netPay",
];

/** What a payroll sheet pays an employee BEFORE deductions, when it prints the
 *  parts and no gross column. */
export const EARNINGS: readonly PayrollField[] = ["basic", "allowance", "overtime", "bonus"];

// ── A POS day ────────────────────────────────────────────────────────────────

export const POS_FIELDS = {
  businessDate: ["business date", "date", "sales date", "trading date", "report date"],
  outlet: ["outlet", "store", "branch", "location"],
  bills: ["bills", "bill count", "covers", "transactions"],
  netSales: ["net sales", "sales", "net sales amount"],
  serviceCharge: ["service charge", "svc charge", "sc"],
  gst: ["gst", "gst amount", "tax", "output tax"],
  grossTotal: ["gross total", "gross sales", "total sales", "grand total", "gross", "total"],
  card: ["card", "cards", "card sales"],
  nets: ["nets", "nets pay now", "paynow", "pay now"],
  cash: ["cash", "cash sales"],
} as const;

export type PosField = keyof typeof POS_FIELDS;

export type SheetField = StatementField | PayrollField | PosField;

/** The fields one kind's column map may name. */
export function fieldsOf(kind: SheetDocKind): Readonly<Record<string, readonly string[]>> {
  switch (kind) {
    case "bank_statement":
    case "card_statement":
      return STATEMENT_FIELDS;
    case "payroll":
    case "cpf_submission":
      return PAYROLL_FIELDS;
    case "pos_summary":
      return POS_FIELDS;
  }
}

/** Field name → 0-based column. */
export type ColumnMap = Readonly<Record<string, number>>;

/**
 * Whether a set of mapped fields makes a sheet this kind. The kinds are written
 * to exclude each other, so a header row is one kind or none:
 *
 *   statement       a day, words, and money as one amount or debit AND credit
 *   payroll         who, what they were paid (gross or net), and CPF
 *   cpf_submission  an NRIC, ordinary wages and both CPF shares, and NO pay
 *                   column (a payroll sheet has one)
 *   pos_summary     a business day, net sales, GST and the gross total
 */
export function accepts(kind: SheetDocKind, mapped: ReadonlySet<string>): boolean {
  const has = (f: string): boolean => mapped.has(f);
  switch (kind) {
    case "bank_statement":
    case "card_statement":
      return has("txnDate") && has("narration") && (has("amount") || (has("debit") && has("credit")));
    case "payroll":
      return (
        (has("employeeName") || has("employeeRef") || has("nric")) &&
        (has("grossPay") || has("netPay")) &&
        (has("cpfEmployee") || has("cpfEmployer"))
      );
    case "cpf_submission":
      return (
        has("nric") && has("ordinaryWage") && has("cpfEmployee") && has("cpfEmployer") &&
        !has("grossPay") && !has("netPay")
      );
    case "pos_summary":
      return has("businessDate") && has("netSales") && has("gst") && has("grossTotal");
  }
}

/** The kinds the recogniser tries, by vocabulary. Bank and card share one, and
 *  which of the two a statement is comes from its words, not its columns. */
export const RECOGNISED_KINDS: readonly SheetDocKind[] = ["bank_statement", "payroll", "cpf_submission", "pos_summary"];

// ── Reference masters (00_Reference) ─────────────────────────────────────────
//
// A chart of accounts, a vendor, customer or employee master, a GST code list
// and an opening trial balance. They are not transactions: importing them is
// F3.1's, through its own screen. The sheet reader only RECOGNISES one, so the
// file is not left at "unrecognised" for a person to puzzle over, and produces
// no lines.

export type MasterKind = "chart_of_accounts" | "trial_balance" | "counterparty_master" | "employee_master" | "gst_codes";

const ACCOUNT_CODE = ["account", "account code", "account no", "account number", "gl code", "gl account", "code"];
const ACCOUNT_NAME = ["name", "account name", "description", "account description"];
const ACCOUNT_TYPE = ["type", "account type", "category", "class"];
const PARTY = ["vendor", "vendor name", "supplier", "supplier name", "customer", "customer name"];
const PARTY_FACT = ["uen", "gst reg no", "gst registration no", "gst no", "credit terms days", "credit terms", "default gst code", "default gl"];
const EMPLOYEE_FACT = ["dob", "date of birth", "designation", "join date", "leave date"];
const PAY_COLUMNS = new Set<string>([
  ...PAYROLL_FIELDS.grossPay,
  ...PAYROLL_FIELDS.netPay,
  ...PAYROLL_FIELDS.cpfEmployee,
  ...PAYROLL_FIELDS.cpfEmployer,
]);
const DAY_COLUMNS = new Set<string>([...STATEMENT_FIELDS.txnDate, ...STATEMENT_FIELDS.valueDate]);

/** The master a header row is, or null. Read from the set of normalised
 *  header words; an employee master has a name, an id and an NRIC like a
 *  payroll sheet, and no pay column, which is the difference. */
export function masterOf(headers: readonly string[]): MasterKind | null {
  const set = new Set(headers.filter((h) => h !== ""));
  const any = (words: readonly string[]): boolean => words.some((w) => set.has(w));
  const anyWhere = (test: (h: string) => boolean): boolean => [...set].some(test);
  if (anyWhere((h) => DAY_COLUMNS.has(h))) return null;
  if (any(ACCOUNT_CODE) && set.has("debit") && set.has("credit")) return "trial_balance";
  if (any(ACCOUNT_CODE) && any(ACCOUNT_NAME) && any(ACCOUNT_TYPE)) return "chart_of_accounts";
  if (any(PARTY) && any(PARTY_FACT)) return "counterparty_master";
  if (
    any(PAYROLL_FIELDS.employeeRef) &&
    any(PAYROLL_FIELDS.employeeName) &&
    anyWhere((h) => h.startsWith("nric") || h === "fin" || h === "ic") &&
    any(EMPLOYEE_FACT) &&
    !anyWhere((h) => PAY_COLUMNS.has(h))
  ) {
    return "employee_master";
  }
  if (set.size <= 4 && any(["code", "gst code", "tax code"]) && any(["meaning", "description", "gst description"])) {
    return "gst_codes";
  }
  return null;
}
