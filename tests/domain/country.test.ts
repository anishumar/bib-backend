// F04 / CA#44: a country is a CURRENT ISO 3166-1 alpha-2 code, never a retired
// or reserved one that no rule keyed on the real code will ever match.
import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, countryCodeProblem, isCountryCode } from "../../src/domain/country";
import { isJurisdiction } from "../../src/domain/document/model";

describe("country codes", () => {
  it("holds exactly the 249 codes ISO 3166-1 assigns", () => {
    expect(COUNTRY_CODES.size).toBe(249);
    for (const code of ["IN", "AE", "GB", "US", "SG", "DE", "RS", "MM", "CW", "TL"]) {
      expect(isCountryCode(code), code).toBe(true);
    }
  });

  it("refuses the retired and reserved codes the old picker saved", () => {
    for (const code of ["DD", "UK", "SU", "YU", "CS", "BU", "AN", "RH", "NH", "VD", "YD", "FX", "DY", "HV", "ZR", "TP"]) {
      expect(isCountryCode(code), code).toBe(false);
      expect(isJurisdiction(code), code).toBe(false);
    }
  });

  it("refuses groupings, user-assigned and lower-case codes", () => {
    for (const code of ["EU", "UN", "ZZ", "XK", "QO", "in", "Gb", "IND", ""]) {
      expect(isCountryCode(code), code).toBe(false);
    }
  });

  it("says what was meant, in words, for a retired code", () => {
    expect(countryCodeProblem("dd")).toBe(`"DD" is no longer a country code. For Germany, use DE.`);
    expect(countryCodeProblem("UK")).toBe(`"UK" is not the code for the United Kingdom. Use GB.`);
    expect(countryCodeProblem("QQ")).toMatch(/^"QQ" is not a country code\. Pick the country from the list/);
  });
});
