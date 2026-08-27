// Gate 3 and the fee axis, at the use-case level. The route-level half lives in
// tests/api/auth-coverage.test.ts; this is the policy itself.
import { describe, expect, it } from "vitest";
import { AuthzService } from "../../src/usecase/authz/service";
import { StaticPermissionSource } from "../../src/infrastructure/authz/static-permissions";
import { NotPermitted, UnknownRole } from "../../src/domain/authz/errors";
import { DEFAULT_ROLE_PERMISSIONS, redactCommercials } from "../../src/domain/authz/model";
import type { Principal } from "../../src/platform/callctx";

const authz = new AuthzService({ permissions: new StaticPermissionSource() });

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    tenantId: "00000000-0000-4000-8000-000000000003",
    audience: "STAFF",
    role: "partner",
    commercialVisibility: true,
    ...over,
  };
}

describe("the seeded role matrix", () => {
  it("gives a partner everything the product defines", () => {
    expect(DEFAULT_ROLE_PERMISSIONS["partner"]).toContain("tenant:admin");
    expect(DEFAULT_ROLE_PERMISSIONS["partner"]).toContain("ledger:read");
  });

  it("does not give an associate the firm's whole audit trail", () => {
    // It names every client the firm has, which is more than doing the work
    // requires.
    expect(DEFAULT_ROLE_PERMISSIONS["associate"]).not.toContain("ledger:read");
    expect(DEFAULT_ROLE_PERMISSIONS["associate"]).toContain("party:write");
  });

  it("gives a client contact nothing on the staff surface", () => {
    // The audience gate already refuses them; this is the second, independent
    // answer, so neither gate is load-bearing alone.
    expect(DEFAULT_ROLE_PERMISSIONS["client_contact"]).toEqual([]);
  });
});

describe("require", () => {
  it("passes when the role carries the permission", async () => {
    await expect(authz.require(principal({ role: "manager" }), "party:write")).resolves
      .toBeUndefined();
  });

  it("throws NotPermitted when it does not", async () => {
    await expect(
      authz.require(principal({ role: "associate" }), "ledger:read"),
    ).rejects.toBeInstanceOf(NotPermitted);
  });

  it("throws UnknownRole for a role the product does not define", async () => {
    // Distinct from NotPermitted on purpose: this is a misconfigured
    // membership, not policy working as intended, and an operator reading the
    // log needs to tell those apart.
    const err = await authz
      .require(principal({ role: "rm" }), "party:read")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRole);
    expect((err as Error).message).toContain("partner");
  });

  it("refuses a principal that has not chosen an org", async () => {
    await expect(
      authz.require(principal({ tenantId: null, role: null }), "party:read"),
    ).rejects.toBeInstanceOf(UnknownRole);
  });
});

describe("the fee axis is orthogonal to the role", () => {
  it("is read from the membership flag, not from seniority", () => {
    // A firm can hand fee visibility to one associate without promoting them.
    expect(authz.seesFees(principal({ role: "associate", commercialVisibility: true }))).toBe(true);
    // And withhold it from a manager who does not need it.
    expect(authz.seesFees(principal({ role: "manager", commercialVisibility: false }))).toBe(false);
  });

  it("does not follow from any permission", async () => {
    // The moment fee visibility is derivable from a role, "senior_associate_
    // who_sees_fees" is a role someone adds, and seniority gets written twice.
    const feeBlindPartner = principal({ role: "partner", commercialVisibility: false });
    expect(await authz.can(feeBlindPartner, "tenant:admin")).toBe(true);
    expect(authz.seesFees(feeBlindPartner)).toBe(false);
  });

  it("defaults closed when the flag is absent", () => {
    expect(authz.seesFees(principal({ commercialVisibility: null }))).toBe(false);
  });
});

describe("fee redaction", () => {
  // T1.6's acceptance names a work item, which is T3.1 — so the mechanism is
  // proven here against a representative fee-bearing record, and applied to the
  // real one when it exists. The shape is the point: same record, same fields,
  // money nulled.
  const workItem = {
    id: "wi-1",
    title: "GSTR-3B — March",
    clientId: "party-1",
    dueOn: "2026-04-20",
    status: "in_progress",
    feeAmount: "25000.00",
    feeCurrency: "INR",
  };
  const COMMERCIAL = ["feeAmount", "feeCurrency"] as const;

  it("shows the work and hides the money from a delivery role", () => {
    const delivery = principal({ role: "associate", commercialVisibility: false });
    const seen = authz.withFeeVisibility(delivery, workItem, COMMERCIAL);

    // The acceptance, exactly: sees the work item, not its fee.
    expect(seen["title"]).toBe("GSTR-3B — March");
    expect(seen["dueOn"]).toBe("2026-04-20");
    expect(seen["status"]).toBe("in_progress");
    expect(seen["feeAmount"]).toBeNull();
    expect(seen["feeCurrency"]).toBeNull();
  });

  it("shows everything to a principal with commercial visibility", () => {
    const seen = authz.withFeeVisibility(principal(), workItem, COMMERCIAL);
    expect(seen["feeAmount"]).toBe("25000.00");
  });

  it("redacts rather than omits, so the field's absence is not the signal", () => {
    // Dropping the key entirely makes "you may not see this" look identical to
    // "this record has no fee", and a client acts on those differently.
    const seen = authz.withFeeVisibility(
      principal({ commercialVisibility: false }),
      workItem,
      COMMERCIAL,
    );
    expect("feeAmount" in seen).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(Object.keys(workItem).sort());
  });

  it("does not mutate the record it was given", () => {
    authz.withFeeVisibility(principal({ commercialVisibility: false }), workItem, COMMERCIAL);
    expect(workItem.feeAmount).toBe("25000.00");
  });

  it("ignores a named field the record does not have", () => {
    expect(redactCommercials({ a: 1 }, ["a", "missing"] as never[], false)).toEqual({ a: null });
  });
});
