// F12: a refused amount says what is wrong with it, in words, rather than
// "must be a decimal STRING ... a float cannot hold 1499.50 exactly".
import { describe, expect, it } from "vitest";
import { amountProblem } from "../../src/domain/money/model";
import { InvalidInvoiceAmount } from "../../src/domain/invoice/errors";
import { InvalidAmount } from "../../src/domain/engagement/errors";
import { InvalidDiscount, InvalidFxRate, InvalidQuantity, InvalidUnitAmount } from "../../src/domain/proposal/errors";

describe("amountProblem", () => {
  it("names a zero, a negative, a percentage over 100 and a non-number", () => {
    expect(amountProblem("The amount", "0")).toBe("The amount cannot be 0.");
    expect(amountProblem("The rate", "-5")).toBe("The rate cannot be less than 0.");
    expect(amountProblem("The discount", "120", { percent: true })).toBe("The discount cannot be more than 100%.");
    expect(amountProblem("The fee", "12,000.5.0")).toBe(
      'The fee "12,000.5.0" is not a number. Use digits, with up to 4 decimal places, e.g. 1499.50.',
    );
    expect(amountProblem("The fee", "1.123456")).toBe(
      'The fee "1.123456" is not a number. Use digits, with up to 4 decimal places, e.g. 1499.50.',
    );
  });

  it("never talks about strings or floats", () => {
    const all = [
      new InvalidInvoiceAmount("amount", "0").message,
      new InvalidInvoiceAmount("fxRate", "0").message,
      new InvalidInvoiceAmount("taxPercent", "180").message,
      new InvalidAmount("unit amount", "abc").message,
      new InvalidQuantity("0").message,
      new InvalidUnitAmount("-1").message,
      new InvalidDiscount("101").message,
      new InvalidFxRate("0").message,
    ];
    for (const m of all) {
      expect(m).not.toMatch(/STRING|float|decimal string/i);
    }
    expect(new InvalidInvoiceAmount("amount", "0").message).toBe("The amount cannot be 0.");
    expect(new InvalidInvoiceAmount("fxRate", "0").message).toBe("The exchange rate cannot be 0.");
    expect(new InvalidInvoiceAmount("taxPercent", "180").message).toBe("The tax rate cannot be more than 100%.");
  });
});
