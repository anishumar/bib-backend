// The payroll checks, lane `rule` (docs/FIN_BUILD_PLAN.md F4.5). Pure.
//
//   payroll.cpf_work_permit         CPF on a Work Permit holder (not a member)
//   payroll.cpf_employment_pass     CPF on an Employment Pass holder
//   payroll.cpf_s_pass              CPF on an S Pass holder
//   payroll.cpf_ow_ceiling          CPF worked out on Ordinary Wages above the
//                                   month's ceiling
//   payroll.cpf_age_band            CPF at another age band's rates
//   payroll.cpf_amount              CPF that is none of the rules above, and
//                                   still not what the rates and ceiling give
//   payroll.sdl_missing             no Skills Development Levy for an employee
//   payroll.sdl_amount              a levy that is not 0.25% within its bounds
//
// One finding per employee per month, so it points at the row on the sheet.
//
// ── THE CPF ARITHMETIC, AS THE CPF BOARD STATES IT ──────────────────────────
//
// For a citizen or permanent resident earning more than S$750 in the month:
// Ordinary Wages count up to the month's ceiling (S$7,400 in 2025, S$8,000
// from 2026), Additional Wages (a bonus) count up to what is left of the year's
// S$102,000 after the year's Ordinary Wages; the TOTAL contribution is the
// band's total rate on that, rounded to the nearest dollar (fifty cents up),
// the EMPLOYEE's share is the employee rate rounded DOWN to the dollar, and the
// employer pays the rest. Every value comes from `RuleParameters`; nothing here
// knows a rate.
//
// ── WHICH AGE BAND, AND THE AGE THE LINE MUST CARRY ─────────────────────────
//
// The Board moves an employee to the next band from the first day of the month
// AFTER the month of their 55th, 60th, 65th or 70th birthday. So `age` is read
// as the employee's completed years on the LAST DAY OF THE MONTH BEFORE the
// month paid: whoever was 60 on that day had their birthday in an earlier month
// and is "above 60". (Age on the first of the month gives the same band except
// for a birthday on the first itself.)
//
// ── WHAT IS NOT CHECKED, AND WHY ────────────────────────────────────────────
//
// Wages of S$750 or less (graduated rates, not seeded), an employee with no
// pass type or no age, CPF figures the sheet did not show (null is "not read",
// and a sheet missing a column is staging's question), and a month no seeded
// rate covers. A permanent resident in their first two years contributes at
// lower graduated rates the line cannot show, so is held to the full rates and
// flagged when they differ: `passType: "pr"` on the finding says so.
import { assertCheckable, inStableOrder, monthBounds } from "./checks-input";
import type { CheckedPayrollLine, PayrollCheckInput } from "./checks-input";
import { CheckInputInvalid } from "./errors";
import { addRates, fromCents, percentOf, percentOfInDollars, toCents } from "./checks-money";
import type { Cents } from "./checks-money";
import type { FindingDraft, FindingFact } from "./finding";
import type { PassType } from "./lines";
import { cpfBandFor } from "./parameters";
import type { CpfBand, CpfRatesValue } from "./parameters";

const NOT_A_MEMBER_CHECK: Readonly<Record<Exclude<PassType, "citizen" | "pr">, string>> = {
  work_permit: "payroll.cpf_work_permit",
  employment_pass: "payroll.cpf_employment_pass",
  s_pass: "payroll.cpf_s_pass",
};

export function checkPayroll(input: PayrollCheckInput): FindingDraft[] {
  assertCheckable(input.client, input.period, [...input.lines, ...input.history]);
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    const month = monthBounds(line.period);
    if (month === null) {
      throw new CheckInputInvalid(`payroll line ${line.id} is for "${line.period}", which is not a YYYY-MM month`);
    }
    const passCheck = cpfOnANonMember(input, line, month);
    if (passCheck !== null) out.push(passCheck);
    else {
      const cpf = cpfAmount(input, line, month);
      if (cpf !== null) out.push(cpf);
    }
    const sdl = sdlCheck(input, line, month);
    if (sdl !== null) out.push(sdl);
  }
  return inStableOrder(out);
}

interface Month {
  readonly start: string;
  readonly end: string;
}

function finding(
  input: PayrollCheckInput,
  line: CheckedPayrollLine,
  month: Month,
  checkKey: string,
  facts: Record<string, FindingFact>,
): FindingDraft {
  return {
    lane: "rule",
    checkKey,
    clientPartyId: input.client.clientPartyId,
    periodStart: month.start,
    periodEnd: month.end,
    lineIds: [line.id],
    facts: { period: line.period, employeeRef: line.employeeRef, passType: line.passType, ...facts },
    dedupeKey: `${checkKey}:${line.id}`,
  };
}

// ── CPF on somebody who is not a member ──────────────────────────────────────

function cpfOnANonMember(input: PayrollCheckInput, line: CheckedPayrollLine, month: Month): FindingDraft | null {
  if (line.passType === null || line.passType === "citizen" || line.passType === "pr") return null;
  const passes = input.parameters.value("cpf.contributing_passes", month.start);
  if (passes === null || passes.passTypes.includes(line.passType)) return null;
  const employee = toCents(line.cpfEmployee);
  const employer = toCents(line.cpfEmployer);
  if ((employee === null || employee === 0n) && (employer === null || employer === 0n)) return null;
  return finding(input, line, month, NOT_A_MEMBER_CHECK[line.passType], {
    cpfEmployee: employee === null ? null : fromCents(employee),
    cpfEmployer: employer === null ? null : fromCents(employer),
  });
}

// ── CPF amounts ──────────────────────────────────────────────────────────────

interface Contribution {
  readonly employee: Cents;
  readonly employer: Cents;
}

function contribution(band: CpfBand, wages: Cents): Contribution {
  const total = percentOfInDollars(wages, addRates(band.employer, band.employee), "half_away_from_zero");
  const employee = percentOfInDollars(wages, band.employee, "down");
  return { employee, employer: total - employee };
}

function same(a: Contribution, b: Contribution): boolean {
  return a.employee === b.employee && a.employer === b.employer;
}

/**
 * The Additional Wages that count this month: what is left of the year's
 * ceiling after the year's Ordinary Wages, estimated the way payroll software
 * does it, as the months already paid (from `history` and the run's own lines)
 * plus this month's capped Ordinary Wages for this and every remaining month.
 * Months the run was not given count as nothing, which leans toward letting a
 * bonus count in full: a check that errs never raises a finding the Board's
 * own arithmetic would not.
 */
function additionalWagesCounted(
  input: PayrollCheckInput,
  line: CheckedPayrollLine,
  ordinaryCapped: Cents,
  additional: Cents,
  month: Month,
): Cents | null {
  if (additional <= 0n) return 0n;
  const annual = input.parameters.value("cpf.annual_salary_ceiling", month.start);
  if (annual === null) return null;
  const year = line.period.slice(0, 4);
  const monthNo = Number(line.period.slice(5, 7));
  let earlier = 0n;
  for (const other of [...input.history, ...input.lines]) {
    if (other.id === line.id || other.employeeRef !== line.employeeRef) continue;
    if (other.period.slice(0, 4) !== year || other.period >= line.period) continue;
    const bounds = monthBounds(other.period);
    const ceiling = bounds === null ? null : input.parameters.value("cpf.ow_ceiling", bounds.start);
    const ow = toCents(other.ordinaryWage);
    if (ceiling === null || ow === null || ow <= 0n) continue;
    earlier += ow < ceiling.amount ? ow : ceiling.amount;
  }
  const estimatedYear = earlier + ordinaryCapped * BigInt(13 - monthNo);
  const room = annual.amount - estimatedYear;
  if (room <= 0n) return 0n;
  return additional < room ? additional : room;
}

function cpfAmount(input: PayrollCheckInput, line: CheckedPayrollLine, month: Month): FindingDraft | null {
  if (line.passType !== "citizen" && line.passType !== "pr") return null;
  if (line.age === null) return null;
  const passes = input.parameters.value("cpf.contributing_passes", month.start);
  if (passes === null || !passes.passTypes.includes(line.passType)) return null;
  const rates: CpfRatesValue | null = input.parameters.value("cpf.rates", month.start);
  const ceiling = input.parameters.value("cpf.ow_ceiling", month.start);
  if (rates === null || ceiling === null) return null;
  const ordinary = toCents(line.ordinaryWage);
  const employee = toCents(line.cpfEmployee);
  const employer = toCents(line.cpfEmployer);
  if (ordinary === null || employee === null || employer === null) return null;
  const additional = toCents(line.additionalWage) ?? 0n;
  if (ordinary + additional <= rates.aboveMonthlyWage) return null;

  const ordinaryCapped = ordinary < ceiling.amount ? ordinary : ceiling.amount;
  const additionalCounted = additionalWagesCounted(input, line, ordinaryCapped, additional, month);
  if (additionalCounted === null) return null;

  const band = cpfBandFor(rates, line.age);
  const expected = contribution(band, ordinaryCapped + additionalCounted);
  const actual: Contribution = { employee, employer };
  if (same(actual, expected)) return null;

  const facts = {
    age: line.age,
    ordinaryWage: fromCents(ordinary),
    additionalWage: fromCents(additional),
    owCeiling: fromCents(ceiling.amount),
    cpfEmployee: fromCents(employee),
    cpfEmployer: fromCents(employer),
    expectedEmployee: fromCents(expected.employee),
    expectedEmployer: fromCents(expected.employer),
    bandAboveAge: band.aboveAge,
  };

  // Which rule was broken, when the figures say. Only an EXACT match with the
  // broken rule's own arithmetic names it; anything else is `cpf_amount`.
  if (ordinary > ceiling.amount) {
    const uncapped = contribution(band, ordinary + additionalCounted);
    if (
      employee + employer === uncapped.employee + uncapped.employer ||
      employer === uncapped.employer ||
      (employee === uncapped.employee && employee !== expected.employee)
    ) {
      return finding(input, line, month, "payroll.cpf_ow_ceiling", facts);
    }
  }
  const applied = rates.bands.find((b) => b !== band && same(actual, contribution(b, ordinaryCapped + additionalCounted)));
  if (applied !== undefined) {
    return finding(input, line, month, "payroll.cpf_age_band", { ...facts, appliedBandAboveAge: applied.aboveAge });
  }
  return finding(input, line, month, "payroll.cpf_amount", facts);
}

// ── SDL ──────────────────────────────────────────────────────────────────────

/**
 * The Skills Development Levy is due for every employee, foreigners included:
 * 0.25% of the month's total wages, at least S$2 and at most S$11.25. The
 * statute does not say which way a half cent goes, so an amount a cent either
 * side of the arithmetic is accepted; zero is `sdl_missing`.
 */
function sdlCheck(input: PayrollCheckInput, line: CheckedPayrollLine, month: Month): FindingDraft | null {
  const sdlRule = input.parameters.value("sdl.levy", month.start);
  if (sdlRule === null) return null;
  const wages =
    toCents(line.grossPay) ??
    (line.ordinaryWage === null ? null : (toCents(line.ordinaryWage) ?? 0n) + (toCents(line.additionalWage) ?? 0n));
  const sdl = toCents(line.sdl);
  if (wages === null || wages <= 0n || sdl === null) return null;
  const levy = percentOf(wages, sdlRule.rate, "half_away_from_zero");
  const expected = levy < sdlRule.minimum ? sdlRule.minimum : levy > sdlRule.maximum ? sdlRule.maximum : levy;
  const facts = { wages: fromCents(wages), sdl: fromCents(sdl), expectedSdl: fromCents(expected) };
  if (sdl === 0n) return finding(input, line, month, "payroll.sdl_missing", facts);
  const off = sdl - expected;
  if (off > 1n || off < -1n) {
    return finding(input, line, month, "payroll.sdl_amount", { ...facts, difference: fromCents(sdl - expected) });
  }
  return null;
}
