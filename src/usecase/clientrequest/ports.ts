// Ports for the client's own request. Two repositories, one service (as
// `usecase/clientask`): the firm side runs under `withTenant`, the client side
// under `withPortal`. That scoping is gate 4's safety and an adapter fact; the
// rules about a request stay in one service so each is stated once.
import type {
  ClientRequestRecord,
  PortalRequestRow,
  RequestRouting,
} from "../../domain/clientrequest/model";

/** What raising one writes. */
export interface NewRequest {
  readonly id: string;
  readonly tenantId: string;
  /**
   * Which of the client's companies this is about: the first wall column a caller
   * supplies (`NewAsk` reads its client from the work item, 0063; here there is no
   * parent). The wall is 0068's `WITH CHECK (crm.portal_sees(...))` under
   * `withPortal`; the check in `ClientRequestService.raise` only turns the RLS
   * violation into a sentence.
   */
  readonly clientPartyId: string;
  readonly subject: string;
  readonly body: string;
  readonly raisedBy: string;
  /**
   * Resolved BEFORE the write (0070) so `crm.client_assignment` stays out of the
   * portal transaction: it names the firm's people and has no portal policy, so it
   * is read under `withTenant` via `KeyManagerDirectory`. No caller supplies it.
   */
  readonly assigneeUserId: string | null;
  readonly assignmentNote: string | null;
}

/** What one message writes. The client party is read from the request inside the
 *  insert, as `NewResponse` does. */
export interface NewReply {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly body: string;
  readonly writtenBy: string;
}

/** A firm reply, optionally naming a document already filed against this client. */
export interface NewFirmReply extends NewReply {
  readonly documentId: string | null;
}

/** Why a firm reply was refused: the request is gone or finished, or the document
 *  is not this client's. Two refusals, two sentences, so not a null. */
export type FirmReplyOutcome =
  | { readonly ok: true; readonly record: ClientRequestRecord }
  | { readonly ok: false; readonly reason: "request" | "document" };

/**
 * The FIRM's side; every method is `withTenant`. No per-client list: the inbox has
 * no routing (0068, Shrestha 2026-09-02), and a per-client read waits for the
 * client 360 screen.
 */
export interface RequestRepository {
  /** Everything not finished, newest first — the whole inbox. */
  listLive(tenantId: string): Promise<readonly ClientRequestRecord[]>;

  /** Closed or withdrawn: the complement of `listLive`, not its own status list,
   *  so a status added later cannot land on neither. */
  listFinished(tenantId: string): Promise<readonly ClientRequestRecord[]>;

  findById(tenantId: string, requestId: string): Promise<ClientRequestRecord | null>;

  /**
   * The firm replies and, if a document is named, makes it client-visible (0066
   * `is_client_visible`) in the same transaction: attaching it to a message to the
   * client IS the decision to show it, so no reply points at something invisible.
   */
  reply(input: NewFirmReply): Promise<FirmReplyOutcome>;

  /** The firm's ending, `closed`, never `withdrawn`. "You did not need this" is a
   *  close with a reply saying so. */
  close(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly settledBy: string;
  }): Promise<ClientRequestRecord | null>;

  /**
   * Assign or unassign in one UPDATE: 0070 refuses a note beside a name, so
   * assigning clears the note. Null when the request is gone or already settled.
   */
  assign(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly assigneeUserId: string | null;
    readonly note: string | null;
  }): Promise<ClientRequestRecord | null>;
}

/** The firm's routing setting: a tenant column, not a config kind (`work_split_axis`'s
 *  argument, 0043): changing it restates nothing and needs no versioning. */
export interface RequestRoutingSource {
  routingFor(tenantId: string): Promise<RequestRouting>;
  setRouting(tenantId: string, routing: RequestRouting): Promise<RequestRouting>;
}

/**
 * A client's key_manager on a day (`crm.client_assignment`). Never a SPOC: it needs
 * an `axis_id` and a request names no service (0068). One id, not a list: an
 * exclusion constraint keeps one key_manager at a time (several SPOCs per axis are
 * G3.2's). Declared here, not imported from `usecase/clientassignment`; `setup/`
 * satisfies it with that service's read.
 */
export interface KeyManagerDirectory {
  keyManagerFor(
    tenantId: string,
    clientPartyId: string,
    on: string,
  ): Promise<string | null>;
}

/**
 * Whether somebody is an ACTIVE member of this firm. No FK can say it:
 * `tenancy.user_account` is GLOBAL (ADR-02) and a membership lapses later.
 * `client_assignment` and `work_item` check it in the service too.
 */
export interface AssignableStaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/** The firm's calendar zone (0071): `PostgresFirmTimeZone`, `FakeFirmTimeZone`. */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * Which companies this SESSION may read today. Same shape as the ports in
 * `usecase/clientask` and `usecase/portalhome`; `setup/` satisfies all three with
 * `PortalAccessService.scopedClientsForUser`. Declared here, not imported.
 */
export interface PortalScopeSource {
  /** Resolved on the FIRM's day by the grant module; no caller's day reaches it (F-07-1). */
  scopedCompanies(
    tenantId: string,
    userId: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]>;
}

/**
 * The CLIENT's side; every method is `withPortal` and takes the party ids. An EMPTY
 * list must reach the database as one: skipping `withPortal` for it would leave the
 * session looking like STAFF, which leaks rather than hides.
 */
export interface PortalRequestRepository {
  list(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalRequestRow[]>;

  findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    requestId: string,
  ): Promise<PortalRequestRow | null>;

  raise(
    tenantId: string,
    clientPartyIds: readonly string[],
    request: NewRequest,
  ): Promise<PortalRequestRow | null>;

  /** A follow-up; it does not move the status (see `lastWordWith`). */
  reply(
    tenantId: string,
    clientPartyIds: readonly string[],
    reply: NewReply,
  ): Promise<PortalRequestRow | null>;

  /** The client's ending, the only one reachable from this side. */
  withdraw(
    tenantId: string,
    clientPartyIds: readonly string[],
    input: { readonly requestId: string; readonly settledBy: string },
  ): Promise<PortalRequestRow | null>;
}
