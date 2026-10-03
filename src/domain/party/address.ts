// A POSTAL ADDRESS, as a document prints it (audit 2026-10-03: B12/CA#1,
// CA#18, CA#22). Pure, stdlib only.
//
// One shape for both halves of a tax invoice: the firm's company's REGISTERED
// address (`core.legal_entity.registered_address`, which held `{ lines }` and
// printed nowhere) and a client's BILLING address (`core.party.billing_address`,
// 0334; clients had no address anywhere).
//
// `lines` stay the firm's own, one printed line each, because the four
// countries the firm works in do not agree on fields. Only the parts a tax
// document names on their own are separate: the STATE or region (an Indian
// invoice names the state; the place of supply follows from it, which is a
// decision for later) and the postal code. `country` is a client's: a firm's
// company is registered in its legal entity's country, which does not move.
//
// Stored as jsonb; `readPostalAddress` reads only this shape and answers null
// for anything else, so a row written before is never guessed at.

export interface PostalAddress {
  readonly lines: readonly string[];
  /** State, province, emirate or region, or null. */
  readonly region: string | null;
  readonly postalCode: string | null;
  /** ISO 3166-1 alpha-2, for a client's billing address; null on a firm's
   *  company, whose country is where it is registered. */
  readonly country: string | null;
}

export const ADDRESS_MAX_LINES = 8;
export const ADDRESS_LINE_MAX = 200;
export const ADDRESS_REGION_MAX = 100;
export const ADDRESS_POSTAL_MAX = 20;

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** The stored jsonb in the shape above, or null for anything else. */
export function readPostalAddress(raw: unknown): PostalAddress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const lines = r["lines"];
  if (!Array.isArray(lines) || !lines.every((l): l is string => typeof l === "string")) return null;
  return { lines, region: text(r["region"]), postalCode: text(r["postalCode"]), country: text(r["country"]) };
}

/**
 * What a person typed, tidied: lines trimmed and blank ones dropped, the parts
 * trimmed, the country upper-cased. Null when nothing is left, which is "no
 * address", not an empty one.
 */
export function tidyPostalAddress(raw: {
  readonly lines: readonly string[];
  readonly region?: string | null | undefined;
  readonly postalCode?: string | null | undefined;
  readonly country?: string | null | undefined;
}): PostalAddress | null {
  const lines = raw.lines.map((l) => l.trim()).filter((l) => l !== "");
  const region = raw.region?.trim() ?? "";
  const postalCode = raw.postalCode?.trim() ?? "";
  const country = raw.country?.trim().toUpperCase() ?? "";
  if (lines.length === 0 && region === "" && postalCode === "") return null;
  return {
    lines,
    region: region === "" ? null : region,
    postalCode: postalCode === "" ? null : postalCode,
    country: country === "" ? null : country,
  };
}

/** Why an address cannot be stored, in words for the person who typed it, or
 *  null when it can. Call on a tidied address. */
export function postalAddressProblem(a: PostalAddress): string | null {
  if (a.lines.length === 0) return "An address needs at least one line, such as the building and street.";
  if (a.lines.length > ADDRESS_MAX_LINES) {
    return `An address has at most ${String(ADDRESS_MAX_LINES)} lines.`;
  }
  if (a.lines.some((l) => l.length > ADDRESS_LINE_MAX)) {
    return `Each address line is at most ${String(ADDRESS_LINE_MAX)} characters.`;
  }
  if (a.region !== null && a.region.length > ADDRESS_REGION_MAX) {
    return `The state or region is at most ${String(ADDRESS_REGION_MAX)} characters.`;
  }
  if (a.postalCode !== null && a.postalCode.length > ADDRESS_POSTAL_MAX) {
    return `The postal code is at most ${String(ADDRESS_POSTAL_MAX)} characters.`;
  }
  if (a.country !== null && !/^[A-Z]{2}$/.test(a.country)) {
    return "Choose the country from the list.";
  }
  return null;
}

/** The jsonb written for an address: only the keys that hold something. */
export function postalAddressJson(a: PostalAddress): Record<string, unknown> {
  return {
    lines: [...a.lines],
    ...(a.region === null ? {} : { region: a.region }),
    ...(a.postalCode === null ? {} : { postalCode: a.postalCode }),
    ...(a.country === null ? {} : { country: a.country }),
  };
}
