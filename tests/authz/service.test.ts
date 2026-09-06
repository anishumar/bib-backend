// Gate 3 and the fee axis, at the use-case level. The route-level half lives in
// tests/api/auth-coverage.test.ts; this is the policy itself.
//
// Since T2.5 the permission source is the firm's OWN configuration registry, so
// these run against a registry seeded exactly the way createTenant seeds a real
// one. That is the point of the swap: the service under test did not change,
// and neither did this file's expectations of it.
import { describe, expect, it } from "vitest";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";
import { FakeConfigRepo } from "../../src/testfakes/config";
import { NotPermitted, UnknownRole } from "../../src/domain/authz/errors";
import { DEFAULT_ROLES, redactCommercials } from "../../src/domain/authz/model";
import type { Principal } from "../../src/platform/callctx";

const TENANT = "00000000-0000-4000-8000-000000000003";
const authz = new AuthzService({ permissions: withDefaultRoles(TENANT) });

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    tenantId: TENANT,
    audience: "STAFF",
    role: "partner",
    commercialVisibility: true,
    ...over,
  };
}

describe("the roles a firm starts with", () => {
  it("gives a partner everything the product defines", () => {
    expect(DEFAULT_ROLES["partner"]?.permissions).toContain("tenant:admin");
    expect(DEFAULT_ROLES["partner"]?.permissions).toContain("ledger:read");
  });

  it("does not give an associate the firm's whole audit trail", () => {
    // It names every client the firm has, which is more than doing the work
    // requires. The catalogue, on the other hand, is exactly what an associate
    // building a proposal needs.
    expect(DEFAULT_ROLES["associate"]?.permissions).not.toContain("ledger:read");
    expect(DEFAULT_ROLES["associate"]?.permissions).toContain("party:write");
    expect(DEFAULT_ROLES["associate"]?.permissions).toContain("config:read");
  });

  it("gives the portal roles nothing on the staff surface", () => {
    // The audience gate already refuses them; this is the second, independent
    // answer, so neither gate is load-bearing alone. Since T6.6 the second
    // answer is stronger than "an empty list": these roles DECLARE their
    // audience, so a staff permission on one of them would grant nothing even
    // if a firm added it.
    for (const key of ["client_contact", "client_viewer"]) {
      const role = DEFAULT_ROLES[key];
      expect(role?.audience, `${key} must be written for the portal`).toBe("CLIENT_PORTAL");
      for (const permission of role?.permissions ?? []) {
        // The two portal permissions, and nothing else may join them without
        // somebody deciding to: everything a portal role carries has to be
        // meaningless inside the firm, or `roleServes` is doing the work alone.
        expect(
          ["portal:respond", "portal:request"],
          `${key} must hold nothing that works inside the firm`,
        ).toContain(permission);
      }
    }
  });

  it("separates the contact who may act from the one who may only look", () => {
    // The board's own line for T6.6, asserted rather than left to a comment.
    // `client_viewer` holding NOTHING is not an oversight: reading is authorised
    // by the grant (`crm.portal_access`), never by a permission, so a contact
    // with no permissions still sees their company's whole portal and simply
    // cannot answer anything on it.
    // T6.8 added the second one, and it is a SEPARATE authority rather than a
    // widening: `portal:respond` answers what the firm asked, `portal:request`
    // starts something the firm must act on. A firm may give the first and
    // withhold the second — the registers clerk who sends files and does not
    // open requests — which is the whole reason there are two.
    expect(DEFAULT_ROLES["client_contact"]?.permissions).toEqual([
      "portal:respond",
      "portal:request",
    ]);
    expect(DEFAULT_ROLES["client_viewer"]?.permissions).toEqual([]);
  });

  it("gives every staff role no portal permission, and declares no audience", () => {
    // The other direction, which is the one that is easy to forget: an audience
    // is absent on a staff role rather than written as "STAFF", so a firm's
    // existing role bodies — frozen, published before T6.6 — stay byte-for-byte
    // what they were and the upgrade migrations can still recognise them.
    for (const key of ["partner", "manager", "associate"]) {
      expect(DEFAULT_ROLES[key]?.audience, `${key} declares no audience`).toBeUndefined();
      expect(DEFAULT_ROLES[key]?.permissions).not.toContain("portal:respond");
    }
  });

  it("keeps the right to CHANGE configuration to the administrator", () => {
    // Whoever may publish a role version may grant themselves anything, so the
    // write side of the registry is tenant:admin and not a permission of its
    // own. Reading the catalogue is a different, ordinary thing.
    for (const [role, definition] of Object.entries(DEFAULT_ROLES)) {
      if (role === "partner") continue;
      expect(definition.permissions, `${role} must not administer the firm`).not.toContain(
        "tenant:admin",
      );
    }
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

  it("throws UnknownRole for a role the FIRM does not define", async () => {
    // Distinct from NotPermitted on purpose: this is a misconfigured
    // membership, not policy working as intended, and an operator reading the
    // log needs to tell those apart.
    const err = await authz
      .require(principal({ role: "rm" }), "party:read")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRole);
    // The roles this firm actually has are what helps somebody locked out by a
    // typo — and they are on the ERROR rather than in the message, because the
    // message is sent to the caller verbatim and a refusal must not enumerate
    // the firm's role vocabulary to whoever provoked it.
    expect((err as UnknownRole).definedRoles).toContain("partner");
    expect((err as Error).message).not.toContain("partner");
  });

  it("says so differently when the firm has NO roles at all", async () => {
    // A tenant whose registry was never seeded is not a typo — it is a firm
    // where every single person is locked out, and correcting role names will
    // not fix it. Both are UNKNOWN_ROLE; the message has to separate them.
    const empty = new AuthzService({ permissions: new FakeConfigRepo() });
    const err = await empty
      .require(principal({ role: "partner" }), "party:read")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRole);
    expect((err as Error).message).toContain("no role configuration at all");
  });

  it("refuses a principal that has not chosen an org", async () => {
    await expect(
      authz.require(principal({ tenantId: null, role: null }), "party:read"),
    ).rejects.toBeInstanceOf(UnknownRole);
  });

  it("does not answer one firm's question with another firm's roles", async () => {
    // The registry is tenant-scoped. A session for a tenant that has no rows
    // must not inherit the roles of the tenant that does.
    const other = "00000000-0000-4000-8000-0000000000ff";
    expect(await authz.can(principal({ tenantId: other }), "party:read")).toBe(false);
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
