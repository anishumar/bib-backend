// The portal-access use case (G3.4, gate 4) — who at a client may read that
// client's records. No I/O, no SQL, no HTTP: everything outside arrives as an
// injected port, so this reads as a description of what the business does and is
// testable with in-memory fakes.
//
// ── THIS IS THE WRITER THE WALL WAS MISSING ────────────────────────────────
//
// Migration 0059 put gate 4 in the database — `crm.portal_access`,
// `crm.portal_sees()` and the restrictive policies — and shipped with NO WRITER,
// which the board recorded rather than left to be discovered. A firm could not
// grant anybody anything, so the gate could only ever deny. This is that half.
//
// ── EVERY REFUSAL HERE IS ONE THE DATABASE CANNOT MAKE ─────────────────────
//
// The composite foreign keys already guarantee the membership and the party
// belong to this firm, and the exclusion constraint already refuses an
// overlapping duplicate. What SQL cannot say is that the membership is a
// CLIENT_PORTAL login that still works, or that the party is not a client the
// firm has archived — so those are checked here, in words, and the constraint
// underneath stays as the thing an import or an agent still meets.
//
// ── ENDING IS A DATE, NEVER A DELETE ───────────────────────────────────────
//
// `bib_app` holds no DELETE grant on the table, and that is deliberate rather
// than incidental: "could this person see this client on 14 March" has to be
// answerable a year later, and access revoked by deletion answers it with
// silence. A grant is closed on a day and the row stays.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  PortalAccess,
  PortalAccessRecord,
  PortalScope,
} from "../../domain/portalaccess/model";
import { isInForceOn, scopeOn } from "../../domain/portalaccess/model";
import { dayInZone } from "../../domain/scheduler/zone";
import {
  InvalidPortalDates,
  PortalClientArchived,
  PortalClientNotFound,
  PortalGrantAlreadyEnded,
  PortalGrantDuplicate,
  PortalGrantNotFound,
  PortalMembershipInactive,
  PortalMembershipNotAClientLogin,
  PortalMembershipNotFound,
} from "../../domain/portalaccess/errors";
import type {
  FirmTimeZone,
  NewPortalAccess,
  PortalAccessRepository,
  PortalClientDirectory,
  PortalGroupCompany,
  PortalGroupDirectory,
  PortalMembershipDirectory,
} from "./ports";

interface Deps {
  readonly grants: PortalAccessRepository;
  readonly memberships: PortalMembershipDirectory;
  readonly clients: PortalClientDirectory;
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly clock: Clock;
  /** The firm's zone: whose "today" a grant is in force on (F-07-1). */
  readonly timeZones: FirmTimeZone;
  /** A client's group (Q064). */
  readonly groups: PortalGroupDirectory;
}

/** What granting a group's other companies did (Q064). */
export interface GroupGrantOutcome {
  /** One grant per company, each with its own `portal_access.granted`. */
  readonly granted: readonly (PortalAccess & { readonly clientName: string })[];
  /** Companies the login could already see on that day: left as they were. */
  readonly alreadyHeld: readonly PortalGroupCompany[];
}

/** A contact who sees some of a client's group but not the client (Q064). */
export interface GroupContactMissing {
  readonly membershipId: string;
  readonly contactEmail: string;
  readonly contactDisplayName: string | null;
  /** The group's companies they see today, by name. */
  readonly sees: readonly string[];
}

export interface GrantPortalAccessInput {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly clientPartyId: string;
  /** The day it starts. The CALLER's calendar day when they meant "today" —
   *  see `today()` below for why this service will not assume it. */
  readonly validFrom?: string | undefined;
  /** Optional end, half-open: the FIRST DAY NOT IN FORCE. A fixed-term grant —
   *  a consultant engaged for a quarter — is expressible at the moment it is
   *  written rather than needing somebody to remember to close it. */
  readonly validTo?: string | null | undefined;
  readonly grantedBy: string;
}

export class PortalAccessService {
  constructor(private readonly deps: Deps) {}

  // ── reading ──────────────────────────────────────────────────────────────

  /** Every grant one login has ever held — the portal contact's own row on a
   *  client screen, with the rows that are over still on it. */
  async listForMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<readonly PortalAccessRecord[]> {
    return this.deps.grants.listForMembership(tenantId, membershipId);
  }

  /** Everybody who can see one client. The question asked when a client rings
   *  up about somebody who left. */
  async listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly PortalAccessRecord[]> {
    return this.deps.grants.listForClient(tenantId, clientPartyId);
  }

  /** Who can see which client today, firm-wide, on the FIRM's day. */
  async listInForce(tenantId: string): Promise<readonly PortalAccessRecord[]> {
    return this.deps.grants.listInForce(tenantId, await this.today(tenantId));
  }

  /**
   * What one membership could read on a day — the STAFF question ("who could
   * see this in March"), asked on the firm's screen with `portal:grant`.
   *
   * `on` is the staff caller's day and defaults to the FIRM's. This is never
   * the portal session's own scope: that is `scopedClientsForUser`, which takes
   * no day at all (F-07-1).
   *
   * AN EMPTY LIST IS A REAL ANSWER and is returned as one. Every portal login
   * is in that state between being invited and being granted anything, and the
   * resolver is built to set an empty scope rather than skip the call — see
   * `withPortal`, where treating the two the same is the one silent mistake
   * available.
   */
  async scopeFor(
    tenantId: string,
    membershipId: string,
    on?: string,
  ): Promise<PortalScope & { readonly onDate: string }> {
    const day = on ?? (await this.today(tenantId));
    const grants = await this.deps.grants.listGrants(tenantId, membershipId);
    // `onDate` is the day actually read on, so the route echoes THAT rather
    // than a day of its own (audit 2026-10-03, B44).
    return { ...scopeOn(membershipId, grants, day), onDate: day };
  }

  /**
   * The companies a PORTAL SESSION may read today, by name.
   *
   * `/auth/me`'s read, and the reason it returns names rather than the ids
   * `scopeFor` gives: the portal's own screens have to be able to say "you are
   * looking at Cobalt Foods", and a session that resolved four ids would then
   * look each one up — the per-row join this codebase has been caught by
   * repeatedly.
   *
   * Empty is a real answer, and the portal must render it as one: a contact who
   * has been invited and granted nothing sees a screen that says so, never a
   * blank one and never everything.
   *
   * ── IT TAKES NO DAY, AND THAT IS THE FIX FOR F-07-1 ──────────────────────
   *
   * It took the caller's `asOf`, because the browser's day was meant to decide
   * which filings are "upcoming" — a DISPLAY question. The same value then
   * decided which companies the login may SEE — an AUTHORISATION question — so
   * a contact removed yesterday (0061: "remove means now") read everything
   * again with `?asOf=yesterday`, and a grant dated to start next month was
   * readable today with `?asOf=` that day. Access is now resolved on the
   * FIRM's own day, computed here and nowhere else; a portal screen may still
   * send its day for what it DISPLAYS, and it can no longer reach this.
   */
  async scopedClientsForUser(
    tenantId: string,
    userId: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]> {
    const day = await this.today(tenantId);
    const held = await this.deps.grants.listForPortalUser(tenantId, userId);
    const seen = new Map<string, string>();
    for (const row of held) {
      if (isInForceOn(row.access, day)) seen.set(row.access.clientPartyId, row.clientName);
    }
    return [...seen].map(([clientPartyId, clientName]) => ({ clientPartyId, clientName }));
  }

  // ── writing ──────────────────────────────────────────────────────────────

  /**
   * Let one client-portal login read one client's records.
   *
   * ONE CLIENT PER CALL, and that is the decision this module is built around.
   * A grant that took a list, or that walked `core.party_relationship` to add a
   * group's other companies, would make "who decided this contact may see
   * Kaveri" unanswerable — and would let a CRM edit widen access. A contact who
   * should see four companies is four deliberate rows, four events, four
   * answers.
   */
  // ── a group (Q064) ───────────────────────────────────────────────────────

  /** The OTHER companies in a client's group, on the firm's day. */
  async groupOf(tenantId: string, clientPartyId: string): Promise<readonly PortalGroupCompany[]> {
    return this.deps.groups.groupOf(tenantId, clientPartyId, await this.today(tenantId));
  }

  /**
   * Give a login the rest of a client's group too (Q064, Sid: a group's contact
   * "can see" its sister companies).
   *
   * STILL ONE GRANT PER COMPANY. Each company goes through `grant` on its own,
   * so each is its own row and its own `portal_access.granted` event, with the
   * same checks a single grant makes (a CLIENT_PORTAL login that works, a
   * company not archived). The list is the SERVER's: the caller names the
   * client and nothing else, so no company outside the group, and none of
   * another firm, can be slipped into it. A company the login already sees on
   * that day is left alone and reported, never refused: the act is "the whole
   * group", and part of it being in place already is not an error.
   */
  async grantGroupOf(input: GrantPortalAccessInput, actor: Actor): Promise<GroupGrantOutcome> {
    const validFrom = input.validFrom ?? (await this.today(input.tenantId));
    const validTo = input.validTo ?? null;
    const group = await this.deps.groups.groupOf(input.tenantId, input.clientPartyId, await this.today(input.tenantId));
    const held = await this.deps.grants.listGrants(input.tenantId, input.membershipId);
    const granted: (PortalAccess & { readonly clientName: string })[] = [];
    const alreadyHeld: PortalGroupCompany[] = [];
    for (const company of group) {
      if (held.some((g) => g.clientPartyId === company.id && overlaps(g, validFrom, validTo))) {
        alreadyHeld.push(company);
        continue;
      }
      const row = await this.grant({ ...input, clientPartyId: company.id, validFrom, validTo }, actor);
      granted.push({ ...row, clientName: company.displayName });
    }
    return { granted, alreadyHeld };
  }

  /**
   * NEVER SILENT (Q064). A company added to a group later does not hand its
   * records to the group's portal contacts: those contacts are listed here
   * instead, so the firm user sees "N portal contacts of this group can see the
   * other companies" and decides. A contact who sees at least one other company
   * of the group today and not this one, with a login that still works.
   */
  async groupContactsMissing(tenantId: string, clientPartyId: string): Promise<readonly GroupContactMissing[]> {
    const today = await this.today(tenantId);
    const group = await this.deps.groups.groupOf(tenantId, clientPartyId, today);
    if (group.length === 0) return [];
    const here = new Set(
      (await this.deps.grants.listForClient(tenantId, clientPartyId))
        .filter((r) => isInForceOn(r.access, today))
        .map((r) => r.access.membershipId),
    );
    const byContact = new Map<string, { record: PortalAccessRecord; sees: string[] }>();
    for (const company of group) {
      for (const r of await this.deps.grants.listForClient(tenantId, company.id)) {
        if (!isInForceOn(r.access, today) || here.has(r.access.membershipId)) continue;
        const seen = byContact.get(r.access.membershipId);
        if (seen === undefined) byContact.set(r.access.membershipId, { record: r, sees: [company.displayName] });
        else if (!seen.sees.includes(company.displayName)) seen.sees.push(company.displayName);
      }
    }
    const out: GroupContactMissing[] = [];
    for (const [membershipId, { record, sees }] of byContact) {
      const membership = await this.deps.memberships.findMembership(tenantId, membershipId);
      if (membership === null || !membership.isActive || membership.audience !== "CLIENT_PORTAL") continue;
      out.push({
        membershipId,
        contactEmail: record.contactEmail,
        contactDisplayName: record.contactDisplayName,
        sees: [...sees].sort(),
      });
    }
    return out.sort((a, b) => a.contactEmail.localeCompare(b.contactEmail));
  }

  async grant(input: GrantPortalAccessInput, actor: Actor): Promise<PortalAccess> {
    const validFrom = input.validFrom ?? (await this.today(input.tenantId));
    const validTo = input.validTo ?? null;
    // Half-open, so equal dates describe a grant in force on no day at all —
    // which reads as "granted" on every screen and lets nobody in.
    if (validTo !== null && validTo <= validFrom) throw new InvalidPortalDates(validFrom, validTo);

    const membership = await this.deps.memberships.findMembership(
      input.tenantId,
      input.membershipId,
    );
    if (!membership) throw new PortalMembershipNotFound(input.membershipId);
    // Both checks the composite foreign key cannot make. A STAFF login granted
    // a client would record a permission that governs nothing — gate 2 admits
    // it to the whole staff workspace already — and read on the screen as
    // though it did something.
    if (membership.audience !== "CLIENT_PORTAL") {
      throw new PortalMembershipNotAClientLogin(input.membershipId, membership.audience);
    }
    if (!membership.isActive) throw new PortalMembershipInactive(input.membershipId);

    const client = await this.deps.clients.findParty(input.tenantId, input.clientPartyId);
    if (!client) throw new PortalClientNotFound(input.clientPartyId);
    if (client.archivedAt !== null) throw new PortalClientArchived(client.displayName);

    // Asked in words before the exclusion constraint answers it as a 500. The
    // constraint is still the thing that holds under concurrency and against an
    // import — this is what a person is TOLD.
    const held = await this.deps.grants.listGrants(input.tenantId, input.membershipId);
    if (held.some((g) => g.clientPartyId === client.id && overlaps(g, validFrom, validTo))) {
      throw new PortalGrantDuplicate(client.displayName);
    }

    const row: NewPortalAccess = {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      clientPartyId: client.id,
      validFrom,
      validTo,
      grantedBy: input.grantedBy,
    };
    const created = await this.deps.grants.create(row);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "portal_access.granted",
      objectId: created.id,
      actor,
      // Ids and dates. NO NAMES: the client's display name and the contact's
      // email are personal data about people outside the firm, and this log
      // cannot be erased. The row carries them.
      payload: {
        membershipId: created.membershipId,
        clientPartyId: created.clientPartyId,
        validFrom: created.validFrom,
        validTo: created.validTo,
      },
    });
    return created;
  }

  /**
   * Stop a login seeing a client — NOW, not at midnight.
   *
   * `validTo` is the FIRST DAY NOT IN FORCE, so the default is TODAY and the
   * access is gone on the next request. It defaulted to tomorrow until 0061,
   * on the reasoning that keeping the day intact stops somebody who read a
   * document this morning showing as never having been allowed to — and
   * walking it over HTTP settled the argument the other way: the firm presses
   * remove, asks what the session can see, and the client is still there. That
   * reads as a bug and IS one when somebody is being removed for cause.
   *
   * The row now understates that person by part of a day. Nothing is actually
   * lost: `portal_access.ended` carries the INSTANT, so "when was it taken
   * away" is answerable to the second — the row is date-grained and the ledger
   * is not.
   *
   * Ending on the day it began is therefore allowed and produces an EMPTY
   * range: granted at 10:00, withdrawn at 10:01, in force on no day. 0061
   * relaxed the CHECK for exactly that case. CREATING one that way is still
   * refused below — a grant in force on no day is a typo at the moment of
   * granting, while ending one is a decision somebody took twenty seconds
   * later.
   */
  async end(
    input: { readonly tenantId: string; readonly grantId: string; readonly validTo?: string | undefined },
    actor: Actor,
  ): Promise<PortalAccess> {
    const grant = await this.deps.grants.findById(input.tenantId, input.grantId);
    if (!grant) throw new PortalGrantNotFound(input.grantId);
    if (grant.validTo !== null) throw new PortalGrantAlreadyEnded(grant.id, grant.validTo);

    const validTo = input.validTo ?? (await this.today(input.tenantId));
    // `<` and not `<=`: equal dates are the immediate-revocation case. Earlier
    // than the day it started is not a short grant, it is a wrong one.
    if (validTo < grant.validFrom) throw new InvalidPortalDates(grant.validFrom, validTo);

    const ended = await this.deps.grants.end(input.tenantId, grant.id, validTo);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "portal_access.ended",
      objectId: ended.id,
      actor,
      payload: {
        membershipId: ended.membershipId,
        clientPartyId: ended.clientPartyId,
        validTo,
      },
    });
    return ended;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The FIRM's calendar day (0071) — never the server's, and never a portal
   * caller's.
   *
   * It decides what a client can see, so ONE answer has to serve both ends of
   * a grant: `end` defaults its `validTo` to this day and the session's scope
   * is resolved on it, so "remove means now" holds whichever zone the partner
   * pressing Remove or the client reading is in. It was the UTC day, which is
   * yesterday in India until 05:30 — a grant starting "today" was not yet in
   * force for the first five and a half hours of it.
   */
  private async today(tenantId: string): Promise<string> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    return dayInZone(this.deps.clock.now().toISOString(), zone);
  }

}

/** Do two half-open day ranges share a day? The same comparison the exclusion
 *  constraint makes, in the same convention, so the service and the schema
 *  cannot disagree about what a duplicate is. */
function overlaps(grant: PortalAccess, validFrom: string, validTo: string | null): boolean {
  const startsBeforeOtherEnds = validTo === null || grant.validFrom < validTo;
  const endsAfterOtherStarts = grant.validTo === null || grant.validTo > validFrom;
  return startsBeforeOtherEnds && endsAfterOtherStarts;
}

/** Re-exported so a caller can ask the question without importing the domain
 *  directly — the same courtesy `usecase/clientassignment` extends. */
export { isInForceOn };
