// The firm's client-mail setting (Q059, 0350).
import { describe, expect, it } from "vitest";
import { ClientMailService } from "../../src/usecase/clientmail/service";
import { InvalidSendDomain } from "../../src/domain/tenancy/errors";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { Actor } from "../../src/domain/ledger/model";

const FIRM = "f1f1f1f1-0000-4000-8000-000000000001";
const ME: Actor = { type: "human", id: "a1a1a1a1-0000-4000-8000-000000000001" };

function world() {
  const stored = new Map<string, readonly string[]>();
  const events = new RecordingEventSink();
  const service = new ClientMailService({
    store: {
      sendFromDomains: (t) => Promise.resolve(stored.get(t) ?? []),
      setSendFromDomains: (t, d) => {
        stored.set(t, d);
        return Promise.resolve();
      },
    },
    events,
  });
  return { stored, events, service };
}

describe("the domains a firm's client mail may be sent from", () => {
  it("starts empty", async () => {
    expect(await world().service.sendFromDomains(FIRM)).toEqual([]);
  });

  it("saves the list cleaned, sorted and without repeats, recording both sides", async () => {
    const w = world();
    const saved = await w.service.setSendFromDomains(FIRM, [" 10XGlobal.in", "@ca-firm.co.uk", "10xglobal.in", ""], ME);
    expect(saved).toEqual(["10xglobal.in", "ca-firm.co.uk"]);
    expect(w.stored.get(FIRM)).toEqual(["10xglobal.in", "ca-firm.co.uk"]);
    expect(w.events.recorded).toHaveLength(1);
    expect(w.events.recorded[0]).toMatchObject({
      verb: "tenant.send_domains_set",
      payload: { from: [], to: ["10xglobal.in", "ca-firm.co.uk"] },
    });
  });

  it("records nothing when nothing changed", async () => {
    const w = world();
    await w.service.setSendFromDomains(FIRM, ["10xglobal.in"], ME);
    await w.service.setSendFromDomains(FIRM, ["10XGLOBAL.IN"], ME);
    expect(w.events.recorded).toHaveLength(1);
  });

  it("refuses an address, a non-domain, or more than twenty, and saves nothing", async () => {
    for (const bad of [["priya@10xglobal.in"], ["not a domain"], Array.from({ length: 21 }, (_, i) => `d${String(i)}.in`)]) {
      const w = world();
      await expect(w.service.setSendFromDomains(FIRM, bad, ME)).rejects.toBeInstanceOf(InvalidSendDomain);
      expect(w.stored.size).toBe(0);
      expect(w.events.recorded).toEqual([]);
    }
  });
});
