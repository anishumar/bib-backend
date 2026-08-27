// Authorization: what a role may do, and the separate question of whether it
// may see money.
//
// The four gates a read answers (CLAUDE.md) are tenant, audience, role, and
// record-scope. Gate 1 is RLS, gate 2 is the session guard, gate 4 needs the
// user-to-party link that arrives with the client portal. This file is gate 3,
// plus the FIFTH, ORTHOGONAL axis: fee visibility.
//
// That fifth axis is not a role and must never become one. Delivery staff see
// the work and not the fee; a partner sees both; a client contact sees their
// own fees and not the firm's costs. Encode that as a role and you get
// "senior_associate_who_sees_fees" within a year, and every rule about seniority
// has to be written twice.

/**
 * What a caller may do. A closed set, deliberately coarse: these are the verbs
 * an API route is gated on, not a description of the business. Finer questions
 * ("may they approve THIS item") are record-level and belong with the record.
 */
export type Permission =
  | "party:read"
  | "party:write"
  | "ledger:read"
  | "tenant:admin";

export const PERMISSIONS: readonly Permission[] = [
  "party:read",
  "party:write",
  "ledger:read",
  "tenant:admin",
];

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

/**
 * The seeded role vocabulary.
 *
 * `membership.role` is free text on purpose — it is the firm's own word, and
 * T2.5 (the master configuration registry) makes the mapping below a table a
 * partner can edit. Until then these four are what the product ships with, and
 * a role outside the set resolves to NO permissions rather than to a guess.
 *
 * That is deliberate and it is a real constraint: a firm cannot invent "rm" and
 * have it work today. The alternative — treating an unrecognised role as the
 * least-privileged known one — silently grants access based on a spelling
 * nobody reviewed, and quiet is the wrong failure mode for an access decision.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  // Owns the client relationship and the commercials.
  partner: ["party:read", "party:write", "ledger:read", "tenant:admin"],
  // Runs delivery for a book of clients; sees the audit trail for their work.
  manager: ["party:read", "party:write", "ledger:read"],
  // Does the work. No audit-trail sweep of the whole firm.
  associate: ["party:read", "party:write"],
  // A client's own contact. Holds nothing on the staff surface — the audience
  // gate already refuses them, and this is the second, independent answer.
  client_contact: [],
};

export const KNOWN_ROLES: readonly string[] = Object.keys(DEFAULT_ROLE_PERMISSIONS);

export function isKnownRole(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_PERMISSIONS, role);
}

/** The permissions a seeded role carries; empty for anything unrecognised. */
export function permissionsForRole(role: string): readonly Permission[] {
  return DEFAULT_ROLE_PERMISSIONS[role] ?? [];
}

// ── Pure rules ───────────────────────────────────────────────────────────────

export function grants(held: readonly Permission[], needed: Permission): boolean {
  return held.includes(needed);
}

/**
 * The fee axis, as a function rather than a permission, so it cannot be granted
 * by a role table by accident. It reads a flag that lives on the membership and
 * nowhere else.
 */
export function seesCommercials(commercialVisibility: boolean): boolean {
  return commercialVisibility;
}

/**
 * Strip money from a payload for someone who may not see it.
 *
 * Redaction, not omission of the whole record: the delivery associate still
 * needs the work item — its client, its deadline, its status — and must simply
 * not learn what the firm charges for it. Returning nothing at all would make
 * the fee gate indistinguishable from "no access", and the two are different
 * answers a user acts on differently.
 *
 * Fields are named per call site rather than guessed from key names: a guess
 * would eventually miss `retainerAmount` or redact `feeNote` that was never
 * sensitive, and a fee leak found later cannot be un-leaked.
 */
export function redactCommercials<T extends Record<string, unknown>>(
  record: T,
  commercialFields: readonly (keyof T & string)[],
  canSee: boolean,
): Record<string, unknown> {
  if (canSee) return { ...record };
  const out: Record<string, unknown> = { ...record };
  for (const field of commercialFields) {
    if (field in out) out[field] = null;
  }
  return out;
}
