// T6.18 · D5 — standard prose per issuing company, inheriting a default.
//
// The rule, per KIND: when the company issuing a document has any ACTIVE line
// of a kind, its own lines are the document's set of that kind; otherwise the
// firm's default (null-company) lines are. The country filter then applies
// inside whichever set was chosen. Every branch of `blocksFor` is here, then
// the service's refusals and the two seeding paths. The real seeding path runs
// against Postgres in tests/proposal/entity-prose.integration.test.ts.
import { describe, expect, it } from "vitest";
import { blocksFor } from "../../src/domain/document/model";
import type { StandardBlock } from "../../src/domain/document/model";
import { DocumentService } from "../../src/usecase/document/service";
import { makeDocumentFakes } from "../../src/testfakes/document";
import { FirmEntityNotFound, NotAFirmEntity } from "../../src/domain/document/errors";
import { makeProposalFakes } from "../../src/testfakes/proposal";
import { ProposalService } from "../../src/usecase/proposal/service";
import { makeEngagementFakes } from "../../src/testfakes/engagement";
import { EngagementService } from "../../src/usecase/engagement/service";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };
const PARTY = "00000000-0000-0000-0000-0000000000bb";
const UAE = "00000000-0000-0000-0000-0000000000e3";
const US = "00000000-0000-0000-0000-0000000000e4";
const CLIENT_CO = "00000000-0000-0000-0000-0000000000e9";

let n = 0;
const line = (over: Partial<StandardBlock>): StandardBlock => {
  n += 1;
  return {
    id: `b${String(n).padStart(3, "0")}`,
    tenantId: TENANT,
    kind: "exclusion",
    body: `line ${String(n)}`,
    isHeading: false,
    sortOrder: n,
    jurisdiction: null,
    issuingEntityPartyId: null,
    isActive: true,
    ...over,
  };
};

describe("blocksFor, per company (T6.18, D5)", () => {
  const defaultExclusion = line({ kind: "exclusion", body: "default exclusion" });
  const defaultCommercial = line({ kind: "commercial", body: "default commercial" });
  const uaeExclusion = line({ kind: "exclusion", body: "UAE exclusion", issuingEntityPartyId: UAE });
  const usCommercial = line({ kind: "commercial", body: "US commercial", issuingEntityPartyId: US });
  const all = [defaultExclusion, defaultCommercial, uaeExclusion, usCommercial];
  const bodies = (rows: readonly StandardBlock[]) => rows.map((b) => b.body);

  it("no company named reads the default set alone", () => {
    expect(bodies(blocksFor(all, "AE", "proposal"))).toEqual(["default exclusion", "default commercial"]);
    expect(bodies(blocksFor(all, "AE", "proposal", null))).toEqual(["default exclusion", "default commercial"]);
  });

  it("a company with its own lines of a kind gets those, and the default for the kinds it has none of", () => {
    expect(bodies(blocksFor(all, "AE", "proposal", UAE))).toEqual(["UAE exclusion", "default commercial"]);
    expect(bodies(blocksFor(all, "US", "proposal", US))).toEqual(["default exclusion", "US commercial"]);
  });

  it("never copies another company's lines", () => {
    const sg = "00000000-0000-0000-0000-0000000000e5";
    expect(bodies(blocksFor(all, "SG", "proposal", sg))).toEqual(["default exclusion", "default commercial"]);
  });

  it("a company whose own lines of a kind are all retired falls back to the default", () => {
    const retired = line({ kind: "exclusion", body: "retired UAE", issuingEntityPartyId: UAE, isActive: false });
    expect(bodies(blocksFor([defaultExclusion, retired], "AE", "proposal", UAE))).toEqual(["default exclusion"]);
  });

  it("applies the country filter INSIDE the company's own set", () => {
    const vat = line({ kind: "commercial", body: "UAE VAT", issuingEntityPartyId: UAE, jurisdiction: "AE" });
    const always = line({ kind: "commercial", body: "UAE always", issuingEntityPartyId: UAE });
    const rows = [defaultCommercial, vat, always];
    expect(bodies(blocksFor(rows, "AE", "proposal", UAE))).toEqual(["UAE VAT", "UAE always"]);
    // Written for another country: the company's own set is still chosen, and
    // the scoped line stays off — the default does not come back for it.
    expect(bodies(blocksFor(rows, "IN", "proposal", UAE))).toEqual(["UAE always"]);
  });

  it("keeps a letter's cover and acceptance off a proposal, whoever issues it", () => {
    const cover = line({ kind: "cover", body: "UAE cover", issuingEntityPartyId: UAE });
    expect(bodies(blocksFor([cover], "AE", "proposal", UAE))).toEqual([]);
    expect(bodies(blocksFor([cover], "AE", "engagement_letter", UAE))).toEqual(["UAE cover"]);
  });
});

describe("the standard prose screen, per company (T6.18)", () => {
  function setup(): { service: DocumentService } & ReturnType<typeof makeDocumentFakes> {
    const fakes = makeDocumentFakes();
    return { ...fakes, service: new DocumentService(fakes) };
  }

  it("accepts a line for one of the firm's companies and lists it on that company's tab", async () => {
    const s = setup();
    await s.preferences.set({ id: "p-ae", tenantId: TENANT, clientJurisdiction: "AE", firmEntityPartyId: UAE, note: null });
    await s.service.addStandardBlock({ tenantId: TENANT, kind: "exclusion", body: "Default.", sortOrder: 1 }, ACTOR);
    const own = await s.service.addStandardBlock(
      { tenantId: TENANT, kind: "exclusion", body: "UAE only.", sortOrder: 1, issuingEntityPartyId: UAE },
      ACTOR,
    );
    expect(own.issuingEntityPartyId).toBe(UAE);
    expect((await s.service.listStandardBlocks(TENANT, UAE)).map((b) => b.body)).toEqual(["UAE only."]);
    expect(await s.service.listStandardBlocks(TENANT)).toHaveLength(2);
    expect(s.events.recorded.at(-1)?.payload).toMatchObject({ issuingEntityPartyId: UAE });

    const moved = await s.service.editStandardBlock(TENANT, own.id, { issuingEntityPartyId: null }, ACTOR);
    expect(moved.issuingEntityPartyId).toBeNull();
  });

  it("refuses a company that is not one of the firm's own, and one that does not exist", async () => {
    const s = setup();
    s.preferences.partyNames.set(CLIENT_CO, "Meridian Foods");
    await expect(
      s.service.addStandardBlock(
        { tenantId: TENANT, kind: "exclusion", body: "x", sortOrder: 1, issuingEntityPartyId: CLIENT_CO },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotAFirmEntity);
    await expect(
      s.service.addStandardBlock(
        { tenantId: TENANT, kind: "exclusion", body: "x", sortOrder: 1, issuingEntityPartyId: US },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(FirmEntityNotFound);
  });
});

describe("seeding follows the issuer (T6.18)", () => {
  it("a PROPOSAL takes its issuer's lines, and the issuer's country when the client's is unknown", async () => {
    const f = makeProposalFakes();
    await f.firmEntities.set({ id: "p-ae", tenantId: TENANT, clientJurisdiction: "AE", firmEntityPartyId: UAE, note: null });
    f.firmEntities.partyJurisdictions.set(UAE, "AE");
    for (const [kind, body, jurisdiction, issuer] of [
      ["exclusion", "Default exclusion.", null, null],
      ["commercial", "Exclusive of GST.", "IN", null],
      ["commercial", "Exclusive of VAT.", "AE", null],
      ["exclusion", "UAE's own exclusion.", null, UAE],
    ] as const) {
      await f.prose.addStandardBlock(
        { tenantId: TENANT, kind, body, sortOrder: 1, jurisdiction, issuingEntityPartyId: issuer },
        ACTOR,
      );
    }
    const service = new ProposalService(f);
    const p = await service.draft(
      { tenantId: TENANT, partyId: PARTY, issuingEntityPartyId: UAE, title: "T", currency: "AED", fxRate: "22", fxRateDate: "2026-09-28" },
      ACTOR,
    );
    // No client country sent: AE, where the issuer is registered — so the VAT
    // note arrives, which the old `*` default could never have copied.
    expect((await service.describe(TENANT, p.id)).blocks.map((b) => b.body).sort()).toEqual([
      "Exclusive of VAT.",
      "UAE's own exclusion.",
    ]);
  });

  it("a LETTER takes its issuer's lines and its own country", async () => {
    const f = makeEngagementFakes();
    await f.firmEntities.set({ id: "p-ae", tenantId: TENANT, clientJurisdiction: "AE", firmEntityPartyId: UAE, note: null });
    await f.prose.addStandardBlock({ tenantId: TENANT, kind: "exclusion", body: "Default exclusion.", sortOrder: 1 }, ACTOR);
    await f.prose.addStandardBlock(
      { tenantId: TENANT, kind: "exclusion", body: "UAE's own exclusion.", sortOrder: 1, issuingEntityPartyId: UAE },
      ACTOR,
    );
    await f.prose.addStandardBlock(
      { tenantId: TENANT, kind: "commercial", body: "Exclusive of VAT.", sortOrder: 1, jurisdiction: "AE" },
      ACTOR,
    );
    const service = new EngagementService(f);
    const letter = await service.draft(
      {
        tenantId: TENANT,
        partyId: PARTY,
        issuingEntityPartyId: UAE,
        jurisdiction: "AE",
        title: "T",
        currency: "AED",
        fxRate: "22",
        fxRateDate: "2026-09-28",
        advanceRequired: false,
      },
      ACTOR,
    );
    const blocks = await f.prose.listBlocks(TENANT, { kind: "engagement_letter", id: letter.id });
    expect(blocks.map((b) => b.body).sort()).toEqual(["Exclusive of VAT.", "UAE's own exclusion."]);
  });
});
