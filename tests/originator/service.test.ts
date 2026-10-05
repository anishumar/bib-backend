// Who won the work of a letter (0355, Q049), against fakes. The SQL half (the
// default read off the deal, the wall) is in
// tests/dashboard/revenue-report.integration.test.ts.
import { describe, expect, it } from "vitest";
import { OriginatorService } from "../../src/usecase/originator/service";
import { FakeOriginatorStore } from "../../src/testfakes/originator";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const FIRM = "00000000-0000-4000-8000-00000000d001";
const LETTER = "00000000-0000-4000-8000-00000000d002";
const LEAD_OWNER = "00000000-0000-4000-8000-00000000d003";
const SELLER = "00000000-0000-4000-8000-00000000d004";
const PARTNER = "00000000-0000-4000-8000-00000000d005";
const STRANGER = "00000000-0000-4000-8000-00000000d006";

function world() {
  const store = new FakeOriginatorStore();
  store.letters.set(LETTER, { tenantId: FIRM, ref: "EL-2026-0001", dealUserId: LEAD_OWNER, dealHow: "lead_owner" });
  for (const [id, name] of [
    [LEAD_OWNER, "Leela Owner"],
    [SELLER, "Sunil Seller"],
    [PARTNER, "Pat Partner"],
  ] as const) {
    store.staff.add(id);
    store.names.set(id, name);
  }
  const events = new RecordingEventSink();
  return { store, events, service: new OriginatorService({ store, events }) };
}

describe("the letter's originator (Q049)", () => {
  it("is read off the deal until somebody says otherwise", async () => {
    const w = world();
    expect(await w.service.get(FIRM, LETTER)).toMatchObject({ userId: LEAD_OWNER, how: "lead_owner", name: "Leela Owner" });
    expect(w.events.recorded).toHaveLength(0);
  });

  it("a partner sets it, and the ledger says who it was before", async () => {
    const w = world();
    const out = await w.service.set({ tenantId: FIRM, letterId: LETTER, userId: SELLER }, { type: "human", id: PARTNER });
    expect(out).toMatchObject({ userId: SELLER, how: "set", setBy: { userId: PARTNER } });
    const [event] = w.events.recorded;
    expect(event?.verb).toBe("engagement_letter.originator_set");
    expect(event?.payload).toEqual({ originatorUserId: SELLER, previousOriginatorUserId: LEAD_OWNER, previousHow: "lead_owner" });
  });

  it("may say nobody won it (a renewal)", async () => {
    const w = world();
    const out = await w.service.set({ tenantId: FIRM, letterId: LETTER, userId: null }, { type: "human", id: PARTNER });
    expect(out).toMatchObject({ userId: null, how: "set" });
  });

  it("setting the same person again records nothing", async () => {
    const w = world();
    await w.service.set({ tenantId: FIRM, letterId: LETTER, userId: SELLER }, { type: "human", id: PARTNER });
    await w.service.set({ tenantId: FIRM, letterId: LETTER, userId: SELLER }, { type: "human", id: PARTNER });
    expect(w.events.recorded).toHaveLength(1);
  });

  it("refuses somebody who is not active staff here, in words", async () => {
    const w = world();
    await expect(
      w.service.set({ tenantId: FIRM, letterId: LETTER, userId: STRANGER }, { type: "human", id: PARTNER }),
    ).rejects.toMatchObject({ code: "ORIGINATOR_NOT_STAFF" });
    expect(w.events.recorded).toHaveLength(0);
  });

  it("refuses a letter deleted as a mistake, and one that is not this firm's", async () => {
    const w = world();
    w.store.letters.set(LETTER, { tenantId: FIRM, ref: "EL-2026-0001", deleted: true, dealUserId: null, dealHow: "none" });
    await expect(
      w.service.set({ tenantId: FIRM, letterId: LETTER, userId: SELLER }, { type: "human", id: PARTNER }),
    ).rejects.toMatchObject({ code: "LETTER_DELETED" });
    await expect(w.service.get("00000000-0000-4000-8000-00000000d0ff", LETTER)).rejects.toMatchObject({
      code: "LETTER_NOT_FOUND",
    });
  });
});
