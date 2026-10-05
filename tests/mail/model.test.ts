// Who a client email is from (Q059): the pure rules.
import { describe, expect, it } from "vitest";
import {
  emailDomain,
  mayUseOwnAddress,
  normalizeSendDomain,
  sendDomainProblem,
  senderDisplayName,
} from "../../src/domain/mail/model";

describe("the domains a firm may send from", () => {
  it("stores what a person typed as a bare lower-case domain", () => {
    expect(normalizeSendDomain("  @10XGlobal.IN ")).toBe("10xglobal.in");
  });

  it("refuses what is not a mail domain, in words", () => {
    expect(sendDomainProblem("10xglobal.in")).toBeNull();
    expect(sendDomainProblem("mail.10xglobal.co.uk")).toBeNull();
    expect(sendDomainProblem("")).toMatch(/blank/);
    expect(sendDomainProblem("priya@10xglobal.in")).toMatch(/email address/);
    expect(sendDomainProblem("localhost")).toMatch(/not a mail domain/);
    expect(sendDomainProblem("10x global.in")).toMatch(/not a mail domain/);
    expect(sendDomainProblem("-bad.in")).toMatch(/not a mail domain/);
  });

  it("lets an address be the From only when its own domain is listed, case aside", () => {
    expect(emailDomain("Priya@10XGlobal.in")).toBe("10xglobal.in");
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(mayUseOwnAddress("Priya@10XGlobal.in", ["10xglobal.in"])).toBe(true);
    expect(mayUseOwnAddress("priya@gmail.com", ["10xglobal.in"])).toBe(false);
    // A subdomain is a different domain to SPF and DKIM.
    expect(mayUseOwnAddress("priya@mail.10xglobal.in", ["10xglobal.in"])).toBe(false);
    expect(mayUseOwnAddress("priya@10xglobal.in", [])).toBe(false);
  });

  it("names the person and the firm, else whichever is known", () => {
    const priya = { name: "Priya Sharma", email: "priya@10xglobal.in", ownAddress: false };
    expect(senderDisplayName(priya, "10x Global")).toBe("Priya Sharma, 10x Global");
    expect(senderDisplayName({ ...priya, name: "  " }, "10x Global")).toBe("priya@10xglobal.in, 10x Global");
    expect(senderDisplayName(priya, null)).toBe("Priya Sharma");
    expect(senderDisplayName(null, "10x Global")).toBe("10x Global");
  });
});
