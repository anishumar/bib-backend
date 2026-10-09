// The client's own request (T6.8): the client asks, the firm replies and closes,
// the client may withdraw. Gate 4 is deliberately not in this file:
// `PORTAL_PATHS` (api/guards.ts) admits the routes; `portal:request` (gate 3, the
// second portal permission) decides which contact may raise one; `withPortal` and
// 0068's RESTRICTIVE policies filter reads AND writes, and since the client names
// the company, `WITH CHECK (crm.portal_sees(...))` is what refuses a wrong one.
// This file resolves the session once and refuses, with a sentence, what the
// database cannot: a finished request, an empty reply, another client's document.
// An empty scope still goes to the database; never `return []` early (see
// `PortalRequestRepository`).
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  ClientRequestRecord,
  PortalRequestRow,
  RequestRouting,
  RequestStatus,
} from "../../domain/clientrequest/model";
import {
  acceptsReply,
  isRequestRouting,
  REQUEST_ROUTINGS,
  routeRequest,
  splitByReplied,
} from "../../domain/clientrequest/model";
import {
  RequestAlreadySettled,
  RequestAssigneeNotStaff,
  RequestBodyEmpty,
  RequestCompanyNotYours,
  RequestDocumentNotFound,
  RequestNotFound,
  RequestReplyEmpty,
  RequestRoutingUnknown,
  RequestSubjectEmpty,
} from "../../domain/clientrequest/errors";
import type {
  FirmTimeZone,
  AssignableStaffDirectory,
  KeyManagerDirectory,
  PortalRequestRepository,
  PortalScopeSource,
  RequestRepository,
  RequestRoutingSource,
} from "./ports";
import { dayInZone } from "../../domain/scheduler/zone";

/**
 * No mailer, on purpose: transport is P10 (Phase 7), so a raised request is a row
 * the firm sees in its inbox (as `ChaserService`, `NudgeService`).
 * `tests/clientrequest/service.test.ts` asserts this list, so adding a transport is
 * a board decision. A logging stub claiming the firm was emailed would be a lie.
 */
export interface Deps {
  readonly requests: RequestRepository;
  readonly portal: PortalRequestRepository;
  readonly scope: PortalScopeSource;
  readonly routing: RequestRoutingSource;
  /** A STAFF read, never made inside the portal transaction — see `NewRequest`. */
  readonly keyManagers: KeyManagerDirectory;
  /** A refusal no foreign key can make: `tenancy.user_account` is GLOBAL. */
  readonly staff: AssignableStaffDirectory;
  readonly ids: IdGen;
  readonly events: EventSink;
  readonly clock: Clock;
  /** The firm's zone: its "today" picks the Key Manager; no portal caller's day reaches here. */
  readonly timeZones: FirmTimeZone;
}

export interface RaiseRequestInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly clientPartyId: string;
  readonly subject: string;
  readonly body: string;
  readonly actor: Actor;
}

export interface PortalReplyInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly body: string;
  readonly actor: Actor;
}

export interface WithdrawInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly actor: Actor;
}

export interface FirmReplyInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly body: string;
  readonly documentId: string | null;
  readonly actor: Actor;
}

export interface CloseRequestInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly actor: Actor;
}

export interface AssignRequestInput {
  readonly tenantId: string;
  readonly requestId: string;
  /** Null takes it off a desk; there is no separate `unassign`. */
  readonly assigneeUserId: string | null;
  readonly actor: Actor;
}

export interface RequestInbox {
  readonly requests: readonly ClientRequestRecord[];
  /** Lets the screen tell "the rule found nobody" from "no rule at all". */
  readonly routing: RequestRouting;
}

export interface PortalRequestList {
  readonly awaitingFirm: readonly PortalRequestRow[];
  readonly replied: readonly PortalRequestRow[];
  readonly settled: readonly PortalRequestRow[];
}

export class ClientRequestService {
  constructor(private readonly deps: Deps) {}

  // ── the firm's side ───────────────────────────────────────────────────────

  /**
   * The inbox, newest first: one list, no routing (0068). Rows carry the company
   * and who spoke last, which keeps an unrouted list workable while short.
   * `finished` is the archive in the same shape: without it a closed request left
   * every staff screen while the client's portal still showed the whole thread.
   */
  async inbox(tenantId: string, scope: "live" | "finished" = "live"): Promise<RequestInbox> {
    // The setting travels with the list (T4.5's `ladderPublished` decision):
    // "routes nothing" and "the rule found nobody" otherwise look the same.
    const [requests, routing] = await Promise.all([
      scope === "finished"
        ? this.deps.requests.listFinished(tenantId)
        : this.deps.requests.listLive(tenantId),
      this.deps.routing.routingFor(tenantId),
    ]);
    return { requests, routing };
  }

  /** Read the switch on its own, for the screen that sets it. */
  routing(tenantId: string): Promise<RequestRouting> {
    return this.deps.routing.routingFor(tenantId);
  }

  /**
   * Change how arriving requests are routed. Restates nothing (as
   * `work_split_axis`, 0043): existing assignees stay, only the next request is
   * routed the new way.
   */
  async setRouting(
    tenantId: string,
    routing: string,
    actor: Actor,
  ): Promise<RequestRouting> {
    if (!isRequestRouting(routing)) throw new RequestRoutingUnknown(routing, REQUEST_ROUTINGS);
    const chosen = await this.deps.routing.setRouting(tenantId, routing);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "client_request.routing_set",
      // The firm is the object (`tenancy.tenant`'s id), as `work_split_axis`'s event.
      objectId: tenantId,
      actor,
      payload: { routing: chosen },
    });
    return chosen;
  }

  /** Assign or unassign. Always available, whatever the switch: the rule is a default, not a wall. */
  async assign(input: AssignRequestInput): Promise<ClientRequestRecord> {
    const current = await this.find(input.tenantId, input.requestId);

    if (input.assigneeUserId !== null) {
      // The FK points at a GLOBAL table and no constraint can say "still works here".
      const ok = await this.deps.staff.isActiveStaff(input.tenantId, input.assigneeUserId);
      if (!ok) throw new RequestAssigneeNotStaff(input.assigneeUserId);
    }

    const record = await this.deps.requests.assign({
      tenantId: input.tenantId,
      requestId: input.requestId,
      assigneeUserId: input.assigneeUserId,
      // Unassigning by hand is not a routing failure: no note, and the rule's
      // old sentence is cleared.
      note: null,
    });
    if (record === null) {
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.assigned",
      objectId: input.requestId,
      actor: input.actor,
      payload: {
        clientPartyId: record.request.clientPartyId,
        // `by` tells a person from the rule: the only way to judge the rule later.
        assigneeUserId: input.assigneeUserId,
        by: "person",
      },
    });
    return record;
  }

  async find(tenantId: string, requestId: string): Promise<ClientRequestRecord> {
    const record = await this.deps.requests.findById(tenantId, requestId);
    if (record === null) throw new RequestNotFound(requestId);
    return record;
  }

  /**
   * The firm answers, optionally attaching a document already filed against this
   * client (not an upload; something unfiled is filed first). The adapter makes it
   * client-visible (0066) in the same transaction — see `RequestRepository.reply`.
   */
  async replyAsFirm(input: FirmReplyInput): Promise<ClientRequestRecord> {
    const body = input.body.trim();
    if (body.length === 0) throw new RequestReplyEmpty();

    // Read first so a settled request gets its own sentence; the adapter's
    // live-status predicate is what holds under a race.
    const current = await this.find(input.tenantId, input.requestId);
    if (!acceptsReply(current.request.status)) {
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    const outcome = await this.deps.requests.reply({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      requestId: input.requestId,
      body,
      documentId: input.documentId,
      writtenBy: this.requireHuman(input.actor),
    });
    if (!outcome.ok) {
      if (outcome.reason === "document") {
        throw new RequestDocumentNotFound(input.documentId ?? "");
      }
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.replied",
      objectId: input.requestId,
      actor: input.actor,
      // Ids and machine facts only: never the reply's or request's words, which
      // are prose about a client's business, and the log cannot be erased (§3.4).
      payload: {
        authorSide: "firm",
        clientPartyId: outcome.record.request.clientPartyId,
        documentAttached: input.documentId !== null,
      },
    });
    return outcome.record;
  }

  /** The firm's ending; `withdrawn` is the client's and not reachable here. */
  async close(input: CloseRequestInput): Promise<ClientRequestRecord> {
    const current = await this.find(input.tenantId, input.requestId);
    const record = await this.deps.requests.close({
      tenantId: input.tenantId,
      requestId: input.requestId,
      settledBy: this.requireHuman(input.actor),
    });
    // Null: somebody else settled it between the read and the write.
    if (record === null) {
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.closed",
      objectId: input.requestId,
      actor: input.actor,
      payload: {
        clientPartyId: record.request.clientPartyId,
        replyCount: record.replies.length,
      },
    });
    return record;
  }

  // ── the client's side ─────────────────────────────────────────────────────

  /** Everything this login has asked, finished ones included, unlike the asks:
   *  "did I already ask for this" stops the second phone call. */
  async mine(tenantId: string, userId: string): Promise<PortalRequestList> {
    const parties = await this.scopedParties(tenantId, userId);
    const rows = await this.deps.portal.list(tenantId, parties);
    const live = splitByReplied(rows);
    return {
      awaitingFirm: live.awaitingFirm,
      replied: live.replied,
      settled: rows.filter((r) => r.status === "closed" || r.status === "withdrawn"),
    };
  }

  /** A client asks the firm for something: the first row in this product a client creates. */
  async raise(input: RaiseRequestInput): Promise<PortalRequestRow> {
    const subject = input.subject.trim();
    if (subject.length === 0) throw new RequestSubjectEmpty();
    const body = input.body.trim();
    if (body.length === 0) throw new RequestBodyEmpty();

    const parties = await this.scopedParties(input.tenantId, input.userId);

    // A sentence, not the wall: 0068's `WITH CHECK (crm.portal_sees(client_party_id))`
    // refuses this in the database, but as an RLS violation (a 500). This makes it
    // a 404. The integration suite removes this check and watches the INSERT throw.
    if (!parties.includes(input.clientPartyId)) {
      throw new RequestCompanyNotYours(input.clientPartyId);
    }

    // Whose desk, decided before the write by STAFF reads outside the portal
    // transaction (`tenancy.tenant`, `crm.client_assignment`). The answer never
    // reaches the client: `PortalRequestRow` has no assignee (T6.5).
    const routing = await this.deps.routing.routingFor(input.tenantId);
    const keyManager =
      routing === "none"
        ? null
        : await this.deps.keyManagers.keyManagerFor(
            input.tenantId,
            input.clientPartyId,
            await this.firmDay(input.tenantId),
          );
    const routed = routeRequest(routing, keyManager);

    const row = await this.deps.portal.raise(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      clientPartyId: input.clientPartyId,
      subject,
      body,
      raisedBy: this.requireHuman(input.actor),
      assigneeUserId: routed.assigneeUserId,
      assignmentNote: routed.note,
    });
    if (row === null) throw new RequestCompanyNotYours(input.clientPartyId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.raised",
      objectId: row.requestId,
      // A client contact: after `client_ask.answered`, the first verb whose human
      // outside the firm STARTS something rather than replies.
      actor: input.actor,
      // Never the subject or body: the client's own words about their affairs,
      // and this log cannot be erased.
      payload: { clientPartyId: input.clientPartyId },
    });

    // A second event only when the RULE placed it, per placement (as
    // `client_ask.chased`, `obligation.nudged`), so the rule's hit rate is a count
    // over rows; `by: "rule"` tells it from a person assigning by hand.
    if (routed.assigneeUserId !== null) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "client_request.assigned",
        objectId: row.requestId,
        // The client contact, whose request caused it: not the assignee (no
        // decision of theirs), not the system (it would hide who set it off).
        actor: input.actor,
        payload: {
          clientPartyId: input.clientPartyId,
          assigneeUserId: routed.assigneeUserId,
          by: "rule",
        },
      });
    }
    return row;
  }

  /** The client adds to the thread — most often "that is not what I meant". */
  async replyAsClient(input: PortalReplyInput): Promise<PortalRequestRow> {
    const body = input.body.trim();
    if (body.length === 0) throw new RequestReplyEmpty();

    const { parties, row } = await this.reachable(
      input.tenantId,
      input.userId,
      input.requestId,
    );
    if (!acceptsReply(row.status)) {
      throw new RequestAlreadySettled(input.requestId, row.status);
    }

    const next = await this.deps.portal.reply(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      requestId: input.requestId,
      body,
      writtenBy: this.requireHuman(input.actor),
    });
    if (next === null) throw new RequestAlreadySettled(input.requestId, row.status);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.replied",
      objectId: input.requestId,
      actor: input.actor,
      payload: {
        authorSide: "client",
        clientPartyId: this.partyOf(parties, next),
        documentAttached: false,
      },
    });
    return next;
  }

  /**
   * The client no longer wants it. Its own verb, not a flavour of close (as
   * `client_ask.withdrawn`): "we sorted it ourselves" and "the firm dealt with it"
   * differ, and a firm whose requests are mostly withdrawn is being told something.
   */
  async withdraw(input: WithdrawInput): Promise<PortalRequestRow> {
    const { parties, row } = await this.reachable(
      input.tenantId,
      input.userId,
      input.requestId,
    );

    const next = await this.deps.portal.withdraw(input.tenantId, parties, {
      requestId: input.requestId,
      settledBy: this.requireHuman(input.actor),
    });
    if (next === null) throw new RequestAlreadySettled(input.requestId, row.status);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.withdrawn",
      objectId: input.requestId,
      actor: input.actor,
      payload: { clientPartyId: this.partyOf(parties, next) },
    });
    return next;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The reachable request plus the scope that reached it, so writes reuse one
   *  answer to "what may this session see" rather than a later one. */
  private async reachable(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<{ parties: readonly string[]; row: PortalRequestRow }> {
    const parties = await this.scopedParties(tenantId, userId);
    const row = await this.deps.portal.findById(tenantId, parties, requestId);
    if (row === null) throw new RequestNotFound(requestId);
    return { parties, row };
  }

  /** The grants, resolved on the FIRM's day — never the portal caller's (F-07-1). */
  private async scopedParties(tenantId: string, userId: string): Promise<readonly string[]> {
    const companies = await this.deps.scope.scopedCompanies(tenantId, userId);
    return companies.map((c) => c.clientPartyId);
  }

  /**
   * The client party for the ledger payload: the only granted company, else null
   * rather than a guess (the narrow portal row carries no id; `objectId` resolves
   * to the request, which knows).
   */
  private partyOf(parties: readonly string[], _row: PortalRequestRow): string | null {
    return parties.length === 1 ? (parties[0] ?? null) : null;
  }

  private requireHuman(actor: Actor): string {
    // Unreachable behind the session guard. `raised_by` and `written_by` are NOT
    // NULL, and nothing raises a request on a client's behalf.
    const id = actor.type === "human" ? actor.id : null;
    if (id === null) throw new RequestReplyEmpty();
    return id;
  }

  /** The FIRM's day (0071), which picks the Key Manager in force; never a portal
   *  caller's day (F-07-1), never the server's UTC day. */
  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

export type { ClientRequestRecord, PortalRequestRow, RequestRouting, RequestStatus };
