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
      `role ${JSON.stringify(role)} does not carry ${JSON.stringify(permission)}`,
    );
  }
}

export class UnknownRole extends AuthzError {
  constructor(role: string, known: readonly string[]) {
    super(
      "UNKNOWN_ROLE",
      `membership role ${JSON.stringify(role)} is not one the product knows, so it carries no ` +
        `permissions. Known roles: ${known.join(", ")}. A firm's own vocabulary becomes ` +
        `configurable in T2.5; until then a membership must use one of these.`,
    );
  }
}
