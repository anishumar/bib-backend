// Which permission each route requires — one table, read by one middleware.
//
// The alternative is a check inside each handler, and this codebase has already
// paid for that: three routes shipped with no authentication at all because the
// check lived in the files rather than in front of them. Gate 3 gets the
// treatment gates 1 and 2 got.
//
// DENY BY DEFAULT. A route with no entry here is refused for everyone, so
// adding a route without deciding who may reach it fails loudly and
// immediately, rather than being open until someone notices. A structural test
// asserts every registered route is either listed here or explicitly exempt.
import type { Permission } from "../domain/authz/model";

/** `METHOD /path` exactly as the OpenAPI spec names it, templates included. */
export type RouteKey = string;

export function routeKey(method: string, path: string): RouteKey {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Routes that need a session but no particular permission.
 *
 * Only session management belongs here: a caller must be able to see who they
 * are, choose an org, and sign out regardless of what their role permits —
 * otherwise a misconfigured role would lock someone out of the very endpoints
 * they need to fix it.
 */
export const NO_PERMISSION_REQUIRED: ReadonlySet<RouteKey> = new Set([
  routeKey("GET", "/api/v1/auth/me"),
  routeKey("POST", "/api/v1/auth/switch-tenant"),
  routeKey("POST", "/api/v1/auth/logout"),
  routeKey("GET", "/api/v1/tenancy/me/memberships"),
]);

/** The permission each business route requires. */
export const ROUTE_PERMISSIONS: ReadonlyMap<RouteKey, Permission> = new Map([
  [routeKey("GET", "/api/v1/parties"), "party:read" as const],
  [routeKey("GET", "/api/v1/parties/{partyId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/parties/organizations"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/persons"), "party:write" as const],
  [
    routeKey("POST", "/api/v1/parties/organizations/{partyId}/legal-entities"),
    "party:write" as const,
  ],
  [routeKey("POST", "/api/v1/parties/{partyId}/identifiers"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/relationships"), "party:write" as const],
  // Archiving reuses `party:write` rather than inventing party:archive. It is
  // not a delete — the row stays, it still resolves by id, and un-archiving is
  // one call away — so it is no more destructive than renaming a client, which
  // this permission already allows. A new permission is also no longer free:
  // permissions reach existing firms as config rows, so one costs a migration
  // that carries it to every tenant that has not customised its roles.
  [routeKey("POST", "/api/v1/parties/{partyId}/archive"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/{partyId}/unarchive"), "party:write" as const],
  // The firm's whole audit trail is a partner-and-manager read: it names every
  // client the firm has, which is more than an associate needs to do their work.
  [routeKey("GET", "/api/v1/events"), "ledger:read" as const],
  [routeKey("GET", "/api/v1/objects/{objectType}/{objectId}/events"), "ledger:read" as const],

  // FIRM ADMINISTRATION. `tenant:admin` on all four, including the READ.
  //
  // The roster lists colleagues' email addresses, and this is the screen for
  // running the firm rather than working at it. A general "who works here"
  // directory is a wider decision — different data, probably a different
  // permission — and belongs to whichever screen first needs one, not smuggled
  // in as a side effect of the admin surface.
  //
  // The write side is the same `tenant:admin` the config registry uses, and for
  // the same reason: between them these two surfaces decide what every role
  // means AND who holds it, which is the whole of access control at a firm.
  [routeKey("GET", "/api/v1/tenancy/members"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/tenancy/members"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/role"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/active"), "tenant:admin" as const],

  // THE SENIORITY LADDER (G3.3). `tenant:admin` on all five, the READ included,
  // and the read is the one worth explaining.
  //
  // A grade is not a permission — holding one grants nothing — so the argument
  // is not escalation, it is that these five routes are a firm RUNNING ITSELF.
  // Between the ladder and the roster they decide who may sign off whose work:
  // the firm's review rule is "Manager or above", so moving a rung's rank or
  // moving a person onto it changes who can approve a statutory filing. Anybody
  // who needs the rungs for a picker is already on the admin surface.
  //
  // It is also not free to loosen later in the other direction: a `grade:read`
  // of its own would be a new permission, and since T2.5 a new permission costs
  // a migration to reach every existing firm. When a screen outside
  // administration needs the ladder — a work board showing seniority, say —
  // that is the point to pay for it, with the screen in hand.
  [routeKey("GET", "/api/v1/tenancy/grades"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/tenancy/grades"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/grades/{gradeId}"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/grades/{gradeId}/active"), "tenant:admin" as const],

  // The firm's delivery structure (G2.4). `tenant:admin` throughout, the READ
  // included, for the same reason the ladder above is: this is a firm
  // describing itself, and the split axis chosen here decides how every future
  // engagement is cut into jobs.
  [routeKey("GET", "/api/v1/tenancy/structure"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/tenancy/structure/axes"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/axes/{axisId}"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/axes/{axisId}/active"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/work-split"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/grade"), "tenant:admin" as const],
  // WHO BINDS THE FIRM (G1.4). The same split the firm-entity rule and the
  // configuration registry use, and for the same reason: this IS firm
  // configuration. Reading is `config:read` — an associate drafting a letter
  // should be able to see whose signature will appear on it, and the client is
  // about to read that name anyway. Writing is `tenant:admin`, because naming
  // the person who commits the firm to every engagement it signs is a decision
  // at the same level as deciding what a role means.
  //
  // Literal paths, and they sort ahead of /members/{membershipId} by the
  // literal-first rule in decideRoute.
  [routeKey("GET", "/api/v1/tenancy/firm-signatory"), "config:read" as const],
  [routeKey("PUT", "/api/v1/tenancy/firm-signatory"), "tenant:admin" as const],

  // THE PIPELINE (T2.1) reuses the PARTY permissions rather than inventing
  // lead:read / lead:write, and that is a decision rather than laziness.
  //
  // A lead in this model IS a party — the opportunity is a row about a
  // counterparty the firm already stores, not a shadow copy of one — so a role
  // that may read the firm's parties may already see every prospect in it
  // through /api/v1/parties. A separate permission would look like a boundary
  // while enforcing none.
  //
  // It is also no longer free to add one. Permissions reach existing firms as
  // config rows, so a new one costs a migration that carries it to every tenant
  // that has not customised the role. Worth paying when a firm asks to keep the
  // pipeline from delivery staff; not worth paying for a distinction nobody has
  // asked for. When they do ask, they can now do most of it themselves: a
  // custom role, published, no deploy.
  [routeKey("GET", "/api/v1/leads"), "party:read" as const],
  [routeKey("GET", "/api/v1/leads/{leadId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/leads"), "party:write" as const],
  [routeKey("POST", "/api/v1/leads/{leadId}/stage"), "party:write" as const],
  [routeKey("PUT", "/api/v1/leads/{leadId}/owner"), "party:write" as const],

  // PROPOSALS (T2.2) reuse the party permissions for their CRUD, for the same
  // reason the pipeline does: a proposal is a document about a party, and a role
  // that may already read every prospect and every lead gains no boundary from a
  // `proposal:read` beside them. What money it shows is a different question,
  // answered by the fee-visibility axis on the membership — which REDACTS the
  // amounts rather than hiding the document, so "you may not see the fee" never
  // looks like "there is no proposal".
  //
  // The exception is the one capability that is genuinely its own: authorising a
  // discount past the firm's published limit. That is not `tenant:admin` — the
  // person who manages logins and the person who may sign off forty percent off
  // are different people at any real firm — and it is not the fee axis either,
  // which governs SEEING money rather than authorising a price. So it has its
  // own permission, and migration 0012 carried it to the firms that already
  // exist, which is what a new permission costs since T2.5.
  [routeKey("GET", "/api/v1/proposals"), "party:read" as const],
  [routeKey("GET", "/api/v1/proposals/{proposalId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/proposals"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/lines"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/proposals/{proposalId}/lines/{lineId}"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/send"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/decision"), "party:write" as const],
  [
    routeKey("POST", "/api/v1/proposals/{proposalId}/discount-approval"),
    "proposal:approve" as const,
  ],

  // ENGAGEMENT LETTERS (T2.3) reuse the party permissions, including SIGNING.
  //
  // That last part was argued rather than assumed. Recording a signature creates
  // obligations and spawns work, which is a fair case for its own permission —
  // but a new one costs a migration to reach every existing firm (T2.5's rule),
  // and no firm has asked for the distinction. `proposal:approve` is the
  // precedent for what "asked for" looks like: there, the person who manages
  // logins is demonstrably not the person who signs off a discount. Here, a firm
  // that wants signing held back from delivery staff can publish its own role
  // this afternoon, with no deploy. Revisit when one asks.
  [routeKey("GET", "/api/v1/engagement-letters"), "party:read" as const],
  [routeKey("GET", "/api/v1/engagement-letters/{letterId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/engagement-letters"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/lines"), "party:write" as const],
  [
    routeKey("DELETE", "/api/v1/engagement-letters/{letterId}/lines/{lineId}"),
    "party:write" as const,
  ],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/clauses"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/send"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/withdraw"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/signature"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/advance"), "party:write" as const],

  // THE DELIVERY ENGINE (T2.6). `party:read`, the same permission the pipeline
  // and the proposals use — and for the same reason. A job names the engagement
  // that caused it, and anybody who may already read the firm's parties, leads
  // and proposals can see that engagement anyway; a `job:read` beside them would
  // look like a boundary while enforcing none. It is also no longer free to add
  // one: since T2.5 a new permission costs a migration to reach every existing
  // firm. When a firm asks to keep delivery from commercial staff, that is the
  // moment to pay for it.
  [routeKey("GET", "/api/v1/jobs"), "party:read" as const],

  // A job's steps (T2.7). READ on `party:read`, like the job list it hangs off:
  // the work board is what every member of the delivery team looks at, and a
  // step's label and state carry no money and no personal data.
  [routeKey("GET", "/api/v1/jobs/{jobId}"), "party:read" as const],
  [routeKey("GET", "/api/v1/jobs/{jobId}/steps"), "party:read" as const],
  // COMPLETING one needs `work:write` — a separate permission, because saying a
  // filing is done is not the same act as reading the board, and the record of
  // WHO did it is worth only as much as the gate in front of it.
  [routeKey("POST", "/api/v1/jobs/{jobId}/steps/{stepKey}/complete"), "work:write" as const],
  // Deciding a machine's output is doing the work, not reading the board: the
  // row it writes is the record of who checked it. Same permission as
  // completing a step, deliberately — a firm that trusts somebody to say "this
  // filing is done" trusts them to say "the machine got it right".
  [routeKey("POST", "/api/v1/jobs/{jobId}/steps/{stepKey}/decide"), "work:write" as const],
  // WHICH OF THE FIRM'S OWN ENTITIES ISSUES (G1.2). The same split the
  // configuration registry uses, and for the same reason: this IS firm
  // configuration. Reading it is `config:read` — an associate drafting a letter
  // should be able to see which of our companies will be on it. Writing it is
  // `tenant:admin`, because moving the fallback silently changes the governing
  // law, the courts and the counterparty on every document issued afterwards,
  // and that is a decision at the same level as deciding what a role means.
  // WHOSE DESK COVERS A COUNTRY (T2.1b) — the same split as the two rules above
  // and for the same reason. Reading is `config:read`: anybody drafting should
  // be able to see where a lead will land. Writing is `tenant:admin`, because a
  // territory rule decides who a new opportunity goes to before anybody has
  // looked at it, and quietly moving a country moves the pipeline — and with it
  // whose numbers it shows up in.
  // INVOICING (T3.4). Reading is `party:read` — a delivery colleague opening a
  // client's page sees that an invoice exists, and the FEE AXIS is what decides
  // whether they see the amounts, not this table. Writing is `party:write`, the
  // same permission every other drafting route on both documents takes.
  //
  // ISSUING AND CANCELLING ARE `tenant:admin`, and that is the one considered
  // difference. Raising a draft is bookkeeping; ISSUING allocates nothing new
  // but sends a legal demand to a client under one of the firm's own entities,
  // and CANCELLING withdraws one — both leave a permanent mark in a consecutive
  // series that a tax authority may ask about. That is a decision at the level
  // of deciding what a role means, not a drafting action.
  [routeKey("GET", "/api/v1/invoices"), "party:read" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/invoices"), "party:write" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/lines"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/invoices/{invoiceId}/lines/{lineId}"), "party:write" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/issue"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/cancel"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/irn"), "party:write" as const],
  // MONEY AGAINST AN INVOICE (T3.5). Recording a payment is `party:write` —
  // it is bookkeeping, and the person chasing a receivable is the person who
  // marks it settled. ISSUING A CREDIT NOTE IS `tenant:admin`, and that is the
  // considered line: it takes money off a legal document, it is the mechanism
  // through which revenue leaks, and the reason it demands a REASON is that
  // somebody has to answer for it later. Reading is `party:read`, with the fee
  // axis deciding whether the amounts are visible — not this table.
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/payments"), "party:write" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/payments"), "party:read" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/credit-notes"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/credit-notes"), "party:read" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/balance"), "party:read" as const],
  [routeKey("GET", "/api/v1/receivables"), "party:read" as const],

  // THE DUNNING LADDER (T3.5). Reading how far a receivable has been chased is
  // `party:read` — the person on the phone to the client needs to know what has
  // already been sent. DECIDING a terminal step is `tenant:admin`, and that is
  // the acceptance line as a permission: credit hold and legal action are the
  // two things on this ladder a firm cannot take back with an apology, and the
  // worker deliberately stops short of them. The gate is what makes "the worker
  // climbs the ladder; terminal needs partner approval" true rather than
  // intended.
  [routeKey("GET", "/api/v1/dunning/pending"), "party:read" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/dunning"), "party:read" as const],
  [routeKey("POST", "/api/v1/dunning/{actionId}/decide"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/invoice-series"), "config:read" as const],
  [routeKey("POST", "/api/v1/invoice-series/{entityPartyId}/prefix"), "tenant:admin" as const],

  [routeKey("GET", "/api/v1/territory-rules"), "config:read" as const],
  [routeKey("POST", "/api/v1/territory-rules"), "tenant:admin" as const],

  [routeKey("GET", "/api/v1/firm-entities/preferences"), "config:read" as const],
  [routeKey("POST", "/api/v1/firm-entities/preferences"), "tenant:admin" as const],

  // THE FIRM'S STANDARD PROSE (G1.7) — the same split, for the same reason.
  // Reading is `config:read`: an associate drafting a letter should see which
  // exclusions it will carry. Writing is `tenant:admin`, because editing the
  // standard set changes what EVERY document written from here on says — an
  // exclusion quietly removed is a limit the firm stops asserting on work it
  // has not been paid for yet, and nothing on a later letter would show it was
  // ever there. Retiring travels the same route (PATCH with isActive), so it is
  // covered by the same entry rather than needing one of its own.
  [routeKey("GET", "/api/v1/document-blocks/standard"), "config:read" as const],
  [routeKey("POST", "/api/v1/document-blocks/standard"), "tenant:admin" as const],
  [routeKey("PATCH", "/api/v1/document-blocks/standard/{blockId}"), "tenant:admin" as const],

  // A DOCUMENT's own blocks are `party:write`, NOT `tenant:admin`, and the
  // difference is the point of the copy. Editing the standard set changes every
  // document from here on and is an administrator's decision; striking an
  // exclusion off ONE proposal because this client negotiated it away is what
  // drafting IS, and it is the same permission every other drafting route on
  // both documents already takes.
  //
  // `party:write` rather than a `document:write` of its own, for the reason the
  // proposal routes above give: a new permission is not a line here, it is a
  // migration that publishes a new version of every default role, and it would
  // buy a distinction nobody has asked for.
  [routeKey("POST", "/api/v1/document-blocks"), "party:write" as const],
  [routeKey("PATCH", "/api/v1/document-blocks/{blockId}"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/document-blocks/{blockId}"), "party:write" as const],

  // THE CONFIGURATION REGISTRY (T2.5). Reading is broad — an associate building
  // a proposal quotes from the service catalogue — and WRITING is `tenant:admin`
  // rather than a `config:write` of its own.
  //
  // That is deliberate and it is the security decision in this table. One of the
  // things this surface configures is the ROLE registry, so whoever may publish
  // here may grant themselves every permission in the product. A separate name
  // for it would let a firm hand out "just config editing" believing it was a
  // small thing, when it is the largest thing there is. Naming the permission
  // `tenant:admin` makes the grant say what it actually means at the moment
  // somebody decides to make it.
  // Literal, and it sorts ahead of the template above by the literal-first rule
  // in decideRoute — "permissions" is not a kind.
  [routeKey("GET", "/api/v1/config/permissions"), "config:read" as const],
  [routeKey("GET", "/api/v1/config/{kind}"), "config:read" as const],
  [routeKey("GET", "/api/v1/config/{kind}/{key}"), "config:read" as const],
  [routeKey("POST", "/api/v1/config/{kind}"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/config/{kind}/{key}/versions"), "tenant:admin" as const],
  [
    routeKey("POST", "/api/v1/config/{kind}/{key}/versions/{version}/publish"),
    "tenant:admin" as const,
  ],
]);

// ── Matching a request to its entry ──────────────────────────────────────────
//
// The middleware sees a concrete path (/api/v1/parties/9f8b…) and the tables
// above are keyed by template (/api/v1/parties/{partyId}). Rather than reach
// into the framework for the matched route pattern — undocumented, and it
// reports the MIDDLEWARE's pattern at this point in the chain — the templates
// are compiled to regexes once and matched here. Fifteen regex tests per
// request is nothing next to the database work that follows.

export type RouteDecision =
  | { readonly kind: "permission"; readonly permission: Permission }
  /** Needs a session, no particular permission. */
  | { readonly kind: "open" }
  /** No entry in either table — refused, loudly. */
  | { readonly kind: "unmapped" };

interface CompiledRoute {
  readonly method: string;
  readonly pattern: RegExp;
  readonly literal: boolean;
  readonly decision: RouteDecision;
}

function compile(key: RouteKey, decision: RouteDecision): CompiledRoute {
  const [method = "", path = ""] = key.split(" ");
  const literal = !path.includes("{");
  const source = path
    .split("/")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return { method, pattern: new RegExp(`^${source}$`), literal, decision };
}

// Literal routes first: /api/v1/parties/organizations must not be swallowed by
// /api/v1/parties/{partyId} because a template happened to be checked earlier.
const COMPILED: readonly CompiledRoute[] = [
  ...[...NO_PERMISSION_REQUIRED].map((key) => compile(key, { kind: "open" })),
  ...[...ROUTE_PERMISSIONS].map(([key, permission]) =>
    compile(key, { kind: "permission", permission }),
  ),
].sort((a, b) => Number(b.literal) - Number(a.literal));

/** What this request needs. Unmapped is a refusal, never a pass. */
export function decideRoute(method: string, path: string): RouteDecision {
  const wanted = method.toUpperCase();
  for (const route of COMPILED) {
    if (route.method === wanted && route.pattern.test(path)) return route.decision;
  }
  return { kind: "unmapped" };
}
