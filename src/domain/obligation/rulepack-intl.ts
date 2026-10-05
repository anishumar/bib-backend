// DRAFT rule packs for the UAE, Singapore and the United States (Q074,
// 2026-10-05). Ashish (10x): "You can prepare one and I will confirm."
//
// ── WHERE THESE DATES CAME FROM, AND WHY THAT IS NOT THE INDIA PACK'S RULE ──
//
// The India pack encodes a date ONLY where the firm's own sheet states one.
// There is no firm sheet for these countries, so each row is the statute as
// the authority publishes it, with that page as `source`, and the firm is
// asked to confirm the whole list (`bib/qa/intl-rule-packs-draft-2026-10.xlsx`,
// "10x: keep / change / drop"). That is why every row ships UNCONFIRMED and on
// NO service, and why the pack loads only when a firm presses Load: it puts
// nothing on any calendar until the firm adds a filing to a service it sells.
//
// A date is a formula only where it is "N months after the period end, on day
// D" or "N days after it". Anything else (counted from an event, fixed to a day
// that moves with the year end, different per state, a schedule of
// instalments) is an `unresolvedReason` in words, never a guess.
import type { PeriodBasis } from "./model";
import type { SeedRule } from "./rulepack-in";

export interface IntlSeedRule extends SeedRule {
  readonly fiscalYearStartMonth: number;
  readonly periodBasis: PeriodBasis;
  /** The authority's own page for the rule. */
  readonly source: string;
}

export interface IntlRulePack {
  readonly jurisdiction: "AE" | "SG" | "US";
  readonly country: string;
  readonly rulePack: string;
  readonly rules: readonly IntlSeedRule[];
}

/** "N months after the period ends, on day D." */
function months(
  module: string, name: string, authority: string, recurrence: SeedRule["recurrence"],
  periodBasis: PeriodBasis, offset: number, day: number, applies: string, source: string,
): IntlSeedRule {
  return {
    module, name, authority, recurrence, periodBasis, fiscalYearStartMonth: 1,
    dueRule: "day_of_month", dueMonthOffset: offset, dueDayOfMonth: day, dueDaysAfter: null,
    unresolvedReason: null, applicabilityNote: applies, source,
  };
}

/** A real filing whose date this system cannot compute; the reason in words. */
function unresolved(
  module: string, name: string, authority: string, recurrence: SeedRule["recurrence"],
  periodBasis: PeriodBasis, reason: string, applies: string, source: string,
): IntlSeedRule {
  return {
    module, name, authority, recurrence, periodBasis, fiscalYearStartMonth: 1,
    dueRule: null, dueMonthOffset: null, dueDayOfMonth: null, dueDaysAfter: null,
    unresolvedReason: reason, applicabilityNote: applies, source,
  };
}

const UAE_CT = "https://tax.gov.ae/en/taxes/corporate.tax.aspx";

export const INTL_RULE_PACKS: readonly IntlRulePack[] = [
  {
    jurisdiction: "AE",
    country: "United Arab Emirates",
    rulePack: "ae-draft@2026.10",
    rules: [
      months("CT", "Corporate Tax return and payment", "FTA", "annual", "client_year_end", 9, 31,
        "Every CT-registered juridical person, free-zone persons included. Audited accounts with the return above AED 50m revenue or for a QFZP.", UAE_CT),
      months("CT", "Transfer pricing disclosure form", "FTA", "annual", "client_year_end", 9, 31,
        "With the CT return, where related-party transactions exceed AED 40m in total.", UAE_CT),
      months("VAT", "VAT return (VAT 201) and payment", "FTA", "quarterly", "authority_assigned", 1, 28,
        "VAT-registered: mandatory above AED 375,000 of taxable supplies in 12 months. On each client's FTA-assigned period.",
        "https://tax.gov.ae/en/taxes/vat.aspx"),
      months("EXCISE", "Excise Tax return and payment", "FTA", "monthly", "rule_calendar", 1, 15,
        "Importers, producers and stockpilers of excise goods only.", "https://tax.gov.ae/en/taxes/excise.tax.aspx"),
      unresolved("CT", "Corporate Tax registration", "FTA", "event", "rule_calendar",
        "Counted from the company's incorporation or licence date, which BiB does not watch. Within 3 months for a new company.",
        "New juridical persons.", UAE_CT),
      unresolved("UBO", "UBO register update", "Licensing registrar", "event", "rule_calendar",
        "Within 15 days of a change of beneficial owner; BiB is not told of the change.",
        "Mainland and commercial free-zone companies.", "https://www.moec.gov.ae"),
    ],
  },
  {
    jurisdiction: "SG",
    country: "Singapore",
    rulePack: "sg-draft@2026.10",
    rules: [
      unresolved("INCOME_TAX", "Form C-S / C-S (Lite) / C", "IRAS", "annual", "client_year_end",
        "Due 30 November of the year after the financial year ends, so the months from the year end differ by year end. Needs a fixed-date rule BiB does not have.",
        "Every Singapore company. C-S: revenue up to S$5m; C-S (Lite): up to S$200k; Form C otherwise.",
        "https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/corporate-income-tax-filing-season-2026"),
      months("INCOME_TAX", "Estimated Chargeable Income (ECI)", "IRAS", "annual", "client_year_end", 3, 31,
        "Every company, except revenue up to S$5m with nil ECI.",
        "https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/estimated-chargeable-income-(eci)-filing"),
      months("ACRA", "Annual General Meeting", "ACRA", "annual", "client_year_end", 6, 31,
        "Non-listed companies, unless dispensed with by written resolution.",
        "https://www.acra.gov.sg/compliance/annual-general-meetings"),
      months("ACRA", "ACRA Annual Return (with XBRL)", "ACRA", "annual", "client_year_end", 7, 31,
        "Every Singapore company (listed companies: 5 months).", "https://www.acra.gov.sg/compliance/annual-returns"),
      months("GST", "GST F5 return and payment", "IRAS", "quarterly", "authority_assigned", 1, 31,
        "GST-registered: taxable supplies above S$1m. On each client's IRAS-assigned accounting period.",
        "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst"),
      months("PAYROLL", "IR8A and appendices (AIS)", "IRAS", "annual", "rule_calendar", 3, 1,
        "Every employer; through AIS with 5 or more employees.",
        "https://www.iras.gov.sg/taxes/individual-income-tax/employers/auto-inclusion-scheme-(ais)-for-employment-income"),
      months("PAYROLL", "CPF contributions and SDL", "CPF Board", "monthly", "rule_calendar", 1, 14,
        "Employers of Singapore citizens and PRs (CPF); SDL for all employees.", "https://www.cpf.gov.sg/employer"),
      unresolved("INCOME_TAX", "Withholding tax (S45) return", "IRAS", "event", "rule_calendar",
        "15th of the second month after each payment to a non-resident; BiB does not see the payment.",
        "Payers of royalties, interest or service fees to non-residents.", "https://www.iras.gov.sg/taxes/withholding-tax"),
    ],
  },
  {
    jurisdiction: "US",
    country: "United States",
    rulePack: "us-draft@2026.10",
    rules: [
      months("INCOME_TAX", "Form 1120 (C corporation)", "IRS", "annual", "client_year_end", 4, 15,
        "C corporations. A 30 June year end is due on the 15th of the 3rd month for years beginning before 2026.",
        "https://www.irs.gov/forms-pubs/about-form-1120"),
      months("INCOME_TAX", "Form 5472 (with Form 1120)", "IRS", "annual", "client_year_end", 4, 15,
        "25% foreign-owned US corporations and foreign-owned single-member LLCs.", "https://www.irs.gov/forms-pubs/about-form-5472"),
      months("INCOME_TAX", "Form 1120-S (S corporation)", "IRS", "annual", "client_year_end", 3, 15,
        "S corporations.", "https://www.irs.gov/forms-pubs/about-form-1120-s"),
      months("INCOME_TAX", "Form 1065 (partnership)", "IRS", "annual", "client_year_end", 3, 15,
        "Partnerships and multi-member LLCs.", "https://www.irs.gov/forms-pubs/about-form-1065"),
      unresolved("INCOME_TAX", "Corporate estimated tax instalments", "IRS", "quarterly", "client_year_end",
        "Due the 15th of the 4th, 6th, 9th and 12th months of the tax year: the first instalment's gap differs from the other three.",
        "C corporations expecting $500 or more of tax.", "https://www.irs.gov/forms-pubs/about-form-1120-w"),
      months("PAYROLL", "Payroll tax deposit (monthly depositor)", "IRS", "monthly", "rule_calendar", 1, 15,
        "Employers under the $50,000 lookback threshold; semi-weekly depositors differ.",
        "https://www.irs.gov/businesses/small-businesses-self-employed/depositing-and-reporting-employment-taxes"),
      months("PAYROLL", "Form 941 (quarterly payroll)", "IRS", "quarterly", "rule_calendar", 1, 31,
        "Employers (Form 944 instead if the IRS says so).", "https://www.irs.gov/forms-pubs/about-form-941"),
      months("PAYROLL", "Form 940 (FUTA)", "IRS", "annual", "rule_calendar", 1, 31,
        "Employers paying $1,500 or more in a quarter.", "https://www.irs.gov/forms-pubs/about-form-940"),
      months("PAYROLL", "Forms W-2 and W-3", "IRS / SSA", "annual", "rule_calendar", 1, 31,
        "Every employer.", "https://www.irs.gov/forms-pubs/about-form-w-2"),
      months("PAYROLL", "Form 1099-NEC", "IRS", "annual", "rule_calendar", 1, 31,
        "Payers to non-employees above the reporting threshold ($600; check the 2026 change).",
        "https://www.irs.gov/forms-pubs/about-form-1099-nec"),
      months("CORP", "FBAR (FinCEN 114)", "FinCEN", "annual", "rule_calendar", 4, 15,
        "US entities with foreign accounts above $10,000 in total; extended to 15 October automatically.",
        "https://www.fincen.gov/report-foreign-bank-and-financial-accounts"),
      months("STATE", "Delaware franchise tax and annual report", "Delaware Division of Corporations", "annual", "rule_calendar", 3, 1,
        "Delaware corporations.", "https://corp.delaware.gov/paytaxes/"),
      months("STATE", "Delaware LLC annual tax", "Delaware Division of Corporations", "annual", "rule_calendar", 6, 1,
        "Delaware LLCs and LPs.", "https://corp.delaware.gov/paytaxes/"),
      unresolved("STATE", "State franchise / income tax and annual report", "State", "annual", "rule_calendar",
        "Different in every state (e.g. California's $800 minimum franchise tax); a firm writes one rule per state it files in.",
        "Companies formed or registered in each state.", "https://www.nass.org/business-services/corporate-registration"),
    ],
  },
];
