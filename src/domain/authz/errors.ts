// Sentinel errors for authorization. Two of them, and the distinction between
// them is what an operator needs at 3 a.m.:
//
//   NotPermitted    the role exists and does not carry this permission — the
//                   system working as configured.
//   UnknownRole     the membership names a role the product does not know, so
//                   the answer is "no" for a reason nobody intended. That is a
//                   configuration fault, not a policy decision, and it says so.
//
// Both are 403 on the wire. Collapsing them into one error would hide a firm
// whose staff were all locked out by a typo in a role name.
export class AuthzError extends Error {
  constructor(
    readonly code: AuthzErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type AuthzErrorCode = "NOT_PERMITTED" | "UNKNOWN_ROLE";

export class NotPermitted extends AuthzError {
  constructor(role: string, permission: string) {
    super(
      "NOT_PERMITTED",
      `Role ${JSON.stringify(role)} does not carry ${JSON.stringify(permission)}`,
    );
  }
}

export class UnknownRole extends AuthzError {
  constructor(role: string, known: readonly string[]) {
    // Two genuinely different faults share this code, and the message separates
    // them because the fixes are different. A role the firm does not define is
    // somebody's typo in a membership. NO roles at all is a firm whose
    // configuration was never seeded — every one of its people is locked out,
    // and no amount of correcting role names will help.
    super(
      "UNKNOWN_ROLE",
      known.length === 0
        ? `membership role ${JSON.stringify(role)} carries no permissions because this firm has no ` +
          `role configuration at all. Every member is locked out until it has one. Roles are seeded ` +
          `when a tenant is created, so this firm's provisioning did not finish.`
        : `membership role ${JSON.stringify(role)} is not one this firm defines, so it carries no ` +
          `permissions. This firm's roles: ${known.join(", ")}. Either the membership names the ` +
          `wrong one, or the role needs defining in the configuration registry.`,
    );
  }
}
