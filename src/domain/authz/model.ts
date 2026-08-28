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
 *
 * The SET is the product's and stays code — a firm composes its roles out of
 * these, it does not invent new ones. A permission nothing checks would be a
 * lie on a screen, and only code knows what is actually checked.
 */
export type Permission =
  | "party:read"
  | "party:write"
  | "ledger:read"
  | "config:read"
  | "tenant:admin";

export const PERMISSIONS: readonly Permission[] = [
  "party:read",
  "party:write",
  "ledger:read",
  "config:read",
  "tenant:admin",
];

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

/**
 * The permission that can change the permissions.
 *
 * Config writes require exactly this one, and not a `config:write` of their
 * own. Editing the role registry IS tenant administration: whoever can publish
 * a role version can grant themselves anything, so a separate name for it would
 * let a firm hand out "just config editing" without realising they had handed
 * out everything. Naming it here keeps the rule and its reason together —
 * api/permissions.ts gates the routes on it, and the domain uses it to refuse a
 * role set that would leave nobody able to administer the firm at all.
 */
export const ADMIN_PERMISSION: Permission = "tenant:admin";

/**
 * The four roles a firm STARTS with — seed data, not the runtime answer.
 *
 * Since T2.5 the live role matrix is config rows (kind `role`) that the firm
 * owns and can edit, read through the `PermissionSource` port. This table is
 * what gets written into those rows the moment a tenant is created, and nothing
 * consults it afterwards. Deliberately: a built-in fallback consulted at read
 * time would mean a firm could never actually remove a permission, or would
 * lock out every role it had not yet redefined. See the note in
 * migrations/0005_config.up.sql for both failure modes.
 *
 * migrations/0005 seeds the same four for the firms that existed before it, and
 * tests/config/seed-parity.test.ts fails if the two ever drift.
 */
export interface RoleDefinition {
  /** What a person sees in the org chart. The firm may rename it. */
  readonly label: string;
  readonly permissions: readonly Permission[];
}

export const DEFAULT_ROLES: Readonly<Record<string, RoleDefinition>> = {
  // Owns the client relationship and the commercials.
  partner: {
    label: "Partner",
    permissions: ["party:read", "party:write", "ledger:read", "config:read", "tenant:admin"],
  },
  // Runs delivery for a book of clients; sees the audit trail for their work.
  manager: {
    label: "Manager",
    permissions: ["party:read", "party:write", "ledger:read", "config:read"],
  },
  // Does the work, and quotes from the catalogue. No audit-trail sweep of the
  // whole firm.
  associate: {
    label: "Associate",
    permissions: ["party:read", "party:write", "config:read"],
  },
  // A client's own contact. Holds nothing on the staff surface — the audience
  // gate already refuses them, and this is the second, independent answer.
  client_contact: { label: "Client contact", permissions: [] },
};

// ── Pure rules ───────────────────────────────────────────────────────────────

export function grants(held: readonly Permission[], needed: Permission): boolean {
  return held.includes(needed);
}

/**
 * Whether a firm's whole role set leaves nobody able to administer it.
 *
 * Publishing a role version that drops `tenant:admin` from the last role
 * carrying it is unrecoverable through the product: config writes need that
 * permission, so there would be no way to put it back. The registry refuses the
 * publish instead — see usecase/config/service.ts.
 */
export function leavesNobodyAdmin(
  permissionsByRole: ReadonlyMap<string, readonly Permission[]>,
): boolean {
  for (const held of permissionsByRole.values()) {
    if (held.includes(ADMIN_PERMISSION)) return false;
  }
  return true;
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
