// In-memory port fakes for the client-directed ask (T6.6).
//
// `implements` both repositories the Postgres adapters implement, which is a
// compile-time assertion that the fakes and the real thing stay in step.
//
// ── WHAT THESE DO NOT REPRODUCE, AND MUST NOT PRETEND TO ─────────────────
//
// GATE 4. `FakePortalAskRepository` takes the granted parties and filters on
// them in TypeScript, which is the OPPOSITE of how the real adapter works — the
// real one hands them to `withPortal` and lets the RESTRICTIVE policies in 0063
// do it, and its SQL never mentions `client_party_id`. So a green unit test here
// says the SERVICE resolves and passes the scope; it says nothing at all about
// whether the wall holds.
//
// The wall is proven where it lives:
// `tests/portal/client-ask.integration.test.ts` asks for another client's ask BY
// ID against real Postgres, and every one of its assertions is watched go RED
// with its policy dropped. A unit test that "proved" gate 4 with a filter in a
// fake would be the most dangerous file in this repository.
import type {
  AskDecision,
  AskRecord,
  AskResponse,
  ClientAsk,
  PortalAskRow,
  ResponseKind,
} from "../domain/clientask/model";
import type {
  AskRepository,
  NewAsk,
  NewResponse,
  PortalAskRepository,
  PortalScopeSource,
  UploadedBytes,
} from "../usecase/clientask/ports";

interface StoredResponse {
  readonly id: string;
  readonly askId: string;
  readonly responseKind: ResponseKind;
  readonly answerText: string | null;
  readonly documentId: string | null;
  readonly decision: AskDecision | null;
  readonly respondedAt: string;
  readonly filename: string | null;
}

/**
 * One store behind both fakes, because there is one table behind both adapters.
 *
 * Two stores would let a test set up an ask the firm can see and the client
 * cannot, which is a state the database cannot produce — and a fixture that can
 * describe an impossible situation is a fixture that will eventually be used to
 * assert one.
 */
export class FakeAskStore {
  readonly asks: ClientAsk[] = [];
  readonly responses: StoredResponse[] = [];
  /** Which client each work item belongs to — the fact `raise` reads out of
   *  `delivery.work_item` in the real adapter. */
  readonly workItems = new Map<string, { clientPartyId: string; title: string }>();
  /** Work items the firm has marked invisible to the client. In Postgres this is
   *  0062's policy on the JOIN; here it is a set, and the note at the top of the
   *  file applies. */
  readonly hiddenWorkItems = new Set<string>();
  private tick = 0;

  now(): string {
    this.tick += 1;
    return new Date(Date.parse("2026-09-01T09:00:00Z") + this.tick * 60_000).toISOString();
  }

  workItem(id: string, clientPartyId: string, title = "GST monthly filing"): this {
    this.workItems.set(id, { clientPartyId, title });
    return this;
  }

  hide(workItemId: string): this {
    this.hiddenWorkItems.add(workItemId);
    return this;
  }
}

export class FakeAskRepo implements AskRepository {
  constructor(private readonly store: FakeAskStore) {}

  raise(ask: NewAsk): Promise<AskRecord | null> {
    const wi = this.store.workItems.get(ask.workItemId);
    if (!wi) return Promise.resolve(null);
    const row: ClientAsk = {
      id: ask.id,
      tenantId: ask.tenantId,
      workItemId: ask.workItemId,
      // Read from the work item, never from the caller — the fake reproduces
      // that because it is the property the wall column depends on.
      clientPartyId: wi.clientPartyId,
      askKind: ask.askKind,
      prompt: ask.prompt,
      documentKind: ask.documentKind,
      status: "open",
      raisedBy: ask.raisedBy,
      raisedAt: this.store.now(),
      firstAnsweredAt: null,
      closedBy: null,
      closedAt: null,
    };
    this.store.asks.push(row);
    return Promise.resolve(this.record(row));
  }

  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly AskRecord[]> {
    return Promise.resolve(
      this.store.asks
        .filter((a) => a.tenantId === tenantId && a.workItemId === workItemId)
        .map((a) => this.record(a)),
    );
  }

  findById(tenantId: string, askId: string): Promise<AskRecord | null> {
    const row = this.store.asks.find((a) => a.tenantId === tenantId && a.id === askId);
    return Promise.resolve(row ? this.record(row) : null);
  }

  settle(input: {
    readonly tenantId: string;
    readonly askId: string;
    readonly status: "closed" | "withdrawn";
    readonly closedBy: string;
  }): Promise<AskRecord | null> {
    const i = this.store.asks.findIndex(
      (a) => a.tenantId === input.tenantId && a.id === input.askId,
    );
    const row = this.store.asks[i];
    // The real UPDATE carries `AND status IN ('open','answered')`, so a
    // double-click writes nothing rather than moving the closure date.
    if (i < 0 || !row || (row.status !== "open" && row.status !== "answered")) {
      return Promise.resolve(null);
    }
    const next: ClientAsk = {
      ...row,
      status: input.status,
      closedBy: input.closedBy,
      closedAt: this.store.now(),
    };
    this.store.asks[i] = next;
    return Promise.resolve(this.record(next));
  }

  private record(ask: ClientAsk): AskRecord {
    return {
      ask,
      clientName: `Client ${ask.clientPartyId.slice(0, 4)}`,
      raisedByName: "Aarav Menon",
      closedByName: ask.closedBy === null ? null : "Aarav Menon",
      responses: this.store.responses
        .filter((r) => r.askId === ask.id)
        .map((r) => toResponse(r)),
    };
  }
}

export class FakePortalAskRepo implements PortalAskRepository {
  constructor(private readonly store: FakeAskStore) {}

  list(tenantId: string, clientPartyIds: readonly string[]): Promise<readonly PortalAskRow[]> {
    return Promise.resolve(this.visible(tenantId, clientPartyIds).map((a) => this.row(a)));
  }

  findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    askId: string,
  ): Promise<PortalAskRow | null> {
    const row = this.visible(tenantId, clientPartyIds).find((a) => a.id === askId);
    return Promise.resolve(row ? this.row(row) : null);
  }

  respond(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
  ): Promise<PortalAskRow | null> {
    return Promise.resolve(this.write(tenantId, clientPartyIds, response, null));
  }

  respondWithDocument(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
    upload: UploadedBytes,
  ): Promise<PortalAskRow | null> {
    return Promise.resolve(this.write(tenantId, clientPartyIds, response, upload));
  }

  private write(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
    upload: UploadedBytes | null,
  ): PortalAskRow | null {
    const i = this.store.asks.findIndex(
      (a) => a.tenantId === tenantId && a.id === response.askId,
    );
    const ask = this.store.asks[i];
    if (i < 0 || !ask) return null;
    // The scope check, and the note at the top applies: in Postgres this is a
    // policy and the statement does not mention the column at all.
    if (!clientPartyIds.includes(ask.clientPartyId)) return null;
    if (ask.status !== "open" && ask.status !== "answered") return null;

    // ONE instant for the response and for `first_answered_at`, because the real
    // write is one transaction — two ticks would put the ask's first-answer
    // stamp a minute after the response it names.
    const at = this.store.now();
    this.store.responses.push({
      id: response.id,
      askId: response.askId,
      responseKind: response.responseKind,
      answerText: response.answerText,
      documentId: upload?.documentId ?? null,
      decision: (response.decision as AskDecision | null) ?? null,
      respondedAt: at,
      filename: upload?.filename ?? null,
    });
    // `coalesce(first_answered_at, now())` — the FIRST reply stays the first.
    this.store.asks[i] = {
      ...ask,
      status: "answered",
      firstAnsweredAt: ask.firstAnsweredAt ?? at,
    };
    const updated = this.store.asks[i];
    return updated ? this.row(updated) : null;
  }

  private visible(tenantId: string, clientPartyIds: readonly string[]): ClientAsk[] {
    return this.store.asks.filter(
      (a) =>
        a.tenantId === tenantId &&
        clientPartyIds.includes(a.clientPartyId) &&
        !this.store.hiddenWorkItems.has(a.workItemId) &&
        (a.status === "open" || a.status === "answered"),
    );
  }

  private row(ask: ClientAsk): PortalAskRow {
    return {
      askId: ask.id,
      askKind: ask.askKind,
      prompt: ask.prompt,
      documentKind: ask.documentKind,
      status: ask.status,
      companyName: "Cobalt Foods Private Limited",
      workItemTitle: this.store.workItems.get(ask.workItemId)?.title ?? "a task",
      raisedAt: ask.raisedAt,
      responses: this.store.responses
        .filter((r) => r.askId === ask.id)
        .map((r) => toResponse(r)),
    };
  }
}

/** The grants a portal session resolves to. Satisfies the port structurally, the
 *  same way `PortalAccessService` does in `setup/`. */
export class FakeAskScope implements PortalScopeSource {
  private readonly byUser = new Map<string, { clientPartyId: string; clientName: string }[]>();

  grant(userId: string, clientPartyId: string, clientName = "Cobalt Foods"): this {
    const held = this.byUser.get(userId) ?? [];
    held.push({ clientPartyId, clientName });
    this.byUser.set(userId, held);
    return this;
  }

  scopedCompanies(
    _tenantId: string,
    userId: string,
    _on: string,
  ): Promise<readonly { clientPartyId: string; clientName: string }[]> {
    // An EMPTY array for a user with no grants, never a throw and never a
    // shortcut: "invited and granted nothing" is a real answer the service has
    // to carry all the way to the repository.
    return Promise.resolve(this.byUser.get(userId) ?? []);
  }
}

function toResponse(r: StoredResponse) {
  const response: AskResponse = {
    id: r.id,
    askId: r.askId,
    responseKind: r.responseKind,
    answerText: r.answerText,
    documentId: r.documentId,
    decision: r.decision,
    respondedAt: r.respondedAt,
  };
  return {
    response,
    respondedByName: "Meera Iyer",
    document:
      r.documentId !== null && r.filename !== null
        ? {
            documentId: r.documentId,
            filename: r.filename,
            byteSize: 1024,
            mediaType: "application/pdf",
          }
        : null,
  };
}
