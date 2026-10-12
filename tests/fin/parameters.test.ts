// F4.1: the dated statutory values, read strictly and looked up by day. Golden
// cases on each side of every date boundary 0387 seeds.
import { describe, expect, it } from "vitest";
import { RuleParameterUnreadable } from "../../src/domain/fin/errors";
import { RuleParameters, cpfBandFor } from "../../src/domain/fin/parameters";
import type { RuleParameterRow } from "../../src/domain/fin/parameters";
import { fromCents, rateText } from "../../src/domain/fin/checks-money";
import { SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";

const sg = RuleParameters.from("SG", SINGAPORE_PARAMETERS);

const gst = (day: string): string | null => {
  const v = sg.value("gst.standard_rate", day);
  return v === null ? null : rateText(v.rate);
};
const ceiling = (day: string): string | null => {
  const v = sg.value("cpf.ow_ceiling", day);
  return v === null ? null : fromCents(v.amount);
};
const bands = (day: string): string[] | null => {
  const v = sg.value("cpf.rates", day);
  return v === null ? null : v.bands.map((b) => `${String(b.aboveAge)}:${rateText(b.employer)}/${rateText(b.employee)}`);
};

describe("the GST rate on each side of every change", () => {
  it.each([
    ["2007-06-30", null],
    ["2007-07-01", "7"],
    ["2022-12-31", "7"],
    ["2023-01-01", "8"],
    ["2023-12-31", "8"],
    ["2024-01-01", "9"],
    ["2025-04-21", "9"],
    ["2026-01-06", "9"],
  ] as const)("%s → %s", (day, rate) => {
    expect(gst(day)).toBe(rate);
  });

  it("names where each value came from, and the day it took effect", () => {
    const inForce = sg.inForce("gst.standard_rate", "2024-01-01");
    expect(inForce?.validFrom).toBe("2024-01-01");
    expect(inForce?.source).toBe("0387");
  });
});

describe("the CPF Ordinary Wage ceiling", () => {
  it.each([
    ["2023-12-31", null],
    ["2024-01-01", "6800.00"],
    ["2024-12-31", "6800.00"],
    ["2025-01-01", "7400.00"],
    ["2025-12-31", "7400.00"],
    ["2026-01-01", "8000.00"],
    ["2030-06-01", "8000.00"],
  ] as const)("%s → %s", (day, amount) => {
    expect(ceiling(day)).toBe(amount);
  });

  it("the annual salary ceiling is S$102,000", () => {
    expect(fromCents(sg.value("cpf.annual_salary_ceiling", "2025-08-01")?.amount ?? 0n)).toBe("102000.00");
  });
});

describe("the CPF rate table", () => {
  it("is 2025's on 31 December 2025 and 2026's on 1 January 2026", () => {
    expect(bands("2025-12-31")).toEqual(["0:17/20", "55:15.5/17", "60:12/11.5", "65:9/7.5", "70:7.5/5"]);
    expect(bands("2026-01-01")).toEqual(["0:17/20", "55:16/18", "60:12.5/12.5", "65:9/7.5", "70:7.5/5"]);
  });

  it("is not seeded before 2025 or from 2027, so nothing is assumed there", () => {
    expect(bands("2024-12-31")).toBeNull();
    expect(bands("2027-01-01")).toBeNull();
  });

  it("applies wages above S$750", () => {
    expect(fromCents(sg.value("cpf.rates", "2025-06-01")?.aboveMonthlyWage ?? 0n)).toBe("750.00");
  });

  it("chooses the band the employee is ABOVE", () => {
    const rates = sg.value("cpf.rates", "2025-06-01");
    if (rates === null) throw new Error("2025 rates are seeded");
    expect(cpfBandFor(rates, 54).aboveAge).toBe(0);
    expect(cpfBandFor(rates, 55).aboveAge).toBe(55);
    expect(cpfBandFor(rates, 59).aboveAge).toBe(55);
    expect(cpfBandFor(rates, 60).aboveAge).toBe(60);
    expect(cpfBandFor(rates, 65).aboveAge).toBe(65);
    expect(cpfBandFor(rates, 70).aboveAge).toBe(70);
    expect(cpfBandFor(rates, 91).aboveAge).toBe(70);
  });
});

describe("who contributes, and the SDL", () => {
  it("citizens and permanent residents contribute; the three passes do not", () => {
    expect(sg.value("cpf.contributing_passes", "2025-03-01")?.passTypes).toEqual(["citizen", "pr"]);
  });

  it("the SDL is 0.25%, at least S$2 and at most S$11.25, from October 2008", () => {
    expect(sg.value("sdl.levy", "2008-09-30")).toBeNull();
    const sdl = sg.value("sdl.levy", "2008-10-01");
    expect(sdl === null ? null : [rateText(sdl.rate), fromCents(sdl.minimum), fromCents(sdl.maximum)]).toEqual([
      "0.25",
      "2.00",
      "11.25",
    ]);
  });
});

describe("reading strictly", () => {
  const row = (over: Partial<RuleParameterRow>): RuleParameterRow => ({
    jurisdiction: "SG",
    key: "gst.standard_rate",
    validFrom: "2024-01-01",
    validTo: null,
    value: { percent: "9" },
    source: "test",
    ...over,
  });

  it("refuses a value that is not the shape its key promises, naming the row", () => {
    const err = (() => {
      try {
        RuleParameters.from("SG", [row({ value: { percent: 9 } })]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RuleParameterUnreadable);
    expect((err as Error).message).toContain("gst.standard_rate in force from 2024-01-01");
  });

  it("refuses bands out of order, or a table not starting at 0", () => {
    const rates = (bands: unknown) => row({ key: "cpf.rates", value: { aboveMonthlyWage: "750", bands } });
    const band = (aboveAge: number) => ({ aboveAge, employer: "17", employee: "20" });
    expect(() => RuleParameters.from("SG", [rates([band(55)])])).toThrow(RuleParameterUnreadable);
    expect(() => RuleParameters.from("SG", [rates([band(0), band(60), band(55)])])).toThrow(RuleParameterUnreadable);
    expect(() => RuleParameters.from("SG", [rates([])])).toThrow(RuleParameterUnreadable);
  });

  it("refuses an unknown pass type and an SDL whose maximum is below its minimum", () => {
    expect(() =>
      RuleParameters.from("SG", [row({ key: "cpf.contributing_passes", value: { passTypes: ["citizen", "tourist"] } })]),
    ).toThrow(RuleParameterUnreadable);
    expect(() =>
      RuleParameters.from("SG", [row({ key: "sdl.levy", value: { percent: "0.25", minimum: "11.25", maximum: "2" } })]),
    ).toThrow(RuleParameterUnreadable);
  });

  it("refuses another jurisdiction's row, two rows on one day, and a row ending before it starts", () => {
    expect(() => RuleParameters.from("SG", [row({ jurisdiction: "IN" })])).toThrow(RuleParameterUnreadable);
    expect(() =>
      RuleParameters.from("SG", [row({ validTo: "2025-01-01" }), row({ validFrom: "2024-06-01" })]),
    ).toThrow(RuleParameterUnreadable);
    expect(() => RuleParameters.from("SG", [row({ validTo: "2023-01-01" })])).toThrow(RuleParameterUnreadable);
  });

  it("carries a key no check reads yet, and ignores it", () => {
    const set = RuleParameters.from("SG", [row({}), row({ key: "wht.rate", value: { anything: true } })]);
    expect(set.value("gst.standard_rate", "2025-01-01")).not.toBeNull();
  });

  it("is half-open: the last day of a row is in, its end day is the next row's", () => {
    const set = RuleParameters.from("SG", [
      row({ validFrom: "2023-01-01", validTo: "2024-01-01", value: { percent: "8" } }),
      row({ validFrom: "2024-01-01", value: { percent: "9" } }),
    ]);
    expect(rateText(set.value("gst.standard_rate", "2023-12-31")?.rate ?? { units: 0n, scale: 0 })).toBe("8");
    expect(rateText(set.value("gst.standard_rate", "2024-01-01")?.rate ?? { units: 0n, scale: 0 })).toBe("9");
  });
});
