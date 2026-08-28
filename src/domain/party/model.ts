// The party domain — the core object graph: nouns + pure rules only. Imports
// nothing internal (enforced by the arch test). Everything with a counterparty
// is a party; directors/employees/shareholders are effective-dated
// RELATIONSHIPS between parties, never separate tables.

export type PartyKind = "organization" | "person";

export interface Party {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: PartyKind;
  readonly displayName: string;
}

export interface Organization {
  readonly partyId: string;
  readonly tenantId: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly industry: string | null;
  readonly website: string | null;
  /** The firm operating this tenant (10x Global itself). One per tenant. */
  readonly isFirmSelf: boolean;
}

export interface Person {
  readonly partyId: string;
  readonly tenantId: string;
  readonly fullName: string;
  readonly nationality: string | null;
  /** ISO date, YYYY-MM-DD. */
  readonly dateOfBirth: string | null;
}

export type LegalEntityStatus =
  | "active"
  | "dormant"
  | "under_strike_off"
  | "struck_off"
  | "dissolved";

export interface LegalEntity {
  readonly partyId: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly incorporatedOn: string | null;
  /** MM-DD. */
  readonly financialYearEnd: string | null;
  readonly registeredAddress: Record<string, unknown> | null;
  readonly status: LegalEntityStatus;
}

// Identifier types are a CLOSED set — each carries validation the code must know
// about (unlike relationship types, whose set is an open lookup table).
export type IdentifierType =
  | "pan"
  | "gstin"
  | "cin"
  | "llpin"
  | "tan"
  | "din"
  | "uen"
  | "trn"
  | "ein"
  | "crn"
  | "vat"
  | "passport"
  | "email"
  | "phone"
  | "other";

export const IDENTIFIER_TYPES: readonly IdentifierType[] = [
  "pan", "gstin", "cin", "llpin", "tan", "din",
  "uen", "trn", "ein", "crn",
  "vat", "passport", "email", "phone", "other",
];

export function isIdentifierType(v: string): v is IdentifierType {
  return (IDENTIFIER_TYPES as readonly string[]).includes(v);
}

export interface PartyIdentifier {
  readonly id: string;
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly jurisdiction: string | null;
  readonly isPrimary: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface PartyRelationship {
  readonly id: string;
  readonly tenantId: string;
  readonly fromPartyId: string;
  readonly toPartyId: string;
  readonly type: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly attributes: Record<string, unknown>;
}

// ── Pure rules ────────────────────────────────────────────────────────────

/** Normalise an identifier before storage/lookup so dedup is exact: emails
 *  lower-cased, phone stripped of separators, registration numbers upper-cased,
 *  all trimmed. */
export function normalizeIdentifier(type: IdentifierType, value: string): string {
  const v = value.trim();
  if (type === "email") return v.toLowerCase();
  if (type === "phone") return v.replace(/[\s()-]/g, "");
  return v.toUpperCase();
}

/** Shape validation for the identifier types whose format is a fixed public
 *  fact; unknown/free types only require non-empty. Assumes `normalized` has
 *  already been through normalizeIdentifier. */
export function isValidIdentifier(type: IdentifierType, normalized: string): boolean {
  if (normalized.length === 0) return false;
  switch (type) {
    case "pan":
      return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalized); // e.g. ABCDE1234F
    case "gstin":
      return /^[0-9A-Z]{15}$/.test(normalized); // 15-char state GSTIN
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized);
    default:
      return true;
  }
}

/** Effective-dating predicate: was this relationship in force on `onDate`?
 *  Half-open interval [validFrom, validTo) — validTo is the first day NOT in
 *  force. ISO YYYY-MM-DD strings compare lexicographically, which is why dates
 *  are stored and carried as strings. */
export function isInForceOn(
  rel: Pick<PartyRelationship, "validFrom" | "validTo">,
  onDate: string,
): boolean {
  if (onDate < rel.validFrom) return false;
  return rel.validTo === null || onDate < rel.validTo;
}

/** A date range is valid if `validFrom` is a well-formed ISO date and, when
 *  closed, `validTo` is a well-formed ISO date strictly after it (mirrors the
 *  DB CHECK). */
export function isValidDateRange(validFrom: string, validTo: string | null): boolean {
  if (!isIsoDate(validFrom)) return false;
  if (validTo === null) return true;
  return isIsoDate(validTo) && validTo > validFrom;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
