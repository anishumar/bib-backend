// The client's own request (T6.8), against in-memory fakes.
//
// What these prove is the SERVICE's rules — who may end a request, what a reply
// costs, what reaches the ledger. What they deliberately do NOT prove is the
// wall: `FakePortalRequestRepo` filters on the party ids it is handed, which is
// the same outcome as `client_request_portal_scope` by a different mechanism.
// Gate 4 is proven against real Postgres in
// `tests/portal/client-request.integration.test.ts`, by dropping the policy.
import { beforeEach, describe, expect, it } from "vitest";
import { ClientRequestService } from "../../src/usecase/clientrequest/service";
import {
  FakePortalRequestRepo,
  FakeRequestRepo,
  FakeRequestScope,
  FakeRequestStore,
} from "../../src/testfakes/clientrequest";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  RequestAlreadySettled,
  RequestBodyEmpty,
  RequestCompanyNotYours,
  RequestDocumentNotFound,
  RequestNotFound,
  RequestReplyEmpty,
  RequestSubjectEmpty,
} from "../../src/domain/clientrequest/errors";
import type { Actor } from "../../src/domain/ledger/model";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COBALT = "22222222-2222-2222-2222-222222222222";
const LAKEVIEW = "33333333-3333-3333-3333-333333333333";
const MEERA = "44444444-4444-4444-4444-444444444444";
const PARTNER = "55555555-5555-5555-5555-555555555555";
/** Lakeview's own contact. A real uuid, because the ledger refuses a human
 *  actor without one — `isIdentifiedActor`. */
const RAVI = "66666666-6666-6666-6666-666666666666";

const meera: Actor = { type: "human", id: MEERA };
const partner: Actor = { type: "human", id: PARTNER };

function build() {
  const store = new FakeRequestStore();
  const events = new RecordingEventSink();
  const scope = new FakeRequestScope();
  const service = new ClientRequestService({
    requests: new FakeRequestRepo(store),
    portal: new FakePortalRequestRepo(store),
    scope,
    ids: new FakeIds(),
    events,
    clock: new FakeClock(new Date("2026-09-02T00:00:00.000Z")),
  });
  return { service, store, events, scope };
}

/** Meera at Cobalt Foods, granted her own company and nothing else. */
function withMeera() {
  const ctx = build();
  ctx.scope.grant(MEERA, COBALT, "Cobalt Foods");
  ctx.store.seedParty(COBALT, "Cobalt Foods").seedParty(LAKEVIEW, "Lakeview Retail");
  return ctx;
}

async function raised(ctx: ReturnType<typeof withMeera>, subject = "Last year's balance sheet") {
  return ctx.service.raise({
    tenantId: TENANT,
    userId: MEERA,
    clientPartyId: COBALT,
    subject,
    body: "We are being assessed and need the FY23 balance sheet.",
    actor: meera,
  });
}

describe("a client asks the firm for something", () => {
  let ctx: ReturnType<typeof withMeera>;
  beforeEach(() => {
    ctx = withMeera();
  });

  it("raises a request that hangs off nothing", async () => {
    const row = await raised(ctx);
    expect(row.status).toBe("open");
    expect(row.subject).toBe("Last year's balance sheet");
    expect(row.companyName).toBe("Cobalt Foods");
    expect(row.replies).toEqual([]);
    // No work item, no engagement, no obligation. That is the whole point —
    // 0068 exists because `client_ask.work_item_id` is NOT NULL and a client's
    // own request has no parent to hang off.
    expect(row).not.toHaveProperty("workItemId");
  });

  it("refuses a company this session was not granted, and calls it NOT FOUND", async () => {
    // A 403 would confirm the company exists at this firm, which is the
    // enumeration the policy was written to prevent — so the service refuses
    // with the same sentence the wall would produce.
    await expect(
      ctx.service.raise({
        tenantId: TENANT,
        userId: MEERA,
        clientPartyId: LAKEVIEW,
        subject: "Send me Lakeview's returns",
        body: "asking about a company that is not mine",
        actor: meera,
      }),
    ).rejects.toThrow(RequestCompanyNotYours);
    expect(ctx.store.requests).toHaveLength(0);
  });

  it("refuses a blank subject and a blank body separately", async () => {
    await expect(
      ctx.service.raise({
        tenantId: TENANT,
        userId: MEERA,
        clientPartyId: COBALT,
        subject: "   ",
        body: "there is a body",
        actor: meera,
      }),
    ).rejects.toThrow(RequestSubjectEmpty);

    await expect(
      ctx.service.raise({
        tenantId: TENANT,
        userId: MEERA,
        clientPartyId: COBALT,
        subject: "there is a subject",
        body: "\n\t ",
        actor: meera,
      }),
    ).rejects.toThrow(RequestBodyEmpty);
  });

  it("records the raising WITHOUT the client's own words", async () => {
    const row = await raised(ctx);
    const event = ctx.events.recorded.find((e) => e.verb === "client_request.raised");
    expect(event?.objectId).toBe(row.requestId);
    // The stored row names its actor by id — the NAME is a read-time join, which
    // is what lets erasure work. This one is a CLIENT CONTACT: the second verb
    // in the registry whose human is outside the firm, and the first whose
    // human outside the firm STARTED something.
    expect(event?.actorType).toBe("human");
    expect(event?.actorId).toBe(MEERA);
    expect(event?.objectType).toBe("client_request");
    expect(event?.payload).toEqual({ clientPartyId: COBALT });
    // §3.4 — this log cannot be erased, and both fields are prose about a
    // client's own business.
    expect(JSON.stringify(event?.payload)).not.toContain("balance sheet");
    expect(JSON.stringify(event?.payload)).not.toContain("assessed");
  });

  it("lists their own history, finished ones included", async () => {
    const first = await raised(ctx, "One");
    await raised(ctx, "Two");
    await ctx.service.withdraw({
      tenantId: TENANT,
      userId: MEERA,
      requestId: first.requestId,
      actor: meera,
    });

    const list = await ctx.service.mine(TENANT, MEERA);
    expect(list.awaitingFirm.map((r) => r.subject)).toEqual(["Two"]);
    expect(list.replied).toEqual([]);
    // "Did I already ask for this" is the question that stops the second phone
    // call, so a settled request stays readable to the person who raised it.
    expect(list.settled.map((r) => r.subject)).toEqual(["One"]);
  });

  it("asks the database even when the contact was granted nothing", async () => {
    // An EMPTY scope is a real answer and must reach the repository as one.
    // There is no `if (companies.length === 0) return []` and there must never
    // be: it is indistinguishable from the version that works until somebody
    // moves the check one layer down, where skipping the call leaves the
    // session looking like STAFF.
    const bare = build();
    const list = await bare.service.mine(TENANT, "nobody");
    expect(list.awaitingFirm).toEqual([]);
    expect(list.settled).toEqual([]);
  });
});

describe("the two endings belong to different people", () => {
  let ctx: ReturnType<typeof withMeera>;
  beforeEach(() => {
    ctx = withMeera();
  });

  it("the firm's reply does NOT close it", async () => {
    const row = await raised(ctx);
    const record = await ctx.service.replyAsFirm({
      tenantId: TENANT,
      requestId: row.requestId,
      body: "Attached — let us know if you need FY22 as well.",
      documentId: null,
      actor: partner,
    });
    // A client sent the wrong year has to be able to say so without opening a
    // second request that reads as a fresh demand.
    expect(record.request.status).toBe("answered");
    expect(record.request.settledAt).toBeNull();
  });

  it("keeps the FIRST reply the first reply", async () => {
    const row = await raised(ctx);
    for (const body of ["first", "second"]) {
      await ctx.service.replyAsFirm({
        tenantId: TENANT,
        requestId: row.requestId,
        body,
        documentId: null,
        actor: partner,
      });
    }
    const record = await ctx.service.find(TENANT, row.requestId);
    // A request that restated its answer date on every message would credit the
    // firm with a turnaround it did not have — the number a partner reaches for
    // when a client complains about being ignored.
    expect(record.request.firstRepliedAt).toBe(record.replies[0]?.reply.writtenAt);
    expect(record.replies).toHaveLength(2);
  });

  it("a client's follow-up does not move the status, and the thread says who spoke last", async () => {
    const row = await raised(ctx);
    await ctx.service.replyAsFirm({
      tenantId: TENANT,
      requestId: row.requestId,
      body: "Here it is.",
      documentId: null,
      actor: partner,
    });
    await ctx.service.replyAsClient({
      tenantId: TENANT,
      userId: MEERA,
      requestId: row.requestId,
      body: "That is FY22 — we need FY23.",
      actor: meera,
    });

    const record = await ctx.service.find(TENANT, row.requestId);
    // `answered` means the firm has come back at least once, which is the same
    // fact as `first_replied_at IS NOT NULL` and is enforced as such by 0068's
    // CHECK. Walking it back to `open` would break that constraint.
    expect(record.request.status).toBe("answered");
    expect(record.replies.at(-1)?.reply.authorSide).toBe("client");
  });

  it("only the firm closes, and only the client withdraws", async () => {
    const closing = await raised(ctx);
    const withdrawing = await raised(ctx, "Something else");

    const closed = await ctx.service.close({
      tenantId: TENANT,
      requestId: closing.requestId,
      actor: partner,
    });
    expect(closed.request.status).toBe("closed");
    expect(closed.request.settledBy).toBe(PARTNER);

    const withdrawn = await ctx.service.withdraw({
      tenantId: TENANT,
      userId: MEERA,
      requestId: withdrawing.requestId,
      actor: meera,
    });
    expect(withdrawn.status).toBe("withdrawn");

    // And there is no method that lets either side cross over. The firm's
    // repository hard-codes 'closed' and the portal's hard-codes 'withdrawn' —
    // "we decided you did not need this" is a refusal, which is a close with a
    // reply saying so. Asserted structurally: exactly ONE withdraw exists, and
    // it is the one that needs a portal session's `userId`.
    const methods = Object.getOwnPropertyNames(ClientRequestService.prototype);
    expect(methods.filter((m) => m.toLowerCase().includes("withdraw"))).toEqual(["withdraw"]);
    expect(methods.filter((m) => m.toLowerCase().includes("close"))).toEqual(["close"]);
  });

  it("refuses a second ending, and says which one already happened", async () => {
    const row = await raised(ctx);
    await ctx.service.close({ tenantId: TENANT, requestId: row.requestId, actor: partner });

    await expect(
      ctx.service.close({ tenantId: TENANT, requestId: row.requestId, actor: partner }),
    ).rejects.toThrow(RequestAlreadySettled);
    // A settled request takes no more messages either — replying would reopen
    // something one side finished with, without anybody deciding to reopen it.
    await expect(
      ctx.service.replyAsClient({
        tenantId: TENANT,
        userId: MEERA,
        requestId: row.requestId,
        body: "one more thing",
        actor: meera,
      }),
    ).rejects.toThrow(RequestAlreadySettled);
  });

  it("answers NOT FOUND for a request belonging to another of the firm's clients", async () => {
    // Raised by Lakeview's own contact, and unreachable to Meera. On real
    // Postgres this row is filtered by gate 4 before the service sees it, so
    // the service genuinely cannot tell "no such request" from "not yours".
    ctx.scope.grant(RAVI, LAKEVIEW, "Lakeview Retail");
    const theirs = await ctx.service.raise({
      tenantId: TENANT,
      userId: RAVI,
      clientPartyId: LAKEVIEW,
      subject: "Not Meera's",
      body: "another client's request",
      actor: { type: "human", id: RAVI },
    });

    await expect(
      ctx.service.withdraw({
        tenantId: TENANT,
        userId: MEERA,
        requestId: theirs.requestId,
        actor: meera,
      }),
    ).rejects.toThrow(RequestNotFound);
  });
});

describe("what the firm attaches", () => {
  let ctx: ReturnType<typeof withMeera>;
  beforeEach(() => {
    ctx = withMeera();
  });

  it("sends a document already filed against this client, and MAKES IT VISIBLE", async () => {
    ctx.store.seedDocument("doc-1", COBALT);
    const row = await raised(ctx);

    const record = await ctx.service.replyAsFirm({
      tenantId: TENANT,
      requestId: row.requestId,
      body: "Your FY23 balance sheet.",
      documentId: "doc-1",
      actor: partner,
    });

    expect(record.replies.at(-1)?.document?.documentId).toBe("doc-1");
    // 0066's `is_client_visible` defaults FALSE, so a reply naming a document
    // the client cannot open would be that default swallowing the answer.
    // Attaching it to a message addressed to a client IS the decision to show
    // it to them — one act, one transaction.
    expect(ctx.store.madeVisible.has("doc-1")).toBe(true);
  });

  it("refuses another client's document, and the firm's own", async () => {
    ctx.store.seedDocument("theirs", LAKEVIEW);
    // The firm's own working papers carry `party_id IS NULL` and are seeded
    // here by being absent — no NULL matches a NOT NULL value in 0068's
    // composite FK.
    const row = await raised(ctx);

    for (const documentId of ["theirs", "a-working-paper"]) {
      await expect(
        ctx.service.replyAsFirm({
          tenantId: TENANT,
          requestId: row.requestId,
          body: "here you go",
          documentId,
          actor: partner,
        }),
      ).rejects.toThrow(RequestDocumentNotFound);
    }
    expect(ctx.store.madeVisible.size).toBe(0);
  });

  it("refuses a reply with no words in it, attachment or not", async () => {
    ctx.store.seedDocument("doc-1", COBALT);
    const row = await raised(ctx);
    await expect(
      ctx.service.replyAsFirm({
        tenantId: TENANT,
        requestId: row.requestId,
        body: "   ",
        documentId: "doc-1",
        actor: partner,
      }),
    ).rejects.toThrow(RequestReplyEmpty);
    // And nothing was published on the way to the refusal.
    expect(ctx.store.madeVisible.size).toBe(0);
  });

  it("records that a document went back, and never which one", async () => {
    ctx.store.seedDocument("doc-1", COBALT);
    const row = await raised(ctx);
    await ctx.service.replyAsFirm({
      tenantId: TENANT,
      requestId: row.requestId,
      body: "Attached.",
      documentId: "doc-1",
      actor: partner,
    });

    const event = ctx.events.recorded.find((e) => e.verb === "client_request.replied");
    expect(event?.payload).toEqual({
      authorSide: "firm",
      clientPartyId: COBALT,
      documentAttached: true,
    });
    // What the firm DID is an audit fact; the filename and the words are not.
    expect(JSON.stringify(event?.payload)).not.toContain("Attached.");
  });
});

describe("the firm's inbox", () => {
  it("is one list with no routing, and carries the company on every row", async () => {
    const ctx = withMeera();
    ctx.scope.grant(RAVI, LAKEVIEW, "Lakeview Retail");
    await raised(ctx, "From Cobalt");
    await ctx.service.raise({
      tenantId: TENANT,
      userId: RAVI,
      clientPartyId: LAKEVIEW,
      subject: "From Lakeview",
      body: "a second client writes in",
      actor: { type: "human", id: RAVI },
    });

    const inbox = await ctx.service.inbox(TENANT);
    // Nobody is assigned one. The firm has not said who an inbound request
    // belongs to, and this codebase already carries one arbitrary answer to a
    // question of that shape.
    expect(inbox.map((r) => r.clientName).sort()).toEqual(["Cobalt Foods", "Lakeview Retail"]);
    expect(inbox.every((r) => r.clientName.length > 0)).toBe(true);
  });

  it("drops a request once it is settled, from either side", async () => {
    const ctx = withMeera();
    const closed = await raised(ctx, "Closed by us");
    const withdrawn = await raised(ctx, "Taken back");
    await ctx.service.close({ tenantId: TENANT, requestId: closed.requestId, actor: partner });
    await ctx.service.withdraw({
      tenantId: TENANT,
      userId: MEERA,
      requestId: withdrawn.requestId,
      actor: meera,
    });

    // A firm-wide inbox with no routing is only usable while it is short.
    expect(await ctx.service.inbox(TENANT)).toEqual([]);
  });
});

describe("what this service may not do", () => {
  it("holds no seam that could tell anybody", () => {
    // Transport is P10 (Phase 7). A client raising a request raises a ROW, and
    // the firm sees it when it opens the inbox — so the portal is still a PULL
    // in this direction too, and saying so is better than a logging stub
    // claiming the firm was emailed.
    //
    // Asserted structurally, the way `ChaserService`'s and `NudgeService`'s
    // are: a mailer, a notifier or a transport appearing in Deps turns this red
    // and the argument for it goes on the board first.
    const wired = ["requests", "portal", "scope", "ids", "events", "clock"];
    const { service } = build();
    const actual = Object.keys(
      (service as unknown as { deps: Record<string, unknown> }).deps,
    ).sort();
    expect(actual).toEqual([...wired].sort());
  });
});
