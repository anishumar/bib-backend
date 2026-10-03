// The party domain — the core object graph: nouns + pure rules only. Imports
// nothing internal (enforced by the arch test). Everything with a counterparty
// is a party; directors/employees/shareholders are effective-dated
// RELATIONSHIPS between parties, never separate tables.

import { isValidPhone, normalizePhone } from "./phone";
import { isCalendarDay } from "../day";

export type PartyKind = "organization" | "person";

export interface Party {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: PartyKind;
  readonly displayName: string;
  /**
   * When this party was put away, or null while it is live. ISO 8601 with an
   * offset.
   *
   * IT IS NOT A DELETE, and there is deliberately no `deleted_at` anywhere in
   * `core` to mistake it for. Parties are permanent: an archived one still
   * resolves by id forever, so a signed engagement letter's counterparty never
   * renders blank. All it means is "keep this out of pickers and lists"
   * (migration 0035, and the paragraph in CLAUDE.md).
   */
  readonly archivedAt: string | null;
  /**
   * One of the firm's OWN companies: the firm itself, or a live member of
   * `crm.firm_entity` (0313). Computed on read, never stored, by the same
   * definition as `crm.is_firm_entity`, which the invoice, the proposal, the
   * letter and the lead capture all refuse as a client.
   *
   * Kept in the list rather than filtered out: the client screens hide these
   * rows, but a task may be about the firm itself, and whether it may is not
   * the party module's to decide.
   */
  readonly isOwnCompany: boolean;
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
  /** Entered by mistake and voided (V2.5, 0315): kept, shown as voided, and no
   *  longer blocks the value on another party. Final. */
  readonly voidedAt: string | null;
}

/** An identifier blocks a duplicate only while it is OPEN: not voided and no
 *  end day (V2.5). Ending or voiding one frees its value. */
export function isOpenIdentifier(i: Pick<PartyIdentifier, "validTo" | "voidedAt">): boolean {
  return i.voidedAt === null && i.validTo === null;
}

/** The longest display name a party may carry. */
export const DISPLAY_NAME_MAX = 200;

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

// ── A client's structure (F-10-1) ─────────────────────────────────────────

/**
 * Who a document for ONE client may name, on one day.
 *
 * `entities` are the companies work for this client can be FOR: the client
 * itself, every company recorded under it (`parent_of`, any depth), and every
 * company the client holds a stake or a seat in (`shareholder_of`,
 * `director_of`) together with the companies under those. `people` are the
 * persons who hold a role in any of those entities (`CONTACT_ROLES`) — who a
 * letter may be addressed to, care of the client — and the client itself when
 * the client is a person.
 *
 * Decided by Shrestha on 2026-09-25: a line for another client's company, or a
 * letter addressed to another client's director, is refused, and the answer to
 * a refusal is to record the link on the client's page. Archived parties are
 * left out: nothing new names them (0305).
 *
 * A READ MODEL rather than a yes/no, because the same answer fills the
 * letter's pickers — so the screen offers exactly what the API accepts.
 */
export interface ClientStructure {
  readonly entities: readonly StructureMember[];
  readonly people: readonly StructureMember[];
}

export interface StructureMember {
  readonly id: string;
  readonly displayName: string;
}

/** The relationships FROM a client that bring a company into its structure
 *  besides ownership (`parent_of`, which is followed to any depth). */
export const STRUCTURE_HOLDINGS = ["shareholder_of", "director_of"] as const;

/** The roles that make a person somebody a letter may be addressed to. */
export const CONTACT_ROLES = [
  "director_of",
  "authorised_signatory_of",
  "employee_of",
  "shareholder_of",
] as const;

// ── Pure rules ────────────────────────────────────────────────────────────

/** Normalise an identifier before storage/lookup so dedup is exact: emails
 *  lower-cased, phones in E.164 (`normalizePhone` — `country` completes one
 *  typed without its calling code), registration numbers upper-cased, all
 *  trimmed. */
export function normalizeIdentifier(type: IdentifierType, value: string, country?: string | null): string {
  const v = value.trim();
  if (type === "email") return v.toLowerCase();
  if (type === "phone") return normalizePhone(v, country);
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
      // State code, the holder's PAN, the registration's number in that
      // state, a fixed "Z", a check character: 27ABCDE1234F1Z5. The check
      // character's arithmetic is not tested, so a typo there still goes in.
      return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalized);
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized);
    case "phone":
      return isValidPhone(normalized);
    default:
      return true;
  }
}

/** Whether a party is currently hidden from pickers and lists. A one-line
 *  predicate so the question is asked the same way everywhere and nobody has to
 *  decide again whether null or a timestamp is the live state. */
export function isArchived(party: Pick<Party, "archivedAt">): boolean {
  return party.archivedAt !== null;
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
  // A day that EXISTS, not just the shape (audit 2026-10-03, B43): 2026-13-45
  // passed the shape and reached Postgres as an unmapped 22008, a 500.
  return isCalendarDay(s);
}

/**
 * Whether a relationship can be true of these two kinds of party, this way
 * round (CA#53). Only the plainly impossible is refused: nobody is a director
 * or a shareholder OF a person, only a person is somebody's employee or
 * authorised signatory, and a parent and its subsidiary are both companies. A
 * company as a director stays allowed, because some countries allow it. A code
 * this table does not know (the product's list is open) fits either way.
 */
export function relationshipFits(type: string, fromKind: PartyKind, toKind: PartyKind): boolean {
  switch (type) {
    case "director_of":
    case "shareholder_of":
      return toKind === "organization";
    case "employee_of":
    case "authorised_signatory_of":
      return fromKind === "person";
    case "parent_of":
      return fromKind === "organization" && toKind === "organization";
    default:
      return true;
  }
}
