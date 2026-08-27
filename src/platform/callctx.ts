// The call context — who is making this request, carried from the edge into
// the use case. `Principal` is the authenticated identity (a global user id,
// ADR-02: identity above tenant). It is our type, in our vocabulary — never an
// HTTP request object — so the same use case can be driven by a cron job or an
// S2S caller with no HTTP anywhere.
export interface Principal {
  readonly userId: string;
}

export interface CallContext {
  readonly requestId: string;
  readonly principal: Principal;
}
