// FinCompliance's per-firm switch (0381): a PLATFORM act through /internal,
// idempotent, recorded, and never moving the cut it already made.
import { describe, expect, it } from "vitest";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { TenantNotFound } from "../../src/domain/tenancy/errors";
import { makeFakes } from "../../src/testfakes/tenancy";

const platform = "local-dev";

async function firm() {
  const f = makeFakes();
  const service = new TenancyService(f);
  const tenant = await service.createTenant({ name: "Fin Sandbox", slug: "fin-sandbox", reportingCurrency: "SGD" });
  return { service, f, tenantId: tenant.id };
}

function finVerbs(verbs: readonly string[]): string[] {
  return verbs.filter((v) => v.startsWith("tenant.fin_"));
}

describe("switching fin on and off for a firm", () => {
  it("starts off", async () => {
    const { f, tenantId } = await firm();
    expect(await f.tenants.finEnabledSince(tenantId)).toBeNull();
  });

  it("switches on with a cut, and records who did it", async () => {
    const { service, f, tenantId } = await firm();
    const on = await service.setFinEnabled(tenantId, true, platform);
    expect(on.finEnabledSince).not.toBeNull();
    const event = f.events.recorded.find((e) => e.verb === "tenant.fin_enabled");
    // The ledger takes a system actor only with a null id, so the caller is
    // named in the payload instead.
    expect(event).toMatchObject({ actorType: "system", actorId: null, payload: { since: on.finEnabledSince, by: "local-dev" } });
  });

  it("switching on twice records nothing and keeps the first cut", async () => {
    const { service, f, tenantId } = await firm();
    const first = await service.setFinEnabled(tenantId, true, platform);
    const again = await service.setFinEnabled(tenantId, true, platform);
    expect(again.finEnabledSince).toBe(first.finEnabledSince);
    expect(finVerbs(f.events.verbs())).toEqual(["tenant.fin_enabled"]);
  });

  it("switches off, saying when it had been on", async () => {
    const { service, f, tenantId } = await firm();
    const on = await service.setFinEnabled(tenantId, true, platform);
    const off = await service.setFinEnabled(tenantId, false, platform);
    expect(off.finEnabledSince).toBeNull();
    expect(f.events.recorded.find((e) => e.verb === "tenant.fin_disabled")?.payload).toEqual({ wasSince: on.finEnabledSince, by: "local-dev" });
    await service.setFinEnabled(tenantId, false, platform);
    expect(finVerbs(f.events.verbs())).toEqual(["tenant.fin_enabled", "tenant.fin_disabled"]);
  });

  it("refuses a firm that does not exist", async () => {
    const { service } = await firm();
    await expect(service.setFinEnabled("00000000-0000-4000-8000-00000000dead", true, platform)).rejects.toBeInstanceOf(TenantNotFound);
  });
});
