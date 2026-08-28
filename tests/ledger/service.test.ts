// The event contract, as tests. Each block below corresponds to a rule stated
// in docs/EVENT-CONTRACT.md — if a rule is worth writing down, breaking it is
// worth a red build.
import { describe, expect, it } from "vitest";
import { LedgerService, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT } from "../../src/usecase/ledger/service";
import { makeLedgerFakes } from "../../src/testfakes/ledger";
import type { FakeEventStore } from "../../src/testfakes/ledger";
import {
  EVENT_VERBS,
  SYSTEM_ACTOR,
  isWellFormedVerb,
  objectTypeFor,
} from "../../src/domain/ledger/model";
import type { EventVerb } from "../../src/domain/ledger/model";
import {
  InvalidActor,
  InvalidObjectId,
  InvalidOccurredAt,
  InvalidTenantId,
  PayloadContainsPii,
  PayloadNotSerialisable,
  PayloadTooDeep,
  PayloadTooLarge,
  UnknownVerb,
} from "../../src/domain/ledger/errors";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const OBJECT = "33333333-3333-3333-3333-333333333333";
const USER = "44444444-4444-4444-4444-444444444444";

function svc(): { service: LedgerService; store: FakeEventStore } {
  const fakes = makeLedgerFakes();
  return { service: new LedgerService(fakes), store: fakes.events as FakeEventStore };
}

const human = { type: "human", id: USER } as const;

describe("the verb registry", () => {
  it("every registered verb follows the naming convention", () => {
    for (const verb of Object.keys(EVENT_VERBS)) {
      expect(isWellFormedVerb(verb), `${verb} is not <subject>.<past_tense>`).toBe(true);
    }
  });

  it("every registered verb names a snake_case object type", () => {
    for (const [verb, spec] of Object.entries(EVENT_VERBS)) {
      expect(spec.objectType, `${verb} has no object type`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("covers both lanes — the two lanes meet here", () => {
    const lanes = new Set(Object.values(EVENT_VERBS).map((s) => s.lane));
    expect(lanes).toEqual(new Set(["platform", "commercial", "delivery"]));
  });
});

describe("recordEvent", () => {
  it("records an event, deriving object_type from the verb", async () => {
    const { service } = svc();
    const e = await service.recordEvent({
      tenantId: TENANT,
      verb: "party.created",
      objectId: OBJECT,
      actor: human,
      payload: { kind: "organization" },
    });
    expect(e.verb).toBe("party.created");
    // The caller never passed an object type; it cannot disagree with the verb.
    expect(e.objectType).toBe(objectTypeFor("party.created"));
    expect(e.actorType).toBe("human");
    expect(e.actorId).toBe(USER);
    expect(e.payload).toEqual({ kind: "organization" });
  });

  it("defaults the payload to an empty object", async () => {
    const { service } = svc();
    const e = await service.recordEvent({
      tenantId: TENANT,
      verb: "session.started",
      objectId: OBJECT,
      actor: human,
    });
    expect(e.payload).toEqual({});
  });

  it("accepts the system actor with no id", async () => {
    const { service } = svc();
    const e = await service.recordEvent({
      tenantId: TENANT,
      verb: "obligation.spawned",
      objectId: OBJECT,
      actor: SYSTEM_ACTOR,
    });
    expect(e.actorType).toBe("system");
    expect(e.actorId).toBeNull();
  });

  it("refuses an unregistered verb, naming the near misses", async () => {
    const { service } = svc();
    // Cast: the type says only registry verbs are possible, but types are erased
    // and this value routinely arrives from parsed JSON — the check is the point.
    const bad = "party.creted" as EventVerb;
    const err = await service
      .recordEvent({ tenantId: TENANT, verb: bad, objectId: OBJECT, actor: human })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownVerb);
    expect((err as Error).message).toContain("party.created");
  });

  it("refuses a human actor with no id — an event must name who acted", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({
        tenantId: TENANT,
        verb: "party.created",
        objectId: OBJECT,
        actor: { type: "human", id: null },
      }),
    ).rejects.toBeInstanceOf(InvalidActor);
  });

  it("refuses a system actor that carries an id", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({
        tenantId: TENANT,
        verb: "party.created",
        objectId: OBJECT,
        actor: { type: "system", id: USER },
      }),
    ).rejects.toBeInstanceOf(InvalidActor);
  });

  it("refuses a non-uuid tenant or object", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({ tenantId: "acme", verb: "party.created", objectId: OBJECT, actor: human }),
    ).rejects.toBeInstanceOf(InvalidTenantId);
    await expect(
      service.recordEvent({ tenantId: TENANT, verb: "party.created", objectId: "42", actor: human }),
    ).rejects.toBeInstanceOf(InvalidObjectId);
  });

  it("accepts a business time in the past but refuses one without an offset", async () => {
    const { service } = svc();
    const e = await service.recordEvent({
      tenantId: TENANT,
      verb: "obligation.filed",
      objectId: OBJECT,
      actor: SYSTEM_ACTOR,
      occurredAt: "2026-03-31T18:30:00Z",
    });
    expect(e.occurredAt).toBe("2026-03-31T18:30:00Z");
    await expect(
      service.recordEvent({
        tenantId: TENANT,
        verb: "obligation.filed",
        objectId: OBJECT,
        actor: SYSTEM_ACTOR,
        occurredAt: "2026-03-31 18:30:00",
      }),
    ).rejects.toBeInstanceOf(InvalidOccurredAt);
  });
});

describe("the payload carries no personal data", () => {
  const base = { tenantId: TENANT, verb: "party.created" as const, objectId: OBJECT, actor: human };

  it("rejects a personal-data key at the top level", async () => {
    const { service } = svc();
    const err = await service
      .recordEvent({ ...base, payload: { email: "priya@example.com" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadContainsPii);
    expect((err as Error).message).toContain("email");
  });

  it("rejects one buried in a nested object or an array — depth is not a loophole", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({ ...base, payload: { contact: { phone: "+91 98765 43210" } } }),
    ).rejects.toBeInstanceOf(PayloadContainsPii);
    await expect(
      service.recordEvent({ ...base, payload: { directors: [{ pan: "ABCDE1234F" }] } }),
    ).rejects.toBeInstanceOf(PayloadContainsPii);
  });

  it("rejects one spelled in camelCase", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({ ...base, payload: { dateOfBirth: "1980-01-01" } }),
    ).rejects.toBeInstanceOf(PayloadContainsPii);
  });

  it("allows business facts — a company's legal name and GSTIN are not personal data", async () => {
    const { service } = svc();
    const e = await service.recordEvent({
      ...base,
      payload: { legalName: "Harbour Point Advisory Private Limited", gstin: "27AAECH1234K1Z5" },
    });
    expect(e.payload["gstin"]).toBe("27AAECH1234K1Z5");
  });

  it("rejects a payload too deep to scan, rather than scanning half of it", async () => {
    const { service } = svc();
    let deep: Record<string, unknown> = { email: "hidden@example.com" };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    await expect(service.recordEvent({ ...base, payload: deep })).rejects.toBeInstanceOf(
      PayloadTooDeep,
    );
  });

  it("rejects an oversized payload", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({ ...base, payload: { blob: "x".repeat(70_000) } }),
    ).rejects.toBeInstanceOf(PayloadTooLarge);
  });

  it("rejects a payload that cannot be encoded as JSON", async () => {
    const { service } = svc();
    await expect(
      service.recordEvent({ ...base, payload: { amount: 10n } }),
    ).rejects.toBeInstanceOf(PayloadNotSerialisable);
  });

  it("a cyclic payload is caught by the depth check, not by a stack overflow", async () => {
    const { service } = svc();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await expect(service.recordEvent({ ...base, payload: cyclic })).rejects.toBeInstanceOf(
      PayloadTooDeep,
    );
  });
});

describe("idempotency", () => {
  it("a replayed idempotency key re-lands on the same event", async () => {
    const { service, store } = svc();
    const input = {
      tenantId: TENANT,
      verb: "payment.recorded" as const,
      objectId: OBJECT,
      actor: SYSTEM_ACTOR,
      idempotencyKey: `${TENANT}:razorpay:pay_29QQoUBi66xm2f`,
    };
    const first = await service.recordEvent(input);
    const replay = await service.recordEvent(input);
    expect(replay.id).toBe(first.id);
    expect(store.rows).toHaveLength(1);
  });

  it("without a key, two identical calls are two distinct events", async () => {
    const { service, store } = svc();
    const input = {
      tenantId: TENANT,
      verb: "proposal.viewed" as const,
      objectId: OBJECT,
      actor: SYSTEM_ACTOR,
    };
    await service.recordEvent(input);
    await service.recordEvent(input);
    expect(store.rows).toHaveLength(2);
  });
});

describe("reads", () => {
  it("the tenant timeline is newest first and never crosses a tenant", async () => {
    const { service } = svc();
    await service.recordEvent({ tenantId: TENANT, verb: "party.created", objectId: OBJECT, actor: human });
    await service.recordEvent({ tenantId: TENANT, verb: "party_identifier.added", objectId: OBJECT, actor: human });
    await service.recordEvent({ tenantId: OTHER_TENANT, verb: "party.created", objectId: OBJECT, actor: human });

    const timeline = await service.recent(TENANT);
    expect(timeline.map((r) => r.event.verb)).toEqual(["party_identifier.added", "party.created"]);
    expect(timeline.every((r) => r.event.tenantId === TENANT)).toBe(true);
  });

  it("clamps the limit to the ceiling and falls back to the default", async () => {
    const { service, store } = svc();
    for (let i = 0; i < 3; i += 1) {
      await service.recordEvent({ tenantId: TENANT, verb: "job.spawned", objectId: OBJECT, actor: SYSTEM_ACTOR });
    }
    expect(await service.recent(TENANT, 1)).toHaveLength(1);
    expect(await service.recent(TENANT, 10_000)).toHaveLength(store.rows.length);
    expect(MAX_TIMELINE_LIMIT).toBeGreaterThan(DEFAULT_TIMELINE_LIMIT);
  });

  it("the object timeline returns only that object's history", async () => {
    const { service } = svc();
    const other = "55555555-5555-5555-5555-555555555555";
    await service.recordEvent({ tenantId: TENANT, verb: "invoice.issued", objectId: OBJECT, actor: human });
    await service.recordEvent({ tenantId: TENANT, verb: "dunning.escalated", objectId: OBJECT, actor: SYSTEM_ACTOR });
    await service.recordEvent({ tenantId: TENANT, verb: "invoice.issued", objectId: other, actor: human });

    const history = await service.forObject(TENANT, "invoice", OBJECT);
    expect(history).toHaveLength(2);
    expect(history.every((r) => r.event.objectId === OBJECT)).toBe(true);
  });

  it("names the person who acted, and leaves the system unnamed", async () => {
    // The stored row keeps only an actor id — personal data must stay out of a
    // log erasure cannot mutate. The NAME is joined at read time, so an erased
    // account stops resolving and the event survives. Null is therefore a real
    // answer, not a gap: the system and agent actors have no account either.
    const { service, store } = svc();
    store.accounts.set(human.id ?? "", { displayName: "Priya Menon", email: "priya@firm.test" });
    await service.recordEvent({ tenantId: TENANT, verb: "party.created", objectId: OBJECT, actor: human });
    await service.recordEvent({ tenantId: TENANT, verb: "job.spawned", objectId: OBJECT, actor: SYSTEM_ACTOR });

    const timeline = await service.recent(TENANT);
    const byVerb = new Map(timeline.map((r) => [r.event.verb, r]));
    expect(byVerb.get("party.created")?.actor?.displayName).toBe("Priya Menon");
    expect(byVerb.get("job.spawned")?.actor).toBeNull();
  });

  it("an unresolvable actor reads as null rather than as a uuid", async () => {
    // An account erased under a data-protection request. The event must
    // survive it; the name simply stops resolving.
    const { service } = svc();
    await service.recordEvent({ tenantId: TENANT, verb: "party.created", objectId: OBJECT, actor: human });
    const [record] = await service.recent(TENANT);
    expect(record?.event.actorId).toBe(human.id);
    expect(record?.actor).toBeNull();
  });

  it("an object with no history reads as empty, not as an error", async () => {
    const { service } = svc();
    expect(await service.forObject(TENANT, "invoice", OBJECT)).toEqual([]);
  });
});
