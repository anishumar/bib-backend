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

  // WHO OWNS A CLIENT (G3.2) reuses the party permissions, and that is argued
  // rather than assumed.
  //
  // It is not `tenant:admin`: the ladder and the Depts are the firm describing
  // ITSELF, and this is a fact about one client's relationship with it — the
  // same kind of fact as its identifiers and its leads, which `party:write`
  // already covers. Naming somebody the Key Manager grants them nothing; the
  // permission axis is untouched by it.
  //
  // A new `client:assign` would be the tighter answer and it is not free:
  // permissions reach existing firms as config rows, so one costs a migration
  // that carries it to every tenant that has not customised its roles (T2.5's
  // rule). And a firm that wants only partners reassigning clients can do most
  // of it today — publish a role without `party:write`, this afternoon, with no
  // deploy. Revisit when one asks, as `proposal:approve` was.
  [routeKey("GET", "/api/v1/parties/{partyId}/assignments"), "party:read" as const],
  [routeKey("POST", "/api/v1/parties/{partyId}/assignments"), "party:write" as const],
  [
    routeKey("POST", "/api/v1/parties/{partyId}/assignments/{assignmentId}/end"),
    "party:write" as const,
  ],
  // "My clients" is a read of the caller's OWN book and still takes
  // `party:read`, because it returns the firm's clients by name — the thing
  // that permission governs. It is not `NO_PERMISSION_REQUIRED` just because
  // the rows happen to be the caller's.
  [routeKey("GET", "/api/v1/my-clients"), "party:read" as const],

  // Gate 4's grants (G3.4). The READS carry the same permission as the writes,
  // deliberately: this list names a client's own people and what each of them
  // may see, which is not a fact the whole firm needs and is exactly what
  // somebody probing would want. `party:read` would have handed it to every
  // associate.
  [routeKey("GET", "/api/v1/portal-access/memberships/{membershipId}"), "portal:grant" as const],
  [routeKey("GET", "/api/v1/portal-access/memberships/{membershipId}/scope"), "portal:grant" as const],
  [routeKey("GET", "/api/v1/portal-access/clients/{partyId}"), "portal:grant" as const],
  [routeKey("POST", "/api/v1/portal-access/memberships/{membershipId}"), "portal:grant" as const],
  [routeKey("POST", "/api/v1/portal-access/grants/{grantId}/end"), "portal:grant" as const],

  // Inviting a client's contact IS granting them access — it creates the login
  // and the grant in one act — so it carries the same permission rather than a
  // second one that would have to be kept in step with it.
  [routeKey("POST", "/api/v1/portal-invites"), "portal:grant" as const],
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
  // WHO SOMEBODY REPORTS TO (T2.9) — `tenant:admin`, like the grade beside it
  // and for the same reason. Under a `reporting_line` policy this column decides
  // who may sign off whose statutory filing, so editing it is firm
  // administration and not a profile field somebody maintains about themselves.
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/reports-to"), "tenant:admin" as const],
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

  // THE VERIFICATION QUEUE (T2.9).
  //
  // The two reads are `party:read`, like the board they hang off: what is
  // waiting to be checked is delivery state, and it carries no money. Deliberately
  // NOT `work:write` — everybody on the team should be able to see that six
  // filings have been sitting unreviewed for a week, including the people who
  // cannot review them. A queue only reviewers can see is a queue nobody chases.
  [routeKey("GET", "/api/v1/checks"), "party:read" as const],
  [routeKey("GET", "/api/v1/jobs/{jobId}/checks"), "party:read" as const],
  [routeKey("GET", "/api/v1/checks/{approvalId}/checkers"), "party:read" as const],
  // DECIDING one is `work:write`, the same permission as doing the step, and
  // that is a decision rather than a convenience: approving somebody's filing
  // writes to the record of whether the work stands, which is the same kind of
  // act as saying it was done. It is also the floor `isEligible` applies before
  // the firm's own rule, which closes the demo's Q41 — a read-only Management
  // membership carrying a Senior Manager grade would otherwise pass a rank
  // threshold and be able to sign off a statutory filing.
  //
  // The permission is a FLOOR and never the whole answer: `work:write` gets you
  // as far as the firm's published rule, which then decides. And no permission
  // anywhere lets somebody approve their own work — that is a CHECK constraint,
  // not a grant.
  [routeKey("POST", "/api/v1/checks/{approvalId}/decide"), "work:write" as const],

  // WORK ITEMS (T3.1) — the row on somebody's desk.
  //
  // READS are `party:read`, the same permission the job board and the
  // verification queue take, and for the same reason: what is owed, whose it is
  // and what is late is delivery state, it carries no money, and everybody on
  // the team needs to see it — including the people who cannot act on it. A
  // board only the assignee can see is a board nobody chases.
  //
  // WRITES are `work:write`, which is the permission this table is FOR. Saying
  // a filing is done, moving it, or putting it on somebody's desk is doing the
  // work, not reading the board, and the record of who did it is worth only as
  // much as the gate in front of it. Deliberately not `party:write`: raising a
  // task for a client is not the same act as editing the client.
  // THE ESCALATION QUEUE (T4.5). `party:read`, the same as the board it hangs
  // off and the same as T3.3's decision queue — and for that queue's stated
  // reason: everybody on the team should be able to see that six tasks have
  // been escalated for a week, because a list narrowed to what you personally
  // may act on hides exactly the failure the ladder exists to surface. There is
  // no write here at all: a notice ends when the WORK ends, and nothing in this
  // product can dismiss one by hand.
  [routeKey("GET", "/api/v1/escalations"), "party:read" as const],

  [routeKey("GET", "/api/v1/work-items"), "party:read" as const],
  [routeKey("GET", "/api/v1/work-items/{workItemId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/work-items"), "work:write" as const],
  [routeKey("PATCH", "/api/v1/work-items/{workItemId}"), "work:write" as const],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/state"), "work:write" as const],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/assignee"), "work:write" as const],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/checklist"), "work:write" as const],
  [
    routeKey("POST", "/api/v1/work-items/{workItemId}/checklist/{checklistItemId}"),
    "work:write" as const,
  ],
  [
    routeKey("DELETE", "/api/v1/work-items/{workItemId}/checklist/{checklistItemId}"),
    "work:write" as const,
  ],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/dependencies"), "work:write" as const],
  [
    routeKey("DELETE", "/api/v1/work-items/{workItemId}/dependencies/{dependencyId}"),
    "work:write" as const,
  ],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/review"), "work:write" as const],
  // The work-item review queue, split exactly as T2.9's step queue is: the two
  // reads are `party:read` so everybody can see what is waiting, and DECIDING is
  // `work:write`, because approving somebody's filing writes to the record of
  // whether the work stands. The permission is a FLOOR and never the whole
  // answer — it gets you as far as the firm's published rule, which then
  // decides — and no permission anywhere lets somebody approve their own work:
  // that is a CHECK constraint, not a grant.
  // THE COMPLIANCE CALENDAR (T3.2). READS are `party:read`, the same permission
  // the work board takes: what a client owes and by when is delivery state, it
  // carries no money, and everybody on the team needs to see it — including the
  // people who cannot change it.
  //
  // WRITING A RULE is `tenant:admin`, and that is a deliberate step UP from
  // `work:write`. A due date is a RULE and a wrong one costs the CLIENT a
  // penalty rather than costing the firm an afternoon; confirming one is a
  // partner taking responsibility for it against the statute. That is the same
  // class of act as describing the firm's own Depts, not the same class as
  // ticking a task done.
  [routeKey("GET", "/api/v1/obligation-rules"), "party:read" as const],
  [routeKey("POST", "/api/v1/obligation-rules"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/obligation-rules/seed-india"), "tenant:admin" as const],
  [routeKey("PATCH", "/api/v1/obligation-rules/{ruleId}"), "tenant:admin" as const],
  // Superseding is `tenant:admin` like every other rule write, and it is the
  // sharpest of them: it decides which rule a return is due under from a
  // day onward, for every client the rule reaches.
  [routeKey("POST", "/api/v1/obligation-rules/{ruleId}/supersede"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/obligation-rules/{ruleId}/exceptions"), "tenant:admin" as const],
  [
    routeKey("DELETE", "/api/v1/obligation-rules/{ruleId}/exceptions/{periodEndMonth}"),
    "tenant:admin" as const,
  ],
  [routeKey("GET", "/api/v1/calendar"), "party:read" as const],
  // The coverage screen is the ANSWER to an empty calendar, so it is readable by
  // whoever can read the calendar. Hiding it behind admin would mean the person
  // who notices the gap cannot see why it is there.
  [routeKey("GET", "/api/v1/calendar/coverage"), "party:read" as const],

  // THE MISSED-DEADLINE QUEUE (T3.3), and the read and the write are a
  // deliberate step apart.
  //
  // READING is `party:read`, like the calendar it hangs off. A list filtered to
  // what you personally may act on would hide that six filings have been late
  // for a week because nobody senior enough looked — which is the failure this
  // queue exists to surface, reached from the inside.
  //
  // DECIDING is `obligation:resolve`, an eighth permission and its own
  // migration (0056). NOT `work:write`, which is the ordinary act of ticking
  // off the step you just performed: choosing between a provisional filing and
  // accepting a late fee commits the CLIENT'S money and moves liability onto
  // the firm, and it is the one delivery decision a client may later dispute.
  // NOT `tenant:admin` either, though that is partner-only today — a firm that
  // wants its senior manager to decide filings without also handing them the
  // ability to add users and rewrite roles could not express that, and roles
  // are held as config rows precisely so it can.
  [routeKey("GET", "/api/v1/calendar/decisions"), "party:read" as const],
  [routeKey("POST", "/api/v1/obligations/{obligationId}/resolve"), "obligation:resolve" as const],

  // THE FIRM'S OWN WORDS FOR COMPLIANCE (T3.3) — the counterpart of
  // `/work-vocabulary` and the same split, for the same reason. Reading is
  // `party:read`: the states are on every calendar row already, and an
  // associate wanting to know what "Resolved" means should not need admin.
  // Writing is `tenant:admin`, because these flags are MECHANISM — which state
  // a generated filing starts in, where a completed one lands, where a passed
  // deadline goes — and moving one silently changes what the nightly sweep
  // does to every client's filings.
  [routeKey("GET", "/api/v1/obligation-vocabulary"), "party:read" as const],
  [routeKey("POST", "/api/v1/obligation-vocabulary/states"), "tenant:admin" as const],
  [
    routeKey("PATCH", "/api/v1/obligation-vocabulary/states/{stateId}"),
    "tenant:admin" as const,
  ],
  [
    routeKey("POST", "/api/v1/obligation-vocabulary/resolution-options"),
    "tenant:admin" as const,
  ],
  [
    routeKey("PATCH", "/api/v1/obligation-vocabulary/resolution-options/{optionId}"),
    "tenant:admin" as const,
  ],

  [routeKey("GET", "/api/v1/work-item-checks"), "party:read" as const],
  [routeKey("GET", "/api/v1/work-item-checks/{approvalId}/checkers"), "party:read" as const],
  [routeKey("POST", "/api/v1/work-item-checks/{approvalId}/decide"), "work:write" as const],

  // THE FIRM'S OWN WORDS FOR WORK (T3.1). The same split the grade ladder and
  // the Dept lists take, and the same argument: READING is `party:read`,
  // because every board renders these names and a person who cannot read them
  // sees uuids. WRITING is `tenant:admin`, because these rows are not labels —
  // the FLAGS on them decide what every work item in that state must carry, and
  // moving the statutory default changes the urgency of every filing created
  // afterwards. That is a decision at the level of deciding what a role means.
  [routeKey("GET", "/api/v1/work-vocabulary"), "party:read" as const],
  [routeKey("POST", "/api/v1/work-vocabulary/states"), "tenant:admin" as const],
  [routeKey("PATCH", "/api/v1/work-vocabulary/states/{stateId}"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/work-vocabulary/priorities"), "tenant:admin" as const],
  [
    routeKey("PATCH", "/api/v1/work-vocabulary/priorities/{priorityId}"),
    "tenant:admin" as const,
  ],
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

  // THE DOCUMENT STORE (T3.6). Reading is `party:read` and writing is
  // `party:write`, matching every other route that handles a client's material
  // — a document is a fact about a client, and the permission that governs
  // seeing their record governs seeing their file.
  //
  // NO NEW PERMISSION, and that is a considered decision rather than an
  // omission. CLAUDE.md says a new permission costs a migration, so the bar is
  // whether a firm would genuinely want to grant one of these without the
  // other. It would not: anybody who may open a client's page may see what is
  // attached to it, and anybody who may edit that client may attach to it.
  // `document:read` would be a distinction no firm has asked for, enforced on
  // every route from now on.
  //
  // THE DOWNLOAD ROUTES TAKE THE SAME PERMISSION AS THE METADATA, deliberately.
  // Splitting them would say "you may see that a file exists but not open it",
  // which is a record-scope question (Gate 4, U1) and not a role question — and
  // answering a role question with a permission would make the real answer
  // harder to add later.
  // THE DASHBOARDS (T3.7). `party:read` is the ROLE gate, and it is deliberately
  // not the whole story: every one of these routes ALSO requires commercial
  // visibility, checked in the handler rather than here.
  //
  // Two axes, and this table only knows about one. The fee axis is a flag on the
  // membership and is orthogonal to the role by design (CLAUDE.md) — a manager
  // who may read every client is not automatically somebody who may see what the
  // firm earns. Putting it in this table would collapse the two into one, which
  // is the thing the fifth axis exists to prevent.
  [routeKey("GET", "/api/v1/dashboard/overview"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/mrr/{axis}"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/receivables/by-client"), "party:read" as const],

  [routeKey("GET", "/api/v1/documents"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents"), "party:write" as const],
  // Rendering WRITES — it stores a document and attaches it — so `party:write`,
  // the same permission every other drafting route on these documents takes.
  [routeKey("POST", "/api/v1/documents/render"), "party:write" as const],
  [routeKey("GET", "/api/v1/documents/{documentId}"), "party:read" as const],
  [routeKey("GET", "/api/v1/documents/{documentId}/content"), "party:read" as const],
  [routeKey("GET", "/api/v1/documents/{documentId}/versions"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents/{documentId}/versions"), "party:write" as const],
  [
    routeKey("GET", "/api/v1/documents/{documentId}/versions/{versionId}/content"),
    "party:read" as const,
  ],
  [routeKey("GET", "/api/v1/documents/{documentId}/links"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents/{documentId}/links"), "party:write" as const],
  [routeKey("GET", "/api/v1/subjects/{subjectKind}/{subjectRef}/documents"), "party:read" as const],

  // Brand assets are `tenant:admin` to WRITE, unlike the documents themselves.
  // The firm's letterhead and its partners' signature images are what every
  // outgoing document is printed under; putting a new one in force is the same
  // class of act as naming the entity that issues (G1.2), which is admin for
  // the same reason. Reading is `config:read`, so a drafting screen can show
  // what a document will carry without being able to change it.
  [routeKey("GET", "/api/v1/firm-entities/{entityPartyId}/brand-assets"), "config:read" as const],
  [
    routeKey("PUT", "/api/v1/firm-entities/{entityPartyId}/brand-assets/{kind}"),
    "tenant:admin" as const,
  ],

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
