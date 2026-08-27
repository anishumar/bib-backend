// The call context — who is making this request, carried from the edge into
// the use case. `Principal` is the authenticated identity: a global user id
// (ADR-02: identity above tenant) plus the tenant and audience the session is
// currently acting under. It is our type, in our vocabulary — never an HTTP
// request object — so the same use case can be driven by a cron job or an S2S
// caller with no HTTP anywhere.
//
// `tenantId` and `audience` are nullable together: a user with memberships in
// several firms has a valid session before they have chosen one. Routes that
// need a tenant say so; the org-switcher is the route that fills them in.

/** The twin of Audience in domain/tenancy/model.ts. platform imports nothing
 *  internal (it is the innermost layer), so the union is restated here — and
 *  the identity use case assigns one to the other, which makes the compiler,
 *  not a comment, the thing that keeps them identical. */
export type Audience = "STAFF" | "CLIENT_PORTAL";

export interface Principal {
  readonly userId: string;
  /** The session this principal was resolved from — what `logout` revokes. */
  readonly sessionId: string;
  /** The tenant this session is acting under, or null before an org is chosen. */
  readonly tenantId: string | null;
  readonly audience: Audience | null;
}

export interface CallContext {
  readonly requestId: string;
  readonly principal: Principal;
}
