/**
 * Phone numbers, stored the one way the rest of the world reads them: E.164.
 *
 * "+919820012345" — a plus, the country's calling code, then the national
 * number with no trunk "0" and nothing between the digits. It is what
 * WhatsApp, SMS gateways and every dialler take, and it is the only form in
 * which "098200 12345", "+91 98200-12345" and "91 9820012345" are visibly the
 * same person — which matters here, because a phone is a DEDUP key.
 *
 * Checked at two strengths. Every number must be E.164 at all: a "+", a code
 * that does not start with 0, and 7 to 15 digits in total. For the countries
 * this firm works in, the national number must also be the right LENGTH and
 * start with a digit that country uses — "+91 98200" is five digits short and
 * would otherwise go in, and be found by nobody. Other countries get the
 * general check only; a table of every numbering plan is a library's job
 * (the screen uses libphonenumber-js), and the domain imports nothing.
 */

/** Calling code → the national numbers that country hands out. */
const NATIONAL: readonly { readonly code: string; readonly country: readonly string[]; readonly nsn: RegExp }[] = [
  // India: ten digits, mobiles on 6–9, landlines STD code first (11 Delhi …).
  { code: "91", country: ["IN"], nsn: /^[1-9]\d{9}$/ },
  // UAE: mobiles are 5X then seven digits; landlines an area digit (2 Abu
  // Dhabi, 3 Al Ain, 4 Dubai, 6 Sharjah, 7 Ras Al Khaimah, 9 Fujairah) then seven.
  { code: "971", country: ["AE"], nsn: /^(?:5\d{8}|[2-46-79]\d{7})$/ },
  // Singapore: eight digits, on 3, 6, 8 or 9.
  { code: "65", country: ["SG"], nsn: /^[3689]\d{7}$/ },
  // US and Canada share +1: area code and exchange each start 2–9.
  { code: "1", country: ["US", "CA"], nsn: /^[2-9]\d{2}[2-9]\d{6}$/ },
  // United Kingdom: nine or ten digits after the 0 is dropped.
  { code: "44", country: ["GB"], nsn: /^[1-9]\d{8,9}$/ },
];

const E164 = /^\+[1-9]\d{6,14}$/;

/** The calling code for a country this module knows, or null. */
export function callingCodeOf(country: string | null | undefined): string | null {
  if (country === null || country === undefined) return null;
  // "IN-MH" — a jurisdiction may name a state; the country is its first part.
  const c = country.trim().toUpperCase().slice(0, 2);
  return NATIONAL.find((n) => n.country.includes(c))?.code ?? null;
}

/**
 * What was typed, as E.164 where that can be worked out; otherwise the typed
 * digits with the separators taken out, for `isValidPhone` to refuse.
 *
 * Spaces, dashes, dots and brackets go. A leading "00" is the international
 * prefix and becomes "+". A number with no "+" is only completed when the
 * caller says which country it is from — a bare "9820012345" is India's to a
 * CA firm in Mumbai and Singapore's to nobody, and this module does not guess.
 */
export function normalizePhone(typed: string, country?: string | null): string {
  let v = typed.trim().replace(/[\s().-]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (v.startsWith("+") || !/^\d+$/.test(v)) return v;

  const code = callingCodeOf(country);
  if (code === null) return v;
  const plan = NATIONAL.find((n) => n.code === code);
  // Already carries the code without the plus: "919820012345".
  if (plan !== undefined && v.startsWith(code) && plan.nsn.test(v.slice(code.length))) return `+${v}`;
  // The trunk prefix a local caller dials: "09820012345" in India, "1" before
  // an American number.
  const trunk = code === "1" ? "1" : "0";
  if (v.startsWith(trunk)) v = v.slice(trunk.length);
  return `+${code}${v}`;
}

/** Whether a NORMALISED phone is a number somebody could be reached on. */
export function isValidPhone(normalized: string): boolean {
  if (!E164.test(normalized)) return false;
  const digits = normalized.slice(1);
  // Calling codes are prefix-free, so at most one entry can match.
  const plan = NATIONAL.find((n) => digits.startsWith(n.code));
  return plan === undefined || plan.nsn.test(digits.slice(plan.code.length));
}
