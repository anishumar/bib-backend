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
  | "proposal:approve"
  | "work:write"
  | "obligation:resolve"
  | "portal:grant"
  | "portal:respond"
  | "portal:request"
  | "acceptance:record"
  | "tenant:admin";

export const PERMISSIONS: readonly Permission[] = [
  "party:read",
  "party:write",
  "ledger:read",
  "config:read",
  "proposal:approve",
  "work:write",
  "obligation:resolve",
  "portal:grant",
  "portal:respond",
  "portal:request",
  "acceptance:record",
  "tenant:admin",
];

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

/**
 * What each permission means, in a sentence somebody deciding who gets it can
 * act on.
 *
 * Here rather than on a screen because the meaning of a permission is a domain
 * fact, and a description that lives in the UI drifts from what the code
 * actually checks — which on this particular subject is how a firm hands out
 * more than it meant to. The admin screen reads these; so does anyone reading
 * this file.
 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  "party:read": "See the firm's clients, prospects and contacts, and the sales pipeline.",
  "party:write": "Add and change clients, contacts, their identifiers (PAN, GSTIN and so on) and leads.",
  "ledger:read": "Read the firm's whole audit trail. It names every client the firm has.",
  "config:read": "See the service catalogue and how the firm's roles are set up.",
  "proposal:approve":
    "Approve a discount larger than the firm's published limit. Anyone who can write a " +
    "proposal can offer a discount within the limit; this is the sign-off for going past it.",
  "work:write":
    "Mark a step of a client's work as done. This is the record of who did the work, so it " +
    "is a separate permission from seeing the board.",
  "obligation:resolve":
    "Decide what happens to a legal deadline that has already passed: file it late, accept " +
    "the penalty, or record that it never applied. Kept separate from doing the work, " +
    "because this decision commits the client's money.",
  "portal:grant":
    "Give one of a client's own people a login to that client's portal, and take it away " +
    "again. Access is given one client at a time, so it is always clear who decided.",
  "portal:respond":
    "For client portal roles only. Lets a client contact answer the firm: upload a file " +
    "that was asked for, reply to a question, approve or decline something. A contact " +
    "without it can still see everything on their portal, but cannot act.",
  "portal:request":
    "For client portal roles only. Lets a client contact ask the firm for something: a " +
    "document, a copy, a correction, a call. Kept separate from answering, so a firm can let " +
    "somebody send the registers every month without letting them open new requests.",
  "acceptance:record":
    "Record that a client accepted a proposal or an engagement letter outside bib, by email, " +
    "on a call or in a meeting, when they never pressed Accept or signed in DocuSign. A " +
    "letter recorded this way is signed and its work starts, so the client's email must be " +
    "filed with it.",
  "tenant:admin":
    "Administer the firm: who works here, what their roles are, and every setting, " +
    "including this one.",
};

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
 * WHICH SURFACE A ROLE IS WRITTEN FOR (T6.6).
 *
 * The same two words as `tenancy.membership.audience`, and the same meaning:
 * STAFF is the firm's workspace, CLIENT_PORTAL is the client's.
 *
 * ── WHY A ROLE HAS TO DECLARE ONE, AND WHY ONLY NOW ─────────────────────
 *
 * Until T6.6 no portal route needed a permission, so `AuthzService.permissionsOf`
 * could return `[]` for every portal session and be exactly right — gate 2
 * admits a portal session only to `PORTAL_PATHS`, and none of those needed one.
 * That was arithmetic, not policy, and it was documented as arithmetic:
 * `tests/api/portal-permissions.test.ts` was written to go red the day it
 * stopped being true.
 *
 * `portal:respond` is that day. It is the first permission a portal session can
 * actually USE, and the blanket empty would now be a lie in the other direction:
 * a portal screen would be told it may do nothing and would offer nothing that
 * works. But simply removing the blanket is worse, because nothing refuses a
 * STAFF role on a portal membership — `manager` on a CLIENT_PORTAL login is
 * accepted today — and the reverse is just as true: a firm could put
 * `portal:respond` on `associate` and hand a colleague a permission that only
 * means anything outside the firm.
 *
 * So a role says which audience it is for, and a role written for the other one
 * grants NOTHING. That is the honest fix CLAUDE.md has been pointing at since
 * the gate was built, and it makes the two questions independent: `audience` on
 * the MEMBERSHIP is which app you are in, `audience` on the ROLE is which app
 * this list of permissions was written for, and they have to agree.
 */
export type RoleAudience = "STAFF" | "CLIENT_PORTAL";

export const ROLE_AUDIENCES: readonly RoleAudience[] = ["STAFF", "CLIENT_PORTAL"];

export function isRoleAudience(v: string): v is RoleAudience {
  return (ROLE_AUDIENCES as readonly string[]).includes(v);
}

/**
 * The FIVE roles a firm STARTS with — seed data, not the runtime answer.
 *
 * Since T2.5 the live role matrix is config rows (kind `role`) that the firm
 * owns and can edit, read through the `PermissionSource` port. This table is
 * what gets written into those rows the moment a tenant is created, and nothing
 * consults it afterwards. Deliberately: a built-in fallback consulted at read
 * time would mean a firm could never actually remove a permission, or would
 * lock out every role it had not yet redefined. See the note in
 * migrations/0005_config.up.sql for both failure modes.
 *
 * migrations/0005 seeded the first four for the firms that existed before it,
 * 0064 carries this version to them, and tests/config/seed-parity.test.ts fails
 * if the newest seed and this table ever drift.
 */
export interface RoleDefinition {
  /** What a person sees in the org chart. The firm may rename it. */
  readonly label: string;
  /**
   * Which surface this role is for. OPTIONAL, and absent means STAFF.
   *
   * Optional because a published config version is FROZEN: every role row every
   * firm already holds was written before this field existed, and `unknownFields`
   * rejects a body's unknown keys at the WRITE, so those rows cannot be amended
   * in place. Reading an absent `audience` as STAFF is right for all four of
   * them — including `client_contact`, whose permission list was empty, so it
   * granted nothing either way.
   */
  readonly audience?: RoleAudience;
  readonly permissions: readonly Permission[];
}

export const DEFAULT_ROLES: Readonly<Record<string, RoleDefinition>> = {
  // Owns the client relationship and the commercials.
  partner: {
    label: "Partner",
    permissions: [
      "party:read",
      "party:write",
      "ledger:read",
      "config:read",
      "tenant:admin",
      "proposal:approve",
      "work:write",
      "obligation:resolve",
      "portal:grant",
      "acceptance:record",
    ],
  },
  // Runs delivery for a book of clients; sees the audit trail for their work.
  manager: {
    label: "Manager",
    permissions: ["party:read", "party:write", "ledger:read", "config:read", "work:write"],
  },
  // Does the work, and quotes from the catalogue. No audit-trail sweep of the
  // whole firm.
  associate: {
    label: "Associate",
    permissions: ["party:read", "party:write", "config:read", "work:write"],
  },
  // ── THE TWO PORTAL ROLES (T6.6) ───────────────────────────────────────
  //
  // The board's line — "this contact may upload, that one may only look" — and
  // the whole reason a role now declares an audience. Both hold NOTHING on the
  // staff surface, and that is now two independent answers rather than one:
  // gate 2 refuses every staff route to a portal session, and a CLIENT_PORTAL
  // role carries no staff permission for it to refuse.
  //
  // READING IS NOT A PERMISSION EITHER WAY. Being invited and being granted a
  // company IS the authorisation to read that company's status — a row somebody
  // wrote, with a granter, a date and a ledger event (`crm.portal_access`), and
  // gate 4 enforces it. So `client_viewer` with no permissions at all is a
  // contact who sees the whole portal and cannot act, which is exactly what a
  // read-only contact should be.

  // The default a portal invite assigns, and it stays the default: every
  // contact invited before T6.6 holds this role, and giving it nothing would
  // take away an ability they were about to be given rather than granting one.
  client_contact: {
    label: "Client contact",
    audience: "CLIENT_PORTAL",
    permissions: ["portal:respond", "portal:request"],
  },
  // For a contact the firm wants to keep informed and not to hear from — an
  // investor, a bank, a director who is not the one who sends the registers.
  client_viewer: {
    label: "Client contact (read only)",
    audience: "CLIENT_PORTAL",
    permissions: [],
  },
};

// ── Pure rules ───────────────────────────────────────────────────────────────

export function grants(held: readonly Permission[], needed: Permission): boolean {
  return held.includes(needed);
}

/**
 * Whether a role written for one audience may be used by a session in another.
 *
 * It may not, in either direction, and the symmetry is deliberate. A STAFF role
 * on a portal membership granting nothing is the obvious half. The other half
 * matters more: `portal:respond` on `associate` would be a firm handing a
 * colleague a permission that only means something outside the firm, and the
 * portal handlers refuse a staff session anyway — so it would show up on
 * `/auth/me` and work nowhere, which is the exact 403-by-surprise
 * `permissionsOf` exists to prevent.
 *
 * An absent role audience reads as STAFF — see `RoleDefinition.audience` for why
 * it has to be optional.
 */
export function roleServes(
  roleAudience: RoleAudience | undefined,
  sessionAudience: string | null,
): boolean {
  return (roleAudience ?? "STAFF") === (sessionAudience ?? "STAFF");
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
