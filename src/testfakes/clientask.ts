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
  AskChaseRecord,
  AskDecision,
  AskRecord,
  AskResponse,
  ClientAsk,
  PortalAskRow,
  ResponseKind,
} from "../domain/clientask/model";
import type {
  AskRepository,
  DocumentResponse,
  NewAsk,
  NewResponse,
  NewTemplateAsk,
  PortalAskRepository,
  PortalScopeSource,
  TemplateAskInsert,
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
  readonly respondedBy: string;
  /** 0390: the firm recorded it for the client. */
  readonly onBehalf: boolean;
}

/** A document an upload created, as the adapters write it: its kind, whose
 *  act it was, and whether the client can see it. */
export interface StoredUpload {
  readonly askId: string;
  readonly upload: UploadedBytes;
  readonly createdBy: string;
  readonly onBehalf: boolean;
  readonly isClientVisible: boolean;
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
  /** Every document an upload created, in order. */
  readonly uploads: StoredUpload[] = [];
  /** Which client each work item belongs to — the fact `raise` reads out of
   *  `delivery.work_item` in the real adapter. */
  readonly workItems = new Map<string, { clientPartyId: string; title: string }>();
  /** Work items the firm has marked invisible to the client. In Postgres this is
   *  0062's policy on the JOIN; here it is a set, and the note at the top of the
   *  file applies. */
  readonly hiddenWorkItems = new Set<string>();
  /** Reminders the chaser has recorded, by ask. `delivery.client_ask_chase`
   *  (0065) — the table that shipped with a writer and no reader, which is what
   *  T6.7 closed. Kept here so a unit test can assert the two surfaces read it
   *  DIFFERENTLY on purpose: the firm gets every rung, the client gets the last
   *  date and no tally. */
  readonly chases = new Map<string, AskChaseRecord[]>();
  private tick = 0;

  now(): string {
    this.tick += 1;
    return new Date(Date.parse("2026-09-01T09:00:00Z") + this.tick * 60_000).toISOString();
  }

  workItem(id: string, clientPartyId: string, title = "GST monthly filing"): this {
    this.workItems.set(id, { clientPartyId, title });
    return this;
  }

  /** Record that a rung fired on an ask. Append-only here as it is by GRANT in
   *  0065 — there is deliberately no way to remove one. */
  chase(askId: string, rungKey: string, afterDays: number, daysOpen: number): this {
    const held = this.chases.get(askId) ?? [];
    held.push({ rungKey, afterDays, daysOpen, chasedAt: this.now() });
    this.chases.set(askId, held);
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
      dueOn: ask.dueOn,
      fromTemplate: null,
    };
    this.store.asks.push(row);
    return Promise.resolve(this.record(row));
  }

  /**
   * 0385's partial unique index, reproduced: one ask per (firm, task, template
   * key, item key). The real adapter leaves it to `ON CONFLICT DO NOTHING`;
   * here it is a find, which is the same answer for a single-threaded test and
   * says nothing about the race — that is the integration test's.
   */
  raiseFromTemplate(ask: NewTemplateAsk): Promise<TemplateAskInsert> {
    const wi = this.store.workItems.get(ask.workItemId);
    if (!wi) return Promise.resolve({ outcome: "no_work_item" });
    const already = this.store.asks.some(
      (a) =>
        a.tenantId === ask.tenantId &&
        a.workItemId === ask.workItemId &&
        a.fromTemplate !== null &&
        a.fromTemplate.templateKey === ask.template.templateKey &&
        a.fromTemplate.itemKey === ask.template.itemKey,
    );
    if (already) return Promise.resolve({ outcome: "already_raised" });
    const row: ClientAsk = {
      id: ask.id,
      tenantId: ask.tenantId,
      workItemId: ask.workItemId,
      clientPartyId: wi.clientPartyId,
      askKind: ask.askKind,
      prompt: ask.prompt,
      documentKind: ask.documentKind,
      status: "open",
      // NULL — a template raised it, and 0385's CHECK allows that only here.
      raisedBy: null,
      raisedAt: this.store.now(),
      firstAnsweredAt: null,
      closedBy: null,
      closedAt: null,
      dueOn: ask.dueOn,
      fromTemplate: { ...ask.template },
    };
    this.store.asks.push(row);
    return Promise.resolve({ outcome: "created", record: this.record(row) });
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

  /** 0390: the batch lands whole or not at all, as the locked transaction
   *  does; null when the ask is gone or settled, with nothing written. */
  respondOnBehalf(
    tenantId: string,
    askId: string,
    files: readonly DocumentResponse[],
  ): Promise<AskRecord | null> {
    const i = this.store.asks.findIndex((a) => a.tenantId === tenantId && a.id === askId);
    const ask = this.store.asks[i];
    if (i < 0 || !ask || (ask.status !== "open" && ask.status !== "answered")) {
      return Promise.resolve(null);
    }
    const at = this.store.now();
    for (const { response, upload } of files) {
      this.store.uploads.push({
        askId,
        upload,
        createdBy: response.respondedBy,
        onBehalf: true,
        isClientVisible: true,
      });
      this.store.responses.push(storedResponse(response, upload, at, true));
    }
    this.store.asks[i] = { ...ask, status: "answered", firstAnsweredAt: ask.firstAnsweredAt ?? at };
    const updated = this.store.asks[i];
    return Promise.resolve(updated ? this.record(updated) : null);
  }

  private record(ask: ClientAsk): AskRecord {
    return {
      ask,
      clientName: `Client ${ask.clientPartyId.slice(0, 4)}`,
      raisedByName: ask.raisedBy === null ? null : "Aarav Menon",
      closedByName: ask.closedBy === null ? null : "Aarav Menon",
      responses: this.store.responses
        .filter((r) => r.askId === ask.id)
        .map((r) => toResponse(r, "firm")),
      // EVERY RUNG, oldest first. The firm's half of the chase reader.
      chases: [...(this.store.chases.get(ask.id) ?? [])].sort((a, b) =>
        a.chasedAt < b.chasedAt ? -1 : 1,
      ),
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
    return Promise.resolve(
      this.write(tenantId, clientPartyIds, response.askId, [{ response, upload: null }]),
    );
  }

  /** Several files, ONE batch: all of them or none, as the locked transaction
   *  in the real adapter. */
  respondWithDocuments(
    tenantId: string,
    clientPartyIds: readonly string[],
    files: readonly DocumentResponse[],
  ): Promise<PortalAskRow | null> {
    const first = files[0];
    if (first === undefined) return Promise.resolve(null);
    return Promise.resolve(
      this.write(
        tenantId,
        clientPartyIds,
        first.response.askId,
        files.map((f) => ({ response: f.response, upload: f.upload })),
      ),
    );
  }

  private write(
    tenantId: string,
    clientPartyIds: readonly string[],
    askId: string,
    batch: readonly { response: NewResponse; upload: UploadedBytes | null }[],
  ): PortalAskRow | null {
    const i = this.store.asks.findIndex((a) => a.tenantId === tenantId && a.id === askId);
    const ask = this.store.asks[i];
    if (i < 0 || !ask) return null;
    // The scope check, and the note at the top applies: in Postgres this is a
    // policy and the statement does not mention the column at all.
    if (!clientPartyIds.includes(ask.clientPartyId)) return null;
    if (ask.status !== "open" && ask.status !== "answered") return null;

    // ONE instant for the responses and for `first_answered_at`, because the
    // real write is one transaction — two ticks would put the ask's first-answer
    // stamp a minute after the response it names.
    const at = this.store.now();
    for (const { response, upload } of batch) {
      if (upload !== null) {
        this.store.uploads.push({
          askId,
          upload,
          createdBy: response.respondedBy,
          onBehalf: false,
          isClientVisible: true,
        });
      }
      this.store.responses.push(storedResponse(response, upload, at, false));
    }
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
      dueOn: ask.dueOn,
      // THE LAST DATE AND NO COUNT — the client's half, and the difference from
      // `record()` above is the whole decision, not an oversight. `max()` in the
      // real adapter, the same reduction here.
      lastRemindedAt:
        (this.store.chases.get(ask.id) ?? []).reduce<string | null>(
          (latest, c) => (latest === null || c.chasedAt > latest ? c.chasedAt : latest),
          null,
        ),
      responses: this.store.responses
        .filter((r) => r.askId === ask.id)
        .map((r) => toResponse(r, "portal")),
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
  ): Promise<readonly { clientPartyId: string; clientName: string }[]> {
    // An EMPTY array for a user with no grants, never a throw and never a
    // shortcut: "invited and granted nothing" is a real answer the service has
    // to carry all the way to the repository.
    return Promise.resolve(this.byUser.get(userId) ?? []);
  }
}

function storedResponse(
  response: NewResponse,
  upload: UploadedBytes | null,
  at: string,
  onBehalf: boolean,
): StoredResponse {
  return {
    id: response.id,
    askId: response.askId,
    responseKind: response.responseKind,
    answerText: response.answerText,
    documentId: upload?.documentId ?? null,
    decision: (response.decision as AskDecision | null) ?? null,
    respondedAt: at,
    filename: upload?.filename ?? null,
    respondedBy: response.respondedBy,
    onBehalf,
  };
}

/** The firm's read names whoever responded, the colleague included; the
 *  client's never names anybody at the firm (T6.5), so an on-behalf response
 *  names nobody there. */
function toResponse(r: StoredResponse, surface: "firm" | "portal") {
  const response: AskResponse = {
    id: r.id,
    askId: r.askId,
    responseKind: r.responseKind,
    answerText: r.answerText,
    documentId: r.documentId,
    decision: r.decision,
    respondedAt: r.respondedAt,
    onBehalf: r.onBehalf,
  };
  return {
    response,
    respondedByName: r.onBehalf ? (surface === "firm" ? "Aarav Menon" : null) : "Meera Iyer",
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
