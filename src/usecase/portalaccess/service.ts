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
  NewPortalAccess,
  PortalAccessRepository,
  PortalClientDirectory,
  PortalMembershipDirectory,
} from "./ports";

interface Deps {
  readonly grants: PortalAccessRepository;
  readonly memberships: PortalMembershipDirectory;
  readonly clients: PortalClientDirectory;
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly clock: Clock;
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

  /**
   * What one portal session may read — the value `withPortal` takes.
   *
   * `on` is the CALLER's calendar day and defaults to the server's only when
   * nobody said. That fallback is honest for an API caller and wrong for a
   * browser: a firm in India is a day ahead of a UTC server every morning until
   * half past five, and a grant starting today would not be in force yet.
   *
   * AN EMPTY LIST IS A REAL ANSWER and is returned as one. Every portal login
   * is in that state between being invited and being granted anything, and the
   * resolver is built to set an empty scope rather than skip the call — see
   * `withPortal`, where treating the two the same is the one silent mistake
   * available.
   */
  async scopeFor(tenantId: string, membershipId: string, on?: string): Promise<PortalScope> {
    const day = on ?? this.today();
    const grants = await this.deps.grants.listGrants(tenantId, membershipId);
    return scopeOn(membershipId, grants, day);
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
  async grant(input: GrantPortalAccessInput, actor: Actor): Promise<PortalAccess> {
    const validFrom = input.validFrom ?? this.today();
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

    const validTo = input.validTo ?? this.today();
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
   * The server's calendar day — the fallback, never the answer when a caller
   * has one.
   *
   * The same note `WorkItemService.today()` carries, and it matters more here:
   * this decides what a client can see. A browser sends its own day; this is
   * the honest fallback for an API caller that did not say.
   */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
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
