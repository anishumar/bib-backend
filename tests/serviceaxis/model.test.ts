// The pure rules of the firm's delivery structure (G2.4).
//
// `groupByAxis` gets most of the attention here because it is the rule T2.7
// walks: it decides how many jobs an engagement becomes, and every one of its
// edge cases is an ordinary Tuesday at some firm rather than a hypothetical.
import { describe, expect, it } from "vitest";
import {
  assignableAxes,
  axisOrder,
  groupByAxis,
  isServiceAxisKind,
  isValidAxisCode,
  isValidAxisName,
  isWorkSplitAxis,
  normalizeAxisCode,
} from "../../src/domain/serviceaxis/model";
import type { ServiceAxis } from "../../src/domain/serviceaxis/model";
import { isReportingAxis } from "../../src/domain/config/model";

function row(over: Partial<ServiceAxis>): ServiceAxis {
  return {
    id: "id",
    tenantId: "t",
    axis: "dept",
    code: "FRC",
    name: "FRC",
    sortOrder: 0,
    isActive: true,
    ...over,
  };
}

describe("codes", () => {
  it("accepts the shapes the firm actually uses", () => {
    for (const code of ["FRC", "TRC", "RAA", "VCFO CONSOLE", "FINCOMPLIANCE", "A1", "SEC-OPS"]) {
      expect(isValidAxisCode(code)).toBe(true);
    }
  });

  it("refuses lower case, leading/trailing separators and doubled ones", () => {
    for (const code of ["frc", "FRC ", " FRC", "FRC  OPS", "FRC-", "-FRC", "FRC!"]) {
      expect(isValidAxisCode(code)).toBe(false);
    }
  });

  it("caps the length, so a pasted description fails at the write", () => {
    expect(isValidAxisCode("A".repeat(48))).toBe(true);
    expect(isValidAxisCode("A".repeat(49))).toBe(false);
  });

  it("normalises case and stray spacing", () => {
    expect(normalizeAxisCode("  vcfo   console ")).toBe("VCFO CONSOLE");
  });

  // The bug this whole task exists to make unrepresentable, stated as a test so
  // nobody later "improves" the normaliser into pretending it can be fixed here.
  it("does NOT join words — 'FIN COMPLIANCE' stays a different code", () => {
    expect(normalizeAxisCode("fin compliance")).not.toBe("FINCOMPLIANCE");
  });

  /**
   * `isValidAxisCode` and `isReportingAxis` are the same rule written twice,
   * because `domain/serviceaxis` and `domain/config` are siblings and the arch
   * wall forbids either importing the other.
   *
   * A shared import is not available; agreement is therefore held HERE. If they
   * ever drift, a firm can define a row no service body may name, or publish a
   * body naming a code no row can hold — and both look like the feature working
   * until somebody's work lands in the wrong group.
   */
  it("agrees exactly with the config domain's `isReportingAxis`", () => {
    const cases = [
      "FRC", "frc", "FRC ", " FRC", "VCFO CONSOLE", "FRC  OPS", "A1", "SEC-OPS", "SEC_OPS",
      "FRC!", "", "1", "A".repeat(48), "A".repeat(49),
    ];
    for (const c of cases) {
      expect([c, isValidAxisCode(c)]).toEqual([c, isReportingAxis(c)]);
    }
  });
});

describe("names, kinds and the split axis", () => {
  it("takes any readable label, but not nothing and not a paragraph", () => {
    expect(isValidAxisName("Financial Reporting & Compliance")).toBe(true);
    expect(isValidAxisName("   ")).toBe(false);
    expect(isValidAxisName("x".repeat(121))).toBe(false);
  });

  it("knows its two lists and its three split answers", () => {
    expect(isServiceAxisKind("dept")).toBe(true);
    expect(isServiceAxisKind("team")).toBe(true);
    expect(isServiceAxisKind("module")).toBe(false);
    expect(isWorkSplitAxis("none")).toBe(true);
    expect(isWorkSplitAxis("department")).toBe(false);
  });
});

describe("ordering and what a picker offers", () => {
  it("orders by sortOrder, then name, so a tie still has one stable order", () => {
    const rows = [
      row({ code: "B", name: "Beta", sortOrder: 1 }),
      row({ code: "A", name: "Alpha", sortOrder: 1 }),
      row({ code: "C", name: "Gamma", sortOrder: 0 }),
    ];
    expect(axisOrder(rows).map((r) => r.code)).toEqual(["C", "A", "B"]);
  });

  it("offers only what is still in use", () => {
    const rows = [row({ code: "A" }), row({ code: "B", isActive: false })];
    expect(assignableAxes(rows).map((r) => r.code)).toEqual(["A"]);
  });
});

describe("groupByAxis — the rule that decides how many jobs an engagement becomes", () => {
  const lines = [
    { id: "gst", dept: "FRC", team: "FINCOMPLIANCE" },
    { id: "tds", dept: "TRC", team: "FINCOMPLIANCE" },
    { id: "payroll", dept: "FRC", team: "PAYROLL" },
  ];

  // THE CORRECTION. This used to assert one bucket holding everything, on the
  // stated grounds that it was "T2.6's behaviour, unchanged" — and it was not.
  // T2.6 gives one job per ENGAGEMENT and a three-line letter is already three
  // engagements, so one bucket would have MERGED all three for every firm on
  // the default setting. `none` means the firm does not cut its work up, and
  // the honest reading of that is that nothing merges either.
  it("`none` merges nothing — one bucket per item, which is T2.6's behaviour", () => {
    const groups = groupByAxis(lines, "none", (l) => l.dept);
    expect(groups.length).toBe(3);
    expect(groups.map((g) => g.code)).toEqual([null, null, null]);
    expect(groups.map((g) => g.items.map((l) => l.id))).toEqual([
      ["gst"],
      ["tds"],
      ["payroll"],
    ]);
  });

  // The one thing that did NOT change: a firm on `none` whose services all sit
  // under one team still gets a job each. `none` is not "team, unconfigured".
  it("`none` ignores the codes entirely, even when they agree", () => {
    const oneTeam = [
      { id: "gst", dept: "FRC", team: "FINCOMPLIANCE" },
      { id: "tds", dept: "FRC", team: "FINCOMPLIANCE" },
    ];
    expect(groupByAxis(oneTeam, "none", (l) => l.team).length).toBe(2);
  });

  it("`none` over nothing is nothing, not one empty bucket", () => {
    expect(groupByAxis([], "none", () => null)).toEqual([]);
  });

  // The firm's own question, in the firm's own numbers. Three services from one
  // delivery team are one checklist; three from three teams are three.
  it("by team: the two FinCompliance services share a job, Payroll gets its own", () => {
    const groups = groupByAxis(lines, "team", (l) => l.team);
    expect(groups.map((g) => [g.code, g.items.map((l) => l.id)])).toEqual([
      ["FINCOMPLIANCE", ["gst", "tds"]],
      ["PAYROLL", ["payroll"]],
    ]);
  });

  it("by Dept: the same three lines split differently — which is why the firm has to choose", () => {
    const groups = groupByAxis(lines, "dept", (l) => l.dept);
    expect(groups.map((g) => [g.code, g.items.map((l) => l.id)])).toEqual([
      ["FRC", ["gst", "payroll"]],
      ["TRC", ["tds"]],
    ]);
  });

  it("keeps first-seen order, so the same lines produce the same jobs every run", () => {
    const groups = groupByAxis(lines, "dept", (l) => l.dept);
    expect(groups.map((g) => g.code)).toEqual(["FRC", "TRC"]);
  });

  // A service the firm has not filed is a real state — the catalogue screen says
  // "filed under no Dept" rather than hiding the row — so its work must land
  // somewhere. Dropping it would be the worst failure available here.
  it("puts unfiled lines in their own bucket rather than dropping them", () => {
    const withUnfiled = [...lines, { id: "adhoc", dept: null, team: null }];
    const groups = groupByAxis(withUnfiled, "dept", (l) => l.dept);
    const unfiled = groups.find((g) => g.code === null);
    expect(unfiled?.items.map((l) => l.id)).toEqual(["adhoc"]);
  });

  it("treats a blank code as unfiled, not as a group named empty-string", () => {
    const groups = groupByAxis([{ id: "x", dept: "   " }], "dept", (l) => l.dept);
    expect(groups.map((g) => g.code)).toEqual([null]);
  });

  it("gathers every unfiled line into ONE bucket, not one each", () => {
    const groups = groupByAxis(
      [
        { id: "a", dept: null },
        { id: "b", dept: null },
      ],
      "dept",
      (l) => l.dept,
    );
    expect(groups.length).toBe(1);
    expect(groups[0]?.items.map((l) => l.id)).toEqual(["a", "b"]);
  });
});
