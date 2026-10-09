// The firm's own India compliance calendar as rules (T3.2), from
// `docs/India_Compliance_Calendar_Applicability_Business_in_a_Box.xlsx` (the founder, 2026-08-30):
// 55 obligations across twelve modules (Income Tax, TDS, GST, Payroll, MCA, Transfer Pricing,
// FEMA/RBI, Payments, POSH, Labour, Data Privacy, industry licences). Every one is a row here,
// unlike the demo.
// A DUE DATE IS ENCODED ONLY WHERE THE FIRM'S SHEET STATES ONE, never from memory or public
// knowledge (MSME-1 is due 31 Oct / 30 Apr, the sheet does not say so, so neither do we). A fake
// value is survivable, a fake rule is not: a plausible wrong date costs the client a penalty.
// The sheet's vague timings are correct ("after AGM", "State-specific", "7 working days" with no
// holiday calendar, "30 days of allotment" with no event seen), so each is handed back BY NAME
// with its reason on the rules screen. Ten rules compute; forty-seven say what they still need.
// Every rule seeds `unconfirmed`, the ten included (previous vendor + this sheet, not a partner;
// confirming is an UPDATE on a screen, see 0052). Lead time (T-X) seeds 0, so the task appears
// on the statutory date: a guessed lead time is a commitment the firm never made.

import type { DueRuleKind, ObligationRecurrence } from "./model.js";

/** Named for its source and date. A revision is a NEW pack beside this one, never an edit, so a
 *  filing made under the old rules can still explain its due date. */
export const INDIA_RULE_PACK = "in-firm-sheet@2026.08";

export interface SeedException {
  /** The calendar month the filed PERIOD ends in. March is 3. */
  readonly periodEndMonth: number;
  readonly dueRule: DueRuleKind;
  readonly dueMonthOffset: number | null;
  readonly dueDayOfMonth: number | null;
  readonly dueDaysAfter: number | null;
  readonly note: string;
}

export interface SeedRule {
  /** The statute's own grouping, straight from the sheet's `Module` column. */
  readonly module: string;
  readonly name: string;
  readonly authority: string | null;
  readonly recurrence: ObligationRecurrence;
  readonly dueRule: DueRuleKind | null;
  readonly dueMonthOffset: number | null;
  readonly dueDayOfMonth: number | null;
  readonly dueDaysAfter: number | null;
  /** Present exactly when `dueRule` is null; the sheet's own words wherever it gave them. */
  readonly unresolvedReason: string | null;
  /** The sheet's `Applicability Threshold / Trigger`, verbatim: nothing can TEST it yet (see
   *  thresholds in `docs/MERGE_BUILD-PLAN.md`), and it says who each rule reaches. */
  readonly applicabilityNote: string;
  readonly exceptions?: readonly SeedException[];
}

/** Shorthand for a rule we cannot compute yet. */
function unresolved(
  module: string,
  name: string,
  authority: string | null,
  recurrence: ObligationRecurrence,
  unresolvedReason: string,
  applicabilityNote: string,
): SeedRule {
  return {
    module,
    name,
    authority,
    recurrence,
    dueRule: null,
    dueMonthOffset: null,
    dueDayOfMonth: null,
    dueDaysAfter: null,
    unresolvedReason,
    applicabilityNote,
  };
}

/** Shorthand for "N months after the period ends, then day D". */
function dayOfMonth(
  module: string,
  name: string,
  authority: string | null,
  recurrence: ObligationRecurrence,
  dueMonthOffset: number,
  dueDayOfMonth: number,
  applicabilityNote: string,
  exceptions?: readonly SeedException[],
): SeedRule {
  return {
    module,
    name,
    authority,
    recurrence,
    dueRule: "day_of_month",
    dueMonthOffset,
    dueDayOfMonth,
    dueDaysAfter: null,
    unresolvedReason: null,
    applicabilityNote,
    ...(exceptions ? { exceptions } : {}),
  };
}

/**
 * The sheet, in its own order: 57 rows for 55 lines. GSTR-1 and GSTR-3B are each "Monthly /
 * Quarterly" on the sheet, two regimes: the monthly one computes, the QRMP one cannot (no record
 * of who elected it). Each `unresolvedReason` is a question a partner can answer without knowing
 * this system. FC-GPR HAS a formula and generates nothing: it is event-driven.
 */
export const INDIA_SEED_RULES: readonly SeedRule[] = [
  // ── Income Tax ───────────────────────────────────────────────────────────
  // 15 Jun / 15 Sep / 15 Dec / 15 Mar: offset 0 from each quarter's END month, so the
  // instalment falls inside its own quarter (an estimate).
  dayOfMonth("Income Tax", "Advance Tax", "Income Tax", "quarterly", 0, 15,
    "Tax payable for year >= Rs 10,000"),
  unresolved("Income Tax", "Corporate Income Tax Return", "Income Tax", "annual",
    "The due date depends on audit and transfer-pricing status, which BiB does not record " +
      "yet. Which date applies to a company with no tax audit, and " +
      "which with one?",
    "All companies"),
  unresolved("Income Tax", "Tax Audit", "Income Tax", "annual",
    "Two things missing. The date is 'the applicable statutory due date' rather than a fixed " +
      "day, and applicability is a turnover threshold (Rs 1 Cr, or Rs 10 Cr where both cash " +
      "tests are met), and BiB does not store a turnover yet.",
    "Business turnover > Rs 1 Cr; Rs 10 Cr where cash receipts and payments each <= 5%; " +
      "profession > Rs 50 Lakh"),

  // ── TDS ──────────────────────────────────────────────────────────────────
  unresolved("TDS", "TDS deduction", "Income Tax", "event",
    "Deducted at credit or payment, whichever is earlier. A transaction, not a period. " +
      "Nothing here yet sees a payment, so there is nothing to count from.",
    "Depends on payment nature, threshold, payee and PAN"),
  // THE MARCH EXCEPTION, why `obligation_template_exception` exists: the 7th, but March on 30 April.
  dayOfMonth("TDS", "TDS deposit", "Income Tax", "monthly", 1, 7,
    "TDS deducted in the month",
    [{
      periodEndMonth: 3,
      dueRule: "day_of_month",
      dueMonthOffset: 1,
      dueDayOfMonth: 30,
      dueDaysAfter: null,
      note: "March's deduction is due 30 April rather than 7 April. This is the statutory " +
        "date, not a practice of one firm.",
    }],
  ),
  // Q1-Q3 -> 31 Jul / 31 Oct / 31 Jan; Q4 -> 31 MAY, two months after its quarter.
  dayOfMonth("TDS", "Quarterly TDS statements", "Income Tax", "quarterly", 1, 31,
    "Applicable deductors (TAN / TDS activity)",
    [{
      periodEndMonth: 3,
      dueRule: "day_of_month",
      dueMonthOffset: 2,
      dueDayOfMonth: 31,
      dueDaysAfter: null,
      note: "The Jan-Mar statement is due 31 May, two months after its quarter rather than " +
        "one. The four dates are 31 Jul, 31 Oct, 31 Jan and 31 May.",
    }],
  ),

  // ── GST ──────────────────────────────────────────────────────────────────
  unresolved("GST", "GST registration", "GST", "event",
    "Triggered by crossing a turnover threshold (Rs 20 Lakh services, Rs 40 Lakh goods in " +
      "eligible States) or by a compulsory-registration condition. Both are facts BiB does not " +
      "hold yet, and neither is a period.",
    "Generally > Rs 20 Lakh services; goods threshold may be Rs 40 Lakh in eligible States"),
  dayOfMonth("GST", "GSTR-1", "GST", "monthly", 1, 11,
    "GST registered taxpayer filing monthly"),
  unresolved("GST", "GSTR-1 (QRMP quarterly)", "GST", "quarterly",
    "The 13th of the month after the quarter, but only for taxpayers who ELECTED the QRMP " +
      "scheme. This system does not record that election. Which of your clients are on QRMP?",
    "GST registered taxpayer under QRMP"),
  dayOfMonth("GST", "GSTR-3B", "GST", "monthly", 1, 20,
    "GST registered taxpayer filing monthly"),
  unresolved("GST", "GSTR-3B (QRMP quarterly)", "GST", "quarterly",
    "The QRMP date varies by State group and by the taxpayer's QRMP election, and BiB " +
      "records neither yet.",
    "GST registered taxpayer under QRMP"),
  unresolved("GST", "GSTR-2B / ITC reconciliation", "GST", "monthly",
    "It is due 'before GSTR-3B', a deadline relative to another filing rather than to the " +
      "period. Which day of the month should it be done by?",
    "GST-registered entity claiming ITC"),
  unresolved("GST", "GSTR-9", "GST", "annual",
    "'Notified annual due date' is set by notification each year rather than by a standing " +
      "formula, and exemptions depend on turnover, which is not stored here.",
    "Applicable registered taxpayers; exemptions/thresholds depend on current notifications"),
  unresolved("GST", "GSTR-9C", "GST", "annual",
    "Same as GSTR-9: notified each year, and applicability is a turnover threshold this " +
      "system cannot test.",
    "Taxpayers for whom the reconciliation statement is applicable"),
  unresolved("GST", "E-invoicing", "GST", "event",
    "Continuous, at invoice issuance, not a period. Applicability is PAN-level AATO >= Rs 5 " +
      "Cr in any preceding FY, a turnover fact BiB does not hold yet.",
    "AATO Rs 5 Cr or more in any preceding FY, subject to exemptions"),
  unresolved("GST", "E-way bill", "GST", "event",
    "Raised before each movement of goods. A transaction, not a period.",
    "Applicable movement of goods; generally consignment value > Rs 50,000"),
  unresolved("GST", "LUT for exports", "GST", "annual",
    "'Before the relevant FY exports' is a practice rather than a statutory day. " +
      "How many days before the year starts should this be raised?",
    "Eligible exporters supplying zero-rated goods/services without IGST"),

  // ── Payroll ──────────────────────────────────────────────────────────────
  dayOfMonth("Payroll", "EPFO ECR / PF", "EPFO", "monthly", 1, 15,
    "PF-covered establishments"),
  dayOfMonth("Payroll", "ESI", "ESIC", "monthly", 1, 15,
    "ESI-covered establishment and eligible employees"),
  unresolved("Payroll", "Professional Tax", "State", "monthly",
    "State-specific: due on different days in Maharashtra and Karnataka, and this rule " +
      "carries one country code rather than a State. Which States do your clients operate in?",
    "State-specific"),
  unresolved("Payroll", "Labour Welfare Fund", "State", "half_yearly",
    "State-specific, like Professional Tax, and no single day applies.",
    "State-specific"),

  // ── MCA ──────────────────────────────────────────────────────────────────
  unresolved("MCA", "AGM", "MCA", "annual",
    "'Statutory AGM window' is a window rather than a day, and the day within it is the " +
      "company's own choice. Everything below that says 'after AGM' waits on this one.",
    "Companies required to hold an AGM"),
  unresolved("MCA", "AOC-4 / financial statements", "MCA", "annual",
    "Due within a statutory period AFTER the AGM, and the AGM date is not recorded here. " +
      "This becomes computable the day an AGM date is captured.",
    "Companies"),
  unresolved("MCA", "MGT-7 / MGT-7A", "MCA", "annual",
    "Also measured from the AGM date, and which of the two forms applies depends on company " +
      "size, a threshold BiB cannot test yet.",
    "Applicable companies; form depends on status/size"),
  unresolved("MCA", "Small Company classification", "MCA", "annual",
    "An assessment rather than a filing, decided on paid-up capital and turnover thresholds " +
      "with exclusions. None of those numbers are stored here.",
    "Private company; prescribed paid-up capital and turnover thresholds, with exclusions"),
  dayOfMonth("MCA", "DIR-3 KYC / KYC-Web", "MCA", "annual", 6, 30,
    "Applicable DIN holders"),
  dayOfMonth("MCA", "DPT-3", "MCA", "annual", 3, 30,
    "Reportable deposits / specified outstanding amounts"),
  unresolved("MCA", "MSME-1", "MCA", "half_yearly",
    "The law says 'applicable half-yearly deadlines' without a day in the rule. Half-yearly is " +
      "recorded; the two dates are not, and BiB does not invent a statutory date that " +
      "has not been confirmed.",
    "Qualifying outstanding dues to micro/small enterprises"),
  unresolved("MCA", "BEN-2 / SBO", "MCA", "event",
    "Triggered by a significant-beneficial-ownership change. An event, and BiB does not see " +
      "the cap table.",
    "Significant beneficial ownership trigger"),
  unresolved("MCA", "DIR-12", "MCA", "event",
    "Triggered by a director or KMP appointment, resignation or change.",
    "Director/KMP appointment, resignation or change"),
  unresolved("MCA", "PAS-3", "MCA", "event",
    "Triggered by a share allotment.",
    "Share allotment"),
  unresolved("MCA", "MGT-14", "MCA", "event",
    "Triggered by passing a resolution of a filable type.",
    "Resolutions requiring filing"),
  unresolved("MCA", "SH-7", "MCA", "event",
    "Triggered by an alteration of share capital.",
    "Alteration of share capital"),
  unresolved("MCA", "CHG-1 / CHG-4", "MCA", "event",
    "Triggered by creation, modification or satisfaction of a charge.",
    "Creation/modification/satisfaction of charge"),
  unresolved("MCA", "CSR", "MCA", "annual",
    "Applicability is three thresholds in the alternative (net worth, turnover or net profit), " +
      "and none of those figures are stored here. The annual cycle itself has no stated day.",
    "Net worth >= Rs 500 Cr OR turnover >= Rs 1,000 Cr OR net profit >= Rs 5 Cr in the " +
      "immediately preceding FY"),
  unresolved("MCA", "Internal Audit", "MCA", "annual",
    "Applies by company class and prescribed financial thresholds; no single day applies.",
    "Depends on company class and prescribed financial thresholds"),
  unresolved("MCA", "Secretarial Audit", "MCA", "annual",
    "Applies on listed status and financial thresholds; no single day applies.",
    "Listed status + prescribed company thresholds"),
  unresolved("MCA", "Cost Records / Cost Audit", "MCA", "annual",
    "Applies only to prescribed industries and turnover thresholds. Industry is not recorded " +
      "here and neither is turnover.",
    "Specified industries/classes and prescribed turnover/product thresholds"),

  // ── Transfer Pricing ─────────────────────────────────────────────────────
  unresolved("Transfer Pricing", "Form 3CEB", "Income Tax", "annual",
    "Tied to the tax-return cycle, whose own date is unresolved above, and applies only where " +
      "reportable related-party transactions exist.",
    "International / specified domestic transactions"),
  unresolved("Transfer Pricing", "TP Documentation", "Income Tax", "annual",
    "'Contemporaneous' means maintained continuously rather than filed on a day.",
    "Applicable international transactions"),
  unresolved("Transfer Pricing", "Master File", "Income Tax", "annual",
    "Applies on group turnover and international-transaction thresholds, and no single day " +
      "applies.",
    "Applicable multinational groups meeting prescribed thresholds"),
  unresolved("Transfer Pricing", "CbCR", "Income Tax", "annual",
    "Applies on consolidated group revenue, which BiB does not hold yet.",
    "Applicable large multinational groups"),

  // ── FEMA / RBI ───────────────────────────────────────────────────────────
  dayOfMonth("FEMA / RBI", "FLA Return", "RBI", "annual", 3, 15,
    "Indian company with FDI / LLP with applicable foreign investment"),
  {
    module: "FEMA / RBI",
    name: "FC-GPR",
    authority: "RBI",
    recurrence: "event",
    // A formula with no trigger: generates nothing until a share issue is visible here.
    dueRule: "days_after",
    dueMonthOffset: null,
    dueDayOfMonth: null,
    dueDaysAfter: 30,
    unresolvedReason: null,
    applicabilityNote:
      "Indian company issuing eligible equity instruments to a non-resident. Due within 30 " +
      "days of issue. The formula is recorded, and it will produce dates the day a share " +
      "issue is captured here.",
  },
  unresolved("FEMA / RBI", "FC-TRS", "RBI", "event",
    "Triggered by a share transfer involving a non-resident, and the period is the " +
      "'applicable RBI period' rather than a number of days.",
    "Applicable resident/non-resident transfer"),
  unresolved("FEMA / RBI", "ODI / APR", "RBI", "annual",
    "Two obligations in one (an event-driven ODI filing and an annual APR " +
      "per foreign entity), and neither carries a stated date.",
    "Indian entity with overseas investment"),
  unresolved("FEMA / RBI", "ECB-2", "RBI", "monthly",
    "'Within 7 working days from month-end'. Working days are not days, and BiB holds no " +
      "holiday calendar yet. A calendar-day equivalent would be a rule nobody agreed to.",
    "ECB borrower"),
  unresolved("FEMA / RBI", "Form 15CA / 15CB assessment", "Income Tax", "event",
    "Run before each non-resident remittance. A transaction, not a period.",
    "Applicable non-resident remittance"),

  // ── the rest of the sheet ────────────────────────────────────────────────
  unresolved("Payments", "Digital payment acceptance", null, "annual",
    "Applies above a Rs 50 Cr turnover threshold and is described as continuous rather than " +
      "due on a day.",
    "Business turnover > Rs 50 Cr"),
  unresolved("POSH", "POSH Internal Committee / annual compliance", null, "annual",
    "Employee-count driven, and BiB stores no employee count yet. The annual filing has " +
      "no stated day either.",
    "Covered establishments; generally employee-count driven"),
  unresolved("Labour", "Shops & Establishments", "State", "annual",
    "State and UT specific, both for whether it applies and for when.",
    "State/UT-specific establishment criteria"),
  unresolved("Labour", "Minimum wage / wage registers", "State", "monthly",
    "Continuous rather than filed: registers kept, not a return submitted on a day.",
    "Employer; State/category/employee driven"),
  unresolved("Data Privacy", "DPDP compliance", null, "annual",
    "Applicability follows the notified framework, which is still settling.",
    "Applicable data fiduciaries/processors under the notified framework"),
  unresolved("Industry", "FSSAI", "FSSAI", "annual",
    "A licence and return cycle that starts from the licence date, which is not recorded " +
      "here. Applies only to food businesses, and industry is not stored either.",
    "Food business operator"),
  unresolved("Industry", "RBI / NBFC", "RBI", "annual",
    "A regulatory cycle for NBFCs specifically; neither the cycle's dates nor the regulated " +
      "status are recorded here.",
    "RBI-regulated NBFC"),
  unresolved("Industry", "SEBI", "SEBI", "annual",
    "A regulatory cycle for SEBI-regulated entities; no dates are set.",
    "SEBI-regulated entity"),
  unresolved("Industry", "Factory / pollution / fire / local licences", "State", "annual",
    "State and local law, per licence, from each licence's own date. Nothing here holds a " +
      "licence register.",
    "Manufacturing/industrial/local-law applicability"),
];

/** Shipped rules that produce dates. `tests/obligation/rulepack.test.ts` asserts it, so a
 *  question turned into an invented date fails the build. */
export const INDIA_SEED_GENERATING_COUNT = INDIA_SEED_RULES.filter(
  (r) => r.dueRule !== null && r.recurrence !== "event",
).length;
