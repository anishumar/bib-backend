// ONE money formatter for documents (B19, CA#49, CA#60; audit 2026-10-03), and
// the total in words on a tax invoice (B12 / CA#1). Pure, no PDF.
import { describe, expect, it } from "vitest";
import { amountInWords, documentMoney } from "../../src/domain/render/money";

describe("documentMoney: the screens' shape, on paper", () => {
  it("prints rupees with the sign, in lakhs and crores", () => {
    expect(documentMoney("1250000", "INR")).toBe("₹12,50,000");
    expect(documentMoney("125000000.0000", "INR")).toBe("₹12,50,00,000");
    expect(documentMoney("999", "INR")).toBe("₹999");
    expect(documentMoney("15000.00", "INR")).toBe("₹15,000");
  });

  it("prints paise only when there are some, unless the document always shows two places", () => {
    expect(documentMoney("12000.0000", "INR")).toBe("₹12,000");
    expect(documentMoney("1250000.5", "INR")).toBe("₹12,50,000.50");
    expect(documentMoney("5900", "INR", { minorUnits: "always" })).toBe("₹5,900.00");
    expect(documentMoney("91354.8300", "INR", { minorUnits: "always" })).toBe("₹91,354.83");
  });

  it("prints every other currency with its code, grouped its own way", () => {
    expect(documentMoney("1250000", "USD")).toBe("USD 1,250,000");
    expect(documentMoney("5000.25", "AED")).toBe("AED 5,000.25");
    expect(documentMoney("5000", "SGD", { minorUnits: "always" })).toBe("SGD 5,000.00");
  });

  it("keeps a negative sign in front, and never routes the amount through a JS number", () => {
    expect(documentMoney("-1500.50", "INR")).toBe("-₹1,500.50");
    // A float would print 0.30000000000000004 somewhere; a decimal string cannot.
    expect(documentMoney("123456789012345.67", "INR")).toBe("₹12,34,56,78,90,12,345.67");
  });
});

describe("amountInWords: the total, written out", () => {
  it("counts rupees in lakhs and crores, as an Indian invoice is read", () => {
    expect(amountInWords("5900", "INR")).toBe("Indian Rupees Five Thousand Nine Hundred Only");
    expect(amountInWords("1250000", "INR")).toBe("Indian Rupees Twelve Lakh Fifty Thousand Only");
    expect(amountInWords("125000000", "INR")).toBe("Indian Rupees Twelve Crore Fifty Lakh Only");
    expect(amountInWords("32354.83", "INR")).toBe(
      "Indian Rupees Thirty-Two Thousand Three Hundred Fifty-Four and Eighty-Three Paise Only",
    );
  });

  it("counts other currencies in thousands and millions, with their own minor unit", () => {
    expect(amountInWords("1250000", "USD")).toBe("US Dollars One Million Two Hundred Fifty Thousand Only");
    expect(amountInWords("1001.05", "AED")).toBe("UAE Dirhams One Thousand One and Five Fils Only");
    expect(amountInWords("20", "XYZ")).toBe("XYZ Twenty Only");
  });

  it("says zero, and a hundred crore", () => {
    expect(amountInWords("0", "INR")).toBe("Indian Rupees Zero Only");
    expect(amountInWords("1000000000", "INR")).toBe("Indian Rupees One Hundred Crore Only");
  });
});
