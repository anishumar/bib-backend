// The client-directed ask (T6.6) — the rules a database cannot state.
//
// WHAT THIS FILE DOES NOT TEST, and it is the most important line in it: GATE 4.
// The fakes filter the portal scope in TypeScript; the real adapter never does —
// it hands the granted parties to `withPortal` and lets 0063's RESTRICTIVE
// policies filter, and its SQL does not mention `client_party_id` at all. So
// everything green below says the SERVICE resolves and passes the scope, and
// says nothing about whether the wall holds. That is
// `tests/portal/client-ask.integration.test.ts`, against real Postgres, with
// every assertion watched go red with its policy dropped.
import { describe, expect, it } from "vitest";
import { ClientAskService } from "../../src/usecase/clientask/service";
import {
  FakeAskRepo,
  FakeAskScope,
  FakeAskStore,
  FakePortalAskRepo,
} from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import {
  AskAlreadySettled,
  AskAnswerEmpty,
  AskDecisionNotWanted,
  AskDocumentKindMismatch,
  AskNotFound,
  AskWorkItemNotFound,
  InvalidAskKind,
  InvalidAskPrompt,
} from "../../src/domain/clientask/errors";
import { EmptyContent } from "../../src/domain/filestore/errors";

const TENANT = "00000000-0000-4000-8000-000000000001";
const COBALT = "00000000-0000-4000-8000-0000000000c1";
const LAKEVIEW = "00000000-0000-4000-8000-0000000000c2";
const WI_COBALT = "00000000-0000-4000-8000-0000000000a1";
const WI_LAKEVIEW = "00000000-0000-4000-8000-0000000000a2";
const PARTNER = "00000000-0000-4000-8000-0000000000e1";
const MEERA = "00000000-0000-4000-8000-0000000000d1";
const STRANGER = "00000000-0000-4000-8000-0000000000d9";

const staff = { type: "human", id: PARTNER } as const;
const client = { type: "human", id: MEERA } as const;

function svc() {
  const store = new FakeAskStore()
    .workItem(WI_COBALT, COBALT, "GST monthly filing")
    .workItem(WI_LAKEVIEW, LAKEVIEW, "TDS quarterly return");
  const events = new RecordingEventSink();
  const scope = new FakeAskScope().grant(MEERA, COBALT, "Cobalt Foods Private Limited");
  const service = new ClientAskService({
    asks: new FakeAskRepo(store),
    portal: new FakePortalAskRepo(store),
    scope,
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events,
    clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
    maxUploadBytes: 1_000_000,
  });
  return { service, store, events, scope };
}

async function openDocumentAsk(service: ClientAskService) {
  return service.raise({
    tenantId: TENANT,
    workItemId: WI_COBALT,
    askKind: "document",
    prompt: "Please send the Maharashtra purchase register for August",
    documentKind: "working_paper",
    actor: staff,
  });
}

describe("raising an ask", () => {
  it("takes its client FROM THE WORK ITEM, never from the caller", async () => {
    // The whole reason the wall column can be denormalised. Nothing on the
    // request names a client, so nothing a caller sends can decide what gate 4
    // filters this row on — and 0063's composite foreign key makes a mismatch
    // unwritable rather than merely refused.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    expect(ask.ask.clientPartyId).toBe(COBALT);
  });

  it("refuses a work item this firm does not have", async () => {
    const { service } = svc();
    await expect(
      service.raise({
        tenantId: TENANT,
        workItemId: "00000000-0000-4000-8000-00000000dead",
        askKind: "question",
        prompt: "anything",
        documentKind: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(AskWorkItemNotFound);
  });

  it("refuses an ask with nothing in it", async () => {
    // The prompt is the only field that says what is wanted. Without it the
    // client's screen is a row with a button and no question.
    const { service } = svc();
    await expect(
      service.raise({
        tenantId: TENANT,
        workItemId: WI_COBALT,
        askKind: "question",
        prompt: "   ",
        documentKind: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(InvalidAskPrompt);
  });

  it("refuses a kind no screen can draw a control for", async () => {
    const { service } = svc();
    await expect(
      service.raise({
        tenantId: TENANT,
        workItemId: WI_COBALT,
        askKind: "telepathy",
        prompt: "think of a number",
        documentKind: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(InvalidAskKind);
  });

  it("insists a documentKind and a document ask arrive together, both ways", async () => {
    const { service } = svc();
    // A document ask with no filing decision leaves it to whatever the upload
    // defaults to.
    await expect(
      service.raise({
        tenantId: TENANT,
        workItemId: WI_COBALT,
        askKind: "document",
        prompt: "send the register",
        documentKind: null,
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(AskDocumentKindMismatch);
    // And a filing decision on an approval is a field somebody filled in
    // without meaning to.
    await expect(
      service.raise({
        tenantId: TENANT,
        workItemId: WI_COBALT,
        askKind: "approval",
        prompt: "may we file the nil return",
        documentKind: "working_paper",
        actor: staff,
      }),
    ).rejects.toBeInstanceOf(AskDocumentKindMismatch);
  });

  it("records the raising WITHOUT the prompt", async () => {
    // §3.4. The prompt is prose about a client's own business — "send the
    // Kaveri purchase register" names the client as readily as a filename does
    // — and this log cannot be erased.
    const { service, events } = svc();
    const ask = await openDocumentAsk(service);
    const event = events.recorded.find((e) => e.verb === "client_ask.raised");
    expect(event?.objectId).toBe(ask.ask.id);
    expect(JSON.stringify(event?.payload)).not.toContain("purchase register");
    expect(event?.payload).toMatchObject({ askKind: "document", workItemId: WI_COBALT });
  });
});

describe("what a client may act on", () => {
  it("shows a granted company's asks and nothing else", async () => {
    const { service } = svc();
    await openDocumentAsk(service);
    await service.raise({
      tenantId: TENANT,
      workItemId: WI_LAKEVIEW,
      askKind: "question",
      prompt: "which bank is the loan with",
      documentKind: null,
      actor: staff,
    });
    const centre = await service.actionCentre(TENANT, MEERA);
    expect(centre.awaitingYou.map((a) => a.workItemTitle)).toEqual(["GST monthly filing"]);
  });

  it("answers a contact granted nothing with empty lists, having asked anyway", async () => {
    // An empty scope is a real answer and NOT a shortcut. The read still goes
    // all the way to the repository with an empty list, because a version that
    // skipped the call would be indistinguishable from one that leaves
    // `app.portal` unset — which means STAFF, and every read would succeed.
    const { service } = svc();
    await openDocumentAsk(service);
    const centre = await service.actionCentre(TENANT, STRANGER);
    expect(centre.awaitingYou).toEqual([]);
    expect(centre.withTheFirm).toEqual([]);
  });

  it("says 'no such ask' for one belonging to a company it was not granted", async () => {
    // The same sentence as a genuinely missing ask, deliberately: the row is
    // filtered by the policy, so nothing here CAN tell them apart — and a 403
    // would confirm it exists.
    const { service } = svc();
    const other = await service.raise({
      tenantId: TENANT,
      workItemId: WI_LAKEVIEW,
      askKind: "question",
      prompt: "which bank is the loan with",
      documentKind: null,
      actor: staff,
    });
    await expect(
      service.answer({
        tenantId: TENANT,
        userId: MEERA,
        askId: other.ask.id,
        answerText: "HDFC",
        actor: client,
      }),
    ).rejects.toBeInstanceOf(AskNotFound);
  });
});

describe("answering", () => {
  it("moves the ask to answered without closing it", async () => {
    // Shrestha's call. The firm looks at what arrived and decides — a client who
    // sent last quarter's register must not see the ask marked done.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    const row = await service.answer({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      answerText: "We hold none — the Nashik shop closed in 2019.",
      actor: client,
    });
    expect(row.status).toBe("answered");

    const centre = await service.actionCentre(TENANT, MEERA);
    expect(centre.awaitingYou).toEqual([]);
    expect(centre.withTheFirm).toHaveLength(1);
  });

  it("keeps the FIRST reply as the first, however many follow", async () => {
    // "The wrong register on the 3rd and the right one on the 9th" has to keep
    // the 3rd: an ask that restated its answer date on every response would
    // credit the client with a week they did not have, and that number is what
    // a firm reaches for when a filing goes late.
    const { service, store } = svc();
    const ask = await openDocumentAsk(service);
    for (const text of ["sending shortly", "attached now"]) {
      await service.answer({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        answerText: text,
        actor: client,
      });
    }
    const stored = store.asks.find((a) => a.id === ask.ask.id);
    const firstResponse = store.responses.find((r) => r.askId === ask.ask.id);
    expect(store.responses.filter((r) => r.askId === ask.ask.id)).toHaveLength(2);
    expect(stored?.firstAnsweredAt).toBe(firstResponse?.respondedAt);
  });

  it("refuses an answer with no words in it", async () => {
    // It would turn the ask answered and tell the firm nothing, which is worse
    // than leaving it open.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await expect(
      service.answer({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        answerText: "   ",
        actor: client,
      }),
    ).rejects.toBeInstanceOf(AskAnswerEmpty);
  });

  it("answers a DOCUMENT ask in words, on purpose", async () => {
    // "We hold none, the shop closed in 2019" is a real and useful answer to a
    // request for a document. Forcing a file would make the honest answer
    // unsayable.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    const row = await service.answer({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      answerText: "We hold none.",
      actor: client,
    });
    expect(row.responses.at(-1)?.response.responseKind).toBe("answer");
  });

  it("records the answer WITHOUT the client's words", async () => {
    const { service, events } = svc();
    const ask = await openDocumentAsk(service);
    await service.answer({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      answerText: "The Nashik shop closed in 2019.",
      actor: client,
    });
    const event = events.recorded.find((e) => e.verb === "client_ask.answered");
    expect(JSON.stringify(event?.payload)).not.toContain("Nashik");
    expect(event?.payload).toMatchObject({ responseKind: "answer" });
    // The actor is a CLIENT CONTACT — the first verb in the registry whose human
    // actor is routinely somebody outside the firm.
    expect(event?.actorType).toBe("human");
    expect(event?.actorId).toBe(MEERA);
  });
});

describe("a decision is not an answer, and not the firm's own approval", () => {
  it("only answers an approval ask", async () => {
    // A yes on a request for a document would leave a record saying the client
    // agreed to something nobody asked them about.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await expect(
      service.decide({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        decision: "approved",
        note: null,
        actor: client,
      }),
    ).rejects.toBeInstanceOf(AskDecisionNotWanted);
  });

  it("records which way it went, and carries the reason on the row", async () => {
    const { service, events } = svc();
    const ask = await service.raise({
      tenantId: TENANT,
      workItemId: WI_COBALT,
      askKind: "approval",
      prompt: "May we file a nil GSTR-3B for August?",
      documentKind: null,
      actor: staff,
    });
    const row = await service.decide({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      decision: "declined",
      note: "There were two invoices in August, we will send them.",
      actor: client,
    });
    const response = row.responses.at(-1)?.response;
    expect(response?.decision).toBe("declined");
    expect(response?.answerText).toContain("two invoices");

    // WHICH WAY is a machine fact and belongs in the log; the reason is the
    // client's own words about their own affairs and does not.
    const event = events.recorded.find((e) => e.verb === "client_ask.answered");
    expect(event?.payload).toMatchObject({ responseKind: "decision", decision: "declined" });
    expect(JSON.stringify(event?.payload)).not.toContain("two invoices");
  });
});

describe("uploading", () => {
  it("files it under the kind the FIRM chose when it asked", async () => {
    // A client choosing the kind would be a client choosing where in the firm's
    // document store their file lands.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    const row = await service.upload({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      filename: "august-purchases.pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      note: null,
      actor: client,
    });
    expect(row.responses.at(-1)?.document?.filename).toBe("august-purchases.pdf");
  });

  it("writes document.stored as well, so the store's own trail is complete", async () => {
    // "What has this firm taken in, and how big was it" is answered from
    // `document.stored` across every origin. An upload that only wrote
    // `client_ask.answered` would be missing from it.
    const { service, events } = svc();
    const ask = await openDocumentAsk(service);
    await service.upload({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      filename: "august-purchases.pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
      note: null,
      actor: client,
    });
    const stored = events.recorded.find((e) => e.verb === "document.stored");
    expect(stored?.payload).toMatchObject({ origin: "uploaded", kind: "working_paper" });
    expect(JSON.stringify(stored?.payload)).not.toContain("august-purchases");
  });

  it("refuses a zero-byte file before anything is written", async () => {
    // A zero-byte upload is always a failed one, and storing it means the firm
    // sees "register attached" over nothing.
    const { service, store } = svc();
    const ask = await openDocumentAsk(service);
    await expect(
      service.upload({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        filename: "empty.pdf",
        mediaType: "application/pdf",
        bytes: new Uint8Array([]),
        note: null,
        actor: client,
      }),
    ).rejects.toBeInstanceOf(EmptyContent);
    expect(store.responses).toHaveLength(0);
  });
});

describe("closing and withdrawing", () => {
  it("takes the ask off the client's action centre", async () => {
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await service.close({ tenantId: TENANT, askId: ask.ask.id, actor: staff });
    const centre = await service.actionCentre(TENANT, MEERA);
    expect(centre.awaitingYou).toEqual([]);
    expect(centre.withTheFirm).toEqual([]);
  });

  it("refuses a second closure rather than moving the date", async () => {
    // A double-click would move the date somebody is answering questions about.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await service.close({ tenantId: TENANT, askId: ask.ask.id, actor: staff });
    await expect(
      service.close({ tenantId: TENANT, askId: ask.ask.id, actor: staff }),
    ).rejects.toBeInstanceOf(AskAlreadySettled);
  });

  it("keeps withdrawn apart from closed, in the row and in the ledger", async () => {
    // "You sent it" and "never mind" are different answers to a client
    // wondering whether they actually had to do that.
    const { service, events } = svc();
    const ask = await openDocumentAsk(service);
    const record = await service.withdraw({ tenantId: TENANT, askId: ask.ask.id, actor: staff });
    expect(record.ask.status).toBe("withdrawn");
    expect(events.verbs()).toContain("client_ask.withdrawn");
    expect(events.verbs()).not.toContain("client_ask.closed");
  });

  it("refuses a client's answer once the firm has finished with it", async () => {
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await service.close({ tenantId: TENANT, askId: ask.ask.id, actor: staff });
    await expect(
      service.answer({
        tenantId: TENANT,
        userId: MEERA,
        askId: ask.ask.id,
        answerText: "here it is",
        actor: client,
      }),
    ).rejects.toBeInstanceOf(AskNotFound);
  });

  it("still accepts a second answer while the firm has not closed it", async () => {
    // A client who sent the wrong file must be able to send the right one
    // without waiting for the firm to say so — which is why `answered` stays
    // actionable and only `closed` does not.
    const { service } = svc();
    const ask = await openDocumentAsk(service);
    await service.answer({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      answerText: "wrong one, sorry",
      actor: client,
    });
    const row = await service.answer({
      tenantId: TENANT,
      userId: MEERA,
      askId: ask.ask.id,
      answerText: "this is the right one",
      actor: client,
    });
    expect(row.responses).toHaveLength(2);
  });
});
