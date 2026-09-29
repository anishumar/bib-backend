import { describe, expect, it } from "vitest";
import { callingCodeOf, isValidPhone, normalizePhone } from "../../src/domain/party/phone";
import { isValidIdentifier, normalizeIdentifier } from "../../src/domain/party/model";
import { InvalidIdentifier } from "../../src/domain/party/errors";

const ok = (typed: string, country?: string | null): string => {
  const n = normalizePhone(typed, country);
  expect(isValidPhone(n), `${typed} (${country ?? "no country"}) → ${n}`).toBe(true);
  return n;
};
const refused = (typed: string, country?: string | null): void => {
  expect(isValidPhone(normalizePhone(typed, country)), typed).toBe(false);
};

describe("a phone is stored in E.164", () => {
  it("strips what people type between the digits", () => {
    expect(ok("+91 98200-12345")).toBe("+919820012345");
    expect(ok("+91 (982) 001.2345")).toBe("+919820012345");
    expect(ok("0091 98200 12345")).toBe("+919820012345");
  });

  it("completes a number typed without its code only when the country is known", () => {
    expect(ok("98200 12345", "IN")).toBe("+919820012345");
    expect(ok("098200 12345", "IN")).toBe("+919820012345");
    expect(ok("919820012345", "IN")).toBe("+919820012345");
    expect(ok("050 123 4567", "AE")).toBe("+971501234567");
    expect(ok("8123 4567", "SG")).toBe("+6581234567");
    expect(ok("1 (212) 555-0142", "US")).toBe("+12125550142");
    expect(ok("98200 12345", "IN-MH")).toBe("+919820012345");
    // No country, no guess.
    refused("9820012345");
    refused("9820012345", "ZZ");
  });

  it("holds the firm's countries to the right length and leading digit", () => {
    refused("+91 98200 1234"); // nine digits
    refused("+91 98200 123456"); // eleven
    refused("+91 09820 01234"); // trunk zero kept
    ok("+91 11 2345 6789"); // a Delhi landline
    ok("+971 50 123 4567");
    ok("+971 4 123 4567"); // a Dubai landline
    refused("+971 50 123 456");
    ok("+65 9123 4567");
    refused("+65 5123 4567");
    refused("+65 9123 456");
    ok("+1 415 555 0132");
    refused("+1 115 555 0132"); // area code cannot start with 1
    ok("+44 20 7946 0958");
  });

  it("gives other countries the general check only", () => {
    ok("+61 412 345 678");
    ok("+49 30 1234567");
    refused("+0 123 4567"); // no calling code starts with 0
    refused("+49 12"); // too short for anywhere
    refused("+49 1234 5678 9012 34"); // sixteen digits
  });

  it("refuses letters rather than dropping them", () => {
    refused("abc");
    refused("+91 98200 1234O"); // a letter O
    refused("98200 12345 ext 4", "IN");
  });

  it("knows the calling codes it completes with", () => {
    expect(callingCodeOf("in")).toBe("91");
    expect(callingCodeOf("CA")).toBe("1");
    expect(callingCodeOf(null)).toBeNull();
    expect(callingCodeOf("FR")).toBeNull();
  });
});

describe("the identifier rules use it", () => {
  it("normalises and validates a phone through the identifier functions", () => {
    const v = normalizeIdentifier("phone", "98200 12345", "IN");
    expect(v).toBe("+919820012345");
    expect(isValidIdentifier("phone", v)).toBe(true);
    expect(isValidIdentifier("phone", normalizeIdentifier("phone", "12345"))).toBe(false);
  });

  it("holds a GSTIN to its structure, not only its length", () => {
    expect(isValidIdentifier("gstin", "27ABCDE1234F1Z5")).toBe(true);
    expect(isValidIdentifier("gstin", "27ABCDE1234F1X5")).toBe(false); // 14th is always Z
    expect(isValidIdentifier("gstin", "2XABCDE1234F1Z5")).toBe(false); // state code is digits
    expect(isValidIdentifier("gstin", "27ABCD12345F1Z5")).toBe(false); // the PAN inside is malformed
    expect(isValidIdentifier("gstin", "999999999999999")).toBe(false);
  });

  it("tells the person what a good value looks like", () => {
    expect(new InvalidIdentifier("phone", "12345").message).toBe(
      '"12345" is not a valid phone. Write it with the country code, for example +91 98200 12345.',
    );
    expect(new InvalidIdentifier("pan", "ABC").message).toContain("ABCDE1234F");
    expect(new InvalidIdentifier("cin", "x").message).toBe('"x" is not a valid CIN.');
  });
});
