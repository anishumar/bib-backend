// In-memory port fakes for the client's own request (T6.8).
//
// `implements` the ports the Postgres adapters implement, which is a
// compile-time assertion that the fakes and the real thing stay in step.
//
// ── ONE STORE, TWO REPOSITORIES — `testfakes/clientask.ts`'s arrangement ──
//
// The firm's side and the client's side are two ports over ONE table, and a
// test that raised a request through the portal and then read it as the firm
// against two independent maps would prove nothing about the thing being
// tested. `FakeRequestStore` is that table.
//
// ── WHAT THESE DO NOT REPRODUCE, AND IT IS THE MOST IMPORTANT PART ───────
//
// GATE 4. `FakePortalRequestRepo` filters on the party ids it is handed, which
// is the same OUTCOME as `client_request_portal_scope` by a completely
// different mechanism — so a green test here says the SERVICE passes the scope
// down, and NOTHING about whether the policy would refuse a write that skipped
// it. That distinction matters more on this table than on any before it,
// because the client NAMES the company: the wall is the policy's `WITH CHECK`,
// and it is proven in `tests/portal/client-request.integration.test.ts` against
// real Postgres, by dropping the policy and watching an insert for another
// client's company succeed.
//
// Nor do these reproduce the `author_side` clause on that policy, the
// append-only grant, or the composite foreign keys.
import type {
  ClientRequestRecord,
  PortalRequestRow,
  RequestReplyRecord,
  RequestRouting,
  RequestStatus,
} from "../domain/clientrequest/model";
import type {
  AssignableStaffDirectory,
  FirmReplyOutcome,
  KeyManagerDirectory,
  NewFirmReply,
  NewReply,
  NewRequest,
  PortalRequestRepository,
  PortalScopeSource,
  RequestRepository,
  RequestRoutingSource,
} from "../usecase/clientrequest/ports";

interface StoredRequest {
  id: string;
  tenantId: string;
  clientPartyId: string;
  clientName: string;
  subject: string;
  body: string;
  status: RequestStatus;
  raisedBy: string;
  raisedAt: string;
  firstRepliedAt: string | null;
  settledBy: string | null;
  settledAt: string | null;
  assigneeUserId: string | null;
  assignmentNote: string | null;
}

interface StoredReply {
  id: string;
  requestId: string;
  clientPartyId: string;
  authorSide: "firm" | "client";
  body: string;
  documentId: string | null;
  writtenBy: string;
  writtenAt: string;
}

/** The table both repositories read. */
export class FakeRequestStore {
  readonly requests: StoredRequest[] = [];
  readonly replies: StoredReply[] = [];
  /** Documents the firm has filed, as `documentId -> the client they belong
   *  to`. What the composite FK guarantees in Postgres. */
  readonly documents = new Map<string, string>();
  /** Which documents this store has made visible — the flip the adapter does in
   *  the same transaction as the reply. Kept so a test can assert on it. */
  readonly madeVisible = new Set<string>();
  /** `core.party.display_name`, which the real adapters JOIN for. A name table
   *  is not scoped by what it names (0059), so this map has no scoping either. */
  readonly partyNames = new Map<string, string>();
  private clock = 0;

  /** Monotonic, so ordering by it is stable — a real timestamp would let two
   *  writes in one millisecond compare equal, and the thread's ORDER is the
   *  meaning. */
  now(): string {
    this.clock += 1;
    return `2026-09-02T00:00:${String(this.clock).padStart(2, "0")}.000Z`;
  }

  seedParty(clientPartyId: string, displayName: string): this {
    this.partyNames.set(clientPartyId, displayName);
    return this;
  }

  seedDocument(documentId: string, clientPartyId: string): this {
    this.documents.set(documentId, clientPartyId);
    return this;
  }

  find(tenantId: string, requestId: string): StoredRequest | undefined {
    return this.requests.find((r) => r.id === requestId && r.tenantId === tenantId);
  }

  repliesOf(tenantId: string, requestId: string): RequestReplyRecord[] {
    return this.replies
      .filter((x) => x.requestId === requestId)
      .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt))
      .map((x) => ({
        reply: {
          id: x.id,
          requestId: x.requestId,
          authorSide: x.authorSide,
          body: x.body,
          writtenAt: x.writtenAt,
        },
        authorName: `user-${x.writtenBy}`,
        document:
          x.documentId === null
            ? null
            : {
                documentId: x.documentId,
                title: `doc-${x.documentId}`,
                filename: `${x.documentId}.pdf`,
                byteSize: 1024,
                mediaType: "application/pdf",
              },
      }));
  }

  toRecord(row: StoredRequest): ClientRequestRecord {
    return {
      request: {
        id: row.id,
        tenantId: row.tenantId,
        clientPartyId: row.clientPartyId,
        subject: row.subject,
        body: row.body,
        status: row.status,
        raisedBy: row.raisedBy,
        raisedAt: row.raisedAt,
        firstRepliedAt: row.firstRepliedAt,
        settledBy: row.settledBy,
        settledAt: row.settledAt,
        assigneeUserId: row.assigneeUserId,
        assignmentNote: row.assignmentNote,
      },
      clientName: row.clientName,
      raisedByName: `user-${row.raisedBy}`,
      settledByName: row.settledBy === null ? null : `user-${row.settledBy}`,
      assigneeName: row.assigneeUserId === null ? null : `user-${row.assigneeUserId}`,
      assigneeEmail: row.assigneeUserId === null ? null : `${row.assigneeUserId}@firm.test`,
      replies: this.repliesOf(row.tenantId, row.id),
    };
  }

  toPortalRow(row: StoredRequest): PortalRequestRow {
    const replies = this.repliesOf(row.tenantId, row.id);
    const firmReplies = replies.filter((r) => r.reply.authorSide === "firm");
    return {
      requestId: row.id,
      companyName: row.clientName,
      subject: row.subject,
      body: row.body,
      status: row.status,
      raisedAt: row.raisedAt,
      lastRepliedAt: firmReplies[firmReplies.length - 1]?.reply.writtenAt ?? null,
      replies,
    };
  }
}

const LIVE: readonly RequestStatus[] = ["open", "answered"];

export class FakeRequestRepo implements RequestRepository {
  constructor(private readonly store: FakeRequestStore) {}

  listLive(tenantId: string): Promise<readonly ClientRequestRecord[]> {
    return Promise.resolve(this.listWhere(tenantId, true));
  }

  /** The COMPLEMENT of live, exactly as the SQL writes it — a fake that named
   *  the two finished statuses itself would keep passing on the day a third
   *  status appeared and the real query started dropping it from both lists. */
  listFinished(tenantId: string): Promise<readonly ClientRequestRecord[]> {
    return Promise.resolve(this.listWhere(tenantId, false));
  }

  private listWhere(tenantId: string, live: boolean): readonly ClientRequestRecord[] {
    return this.store.requests
      .filter((r) => r.tenantId === tenantId && LIVE.includes(r.status) === live)
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
      .map((r) => this.store.toRecord(r));
  }

  findById(tenantId: string, requestId: string): Promise<ClientRequestRecord | null> {
    const row = this.store.find(tenantId, requestId);
    return Promise.resolve(row ? this.store.toRecord(row) : null);
  }

  reply(input: NewFirmReply): Promise<FirmReplyOutcome> {
    const row = this.store.find(input.tenantId, input.requestId);
    if (!row || !LIVE.includes(row.status)) {
      return Promise.resolve({ ok: false, reason: "request" });
    }
    if (input.documentId !== null) {
      // What the composite FK refuses in Postgres: another client's document,
      // and the firm's own (whose party is null and matches no NOT NULL value).
      if (this.store.documents.get(input.documentId) !== row.clientPartyId) {
        return Promise.resolve({ ok: false, reason: "document" });
      }
      this.store.madeVisible.add(input.documentId);
    }
    const at = this.store.now();
    this.store.replies.push({
      id: input.id,
      requestId: row.id,
      clientPartyId: row.clientPartyId,
      authorSide: "firm",
      body: input.body,
      documentId: input.documentId,
      writtenBy: input.writtenBy,
      writtenAt: at,
    });
    row.status = "answered";
    row.firstRepliedAt = row.firstRepliedAt ?? at;
    return Promise.resolve({ ok: true, record: this.store.toRecord(row) });
  }

  assign(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly assigneeUserId: string | null;
    readonly note: string | null;
  }): Promise<ClientRequestRecord | null> {
    const row = this.store.find(input.tenantId, input.requestId);
    if (!row || !LIVE.includes(row.status)) return Promise.resolve(null);
    // The pair moves together, which is 0070's CHECK expressed as an
    // assignment rather than as a constraint — the fake cannot refuse, so it
    // has to be incapable of writing the refused shape.
    row.assigneeUserId = input.assigneeUserId;
    row.assignmentNote = input.assigneeUserId === null ? input.note : null;
    return Promise.resolve(this.store.toRecord(row));
  }

  close(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly settledBy: string;
  }): Promise<ClientRequestRecord | null> {
    const row = this.store.find(input.tenantId, input.requestId);
    if (!row || !LIVE.includes(row.status)) return Promise.resolve(null);
    row.status = "closed";
    row.settledBy = input.settledBy;
    row.settledAt = this.store.now();
    return Promise.resolve(this.store.toRecord(row));
  }
}

export class FakePortalRequestRepo implements PortalRequestRepository {
  constructor(private readonly store: FakeRequestStore) {}

  list(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalRequestRow[]> {
    return Promise.resolve(
      this.store.requests
        .filter((r) => r.tenantId === tenantId && clientPartyIds.includes(r.clientPartyId))
        .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
        .map((r) => this.store.toPortalRow(r)),
    );
  }

  findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    requestId: string,
  ): Promise<PortalRequestRow | null> {
    const row = this.store.find(tenantId, requestId);
    if (!row || !clientPartyIds.includes(row.clientPartyId)) return Promise.resolve(null);
    return Promise.resolve(this.store.toPortalRow(row));
  }

  raise(
    tenantId: string,
    clientPartyIds: readonly string[],
    request: NewRequest,
  ): Promise<PortalRequestRow | null> {
    // The policy's WITH CHECK, as an outcome. In Postgres this is not a null —
    // it is an RLS violation — which is exactly why the service refuses first.
    if (!clientPartyIds.includes(request.clientPartyId)) return Promise.resolve(null);
    const row: StoredRequest = {
      id: request.id,
      tenantId,
      clientPartyId: request.clientPartyId,
      clientName: this.store.partyNames.get(request.clientPartyId) ?? `party-${request.clientPartyId}`,
      subject: request.subject,
      body: request.body,
      status: "open",
      raisedBy: request.raisedBy,
      raisedAt: this.store.now(),
      firstRepliedAt: null,
      settledBy: null,
      settledAt: null,
      // Resolved by the SERVICE before this call, never here — the whole point
      // of `NewRequest` carrying them.
      assigneeUserId: request.assigneeUserId,
      assignmentNote: request.assignmentNote,
    };
    this.store.requests.push(row);
    return Promise.resolve(this.store.toPortalRow(row));
  }

  reply(
    tenantId: string,
    clientPartyIds: readonly string[],
    reply: NewReply,
  ): Promise<PortalRequestRow | null> {
    const row = this.store.find(tenantId, reply.requestId);
    if (!row || !clientPartyIds.includes(row.clientPartyId)) return Promise.resolve(null);
    if (!LIVE.includes(row.status)) return Promise.resolve(null);
    this.store.replies.push({
      id: reply.id,
      requestId: row.id,
      clientPartyId: row.clientPartyId,
      authorSide: "client",
      body: reply.body,
      // The CHECK in 0068: only the firm attaches.
      documentId: null,
      writtenBy: reply.writtenBy,
      writtenAt: this.store.now(),
    });
    // Deliberately NOT touching the status — see `lastWordWith`.
    return Promise.resolve(this.store.toPortalRow(row));
  }

  withdraw(
    tenantId: string,
    clientPartyIds: readonly string[],
    input: { readonly requestId: string; readonly settledBy: string },
  ): Promise<PortalRequestRow | null> {
    const row = this.store.find(tenantId, input.requestId);
    if (!row || !clientPartyIds.includes(row.clientPartyId)) return Promise.resolve(null);
    if (!LIVE.includes(row.status)) return Promise.resolve(null);
    row.status = "withdrawn";
    row.settledBy = input.settledBy;
    row.settledAt = this.store.now();
    return Promise.resolve(this.store.toPortalRow(row));
  }
}

/** What a portal login was granted. Starts EMPTY, because a contact granted
 *  nothing is a real session and the one the service must still call the
 *  database for. */
export class FakeRequestScope implements PortalScopeSource {
  private readonly byUser = new Map<string, { clientPartyId: string; clientName: string }[]>();

  grant(userId: string, clientPartyId: string, clientName = `party-${clientPartyId}`): this {
    const held = this.byUser.get(userId) ?? [];
    held.push({ clientPartyId, clientName });
    this.byUser.set(userId, held);
    return this;
  }

  scopedCompanies(
    _tenantId: string,
    userId: string,
    _on: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]> {
    return Promise.resolve(this.byUser.get(userId) ?? []);
  }
}

/**
 * How a firm routes. Starts at `none`, because that is what every firm is on
 * until it decides otherwise and a fake that started anywhere else would make
 * the shipped default the one shape nothing is tested against.
 */
export class FakeRequestRouting implements RequestRoutingSource {
  private readonly byTenant = new Map<string, RequestRouting>();

  routingFor(tenantId: string): Promise<RequestRouting> {
    return Promise.resolve(this.byTenant.get(tenantId) ?? "none");
  }

  setRouting(tenantId: string, routing: RequestRouting): Promise<RequestRouting> {
    this.byTenant.set(tenantId, routing);
    return Promise.resolve(routing);
  }
}

/** Who owns which client. Empty means NO Key Manager, which is a real state and
 *  the one the routing rule has to refuse to guess around. */
export class FakeKeyManagers implements KeyManagerDirectory {
  private readonly byClient = new Map<string, string>();

  set(clientPartyId: string, userId: string): this {
    this.byClient.set(clientPartyId, userId);
    return this;
  }

  keyManagerFor(
    _tenantId: string,
    clientPartyId: string,
    _on: string,
  ): Promise<string | null> {
    return Promise.resolve(this.byClient.get(clientPartyId) ?? null);
  }
}

/** Everybody is staff unless a test says otherwise — the refusal is the
 *  interesting case, so it is the one a test has to opt into. */
export class FakeAssignableStaff implements AssignableStaffDirectory {
  private readonly gone = new Set<string>();

  hasLeft(userId: string): this {
    this.gone.add(userId);
    return this;
  }

  isActiveStaff(_tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(!this.gone.has(userId));
  }
}
