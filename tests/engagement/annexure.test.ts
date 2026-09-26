// How an Annexure letter's first annexure is ORGANISED (0083) — the sections,
// the numbered services and the Summary of Fees, decided without drawing a
// page. Every rule here is one a client reads.
import { describe, expect, it } from "vitest";
import { planAnnexure } from "../../src/domain/engagement/annexure";
import type { PlanLine } from "../../src/domain/engagement/annexure";
import { sectionCode } from "../../src/domain/engagement/model";
import type { FeeGroup } from "../../src/domain/engagement/model";
import { resolveTerms } from "../../src/domain/document/model";

const PARENT = "p";
const SUB = "s";

function group(id: string, position: number, over: Partial<FeeGroup> = {}): FeeGroup {
  return {
    id,
    tenantId: "t",
    engagementLetterId: "l",
    position,
    title: `Group ${id}`,
    billingFrequency: "monthly",
    amount: "5000",
    currency: "USD",
    paymentTerms: null,
    feeDescription: null,
    intro: null,
    deliverables: null,
    clientObligations: null,
    ...over,
  };
}

function line(id: string, position: number, over: Partial<PlanLine> = {}): PlanLine {
  return {
    id,
    position,
    feeGroupId: null,
    entityPartyId: PARENT,
    entityName: "MyDojo, Inc.",
    serviceVersionId: "svc",
    description: "Accounting / CAS",
    terms: resolveTerms(
      { scope: null, clientObligations: null, volumeLimits: null, exclusions: null },
      { scope: "- Daily bookkeeping.", clientObligations: null, volumeLimits: null, exclusions: null },
    ),
    billingFrequency: "monthly",
    effectiveFrom: null,
    net: "300.00",
    pricingNote: null,
    oopEstimate: null,
    ...over,
  };
}

describe("a section's letter", () => {
  it("runs A to Z and on to AA, derived from the rank rather than stored", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(sectionCode)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
    ]);
  });

  it("refuses an index that is not one", () => {
    expect(() => sectionCode(-1)).toThrow(RangeError);
    expect(() => sectionCode(1.5)).toThrow(RangeError);
  });
});

describe("planning Annexure 1", () => {
  it("makes each fee group a section, in order, and puts lines priced on their own last", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: "2026-07-01",
      feeGroups: [group("b", 2, { title: "Ongoing" }), group("a", 1, { title: "One-time" })],
      lines: [
        line("1", 1, { feeGroupId: "a", description: "Cleanup", serviceVersionId: "c" }),
        line("2", 2, { feeGroupId: "b" }),
        line("3", 3, { description: "Registered agent", serviceVersionId: "r" }),
      ],
    });
    expect(plan.sections.map((s) => [s.code, s.title, s.items.map((i) => i.code)])).toEqual([
      ["A", "One-time", ["A1"]],
      ["B", "Ongoing", ["B1"]],
      ["C", "Other services", ["C1"]],
    ]);
  });

  it("calls the section of lines priced on their own 'Services' when there are no groups", () => {
    const plan = planAnnexure({ letterEffectiveFrom: null, feeGroups: [], lines: [line("1", 1)] });
    expect(plan.sections.map((s) => [s.code, s.title])).toEqual([["A", "Services"]]);
  });

  it("prints ONE item for one service across four companies, and names them once", () => {
    // G0.1 makes "accounting for the group" four lines; printing the same scope
    // four times is not a letter anybody would send.
    const companies = [
      ["p", "MyDojo, Inc."],
      ["s1", "PrepWorks"],
      ["s2", "Maths Genie"],
      ["s3", "MyDojo HK Limited"],
    ] as const;
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [group("b", 1)],
      lines: companies.map(([entity, name], i) =>
        line(String(i), i + 1, { feeGroupId: "b", entityPartyId: entity, entityName: name }),
      ),
    });
    const [section] = plan.sections;
    expect(section?.items).toHaveLength(1);
    expect(section?.items[0]?.lineIds).toEqual(["0", "1", "2", "3"]);
    // Every item covers the same four, so the SECTION names them.
    expect(section?.entityNames).toEqual(companies.map(([, name]) => name));
    expect(section?.items[0]?.entityNames).toBeNull();
  });

  it("names the companies per item when a section mixes them", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [group("b", 1)],
      lines: [
        line("1", 1, { feeGroupId: "b" }),
        line("2", 2, { feeGroupId: "b", entityPartyId: SUB, entityName: "PrepWorks" }),
        line("3", 3, { feeGroupId: "b", serviceVersionId: "tax", description: "Tax" }),
      ],
    });
    const [section] = plan.sections;
    expect(section?.entityNames).toBeNull();
    expect(section?.items.map((i) => i.entityNames)).toEqual([
      ["MyDojo, Inc.", "PrepWorks"],
      ["MyDojo, Inc."],
    ]);
  });

  it("names nobody on a letter for one company", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [],
      lines: [line("1", 1), line("2", 2, { serviceVersionId: "tax", description: "Tax" })],
    });
    expect(plan.sections[0]?.entityNames).toBeNull();
    expect(plan.sections[0]?.items.every((i) => i.entityNames === null)).toBe(true);
  });

  it("keeps apart lines that would print differently, however alike they look", () => {
    // Different wording for one company is a different promise.
    const tailored = resolveTerms(
      { scope: "- Bookkeeping for the UK books only.", clientObligations: null, volumeLimits: null, exclusions: null },
      null,
    );
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [],
      lines: [
        line("1", 1),
        line("2", 2, { entityPartyId: SUB, entityName: "Maths Genie", terms: tailored }),
      ],
    });
    expect(plan.sections[0]?.items.map((i) => i.lineIds)).toEqual([["1"], ["2"]]);
  });

  it("says when a service starts on a day of its own, and only then", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: "2026-07-01",
      feeGroups: [],
      lines: [
        line("1", 1),
        line("2", 2, { serviceVersionId: "late", effectiveFrom: "2026-10-01" }),
        line("3", 3, { serviceVersionId: "same", effectiveFrom: "2026-07-01" }),
      ],
    });
    expect(plan.sections[0]?.items.map((i) => i.beginsOn)).toEqual([null, "2026-10-01", null]);
  });
});

describe("the Summary of Fees", () => {
  it("has one row per group, carrying its own words, its fee and how it is paid", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: "2026-07-01",
      feeGroups: [
        group("a", 1, {
          title: "One-time",
          billingFrequency: "one_time",
          amount: "40000",
          paymentTerms: "40% advance, 60% on completion",
          feeDescription: "One-time scope for the group.",
        }),
      ],
      lines: [line("1", 1, { feeGroupId: "a", net: null }), line("2", 2, { feeGroupId: "a", net: null })],
    });
    expect(plan.fees).toEqual([
      {
        code: "A",
        description: "One-time scope for the group.",
        billingFrequency: "one_time",
        startsOn: "2026-07-01",
        amount: "40000",
        pricingNote: null,
        paymentTerms: "40% advance, 60% on completion",
      },
    ]);
  });

  it("describes a group by its title and services when the firm wrote nothing", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [group("b", 1, { title: "Ongoing" })],
      lines: [
        line("1", 1, { feeGroupId: "b" }),
        line("2", 2, { feeGroupId: "b", serviceVersionId: "tax", description: "Tax" }),
      ],
    });
    expect(plan.fees[0]?.description).toBe("Ongoing: Accounting / CAS, Tax");
  });

  it("gives a line priced on its own a row of its own, its reason when it has no price", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: null,
      feeGroups: [],
      lines: [
        line("1", 1),
        line("2", 2, {
          serviceVersionId: "x",
          description: "Incorporation",
          net: null,
          pricingNote: "As mutually agreed",
          entityPartyId: SUB,
          entityName: "PrepWorks",
        }),
      ],
    });
    expect(plan.fees.map((f) => [f.code, f.description, f.amount, f.pricingNote])).toEqual([
      ["A1", "Accounting / CAS (MyDojo, Inc.)", "300.00", null],
      ["A2", "Incorporation (PrepWorks)", null, "As mutually agreed"],
    ]);
  });

  it("states a group's start only when every service it covers starts together", () => {
    const plan = planAnnexure({
      letterEffectiveFrom: "2026-07-01",
      feeGroups: [group("b", 1)],
      lines: [
        line("1", 1, { feeGroupId: "b" }),
        line("2", 2, { feeGroupId: "b", serviceVersionId: "late", effectiveFrom: "2026-10-01" }),
      ],
    });
    expect(plan.fees[0]?.startsOn).toBeNull();
  });
});
