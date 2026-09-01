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
  FakeAssignableStaff,
  FakeKeyManagers,
  FakePortalRequestRepo,
  FakeRequestRepo,
  FakeRequestRouting,
  FakeRequestScope,
  FakeRequestStore,
} from "../../src/testfakes/clientrequest";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { routeRequest } from "../../src/domain/clientrequest/model";
import {
  RequestAlreadySettled,
  RequestAssigneeNotStaff,
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
/** Whoever the routing rule would place a request on. */
const KEY_MANAGER = PARTNER;

const meera: Actor = { type: "human", id: MEERA };
const partner: Actor = { type: "human", id: PARTNER };

function build() {
  const store = new FakeRequestStore();
  const events = new RecordingEventSink();
  const scope = new FakeRequestScope();
  const routing = new FakeRequestRouting();
  const keyManagers = new FakeKeyManagers();
  const staff = new FakeAssignableStaff();
  const service = new ClientRequestService({
    requests: new FakeRequestRepo(store),
    portal: new FakePortalRequestRepo(store),
    scope,
    routing,
    keyManagers,
    staff,
    ids: new FakeIds(),
    events,
    clock: new FakeClock(new Date("2026-09-02T00:00:00.000Z")),
  });
  return { service, store, events, scope, routing, keyManagers, staff };
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
    expect(inbox.requests.map((r) => r.clientName).sort()).toEqual([
      "Cobalt Foods",
      "Lakeview Retail",
    ]);
    expect(inbox.requests.every((r) => r.clientName.length > 0)).toBe(true);
    // AND THE SETTING TRAVELS WITH IT. `none` is the shipped default, so an
    // inbox with nothing assigned is explained rather than ambiguous — T4.5's
    // `ladderPublished` decision, applied again.
    expect(inbox.routing).toBe("none");
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

    // A firm-wide inbox is only usable while it is short.
    expect((await ctx.service.inbox(TENANT)).requests).toEqual([]);
  });
});


describe("whose desk it lands on", () => {
  describe("the rule itself, with nothing around it", () => {
    it("routes nothing under `none`, and writes NO note for it", () => {
      // The subtle half. A firm that routes nothing has not FAILED to route
      // anything, and a note would put a permanent sentence on every row of an
      // inbox where every row is equally unassigned — noise saying the same
      // thing as the empty column beside it.
      expect(routeRequest("none", KEY_MANAGER)).toEqual({ assigneeUserId: null, note: null });
      expect(routeRequest("none", null)).toEqual({ assigneeUserId: null, note: null });
    });

    it("names the Key Manager when there is one", () => {
      expect(routeRequest("key_manager", KEY_MANAGER)).toEqual({
        assigneeUserId: KEY_MANAGER,
        note: null,
      });
    });

    it("names NOBODY when there is none, and says what to do about it", () => {
      const out = routeRequest("key_manager", null);
      expect(out.assigneeUserId).toBeNull();
      // A wrong assignee is worse than none (0051): there is no fallback to a
      // partner, to whoever is free, or to the last person who replied. The
      // note is what makes the unassigned queue clearable rather than a pile,
      // and it manages that only by naming the FIX.
      expect(out.note).toMatch(/Key Manager/);
      expect(out.note).toMatch(/Name one on the client's page|take this request yourself/);
    });
  });

  it("places a request on the Key Manager's desk when the firm has switched it on", async () => {
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    ctx.keyManagers.set(COBALT, PARTNER);

    const row = await raised(ctx);
    const record = await ctx.service.find(TENANT, row.requestId);
    expect(record.request.assigneeUserId).toBe(PARTNER);
    expect(record.request.assignmentNote).toBeNull();
  });

  it("leaves it with NOBODY and a sentence when the client has no Key Manager", async () => {
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    // No `keyManagers.set` — the client has nobody, which is an ordinary state
    // and the one the rule must refuse to guess around.

    const row = await raised(ctx);
    const record = await ctx.service.find(TENANT, row.requestId);
    expect(record.request.assigneeUserId).toBeNull();
    expect(record.request.assignmentNote).toMatch(/Key Manager/);
  });

  it("does not look up a Key Manager at all when the firm routes nothing", async () => {
    // Not a performance point. `crm.client_assignment` names the firm's own
    // people, and a read on a client's behalf that the firm has not asked for
    // is a read that should not happen.
    const ctx = withMeera();
    let asked = 0;
    const counting = {
      keyManagerFor: async (t: string, c: string, on: string) => {
        asked += 1;
        return ctx.keyManagers.keyManagerFor(t, c, on);
      },
    };
    const service = new ClientRequestService({
      requests: new FakeRequestRepo(ctx.store),
      portal: new FakePortalRequestRepo(ctx.store),
      scope: ctx.scope,
      routing: ctx.routing,
      keyManagers: counting,
      staff: ctx.staff,
      ids: new FakeIds(),
      events: ctx.events,
      clock: new FakeClock(new Date("2026-09-02T00:00:00.000Z")),
    });
    await service.raise({
      tenantId: TENANT,
      userId: MEERA,
      clientPartyId: COBALT,
      subject: "anything",
      body: "anything",
      actor: meera,
    });
    expect(asked).toBe(0);
  });

  it("records the RULE placing it, apart from a person doing so", async () => {
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    ctx.keyManagers.set(COBALT, PARTNER);
    await raised(ctx);

    const placed = ctx.events.recorded.filter((e) => e.verb === "client_request.assigned");
    expect(placed).toHaveLength(1);
    expect(placed[0]?.payload).toEqual({
      clientPartyId: COBALT,
      assigneeUserId: PARTNER,
      by: "rule",
    });
    // THE ACTOR IS THE CLIENT CONTACT, honestly — their request is what caused
    // it. Naming the assignee would credit them with a decision they did not
    // take; naming the SYSTEM would hide that somebody outside the firm set it
    // off.
    expect(placed[0]?.actorId).toBe(MEERA);
  });

  it("writes NO placement event when the rule found nobody", async () => {
    // Per PLACEMENT, not per raise — so "how often does this rule find
    // somebody" is a count over rows rather than an estimate.
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    await raised(ctx);
    expect(ctx.events.recorded.filter((e) => e.verb === "client_request.assigned")).toEqual([]);
  });

  it("lets a person take one whatever the setting says, and clears the note", async () => {
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    const row = await raised(ctx); // no Key Manager -> unassigned, with a note

    const taken = await ctx.service.assign({
      tenantId: TENANT,
      requestId: row.requestId,
      assigneeUserId: PARTNER,
      actor: partner,
    });
    expect(taken.request.assigneeUserId).toBe(PARTNER);
    // 0070 refuses a note beside a name, so the pair has to move together.
    expect(taken.request.assignmentNote).toBeNull();

    const person = ctx.events.recorded.filter((e) => e.verb === "client_request.assigned");
    expect(person[0]?.payload).toMatchObject({ by: "person" });
  });

  it("takes one OFF a desk with no note, because that is not a routing failure", async () => {
    const ctx = withMeera();
    const row = await raised(ctx);
    await ctx.service.assign({
      tenantId: TENANT,
      requestId: row.requestId,
      assigneeUserId: PARTNER,
      actor: partner,
    });

    const off = await ctx.service.assign({
      tenantId: TENANT,
      requestId: row.requestId,
      assigneeUserId: null,
      actor: partner,
    });
    expect(off.request.assigneeUserId).toBeNull();
    // A person deliberately unassigning has explained it by doing it. Leaving
    // the rule's old sentence would have the screen saying the request is
    // unplaced for a reason that is no longer why.
    expect(off.request.assignmentNote).toBeNull();
  });

  it("refuses somebody who does not work here — a refusal no foreign key can make", async () => {
    const ctx = withMeera();
    const row = await raised(ctx);
    ctx.staff.hasLeft(PARTNER);

    await expect(
      ctx.service.assign({
        tenantId: TENANT,
        requestId: row.requestId,
        assigneeUserId: PARTNER,
        actor: partner,
      }),
    ).rejects.toThrow(RequestAssigneeNotStaff);
  });

  it("refuses to assign a settled request", async () => {
    const ctx = withMeera();
    const row = await raised(ctx);
    await ctx.service.close({ tenantId: TENANT, requestId: row.requestId, actor: partner });
    await expect(
      ctx.service.assign({
        tenantId: TENANT,
        requestId: row.requestId,
        assigneeUserId: PARTNER,
        actor: partner,
      }),
    ).rejects.toThrow(RequestAlreadySettled);
  });

  it("RESTATES NOTHING when the setting changes", async () => {
    // `work_split_axis`'s behaviour and its reason: a firm switching this on
    // does not want yesterday's inbox redistributed underneath whoever is
    // working it, and one switching it off is not asking for every request to
    // be taken off its owner.
    const ctx = withMeera();
    ctx.keyManagers.set(COBALT, PARTNER);
    const before = await raised(ctx, "Raised while routing was off");

    await ctx.service.setRouting(TENANT, "key_manager", partner);
    const after = await raised(ctx, "Raised after it was switched on");

    const inbox = await ctx.service.inbox(TENANT);
    const older = inbox.requests.find((r) => r.request.id === before.requestId);
    const newer = inbox.requests.find((r) => r.request.id === after.requestId);
    expect(older?.request.assigneeUserId).toBeNull();
    expect(newer?.request.assigneeUserId).toBe(PARTNER);
    expect(inbox.routing).toBe("key_manager");
  });

  it("records the switch against the FIRM, not against a request", async () => {
    const ctx = withMeera();
    await ctx.service.setRouting(TENANT, "key_manager", partner);
    const event = ctx.events.recorded.find((e) => e.verb === "client_request.routing_set");
    expect(event?.objectId).toBe(TENANT);
    expect(event?.objectType).toBe("tenant");
    expect(event?.payload).toEqual({ routing: "key_manager" });
  });

  it("refuses a routing this product cannot do, and says what it can", async () => {
    const ctx = withMeera();
    await expect(ctx.service.setRouting(TENANT, "spoc", partner)).rejects.toThrow(
      /not a way this product can route/,
    );
    // A SPOC is the one somebody will reach for, and it cannot be added without
    // choosing an axis on the firm's behalf.
    await expect(ctx.service.setRouting(TENANT, "spoc", partner)).rejects.toThrow(/axis/);
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
    const wired = [
      "requests",
      "portal",
      "scope",
      "routing",
      "keyManagers",
      "staff",
      "ids",
      "events",
      "clock",
    ];
    const { service } = build();
    const actual = Object.keys(
      (service as unknown as { deps: Record<string, unknown> }).deps,
    ).sort();
    expect(actual).toEqual([...wired].sort());
  });
});
