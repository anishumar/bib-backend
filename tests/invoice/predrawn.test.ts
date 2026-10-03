// B51 (audit 2026-10-03; the user decided 2026-10-03: NEVER RENUMBER).
//
// Before 0322 a draft drew its number when it was made. Those drafts still hold
// it. Issuing one now is fine while its number is still in order in its series;
// once a later number of the same series has gone out, or the issue date falls
// in another financial year, issuing it would put the series out of order, and
// it is refused with "cancel it and raise it again". The new draft is numbered
// at issue. Nothing is ever renumbered.
import { describe, expect, it } from "vitest";
import { preDrawnNumberOrder } from "../../src/domain/invoice/model";
import { InvoiceNumberOutOfOrder } from "../../src/domain/invoice/errors";

const draft = { financialYear: 2026, sequenceNumber: 7 };

describe("whether a number drawn before 0322 may still be issued as it is (B51)", () => {
  it("is in order when nothing in its series has been issued", () => {
    expect(preDrawnNumberOrder({ draft, issueFinancialYear: 2026, latestIssued: null })).toEqual({ inOrder: true });
  });

  it("is in order when every issued number of its series is lower", () => {
    const latestIssued = { number: "INV/2026-27/0006", sequenceNumber: 6 };
    expect(preDrawnNumberOrder({ draft, issueFinancialYear: 2026, latestIssued })).toEqual({ inOrder: true });
  });

  it("is OUT OF ORDER once a later number of its series has been issued", () => {
    const latestIssued = { number: "INV/2026-27/0009", sequenceNumber: 9 };
    expect(preDrawnNumberOrder({ draft, issueFinancialYear: 2026, latestIssued })).toEqual({
      inOrder: false,
      why: "later_number_issued",
      laterNumber: "INV/2026-27/0009",
    });
  });

  it("is OUT OF ORDER when today's issue would fall in another financial year than its series", () => {
    expect(preDrawnNumberOrder({ draft, issueFinancialYear: 2027, latestIssued: null })).toEqual({
      inOrder: false,
      why: "another_year",
      issueFinancialYear: 2027,
    });
  });

  it("names the later number first when both are true", () => {
    const latestIssued = { number: "INV/2026-27/0040", sequenceNumber: 40 };
    expect(preDrawnNumberOrder({ draft, issueFinancialYear: 2027, latestIssued })).toMatchObject({
      why: "later_number_issued",
    });
  });
});

describe("the refusal a person reads (B51)", () => {
  it("names both numbers and says to cancel it and raise it again", () => {
    const e = new InvoiceNumberOutOfOrder("INV/2026-27/0007", {
      inOrder: false,
      why: "later_number_issued",
      laterNumber: "INV/2026-27/0009",
    }, "2026-27");
    expect(e.code).toBe("INVOICE_NUMBER_OUT_OF_ORDER");
    expect(e.message).toContain("INV/2026-27/0007");
    expect(e.message).toContain("INV/2026-27/0009");
    expect(e.message).toContain("Cancel this draft and raise it again");
    expect(e.message).toContain("numbered when it is issued");
    expect(e.message).not.toMatch(/—/);
  });

  it("names the year an invoice issued today belongs to", () => {
    const e = new InvoiceNumberOutOfOrder("INV/2025-26/0031", {
      inOrder: false,
      why: "another_year",
      issueFinancialYear: 2026,
    }, "2026-27");
    expect(e.message).toContain("INV/2025-26/0031");
    expect(e.message).toContain("2026-27");
    expect(e.message).toContain("Cancel this draft and raise it again");
    expect(e.message).not.toMatch(/—/);
  });
});
