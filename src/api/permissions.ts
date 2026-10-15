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
 * Session management belongs here: a caller must be able to see who they are,
 * choose an org, and sign out regardless of what their role permits — otherwise
 * a misconfigured role would lock someone out of the very endpoints they need to
 * fix it.
 *
 * ── AND THE CLIENT PORTAL'S STATUS HOME, WHICH IS ARGUED (T6.5) ───────────
 *
 * It is not session management, so it needs its own reason. Being invited and
 * being granted a company IS the authorisation to read that company's status:
 * `crm.portal_access` is a row somebody wrote, with a granter, a date and a
 * ledger event, and gate 4 enforces it in the database. A permission on top
 * would be a second answer to a question already answered — and every portal
 * login would hold it, which is the definition of a permission that decides
 * nothing.
 *
 * What a contact may DO — upload a file, answer a question, approve something —
 * is the question that genuinely needs a role, and it needs one that declares
 * its AUDIENCE (a migration; see `AuthzService.permissionsOf` and
 * `tests/api/portal-permissions.test.ts`). That lands with T6.6, where those
 * verbs exist. Adding the permission first would register something no route
 * checks, which this codebase has now paid for four times.
 */
export const NO_PERMISSION_REQUIRED: ReadonlySet<RouteKey> = new Set([
  routeKey("GET", "/api/v1/auth/me"),
  routeKey("POST", "/api/v1/auth/switch-tenant"),
  routeKey("POST", "/api/v1/auth/logout"),
  // Changing your own password. On this list for the reason the sentence above
  // gives about being locked out by a misconfigured role — but more simply than
  // that: there is no role anywhere in this product that should be able to stop
  // somebody rotating their own credential, so a permission here could only
  // ever be one that every role holds, which is the definition of one that
  // decides nothing. Gate 3 is not the control on this route; the CURRENT
  // PASSWORD is.
  routeKey("POST", "/api/v1/auth/password"),
  routeKey("GET", "/api/v1/tenancy/me/memberships"),
  // Your OWN name (V2.5), like your own password: no role anywhere should be
  // able to stop somebody correcting how their name is spelt, and the route
  // takes no id, so it can reach nobody else's account.
  routeKey("PATCH", "/api/v1/tenancy/me"),
  // Your OWN notifications and your own choices about them (0323). Every one of
  // these is the caller's, by construction: none takes a user id, and the
  // database's restrictive policy refuses another person's rows. A role that
  // could stop somebody reading their own bell would be one every role holds.
  // A portal session never reaches them: they are not in PORTAL_PATHS.
  routeKey("GET", "/api/v1/notifications"),
  routeKey("GET", "/api/v1/notifications/unread-count"),
  routeKey("POST", "/api/v1/notifications/{notificationId}/read"),
  routeKey("POST", "/api/v1/notifications/read-all"),
  routeKey("GET", "/api/v1/notifications/preferences"),
  routeKey("PUT", "/api/v1/notifications/preferences"),
  routeKey("GET", "/api/v1/notifications/firm-defaults"),
  routeKey("GET", "/api/v1/portal/home"),
  // The action centre's LIST, for the same reason as the home above it, and it
  // is what makes T6.6's read-only portal role coherent: `client_viewer` holds
  // no permission at all and still sees every ask its company has been sent. It
  // simply cannot answer one — those three routes are in ROUTE_PERMISSIONS,
  // behind `portal:respond`.
  routeKey("GET", "/api/v1/portal/asks"),
  routeKey("GET", "/api/v1/portal/requests"),
  // ── THE LIBRARY (T6.7) ────────────────────────────────────────────────
  //
  // Four reads, and the argument is the one the home and the ask list already
  // made: being invited and granted a company IS the authorisation to read that
  // company's records. `crm.portal_access` is a row somebody wrote, with a
  // granter, a date and a ledger event, and gate 4 enforces it. A permission on
  // top would be a second answer to a settled question, and every portal login
  // would hold it.
  //
  // It also decides something concrete rather than being a formality: a
  // `client_viewer` holds NO permission at all, and the acceptance line — a
  // client finds last year's challan without emailing anyone — has to be true
  // for them too. Putting the download behind `portal:respond` would make the
  // read-only role unable to read.
  routeKey("GET", "/api/v1/portal/documents"),
  routeKey("GET", "/api/v1/portal/documents/{documentId}/content"),
  routeKey("GET", "/api/v1/portal/invoices"),
  routeKey("GET", "/api/v1/portal/digest"),
]);

/** The permission each business route requires. */
export const ROUTE_PERMISSIONS: ReadonlyMap<RouteKey, Permission> = new Map([
  [routeKey("GET", "/api/v1/parties"), "party:read" as const],
  // The product's own vocabulary, not the firm's data — but still behind a
  // session and behind `party:read`, because it is only ever wanted by somebody
  // looking at a party and an unauthenticated read is a surface with no reason
  // to exist.
  [routeKey("GET", "/api/v1/parties/relationship-types"), "party:read" as const],
  [routeKey("GET", "/api/v1/parties/{partyId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/parties/organizations"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/persons"), "party:write" as const],
  [
    routeKey("POST", "/api/v1/parties/organizations/{partyId}/legal-entities"),
    "party:write" as const,
  ],
  [routeKey("POST", "/api/v1/parties/{partyId}/identifiers"), "party:write" as const],
  // Correcting a client's master data (V2.5): the gate that created it.
  [routeKey("PATCH", "/api/v1/parties/{partyId}"), "party:write" as const],
  [routeKey("PATCH", "/api/v1/parties/{partyId}/legal-entity"), "party:write" as const],
  [routeKey("PUT", "/api/v1/parties/{partyId}/legal-entity/time-zone"), "party:write" as const],
  [routeKey("PUT", "/api/v1/parties/{partyId}/return-periods"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/parties/{partyId}/return-periods/{tax}"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/{partyId}/identifiers/{identifierId}/end"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/{partyId}/identifiers/{identifierId}/void"), "party:write" as const],
  [routeKey("POST", "/api/v1/parties/relationships"), "party:write" as const],
  // Ending one is the same permission as recording one. It is not a delete —
  // the row stays, it still resolves by id, and what changes is a date the
  // firm always could have written at the moment of recording.
  [routeKey("POST", "/api/v1/parties/relationships/{relationshipId}/end"), "party:write" as const],
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

  // Loading a firm's existing book of clients. `tenant:admin` rather than
  // `party:write`, and not because the rows are special: one confirm creates
  // parties, legal entities, people, Key Managers, SPOCs and SIGNED engagement
  // letters in one act, and its report names the roster by email — a
  // `tenant:admin` read. Onboarding a book is the administrator's act.
  [routeKey("POST", "/api/v1/client-imports"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/client-imports"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/client-imports/template"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/client-imports/{importId}"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/client-imports/{importId}/confirm"), "tenant:admin" as const],

  // Gate 4's grants (G3.4). The READS carry the same permission as the writes,
  // deliberately: this list names a client's own people and what each of them
  // may see, which is not a fact the whole firm needs and is exactly what
  // somebody probing would want. `party:read` would have handed it to every
  // associate.
  [routeKey("GET", "/api/v1/portal-access/memberships/{membershipId}"), "portal:grant" as const],
  [routeKey("GET", "/api/v1/portal-access/memberships/{membershipId}/scope"), "portal:grant" as const],
  [routeKey("GET", "/api/v1/portal-access/clients/{partyId}"), "portal:grant" as const],
  [routeKey("GET", "/api/v1/portal-access"), "portal:grant" as const],
  [routeKey("POST", "/api/v1/portal-access/memberships/{membershipId}"), "portal:grant" as const],
  // Q064: a client's group, and granting the rest of it (one grant per company).
  [routeKey("GET", "/api/v1/portal-access/clients/{partyId}/group"), "portal:grant" as const],
  [routeKey("POST", "/api/v1/portal-access/memberships/{membershipId}/group"), "portal:grant" as const],
  [routeKey("POST", "/api/v1/portal-access/grants/{grantId}/end"), "portal:grant" as const],

  // Inviting a client's contact IS granting them access — it creates the login
  // and the grant in one act — so it carries the same permission rather than a
  // second one that would have to be kept in step with it.
  [routeKey("POST", "/api/v1/portal-invites"), "portal:grant" as const],

  // Re-sending it carries the SAME permission and not a weaker one, because it
  // is the same power: whoever may press this mails a credential to somebody
  // outside the firm. It looks smaller than inviting — nothing new is created —
  // and it is not, which is exactly the reasoning that would put it behind
  // `party:read` and hand it to every associate.
  [routeKey("POST", "/api/v1/portal-invites/{membershipId}/resend"), "portal:grant" as const],

  // ── The client-directed ask (T6.6) ─────────────────────────────────────
  //
  // The FIRM's side is ordinary delivery work: reading what has been asked of a
  // client is `party:read`, and asking, closing or withdrawing is `work:write`.
  // Not `portal:grant` — that permission decides who may SEE the firm's work,
  // and this is the ordinary act of doing it.
  [routeKey("GET", "/api/v1/work-items/{workItemId}/asks"), "party:read" as const],
  [routeKey("POST", "/api/v1/work-items/{workItemId}/asks"), "work:write" as const],
  [routeKey("POST", "/api/v1/asks/{askId}/close"), "work:write" as const],
  [routeKey("POST", "/api/v1/asks/{askId}/withdraw"), "work:write" as const],

  // ── WHAT CLIENTS HAVE ASKED THE FIRM FOR (T6.8) ───────────────────────
  //
  // `party:read` on the inbox and `work:write` on the acts, exactly as the
  // firm's side of an ask is split. Reading it names every client that has
  // written in, which is the thing `party:read` gates; replying and closing are
  // the firm saying what it is doing about a client's work.
  //
  // There is NO route here requiring a routing permission, because there is no
  // routing (0068): the inbox is firm-wide, so anyone who may read clients may
  // read all of it.
  [routeKey("GET", "/api/v1/client-requests"), "party:read" as const],
  [routeKey("GET", "/api/v1/client-requests/{requestId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/client-requests/{requestId}/replies"), "work:write" as const],
  [routeKey("POST", "/api/v1/client-requests/{requestId}/close"), "work:write" as const],
  // Putting a request on somebody's desk is `work:write` — the same permission
  // that says a piece of work was done, because this is the record of WHOSE the
  // work is. Not `tenant:admin`: assigning is the ordinary act of running the
  // day, and a firm whose managers cannot say who is handling a client's
  // request would have the whole inbox routed by whoever holds the roster.
  [routeKey("PUT", "/api/v1/client-requests/{requestId}/assignee"), "work:write" as const],
  // But the RULE is `tenant:admin`, because it decides that for everybody at
  // once and for every request from now on — the same distinction
  // `/tenancy/structure/work-split` draws between running the firm and doing
  // the work.
  [routeKey("PUT", "/api/v1/tenancy/client-request-routing"), "tenant:admin" as const],

  // ── Stopping the chaser (T4.4) ─────────────────────────────────────────
  //
  // READING is `party:read` — a freeze is a fact about a client, like its
  // identifiers and its account team, and anybody who can open the client page
  // should be able to see why nothing is being sent.
  //
  // SETTING one is `tenant:admin`, and that is argued rather than assumed. It is
  // not `party:write`, which G3.2 established covers facts ABOUT a client that
  // grant nobody anything — this one switches off a piece of the firm's own
  // machinery, silently, for as long as nobody notices. It is not `work:write`
  // either: that is doing the job, and this is deciding the firm will stop
  // asking. The board's own case for it is a partner negotiating a dispute.
  //
  // A `chaser:pause` of its own would be the tighter answer and is not free —
  // a permission reaches existing firms as config rows, so it costs a migration
  // to every tenant that has not customised its roles. `proposal:approve` and
  // `obligation:resolve` both got one when a firm ASKED; revisit the same way.
  [routeKey("GET", "/api/v1/clients/{partyId}/freezes"), "party:read" as const],
  [routeKey("POST", "/api/v1/clients/{partyId}/freezes"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/freezes/{freezeId}/lift"), "tenant:admin" as const],

  // ── AND THE CLIENT'S SIDE — THE FIRST PORTAL ROUTES THAT NEED A PERMISSION ─
  //
  // `portal:respond` is the tenth permission and the only one in this product
  // held by somebody OUTSIDE the firm. It is what makes the board's line — "this
  // contact may upload, that one may only look" — a role a firm can assign:
  // `client_contact` carries it, `client_viewer` does not, and both see
  // everything the portal shows because reading is authorised by the grant.
  //
  // It is not reachable by a colleague. A role declares its AUDIENCE since 0064,
  // and `roleServes` refuses a CLIENT_PORTAL role's permissions to a STAFF
  // session — so a firm that put this on `associate` would find it grants
  // nothing, which is right, because the handlers refuse a staff session anyway.
  [routeKey("POST", "/api/v1/portal/asks/{askId}/answer"), "portal:respond" as const],
  [routeKey("POST", "/api/v1/portal/asks/{askId}/decision"), "portal:respond" as const],
  [routeKey("POST", "/api/v1/portal/asks/{askId}/documents"), "portal:respond" as const],
  // ── AND THE ELEVENTH PERMISSION, THE SECOND HELD OUTSIDE THE FIRM ──────
  //
  // `portal:request` is not a widening of the one above it. Everything
  // `portal:respond` covers is a REPLY to something the firm raised; these
  // three let a contact START something the firm is then expected to act on,
  // and a firm may well want the clerk who sends the registers every month to
  // go on sending them and not to open requests. Folding the two together would
  // take that choice away with no way to give it back short of splitting the
  // permission later, which is a migration and a role edit at every firm.
  //
  // `client_contact` carries it from 0069; `client_viewer` does not, and still
  // sees the whole portal — reading is authorised by the grant, never by a
  // permission. A firm that wants its read-only contact able to ask adds this
  // one permission to that role on the admin screen.
  //
  // The LIST is not here, for the same reason the ask list is not.
  [routeKey("POST", "/api/v1/portal/requests"), "portal:request" as const],
  [routeKey("POST", "/api/v1/portal/requests/{requestId}/replies"), "portal:request" as const],
  [routeKey("POST", "/api/v1/portal/requests/{requestId}/withdraw"), "portal:request" as const],
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
  // Setup readiness (V2.6): what the firm has not set up yet, by name. Behind
  // the permission every line's fix already needs.
  [routeKey("GET", "/api/v1/tenancy/readiness"), "tenant:admin" as const],
  // Which domains the firm's client mail may claim to come from (Q059): an
  // administrator's call, made once the mail provider authorises the relay.
  [routeKey("GET", "/api/v1/tenancy/mail-senders"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/mail-senders"), "tenant:admin" as const],
  // The PICKER, not the roster: names and rungs of active staff, no emails.
  // `party:read`: whoever may look at a client may see which colleague to
  // hand its work to. Decided 2026-09-25; see `TenancyService.listColleagues`.
  [routeKey("GET", "/api/v1/tenancy/colleagues"), "party:read" as const],
  [routeKey("POST", "/api/v1/tenancy/members"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/role"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/active"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/members/{membershipId}/fees"), "tenant:admin" as const],

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
  // The ACTIVE Depts and teams, for a picker (2026-09-25): the account team's
  // SPOC form is `party:write`, and a manager allowed to use it was shown no
  // form because the list behind it was the admin read above. Names and codes
  // only, which the account team table already prints to any client reader.
  [routeKey("GET", "/api/v1/tenancy/axes"), "party:read" as const],
  [routeKey("POST", "/api/v1/tenancy/structure/axes"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/axes/{axisId}"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/axes/{axisId}/active"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/structure/work-split"), "tenant:admin" as const],
  // Same shelf, same permission: which calendar the firm's months are cut on
  // moves what a CLIENT sees on their month view, so it is running the firm.
  [routeKey("PUT", "/api/v1/tenancy/structure/time-zone"), "tenant:admin" as const],
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
  // And the LIST of signatories (0343, Q005), on the same split.
  [routeKey("GET", "/api/v1/tenancy/signatories"), "config:read" as const],
  [routeKey("POST", "/api/v1/tenancy/signatories"), "tenant:admin" as const],
  [routeKey("PATCH", "/api/v1/tenancy/signatories/{signatoryId}"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/tenancy/signatories/{signatoryId}/default"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/tenancy/signatories/{signatoryId}/active"), "tenant:admin" as const],

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
  [routeKey("PUT", "/api/v1/leads/{leadId}/details"), "party:write" as const],
  // Deleting one entered by mistake (0086) is the same permission that
  // captures one: whoever may put a mistake into the pipeline may take it out.
  // The one case that is an administrator's — a lead already closed, and so in
  // the pipeline's numbers — is decided in the service, because it turns on the
  // LEAD, which a route table cannot see.
  [routeKey("DELETE", "/api/v1/leads/{leadId}"), "party:write" as const],

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
  // A draft's head — its title, validity, Background and the cover's two names
  // (0084). The same permission that drafts it and adds its lines.
  [routeKey("PATCH", "/api/v1/proposals/{proposalId}"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/lines"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/proposals/{proposalId}/lines/{lineId}"), "party:write" as const],
  [routeKey("PATCH", "/api/v1/proposals/{proposalId}/lines/{lineId}"), "party:write" as const],
  // One fee for several services (0394): writing the draft, as a priced line is.
  [routeKey("PUT", "/api/v1/proposals/{proposalId}/lines/{lineId}/pricing"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/fee-groups"), "party:write" as const],
  [routeKey("PATCH", "/api/v1/proposals/{proposalId}/fee-groups/{groupId}"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/proposals/{proposalId}/fee-groups/{groupId}"), "party:write" as const],
  // The rate of one of a draft's other currencies (0344): part of writing it.
  [routeKey("PUT", "/api/v1/proposals/{proposalId}/rates/{currency}"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/proposals/{proposalId}/rates/{currency}"), "party:write" as const],
  // A draft made by mistake (0086), on the permission that drafts one — the
  // whole document struck off before it went out, as a line is above.
  [routeKey("DELETE", "/api/v1/proposals/{proposalId}"), "party:write" as const],
  // A closed quote copied into a new draft (0316): drafting, so drafting's
  // permission.
  [routeKey("POST", "/api/v1/proposals/{proposalId}/copy"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/send"), "party:write" as const],
  // A new link, and a new email with it (0085) — sending again, so Send's own
  // permission.
  [routeKey("POST", "/api/v1/proposals/{proposalId}/reissue"), "party:write" as const],
  [routeKey("POST", "/api/v1/proposals/{proposalId}/decision"), "party:write" as const],
  // Accepting on the client's behalf commits the firm, so it is its own
  // permission, a partner's by default (0317); declining stays party:write.
  [routeKey("POST", "/api/v1/proposals/{proposalId}/acceptance"), "acceptance:record" as const],
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

  // What a client can be billed for (T3.5b). `party:read`, like every other
  // read of that client's commercial record — the FIGURES on it are governed by
  // the fee axis, which is a different question from the permission and is
  // applied in the handler, exactly as it is on a letter and a proposal.
  [
    routeKey("GET", "/api/v1/parties/{partyId}/billable-engagements"),
    "party:read" as const,
  ],
  // Who a letter for this client may name (F-10-1). `party:read`: it is the
  // client's own record of companies and people, the same read the client
  // page already gives anybody who may see the client.
  [routeKey("GET", "/api/v1/parties/{partyId}/structure"), "party:read" as const],
  [routeKey("GET", "/api/v1/engagement-letters/{letterId}"), "party:read" as const],
  // Whose desk its work will land on (T6.17): names the firm's own staff, as
  // the letter and the account team already do, to anybody who may read them.
  [routeKey("GET", "/api/v1/engagement-letters/{letterId}/routing"), "party:read" as const],
  [routeKey("POST", "/api/v1/engagement-letters"), "party:write" as const],

  // Writing an accepted quote up as a letter (T3.5b). `party:write`, the same
  // as drafting one by hand, because that is exactly what it is — the terms
  // arrive already typed. Reading the quote it copies is `party:read`, which
  // anybody holding `party:write` also has, so this needs no second permission.
  [
    routeKey("POST", "/api/v1/proposals/{proposalId}/engagement-letter"),
    "party:write" as const,
  ],
  // T6.18 S6: a draft's head and its lines change in place, as a proposal's do.
  [routeKey("PATCH", "/api/v1/engagement-letters/{letterId}"), "party:write" as const],
  [routeKey("PUT", "/api/v1/engagement-letters/{letterId}/rates/{currency}"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/engagement-letters/{letterId}/rates/{currency}"), "party:write" as const],
  [routeKey("PATCH", "/api/v1/engagement-letters/{letterId}/lines/{lineId}"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/lines"), "party:write" as const],
  [
    routeKey("DELETE", "/api/v1/engagement-letters/{letterId}/lines/{lineId}"),
    "party:write" as const,
  ],
  // A fee group and a line's pricing (0083). `party:write`, like every other
  // change to a draft letter's terms — a fee group is the same kind of act as a
  // priced line, stated for several services at once. What an associate may
  // SEE of the fee is the fee axis, applied in the handler.
  [
    routeKey("PUT", "/api/v1/engagement-letters/{letterId}/lines/{lineId}/pricing"),
    "party:write" as const,
  ],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/fee-groups"), "party:write" as const],
  [
    routeKey("PATCH", "/api/v1/engagement-letters/{letterId}/fee-groups/{groupId}"),
    "party:write" as const,
  ],
  [
    routeKey("DELETE", "/api/v1/engagement-letters/{letterId}/fee-groups/{groupId}"),
    "party:write" as const,
  ],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/clauses"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/clauses/standard"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/send"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/withdraw"), "party:write" as const],
  // An engagement's life after signature (V2.3): the same gate as the letter
  // that created it.
  [routeKey("POST", "/api/v1/engagements/{engagementId}/end"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagements/{engagementId}/pause"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagements/{engagementId}/resume"), "party:write" as const],
  // A draft made by mistake (0086), on the permission that withdraws one: the
  // same person who may pull a letter the client has seen may strike off one
  // nobody has.
  [routeKey("DELETE", "/api/v1/engagement-letters/{letterId}"), "party:write" as const],
  // A withdrawn letter copied into a new draft (0316): drafting's permission.
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/copy"), "party:write" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/signature"), "party:write" as const],
  // The client said yes outside bib and a partner records it (0317): it signs
  // the letter and starts the work, so it is not party:write.
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/acceptance"), "acceptance:record" as const],
  // The same yes recorded on a draft that was never sent (the short letter).
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/agreed"), "acceptance:record" as const],
  [routeKey("POST", "/api/v1/engagement-letters/{letterId}/signature-request"), "party:write" as const],


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
  // CANCELLING a job (V2.4) takes its work off every desk: the same gate as
  // doing that work.
  [routeKey("POST", "/api/v1/jobs/{jobId}/cancel"), "work:write" as const],
  // Whose desk a step sits on (0301): moving it is doing the work's
  // housekeeping, so the same gate as ticking it; reading who may do it and
  // what is on your own desk is reading the board.
  [routeKey("PUT", "/api/v1/jobs/{jobId}/steps/{stepKey}/assignee"), "work:write" as const],
  [routeKey("GET", "/api/v1/jobs/{jobId}/steps/{stepKey}/performers"), "party:read" as const],
  [routeKey("GET", "/api/v1/my-steps"), "party:read" as const],
  // Deciding a machine's output is doing the work, not reading the board: the
  // row it writes is the record of who checked it. Same permission as
  // completing a step, deliberately — a firm that trusts somebody to say "this
  // filing is done" trusts them to say "the machine got it right".
  [routeKey("POST", "/api/v1/jobs/{jobId}/steps/{stepKey}/decide"), "work:write" as const],
  // Ticking one of a step's sub-steps (T6.15) is doing part of the step, so it
  // takes what doing the step takes. The desk and the grade band are the
  // service's; this is the floor under them.
  [routeKey("PUT", "/api/v1/jobs/{jobId}/steps/{stepKey}/sub-steps/{itemKey}"), "work:write" as const],

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
  // Ticking a check's review points (T6.15) is part of deciding it, so the same
  // floor, and the same firm's rule on top of it (`eligibilityOf`).
  [routeKey("PUT", "/api/v1/checks/{approvalId}/review-points/{itemKey}"), "work:write" as const],

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
  // A note on a task (0330, CA#30): the same permission as the work itself.
  [routeKey("POST", "/api/v1/work-items/{workItemId}/notes"), "work:write" as const],
  // The filing a task files (CA#36): reading is the board's own permission;
  // linking writes the calendar's record of what work files a filing, which is
  // the permission completing that work needs.
  [routeKey("GET", "/api/v1/work-items/{workItemId}/filing"), "party:read" as const],
  [routeKey("PUT", "/api/v1/work-items/{workItemId}/filing"), "work:write" as const],
  [routeKey("DELETE", "/api/v1/work-items/{workItemId}/filing"), "work:write" as const],
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
  [routeKey("POST", "/api/v1/obligation-rules/seed-pack/{country}"), "tenant:admin" as const],
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
  // WHICH SERVICES OWE WHICH FILING (T6.16). Reading follows the calendar's
  // reads: everybody on the team needs to see what a service carries,
  // including the people who cannot change it. Adding and removing follows
  // every other rule write, `tenant:admin`, and for the same reason and more:
  // it decides which of the firm's clients owe a statutory filing, and adding
  // an unconfirmed rule CONFIRMS it, which is a partner taking responsibility
  // for a date. It is the firm's compliance setup, not an associate's act.
  [routeKey("GET", "/api/v1/obligation-filings"), "party:read" as const],
  [routeKey("GET", "/api/v1/services/{serviceEntryId}/filings"), "party:read" as const],
  [routeKey("POST", "/api/v1/services/{serviceEntryId}/filings"), "tenant:admin" as const],
  [
    routeKey("POST", "/api/v1/services/{serviceEntryId}/filings/{ruleId}/unlink"),
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
  // The firm's review rules by label (CA#27): what a task's sender picks from.
  [routeKey("GET", "/api/v1/review-rules"), "party:read" as const],
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
  // ISSUING AND CANCELLING ARE `invoice:issue`, and that is the one considered
  // difference. (They were `tenant:admin` until 0335, CA#6: a firm had to make
  // its accounts person a full administrator to issue a bill. 0335 gave the new
  // permission to exactly the roles that carried tenant:admin.) Raising a draft is bookkeeping; ISSUING allocates nothing new
  // but sends a legal demand to a client under one of the firm's own entities,
  // and CANCELLING withdraws one — both leave a permanent mark in a consecutive
  // series that a tax authority may ask about. That is a decision at the level
  // of deciding what a role means, not a drafting action.
  [routeKey("GET", "/api/v1/invoices"), "party:read" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}"), "party:read" as const],
  [routeKey("POST", "/api/v1/invoices"), "party:write" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/lines"), "party:write" as const],
  [routeKey("DELETE", "/api/v1/invoices/{invoiceId}/lines/{lineId}"), "party:write" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/issue"), "invoice:issue" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/cancel"), "invoice:issue" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/irn"), "party:write" as const],
  // Who raised a draft may say whose revenue it is, as they did when raising.
  [routeKey("PUT", "/api/v1/invoices/{invoiceId}/manager"), "party:write" as const],
  // And when it is due (B20): a draft's term, set by whoever may raise it.
  [routeKey("PUT", "/api/v1/invoices/{invoiceId}/due-date"), "party:write" as const],
  // MONEY AGAINST AN INVOICE (T3.5). Recording a payment is `party:write` —
  // it is bookkeeping, and the person chasing a receivable is the person who
  // marks it settled. ISSUING A CREDIT NOTE IS `invoice:issue`, and that is the
  // considered line: it takes money off a legal document, it is the mechanism
  // through which revenue leaks, and the reason it demands a REASON is that
  // somebody has to answer for it later. Reading is `party:read`, with the fee
  // axis deciding whether the amounts are visible — not this table.
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/payments"), "party:write" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/payments"), "party:read" as const],
  [routeKey("POST", "/api/v1/invoices/{invoiceId}/credit-notes"), "invoice:issue" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/credit-notes"), "party:read" as const],
  [routeKey("GET", "/api/v1/invoices/{invoiceId}/balance"), "party:read" as const],
  // The GST tax invoice (Q056, Q057): a draft's place of supply and a line's
  // SAC are draft edits like a line; a client's TDS is a client setting.
  [routeKey("PUT", "/api/v1/invoices/{invoiceId}/place-of-supply"), "party:write" as const],
  [routeKey("PUT", "/api/v1/invoices/{invoiceId}/lines/{lineId}/sac"), "party:write" as const],
  [routeKey("GET", "/api/v1/clients/{partyId}/tds"), "party:read" as const],
  [routeKey("PUT", "/api/v1/clients/{partyId}/tds"), "party:write" as const],
  [routeKey("GET", "/api/v1/invoicing/states"), "party:read" as const],
  // A company's bank accounts and LUTs (0369): the firm's own set-up, as a
  // company is (tenant:admin to change, party:read to see).
  [routeKey("GET", "/api/v1/invoicing/companies"), "party:read" as const],
  [routeKey("POST", "/api/v1/firm-entities/{entityPartyId}/bank-accounts"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/firm-entities/{entityPartyId}/bank-accounts/{accountId}/retire"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/firm-entities/{entityPartyId}/luts"), "tenant:admin" as const],
  [routeKey("POST", "/api/v1/firm-entities/{entityPartyId}/luts/{lutId}/retire"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/firm-entities/{entityPartyId}/round-off"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/receivables"), "party:read" as const],

  // BILL DUES (0318). Reading what is owed is `party:read`, with the fee axis
  // redacting the amounts. Raising, linking, skipping and setting a schedule
  // are `party:write`, the permission that raises an invoice by hand: SPOCs
  // and managers both raise bills (Ashish, 2026-10-01). Issuing is
  // `invoice:issue` on the invoice routes (0335). The FIRM'S SETTINGS are
  // `tenant:admin`: the switch starts a sweep across every client, and the
  // advance policy and default tax rates (0322) change what every advance does.
  [routeKey("GET", "/api/v1/billing/dues"), "party:read" as const],
  [routeKey("GET", "/api/v1/billing/unscheduled"), "party:read" as const],
  // Work vs Billing (Q041): a read of the bills beside the work; amounts
  // redacted for a login without the fee axis, like the dues.
  [routeKey("GET", "/api/v1/billing/work-vs-billing"), "party:read" as const],
  [routeKey("PUT", "/api/v1/engagements/{engagementId}/billing"), "party:write" as const],
  [routeKey("POST", "/api/v1/billing/raise"), "party:write" as const],
  // Skipping gives up revenue: the firm's own permission, Partner and Manager by
  // default (0321), moved on the roles screen.
  [routeKey("POST", "/api/v1/billing/dues/{dueId}/skip"), "billing:skip" as const],
  [routeKey("POST", "/api/v1/billing/dues/{dueId}/link"), "party:write" as const],
  // The advance and the final bill (0320). A refund's credit note and keeping
  // an advance are `invoice:issue`, as credit notes are (0335). (Approve start
  // went with 0322: the advance no longer holds the work.)
  [routeKey("GET", "/api/v1/billing/advances"), "party:read" as const],
  // Advances raised before the letter (0363, Q046: "Managers and above"):
  // reading is a colleague's; raising and mapping are advance:manage; giving
  // one back is a credit note, invoice:issue as every credit note is.
  [routeKey("GET", "/api/v1/advances"), "party:read" as const],
  [routeKey("GET", "/api/v1/advances/{advanceId}"), "party:read" as const],
  [routeKey("GET", "/api/v1/advances/{advanceId}/targets"), "party:read" as const],
  [routeKey("POST", "/api/v1/advances"), "advance:manage" as const],
  [routeKey("POST", "/api/v1/advances/{advanceId}/allocations"), "advance:manage" as const],
  [routeKey("POST", "/api/v1/advances/{advanceId}/allocations/{allocationId}/end"), "advance:manage" as const],
  [routeKey("POST", "/api/v1/advances/{advanceId}/give-back"), "invoice:issue" as const],
  // A letter names an advance received as it names its other terms.
  [routeKey("GET", "/api/v1/engagement-letters/{letterId}/advances-received"), "party:read" as const],
  [routeKey("PUT", "/api/v1/engagement-letters/{letterId}/advances-received"), "party:write" as const],
  [routeKey("GET", "/api/v1/billing/refunds"), "party:read" as const],
  [routeKey("POST", "/api/v1/billing/refunds/{dueId}/credit-note"), "invoice:issue" as const],
  [routeKey("POST", "/api/v1/billing/refunds/{dueId}/keep"), "invoice:issue" as const],
  [routeKey("GET", "/api/v1/billing/bill-now"), "party:read" as const],
  [routeKey("POST", "/api/v1/billing/engagements/{engagementId}/bill-now"), "party:write" as const],
  [routeKey("GET", "/api/v1/billing/bill-early"), "party:read" as const],
  [routeKey("POST", "/api/v1/billing/bill-early"), "party:write" as const],
  [routeKey("GET", "/api/v1/billing/settings"), "party:read" as const],
  [routeKey("PUT", "/api/v1/billing/settings"), "tenant:admin" as const],
  // Who hears what across the firm (0323): an administrator's call, like the
  // billing settings beside it. Reading the defaults is open to every colleague
  // (above), because each person's own screen shows what the firm chose.
  [routeKey("PUT", "/api/v1/notifications/firm-defaults"), "tenant:admin" as const],
  [routeKey("PUT", "/api/v1/notifications/digest-hour"), "tenant:admin" as const],

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
  // A public market rate, as a suggestion for a rate box (0345).
  [routeKey("GET", "/api/v1/fx/quote"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/overview"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/mrr/{axis}"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/mrr-by-currency"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/receivables/by-client"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/revenue/by-company"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/revenue/by-manager"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/revenue/report"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/client-summary"), "party:read" as const],
  [routeKey("GET", "/api/v1/dashboard/client-summary/projection"), "party:read" as const],
  [routeKey("GET", "/api/v1/engagement-letters/{letterId}/originator"), "party:read" as const],
  [routeKey("PUT", "/api/v1/engagement-letters/{letterId}/originator"), "tenant:admin" as const],

  [routeKey("GET", "/api/v1/documents"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents"), "party:write" as const],
  // Rendering WRITES — it stores a document and attaches it — so `party:write`,
  // the same permission every other drafting route on these documents takes.
  [routeKey("POST", "/api/v1/documents/render"), "party:write" as const],
  // THE PREVIEW (2026-09-28) stores nothing, and still takes what rendering
  // takes: it draws the same rows through the same renderer, and a session that
  // could not have rendered and downloaded the PDF must not be handed its bytes
  // by a route that merely skips the filing. Fee figures print on the page.
  [routeKey("POST", "/api/v1/documents/preview"), "party:write" as const],
  [routeKey("GET", "/api/v1/documents/{documentId}"), "party:read" as const],
  [routeKey("GET", "/api/v1/documents/{documentId}/content"), "party:read" as const],
  // A DISCLOSURE decision, and it takes `party:write` rather than a permission
  // of its own. Sharing a file with a client is the same kind of act as
  // uploading one for them, and a tenth permission that only ever accompanies
  // this one would be a row every firm has to think about once and never
  // again. `portal:grant` was considered and is wrong: that one decides which
  // COMPANIES a login may read at all, and this decides what is in one of them.
  [
    routeKey("PATCH", "/api/v1/documents/{documentId}/client-visibility"),
    "party:write" as const,
  ],
  [routeKey("GET", "/api/v1/documents/{documentId}/versions"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents/{documentId}/versions"), "party:write" as const],
  [
    routeKey("GET", "/api/v1/documents/{documentId}/versions/{versionId}/content"),
    "party:read" as const,
  ],
  [routeKey("GET", "/api/v1/documents/{documentId}/links"), "party:read" as const],
  [routeKey("POST", "/api/v1/documents/{documentId}/links"), "party:write" as const],
  [routeKey("POST", "/api/v1/documents/{documentId}/links/withdraw"), "party:write" as const],
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

  // T6.18: the firm's own companies. READ on party:read, because every author
  // of a proposal picks an issuer from this list; WRITE on tenant:admin, like
  // the rule that names them.
  [routeKey("GET", "/api/v1/firm-entities"), "party:read" as const],
  [routeKey("POST", "/api/v1/firm-entities"), "tenant:admin" as const],
  [routeKey("PATCH", "/api/v1/firm-entities/{entityPartyId}"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/firm-entities/preferences"), "config:read" as const],
  [routeKey("POST", "/api/v1/firm-entities/preferences"), "tenant:admin" as const],
  [routeKey("GET", "/api/v1/firm-entities/numbering"), "config:read" as const],
  [routeKey("PUT", "/api/v1/firm-entities/numbering"), "tenant:admin" as const],

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
