// The firm's own India compliance calendar, as rules (T3.2).
//
// ── WHAT THIS IS READING ───────────────────────────────────────────────────
//
// `bib-docs/backend/India_Compliance_Calendar_Applicability_Business_in_a_Box.xlsx`, sent by
// the firm's founder on 2026-08-30: FIFTY-FIVE obligations across twelve
// modules — Income Tax, TDS, GST, Payroll, MCA, Transfer Pricing, FEMA/RBI,
// Payments, POSH, Labour, Data Privacy and industry licences.
//
// Every one of them is a row here. That is the decision this file exists to
// carry, and it is the opposite of what the demo did.
//
// ── WHY MOST OF IT CANNOT BECOME A DUE-DATE FORMULA ────────────────────────
//
// The sheet's `Typical Timing` column is precise for some items and deliberately
// vague for others, and the vagueness is CORRECT rather than sloppy:
//
//   "11th of following month"              a formula.
//   "Within statutory period after AGM"    not one. The period depends on the
//                                          AGM date, which depends on the year
//                                          end and on extensions.
//   "State-specific"                       not one. PT is due on different days
//                                          in Maharashtra and Karnataka.
//   "Within 7 working days from month-end" not one. Working days are not days,
//                                          and there is no holiday calendar here.
//   "Within 30 days of allotment"          not one, however well it parses. An
//                                          event-driven filing has no period, so
//                                          there is nothing to count from until
//                                          the event happens — and nothing here
//                                          knows that it has.
//
// ── THE RULE THIS FILE FOLLOWS, WITHOUT EXCEPTION ──────────────────────────
//
// A DUE DATE IS ENCODED ONLY WHERE THE FIRM'S OWN SHEET STATES ONE. Not where
// it is publicly known, not where the author remembers it, not where it is
// "obvious". MSME-1 is genuinely due 31 October and 30 April and this file does
// not say so, because the sheet says "Applicable half-yearly deadlines" and the
// firm has not confirmed the rest.
//
// The standing rule on this project is that a fake VALUE is survivable and a
// fake RULE is not. A plausible-looking wrong due date costs the client a
// penalty rather than costing us an afternoon, and nobody re-reads a date that
// looks right. So this converts what the sheet computes and HANDS THE REST BACK
// BY NAME — on the rules screen, with the reason, rather than in a log.
//
// TEN rules produce dates. FORTY-SEVEN say what they still need. That ratio is
// the honest state of the firm's own specification, and showing it is worth far
// more than a calendar that looks complete: "we read your sheet, here is the one
// fact we still need for AOC-4" is a much better question to put to a partner
// than "what is your compliance calendar".
//
// ── AND EVERY ONE OF THEM IS `unconfirmed` ─────────────────────────────────
//
// Including the ten that compute. Those dates came from a previous vendor's
// document and from this sheet, not from a partner ticking them against the
// statute — and the firm's own practice may be earlier than the law. Confirming
// one is an UPDATE somebody makes on a screen. See migration 0052.
//
// ── LEAD TIME IS NOT IN HERE ───────────────────────────────────────────────
//
// T-X — how many days early the firm starts — is the firm's own working
// practice and appears nowhere in the sheet. Every rule seeds at 0, which means
// the task appears on the statutory date itself. That is visibly useless and
// deliberately so: a guessed lead time is a commitment the firm never made, and
// a zero is a blank a partner fills in on the rules screen.

import type { DueRuleKind, ObligationRecurrence } from "./model.js";

/**
 * The pack this file ships. Named for its SOURCE and its date, because that is
 * what a pack identifies — a revision of these rules is a NEW pack alongside
 * this one, never an edit to it, which is how a filing made under the old rules
 * can still explain its own due date.
 */
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
  /** Present exactly when `dueRule` is null. The sheet's own words wherever it
   *  gave them, so a partner recognises their own specification. */
  readonly unresolvedReason: string | null;
  /** What the sheet's `Applicability Threshold / Trigger` column said. Carried
   *  verbatim because nothing in this schema can yet TEST it — see the note on
   *  thresholds in `bib-docs/backend/MERGE_BUILD-PLAN.md` — and dropping it would lose the
   *  firm's own statement of who each rule reaches. */
  readonly applicabilityNote: string;
  readonly exceptions?: readonly SeedException[];
}

/** Shorthand for the "we cannot compute this yet" shape, so the forty-five
 *  unresolved rows read as data rather than as five nulls each. */
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
 * The sheet, in its own order.
 *
 * FIFTY-SEVEN rows for fifty-five sheet lines, and the two extra are not a
 * miscount. GSTR-1 and GSTR-3B each occupy one line described as
 * "Monthly / Quarterly", which is two different regimes with two different due
 * dates — the monthly one computes, and the QRMP one cannot because this system
 * does not record which clients elected it. Folding them into one row would
 * have meant either inventing the QRMP date or losing the monthly one.
 *
 * Read the `unresolvedReason` on the forty-six that do not compute: each one is
 * a question for the firm, and each one is worded so a partner can answer it
 * without knowing anything about this system. The forty-seventh, FC-GPR, is the
 * odd one — it HAS a formula and still generates nothing, because it is
 * event-driven and nothing here sees a share issue yet.
 */
export const INDIA_SEED_RULES: readonly SeedRule[] = [
  // ── Income Tax ───────────────────────────────────────────────────────────
  // Due 15 Jun / 15 Sep / 15 Dec / 15 Mar for an Apr-start year, which is
  // offset 0 from each quarter's END month — the instalment falls INSIDE its
  // own quarter, because it is an estimate. The two due-rule shapes covered it
  // without a third; see `domain/obligation/model.ts`.
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
  // THE MARCH EXCEPTION, and the reason `obligation_template_exception` exists.
  // Eleven months on the 7th, and March on 30 April.
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
  // Q1 -> 31 Jul, Q2 -> 31 Oct, Q3 -> 31 Jan, and Q4 -> 31 MAY: two months
  // after its quarter rather than one. The same shape as March's deposit.
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
    // A formula WITH no trigger — recorded so it is ready the day a share issue
    // becomes visible to this system, and generating nothing until then.
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

/** How many of the shipped rules can actually produce dates. Asserted by
 *  `tests/obligation/rulepack.test.ts` so that a careless edit which turns a
 *  question into an invented date fails the build rather than shipping. */
export const INDIA_SEED_GENERATING_COUNT = INDIA_SEED_RULES.filter(
  (r) => r.dueRule !== null && r.recurrence !== "event",
).length;
