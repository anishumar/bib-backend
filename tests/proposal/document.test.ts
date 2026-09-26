// How a proposal is organised on paper (0084) — `planProposal`, tested without
// a page. Each rule is one a client reads; see the header of
// src/domain/proposal/document.ts.
import { describe, expect, it } from "vitest";
import { NO_DEPT_SECTION_TITLE, planProposal } from "../../src/domain/proposal/document";
import type { ProposalDept, ProposalPlanLine } from "../../src/domain/proposal/document";
import type { DocumentTerms } from "../../src/domain/document/model";

const NO_TERMS: DocumentTerms = {
  scope: { text: null, tailored: false },
  clientObligations: { text: null, tailored: false },
  volumeLimits: { text: null, tailored: false },
  exclusions: { text: null, tailored: false },
};

const DEPTS: readonly ProposalDept[] = [
  { code: "TRC", name: "Transactions & Regulatory Compliance", sortOrder: 2 },
  { code: "FRC", name: "Financial Reporting & Compliance", sortOrder: 1 },
  { code: "RAA", name: "Risk Assurance & Advisory", sortOrder: 3 },
];

let position = 0;
function line(overrides: Partial<ProposalPlanLine> = {}): ProposalPlanLine {
  position += 1;
  return {
    id: `line-${String(position)}`,
    position,
    ref: null,
    deptCode: null,
    description: `Service ${String(position)}`,
    subject: null,
    terms: NO_TERMS,
    billingFrequency: "annually",
    net: "1000.00",
    pricingNote: null,
    oopEstimate: null,
    ...overrides,
  };
}

describe("a Dept is a section (rule 1)", () => {
  it("prints the firm's own sample the way the firm's own proposal does", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ ref: "H3", deptCode: "FRC", description: "Transfer pricing audit — Form 3CEB" }),
        line({ ref: "C2", deptCode: "TRC", description: "TDS/TCS — quarterly returns" }),
      ],
    });
    expect(plan.sections.map((s) => [s.code, s.title, s.items.map((i) => i.code)])).toEqual([
      ["A", "Financial Reporting & Compliance", ["H3"]],
      ["B", "Transactions & Regulatory Compliance", ["C2"]],
    ]);
  });

  it("orders sections by the firm's Dept order, not by which line came first", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [line({ deptCode: "RAA" }), line({ deptCode: "TRC" }), line({ deptCode: "FRC" })],
    });
    expect(plan.sections.map((s) => s.title)).toEqual([
      "Financial Reporting & Compliance",
      "Transactions & Regulatory Compliance",
      "Risk Assurance & Advisory",
    ]);
  });

  it("letters by RANK among the Depts used — no FRC work still starts at A", () => {
    const plan = planProposal({ depts: DEPTS, lines: [line({ deptCode: "TRC" })] });
    expect(plan.sections.map((s) => [s.code, s.title])).toEqual([
      ["A", "Transactions & Regulatory Compliance"],
    ]);
  });

  it("keeps a service's lines in the proposal's own order inside its section", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ ref: "H4", deptCode: "FRC" }),
        line({ ref: "C2", deptCode: "TRC" }),
        line({ ref: "H1", deptCode: "FRC" }),
      ],
    });
    expect(plan.sections[0]?.items.map((i) => i.code)).toEqual(["H4", "H1"]);
  });

  it("prints a Dept the firm keeps no row for under its code, after the named ones", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [line({ deptCode: "XYZ" }), line({ deptCode: "FRC" })],
    });
    expect(plan.sections.map((s) => s.title)).toEqual(["Financial Reporting & Compliance", "XYZ"]);
  });

  it("puts a service naming no Dept last, as 'Other services' — or 'Services' alone", () => {
    const mixed = planProposal({ depts: DEPTS, lines: [line(), line({ deptCode: "FRC" })] });
    expect(mixed.sections.map((s) => [s.code, s.title])).toEqual([
      ["A", "Financial Reporting & Compliance"],
      ["B", NO_DEPT_SECTION_TITLE.afterDepts],
    ]);
    const alone = planProposal({ depts: [], lines: [line(), line()] });
    expect(alone.sections.map((s) => s.title)).toEqual([NO_DEPT_SECTION_TITLE.alone]);
  });

  it("has no sections when it has no lines", () => {
    expect(planProposal({ depts: DEPTS, lines: [] }).sections).toEqual([]);
  });
});

describe("a service prints under its catalogue code (rule 2)", () => {
  it("numbers a service with no code in its section, counting only those", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ ref: "H3", deptCode: "FRC" }),
        line({ deptCode: "FRC" }),
        line({ deptCode: "FRC" }),
        line({ deptCode: "TRC" }),
      ],
    });
    expect(plan.sections.map((s) => s.items.map((i) => i.code))).toEqual([["H3", "A1", "A2"], ["B1"]]);
  });
});

describe("a company is named when it tells the reader something (rule 3)", () => {
  it("names nobody on a proposal for one company", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ deptCode: "FRC", subject: "Nexus Fintech Private Limited" }),
        line({ deptCode: "TRC", subject: "Nexus Fintech Private Limited" }),
      ],
    });
    expect(plan.sections.flatMap((s) => s.items.map((i) => i.subject))).toEqual([null, null]);
  });

  it("names every company once they differ — two H3 rows are not one row twice", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ ref: "H3", deptCode: "FRC", subject: "Nexus India" }),
        line({ ref: "H3", deptCode: "FRC", subject: "Nexus Singapore" }),
        line({ ref: "C2", deptCode: "TRC" }),
      ],
    });
    expect(plan.sections.flatMap((s) => s.items.map((i) => [i.code, i.subject]))).toEqual([
      ["H3", "Nexus India"],
      ["H3", "Nexus Singapore"],
      ["C2", null],
    ]);
  });

  it("does not merge two lines however alike — each carries its own price", () => {
    const plan = planProposal({
      depts: DEPTS,
      lines: [
        line({ ref: "H3", deptCode: "FRC", net: "50000.00" }),
        line({ ref: "H3", deptCode: "FRC", net: "50000.00" }),
      ],
    });
    expect(plan.sections[0]?.items).toHaveLength(2);
  });
});
