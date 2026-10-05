import { describe, expect, it } from "vitest";

import {
  CLIENT_SHEET_MARKER,
  clientRowsOf,
  daysBefore,
  engagementRowsOf,
  isMonthDay,
  MIGRATED_SIGNATORY,
  parseSheetDate,
  personRowsOf,
  rowsOf,
  mainCurrency, validateImport,
  type ClientRow,
  type EngagementRow,
  type ImportSnapshot,
  type KnownOrganization,
  type PersonRow,
} from "../../src/domain/clientimport/model";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY = "2026-09-07";

function snapshot(over: Partial<ImportSnapshot> = {}): ImportSnapshot {
  return {
    today: TODAY,
    firmCurrency: "INR",
    services: new Map([
      ["a1", { serviceId: "svc-a1", serviceVersionId: "ver-a1", code: "A1", name: "GST filing", module: "TRC", billingFrequency: "monthly" }],
      ["h1", { serviceId: "svc-h1", serviceVersionId: "ver-h1", code: "H1", name: "Payroll", module: "FRC", billingFrequency: null }],
    ]),
    axes: [
      { id: "axis-trc", axis: "dept", code: "TRC", name: "Tax & Regulatory", isActive: true },
      { id: "axis-frc", axis: "dept", code: "FRC", name: "Finance", isActive: true },
      { id: "axis-old", axis: "dept", code: "OLD", name: "Retired", isActive: false },
    ],
    staff: new Map([
      ["anita@firm.test", "user-anita"],
      ["ravi@firm.test", "user-ravi"],
    ]),
    staffByName: new Map([
      ["anita rao", ["anita@firm.test"]],
      ["ravi", ["ravi@firm.test", "ravi.k@firm.test"]],
    ]),
    relationshipTypes: new Set(["director_of", "authorised_signatory_of", "shareholder_of", "employee_of", "parent_of", "client_of"]),
    clauseJurisdictions: new Set(["IN"]),
    byIdentifier: new Map(),
    byName: new Map(),
    peopleByEmail: new Map(),
    activeEngagements: new Set(),
    complianceFloor: "2026-04-01",
    reachBackDays: 90,
    ...over,
  };
}

function client(over: Partial<ClientRow> = {}): ClientRow {
  return {
    lineNo: 2,
    legalName: "Cobalt Foods Private Limited",
    tradeName: null,
    industry: null,
    website: null,
    clientSince: null,
    group: null,
    jurisdiction: "IN",
    entityType: "private_limited",
    incorporatedOn: null,
    financialYearEnd: "03-31",
    returnPeriodCell: null,
    returnPeriods: [],
    registeredAddress: null,
    identifiers: [{ type: "pan", value: "AAACC1234F" }],
    keyManagerEmail: "anita@firm.test",
    spocs: [{ dept: "TRC", email: "ravi@firm.test", column: "SPOC: TRC" }],
    signatory: null,
    portalInviteRaw: null,
    portalEmail: null,
    ...over,
  };
}

function person(over: Partial<PersonRow> = {}): PersonRow {
  return {
    lineNo: 2,
    client: "Cobalt Foods Private Limited",
    of: null,
    fullName: "Priya Menon",
    relationship: "director",
    since: "2019-06-11",
    email: "priya@cobalt.test",
    phone: null,
    ...over,
  };
}

function engagement(over: Partial<EngagementRow> = {}): EngagementRow {
  return {
    lineNo: 2,
    company: "Cobalt Foods Private Limited",
    serviceCode: "A1",
    startedOn: "2025-04-01",
    billed: null,
    fee: "6000",
    currency: "INR",
    where: null,
    basis: "EL 2025-04, Drive/Cobalt",
    ...over,
  };
}

const blockingMessages = (r: ReturnType<typeof validateImport>) =>
  r.findings.filter((f) => f.severity === "blocking").map((f) => f.message);
const warningMessages = (r: ReturnType<typeof validateImport>) =>
  r.findings.filter((f) => f.severity === "warning").map((f) => f.message);

// ── Reading a grid ───────────────────────────────────────────────────────────

describe("reading a grid", () => {
  it("finds the header row by its marker, wherever it is, and numbers rows as Excel does", () => {
    const grid = [
      ["10x Global — clients", ""],
      [],
      ["client name", "Country", "Entity Type", "PAN"],
      ["Alpha Ltd", "IN", "private_limited", "AAACA1111A"],
    ];
    const rows = rowsOf(grid, CLIENT_SHEET_MARKER);
    expect(rows).not.toBeNull();
    expect(rows?.[0]?.lineNo).toBe(4);
    expect(rows?.[0]?.cell("Client Name")).toBe("Alpha Ltd");
    expect(rows?.[0]?.cell("Entity  type")).toBe("private_limited");
  });

  it("says null when no row carries the marker", () => {
    expect(rowsOf([["Name", "Email"]], CLIENT_SHEET_MARKER)).toBeNull();
  });

  it("reads the older Dept-in-the-header form, and a blank cell there is simply no SPOC", () => {
    const grid = [
      ["Client Name", "Country", "Entity Type", "SPOC: TRC", "spoc: Finance"],
      ["Alpha Ltd", "IN", "private_limited", "ravi@firm.test", ""],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.spocs).toEqual([{ dept: "TRC", email: "ravi@firm.test", column: "SPOC: TRC" }]);
  });

  it("keeps the month and day of a Financial Year End Excel turned into a whole date", () => {
    const grid = [
      ["Client Name", "Financial Year End"],
      ["Alpha Ltd", "2031-03-31"],
      ["Beta Ltd", "31-Dec-2012"],
      ["Gamma Ltd", "03-31"],
      ["Delta Ltd", "31/03"],
    ];
    const rows = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(rows.map((r) => r.financialYearEnd)).toEqual(["03-31", "12-31", "03-31", "31/03"]);
  });

  it("reads the numbered pairs, whose headers are the same at every firm", () => {
    const grid = [
      ["Client Name", "SPOC 1 Dept", "SPOC 1 Email", "spoc 2 dept", "SPOC  2  Email"],
      ["Alpha Ltd", "TRC", "ravi@firm.test", "Finance", "asha@firm.test"],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.spocs).toEqual([
      { dept: "TRC", email: "ravi@firm.test", column: "SPOC 1" },
      { dept: "Finance", email: "asha@firm.test", column: "SPOC 2" },
    ]);
  });

  it("keeps TWO SPOCs named for the SAME Dept — G3.2 allows it, and a map would have lost one", () => {
    const grid = [
      ["Client Name", "SPOC 1 Dept", "SPOC 1 Email", "SPOC 2 Dept", "SPOC 2 Email"],
      ["Alpha Ltd", "TRC", "ravi@firm.test", "TRC", "asha@firm.test"],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.spocs.map((s) => s.email)).toEqual(["ravi@firm.test", "asha@firm.test"]);
  });

  it("keeps a HALF-FILLED pair rather than dropping it, so validation can refuse it by name", () => {
    const grid = [
      ["Client Name", "SPOC 1 Dept", "SPOC 1 Email", "SPOC 2 Dept", "SPOC 2 Email"],
      ["Alpha Ltd", "TRC", "", "", "asha@firm.test"],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.spocs).toEqual([
      { dept: "TRC", email: "", column: "SPOC 1" },
      { dept: "", email: "asha@firm.test", column: "SPOC 2" },
    ]);
  });

  it("reads a sheet carrying BOTH forms, so a file sent before the change still loads", () => {
    const grid = [
      ["Client Name", "SPOC: TRC", "SPOC 1 Dept", "SPOC 1 Email"],
      ["Alpha Ltd", "ravi@firm.test", "Finance", "asha@firm.test"],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.spocs.map((s) => s.dept)).toEqual(["TRC", "Finance"]);
  });

  it("collects every identifier column that is filled and ignores the blank ones", () => {
    const grid = [
      ["Client Name", "PAN", "GSTIN", "CIN"],
      ["Alpha Ltd", "AAACA1111A", "", "U12345KA2019PTC000001"],
    ];
    const [row] = clientRowsOf(rowsOf(grid, CLIENT_SHEET_MARKER) ?? []);
    expect(row?.identifiers).toEqual([
      { type: "pan", value: "AAACA1111A" },
      { type: "cin", value: "U12345KA2019PTC000001" },
    ]);
  });

  it("reads the people and engagement sheets into their rows", () => {
    const [p] = personRowsOf(rowsOf([["Client", "Name", "Relationship"], ["Alpha", "Priya", "director"]], "Name") ?? []);
    expect(p).toMatchObject({ client: "Alpha", fullName: "Priya", relationship: "director", of: null });
    const [e] = engagementRowsOf(rowsOf([["Company", "Service", "Started On", "Fee"], ["Alpha", "A1", "2025-04-01", "6000"]], "Company") ?? []);
    expect(e).toMatchObject({ company: "Alpha", serviceCode: "A1", startedOn: "2025-04-01", fee: "6000", currency: null });
  });
});

// ── Dates ────────────────────────────────────────────────────────────────────

describe("a date in a sheet", () => {
  it("reads ISO and day-Mon-year, and refuses the ambiguous slash form", () => {
    expect(parseSheetDate("2019-02-11")).toBe("2019-02-11");
    expect(parseSheetDate("13-Feb-1995")).toBe("1995-02-13");
    expect(parseSheetDate("13 February 1995")).toBe("1995-02-13");
    expect(parseSheetDate("13/02/1995")).toBeNull();
  });

  it("refuses a day that does not exist in that month, leap years included", () => {
    expect(parseSheetDate("32-Feb-1995")).toBeNull();
    expect(parseSheetDate("2023-02-29")).toBeNull();
    expect(parseSheetDate("2024-02-29")).toBe("2024-02-29");
  });

  it("knows a financial year end is MM-DD", () => {
    expect(isMonthDay("03-31")).toBe(true);
    expect(isMonthDay("31-03")).toBe(false);
    expect(isMonthDay("02-30")).toBe(false);
  });

  it("counts days back across a year boundary", () => {
    expect(daysBefore("2026-01-10", 90)).toBe("2025-10-12");
  });
});

// ── Clients ──────────────────────────────────────────────────────────────────

describe("a client row", () => {
  it("refuses a retired or reserved country code in Country and in Where (F04)", () => {
    const report = validateImport(
      { clients: [client({ jurisdiction: "UK" })], people: [], engagements: [engagement({ where: "DD" })] },
      snapshot(),
    );
    const blocking = blockingMessages(report);
    expect(blocking.some((m) => m.includes(`"UK" is not the code for the United Kingdom. Use GB.`))).toBe(true);
    expect(blocking.some((m) => m.includes(`"DD" is no longer a country code. For Germany, use DE.`))).toBe(true);
  });

  it("names the kind and the country in words, with the right article (CA#39)", () => {
    const person = validateImport(
      { clients: [client({ entityType: "individual" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(person.rows[0]?.detail).toBe("an individual in India");
    const own = validateImport(
      { clients: [client({ entityType: "Family office" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(own.rows[0]?.detail).toBe("a family office in India");
  });

  it("loads with its registration, identifiers and account team", () => {
    const report = validateImport({ clients: [client()], people: [], engagements: [] }, snapshot());
    expect(report.blocking).toBe(0);
    // In words (CA#39): it read "a private_limited in IN", and "create a individual".
    expect(report.rows[0]).toMatchObject({ sheet: "clients", action: "create", detail: "a private limited company in India" });
    expect(report.counts).toMatchObject({ clientsToCreate: 1, entitiesToRegister: 1, assignmentsToRecord: 2 });
  });

  it("is refused with a country and no entity type, and the other way round", () => {
    const a = validateImport({ clients: [client({ entityType: null })], people: [], engagements: [] }, snapshot());
    expect(blockingMessages(a)).toContain("has a Country but no Entity Type. A registration needs both");
    const b = validateImport({ clients: [client({ jurisdiction: null })], people: [], engagements: [] }, snapshot());
    expect(blockingMessages(b)).toContain("has an Entity Type but no Country. A registration needs both");
  });

  it("is refused with no registration unless other rows file themselves under it", () => {
    const alone = validateImport(
      { clients: [client({ jurisdiction: null, entityType: null })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(alone)[0]).toMatch(/needs a Country and an Entity Type, or companies under it/);

    const group = validateImport(
      {
        clients: [
          client({ legalName: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }),
          client({ lineNo: 3, legalName: "Kaveri Foods", group: "Kaveri Group" }),
        ],
        people: [],
        engagements: [],
      },
      snapshot(),
    );
    expect(group.blocking).toBe(0);
    expect(group.rows.map((r) => r.detail)).toEqual(["a group, with companies under it", 'a company under "Kaveri Group"']);
  });

  it("does not nag about a Key Manager on a company inside a group — the group owns it", () => {
    const report = validateImport(
      {
        clients: [
          client({ legalName: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }),
          client({ lineNo: 3, legalName: "Kaveri Foods", group: "Kaveri Group", identifiers: [], keyManagerEmail: null }),
        ],
        people: [],
        engagements: [],
      },
      snapshot(),
    );
    expect(warningMessages(report)).toEqual([]);
  });

  it("refuses a company inside a group with no registration — it could never be issued a letter", () => {
    const report = validateImport(
      {
        clients: [
          client({ legalName: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }),
          client({ lineNo: 3, legalName: "Kaveri Foods", group: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }),
        ],
        people: [],
        engagements: [],
      },
      snapshot(),
    );
    expect(blockingMessages(report)[0]).toMatch(/a company inside a group needs a Country and an Entity Type/);
  });

  it("refuses a group that is on neither the sheet nor the file, naming the column", () => {
    const report = validateImport({ clients: [client({ group: "Nobody Group" })], people: [], engagements: [] }, snapshot());
    expect(blockingMessages(report)[0]).toMatch(/no client called "Nobody Group" on this sheet or on file. Check the Group column/);
  });

  it("refuses a malformed PAN, a repeated PAN and a repeated name, each naming the other row", () => {
    const report = validateImport(
      {
        clients: [
          client({ identifiers: [{ type: "pan", value: "NOT-A-PAN" }] }),
          client({ lineNo: 3, legalName: "Beta Ltd", identifiers: [{ type: "pan", value: "AAACB2222B" }] }),
          client({ lineNo: 4, legalName: "beta ltd", identifiers: [{ type: "pan", value: "aaacb2222b" }] }),
        ],
        people: [],
        engagements: [],
      },
      snapshot(),
    );
    const messages = blockingMessages(report);
    expect(messages).toContain('PAN "NOT-A-PAN" is not a well-formed PAN');
    expect(messages).toContain("the same Client Name is on row 3");
    expect(messages).toContain("PAN AAACB2222B is also on row 3");
  });

  it("refuses a Key Manager or a SPOC who is not active staff, and a SPOC column naming no Dept", () => {
    const report = validateImport(
      { clients: [client({ keyManagerEmail: "gone@firm.test", spocs: [{ dept: "TRC", email: "who@firm.test", column: "SPOC: TRC" }, { dept: "Legal", email: "ravi@firm.test", column: "SPOC: Legal" }] })], people: [], engagements: [] },
      snapshot(),
    );
    const messages = blockingMessages(report);
    expect(messages).toContain('Key Manager "gone@firm.test" is not an active member of staff at this firm');
    expect(messages).toContain('SPOC for TRC "who@firm.test" is not an active member of staff at this firm');
    expect(messages.some((m) => m.startsWith('the column "SPOC: Legal" names no active Dept'))).toBe(true);
    expect(report.findings.find((f) => f.name === "SPOC: Legal")?.sheet).toBe("file");
  });

  it("names the email a NAME typed into an email column belongs to, and never picks one of two", () => {
    const report = validateImport(
      {
        clients: [
          client({ keyManagerEmail: "Anita  Rao", spocs: [{ dept: "TRC", email: "Ravi", column: "SPOC 1" }] }),
          client({ lineNo: 3, legalName: "Beta Ltd", identifiers: [], keyManagerEmail: "Nobody Known" }),
        ],
        people: [],
        engagements: [],
      },
      snapshot(),
    );
    const messages = blockingMessages(report);
    expect(messages).toContain('Key Manager "Anita  Rao" is a name. This column takes the colleague\'s login email: anita@firm.test');
    expect(messages).toContain('SPOC for TRC "Ravi" is a name, and 2 colleagues have it (ravi@firm.test, ravi.k@firm.test). Put the login email of the one you mean');
    expect(messages).toContain('Key Manager "Nobody Known" is not an email. This column takes the login email of an active member of staff at this firm');
  });

  it("refuses HALF a numbered pair — a SPOC covers a Dept, so neither half is a smaller SPOC", () => {
    const noEmail = validateImport(
      { clients: [client({ spocs: [{ dept: "TRC", email: "", column: "SPOC 1" }] })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(noEmail).some((m) => m.startsWith('SPOC 1 Dept is "TRC" with no SPOC 1 Email'))).toBe(true);

    const noDept = validateImport(
      { clients: [client({ spocs: [{ dept: "", email: "ravi@firm.test", column: "SPOC 2" }] })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(noDept).some((m) => m.startsWith('SPOC 2 Email is "ravi@firm.test" with no SPOC 2 Dept'))).toBe(true);
  });

  it("refuses a bad Dept in a CELL against the ROW, not the file — one header was wrong for everybody, one cell is not", () => {
    const report = validateImport(
      { clients: [client({ spocs: [{ dept: "Legal", email: "ravi@firm.test", column: "SPOC 1" }] })], people: [], engagements: [] },
      snapshot(),
    );
    const finding = report.findings.find((f) => f.severity === "blocking");
    expect(finding?.sheet).toBe("clients");
    expect(finding?.lineNo).not.toBeNull();
    expect(finding?.message).toContain('SPOC 1 Dept is "Legal"');
  });

  it("matches a SPOC column on the Dept's NAME as well as its code, and never on a retired one", () => {
    const ok = validateImport({ clients: [client({ spocs: [{ dept: "Finance", email: "ravi@firm.test", column: "SPOC: Finance" }] })], people: [], engagements: [] }, snapshot());
    expect(ok.blocking).toBe(0);
    const retired = validateImport({ clients: [client({ spocs: [{ dept: "OLD", email: "ravi@firm.test", column: "SPOC: OLD" }] })], people: [], engagements: [] }, snapshot());
    expect(retired.blocking).toBe(1);
  });

  it("warns, rather than refuses, about a missing Key Manager; an Indian company needs no year end", () => {
    const report = validateImport({ clients: [client({ keyManagerEmail: null, financialYearEnd: null })], people: [], engagements: [] }, snapshot());
    expect(report.blocking).toBe(0);
    expect(warningMessages(report)).toEqual([
      "no Key Manager. Nobody at the firm will own this client until somebody is named",
    ]);
  });

  it("refuses a company outside India with no year end, and an Indian one with another year end (Q076)", () => {
    const abroad = validateImport(
      { clients: [client({ jurisdiction: "AE", entityType: "fzco", financialYearEnd: null })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(abroad).join(" ")).toContain("a company outside India needs its Financial Year End");
    const ok = validateImport(
      { clients: [client({ jurisdiction: "AE", entityType: "fzco", financialYearEnd: "12-31" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(ok).join(" ")).not.toContain("Financial Year End");
    const india = validateImport({ clients: [client({ financialYearEnd: "12-31" })], people: [], engagements: [] }, snapshot());
    expect(blockingMessages(india).join(" ")).toContain("an Indian company's year ends on 31 March");
  });

  it("refuses a date it cannot read in Client Since or Incorporated On", () => {
    const report = validateImport({ clients: [client({ clientSince: "01/04/2019", incorporatedOn: "31-Feb-2019" })], people: [], engagements: [] }, snapshot());
    expect(blockingMessages(report)).toHaveLength(2);
  });

  it("is skipped, never updated, when a registration number is already on file", () => {
    const onFile = { partyId: "party-cobalt", displayName: "Cobalt Foods Pvt Ltd", registered: true, jurisdiction: "IN", billToPartyId: "party-cobalt", archived: false };
    const report = validateImport(
      { clients: [client({ legalName: "Cobalt Foods (renamed)" })], people: [], engagements: [] },
      snapshot({ byIdentifier: new Map([["pan:AAACC1234F", onFile]]) }),
    );
    expect(report.blocking).toBe(0);
    expect(report.rows[0]).toMatchObject({ action: "skip", detail: 'already on file as "Cobalt Foods Pvt Ltd"' });
    expect(report.counts.clientsOnFile).toBe(1);
    expect(report.counts.assignmentsToRecord).toBe(0);
  });

  it("is skipped by name when the sheet carries no number", () => {
    const onFile = { partyId: "party-cobalt", displayName: "Cobalt Foods Private Limited", registered: true, jurisdiction: "IN", billToPartyId: "party-cobalt", archived: false };
    const report = validateImport(
      { clients: [client({ identifiers: [] })], people: [], engagements: [] },
      snapshot({ byName: new Map([["cobalt foods private limited", onFile]]) }),
    );
    expect(report.rows[0]?.action).toBe("skip");
  });
});

// ── People ───────────────────────────────────────────────────────────────────

describe("a people row", () => {
  it("attaches a director to a client on the sheet, dated", () => {
    const report = validateImport({ clients: [client()], people: [person()], engagements: [] }, snapshot());
    expect(report.blocking).toBe(0);
    expect(report.rows.find((r) => r.sheet === "people")).toMatchObject({ action: "create", detail: "director of Cobalt Foods Private Limited" });
  });

  it("attaches to the company named in Of, which may be on file rather than on the sheet", () => {
    const onFile = { partyId: "party-sub", displayName: "Cobalt Logistics", registered: true, jurisdiction: "IN", billToPartyId: "party-cobalt", archived: false };
    const report = validateImport(
      { clients: [client()], people: [person({ of: "Cobalt Logistics" })], engagements: [] },
      snapshot({ byName: new Map([["cobalt logistics", onFile]]) }),
    );
    expect(report.rows.find((r) => r.sheet === "people")?.detail).toBe("director of Cobalt Logistics");
  });

  it("stores a phone in E.164, completing one typed without its code with the company's country", () => {
    const report = validateImport(
      {
        clients: [client()],
        people: [
          person({ lineNo: 2, phone: "098200 12345" }),
          person({ lineNo: 3, email: "ravi@cobalt.test", fullName: "Ravi Iyer", phone: "+971 50 123 4567" }),
          person({ lineNo: 4, email: "sara@cobalt.test", fullName: "Sara Khan", phone: "98200" }),
        ],
        engagements: [],
      },
      snapshot(),
    );
    expect(report.peoplePhones.get(2)).toBe("+919820012345");
    expect(report.peoplePhones.get(3)).toBe("+971501234567");
    expect(report.peoplePhones.has(4)).toBe(false);
    expect(blockingMessages(report)).toContain(
      'Phone "98200" is not a phone number this can read. Write it with the country code, for example +91 98200 12345',
    );
  });

  it("refuses a person whose client is nowhere, a relationship it does not read, and a bad email", () => {
    const report = validateImport(
      { clients: [client()], people: [person({ client: "Nobody Ltd", relationship: "auditor", email: "not-an-email" })], engagements: [] },
      snapshot(),
    );
    const messages = blockingMessages(report);
    expect(messages).toContain('no client called "Nobody Ltd" on this sheet or on file');
    expect(messages).toContain('Relationship "auditor" is not one this can read. Use director, signatory, shareholder or employee');
    expect(messages).toContain('Email "not-an-email" is not an email address');
  });

  it("is blocked when its client row is blocked", () => {
    const report = validateImport({ clients: [client({ entityType: null })], people: [person()], engagements: [] }, snapshot());
    expect(blockingMessages(report)).toContain('its client "Cobalt Foods Private Limited" has errors on the client sheet');
  });

  // A ROW IS A ROLE, not a person. One director of three companies in a group
  // is three rows carrying the same email, and both of the tidier readings —
  // "a repeated email is a duplicate" and "a person on file means skip the
  // row" — drop a real relationship on the floor.

  it("takes the SAME EMAIL on several rows as one person holding several roles", () => {
    const report = validateImport(
      {
        clients: [client(), client({ lineNo: 3, legalName: "Cobalt Logistics Private Limited", identifiers: [] })],
        people: [person(), person({ lineNo: 3, client: "Cobalt Logistics Private Limited" })],
        engagements: [],
      },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    const people = report.rows.filter((r) => r.sheet === "people");
    expect(people.map((r) => r.action)).toEqual(["create", "create"]);
    expect(people[1]?.detail).toContain("added to the person on row 2");
  });

  it("refuses only the SAME ROLE twice — same person, same company, same relationship", () => {
    const report = validateImport(
      { clients: [client()], people: [person(), person({ lineNo: 3 })], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(report)).toContain(
      'row 2 already makes "priya@cobalt.test" a director of Cobalt Foods Private Limited',
    );
  });

  it("adds the role to a person ALREADY ON FILE rather than skipping the row", () => {
    const report = validateImport(
      { clients: [client()], people: [person()], engagements: [] },
      snapshot({
        peopleByEmail: new Map([
          ["priya@cobalt.test", { partyId: "party-priya", name: "Priya Menon", roles: new Set<string>() }],
        ]),
      }),
    );
    const row = report.rows.find((r) => r.sheet === "people");
    expect(row?.action).toBe("create");
    expect(row?.detail).toContain('added to "Priya Menon", already on file');
  });

  it("skips only when THAT ROLE is already recorded — which is what keeps a re-run boring", () => {
    const onFile = {
      partyId: "party-cobalt",
      displayName: "Cobalt Foods Private Limited",
      registered: true,
      jurisdiction: "IN",
      billToPartyId: "party-cobalt",
      archived: false,
    };
    const report = validateImport(
      { clients: [], people: [person()], engagements: [] },
      snapshot({
        byName: new Map([["cobalt foods private limited", onFile]]),
        peopleByEmail: new Map([
          [
            "priya@cobalt.test",
            { partyId: "party-priya", name: "Priya Menon", roles: new Set(["party-cobalt:director_of"]) },
          ],
        ]),
      }),
    );
    const row = report.rows.find((r) => r.sheet === "people");
    expect(row?.action).toBe("skip");
    expect(row?.detail).toContain("already a director of");
  });

  it('says "an authorised signatory", not "a authorised signatory"', () => {
    const onFile = {
      partyId: "party-cobalt",
      displayName: "Cobalt Foods Private Limited",
      registered: true,
      jurisdiction: "IN",
      billToPartyId: "party-cobalt",
      archived: false,
    };
    const report = validateImport(
      { clients: [], people: [person({ relationship: "signatory" })], engagements: [] },
      snapshot({
        byName: new Map([["cobalt foods private limited", onFile]]),
        peopleByEmail: new Map([
          [
            "priya@cobalt.test",
            { partyId: "party-priya", name: "Priya Menon", roles: new Set(["party-cobalt:authorised_signatory_of"]) },
          ],
        ]),
      }),
    );
    expect(report.rows.find((r) => r.sheet === "people")?.detail).toBe(
      "already an authorised signatory of Cobalt Foods Private Limited",
    );
  });

  it("warns when one email is given two different names, and keeps the first", () => {
    const report = validateImport(
      {
        clients: [client(), client({ lineNo: 3, legalName: "Cobalt Logistics Private Limited", identifiers: [] })],
        people: [person(), person({ lineNo: 3, fullName: "P. Menon", client: "Cobalt Logistics Private Limited" })],
        engagements: [],
      },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(report.findings.some((f) => f.severity === "warning" && f.message.includes('calls this email "Priya Menon"'))).toBe(true);
  });
});

// ── Portal Invite ────────────────────────────────────────────────────────────

describe("the Portal Invite column", () => {
  it("plans an invite for TRUE with a valid email, and counts it", () => {
    const report = validateImport(
      { clients: [client({ portalInviteRaw: "TRUE", portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(report.counts.portalInvitesToSend).toBe(1);
    expect(report.portalInvites).toEqual([
      { clientLineNo: 2, clientName: "Cobalt Foods Private Limited", clientPartyId: null, email: "priya.menon@cobalt.test" },
    ]);
  });

  it("reads TRUE/FALSE case-insensitively and trims it", () => {
    const report = validateImport(
      { clients: [client({ portalInviteRaw: " true ", portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(report.counts.portalInvitesToSend).toBe(1);
  });

  it("sends nothing for FALSE or blank, even with an email given", () => {
    const withFalse = validateImport(
      { clients: [client({ portalInviteRaw: "FALSE", portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(withFalse.blocking).toBe(0);
    expect(withFalse.counts.portalInvitesToSend).toBe(0);
    expect(withFalse.portalInvites).toEqual([]);

    const blank = validateImport(
      { clients: [client({ portalInviteRaw: null, portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blank.counts.portalInvitesToSend).toBe(0);
  });

  it("refuses a value that is not TRUE or FALSE, naming it", () => {
    const report = validateImport(
      { clients: [client({ portalInviteRaw: "yes please" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(report)).toContain('Portal Invite "yes please" is not TRUE or FALSE');
    expect(report.counts.portalInvitesToSend).toBe(0);
  });

  it("refuses TRUE with no email — nobody to send the login to", () => {
    const report = validateImport(
      { clients: [client({ portalInviteRaw: "TRUE", portalEmail: null })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(report)).toContain(
      "Portal Invite is TRUE but no Portal Email is given, so there is nobody to send the login to",
    );
  });

  it("refuses TRUE with a malformed email", () => {
    const report = validateImport(
      { clients: [client({ portalInviteRaw: "TRUE", portalEmail: "not-an-email" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(blockingMessages(report)).toContain('Portal Email "not-an-email" is not an email address');
  });

  it("still plans the invite when the client is already on file", () => {
    const onFile = { partyId: "party-cobalt", displayName: "Cobalt Foods Private Limited", registered: true, jurisdiction: "IN", billToPartyId: "party-cobalt", archived: false };
    const report = validateImport(
      { clients: [client({ portalInviteRaw: "TRUE", portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot({ byIdentifier: new Map([["pan:AAACC1234F", onFile]]) }),
    );
    expect(report.rows[0]?.action).toBe("skip");
    expect(report.portalInvites).toEqual([
      { clientLineNo: 2, clientName: "Cobalt Foods Private Limited", clientPartyId: "party-cobalt", email: "priya.menon@cobalt.test" },
    ]);
  });

  it("plans no invite for a client blocked for an unrelated reason", () => {
    const report = validateImport(
      { clients: [client({ entityType: null, portalInviteRaw: "TRUE", portalEmail: "priya.menon@cobalt.test" })], people: [], engagements: [] },
      snapshot(),
    );
    expect(report.blocking).toBeGreaterThan(0);
    expect(report.portalInvites).toEqual([]);
  });
});

// ── Engagements and letters ──────────────────────────────────────────────────

describe("an engagement row", () => {
  it("becomes a line on one signed letter per client and currency, dated from its start", () => {
    const report = validateImport(
      { clients: [client({ signatory: "Priya Menon" })], people: [], engagements: [engagement(), engagement({ lineNo: 3, serviceCode: "H1", billed: "quarterly", fee: null })] },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(report.letters).toHaveLength(1);
    expect(report.letters[0]).toMatchObject({
      clientName: "Cobalt Foods Private Limited",
      clientLineNo: 2,
      jurisdiction: "IN",
      currency: "INR",
      effectiveFrom: "2025-04-01",
      signatory: "Priya Menon",
    });
    expect(report.letters[0]?.lines.map((l) => [l.serviceCode, l.billingFrequency, l.unitAmount])).toEqual([
      ["A1", "monthly", "6000"],
      ["H1", "quarterly", null],
    ]);
    expect(report.counts).toMatchObject({ engagementsToCreate: 2, lettersToDraft: 1 });
  });

  it("names the signatory as on the paper letter when the sheet gives none", () => {
    const report = validateImport({ clients: [client()], people: [], engagements: [engagement()] }, snapshot());
    expect(report.letters[0]?.signatory).toBe(MIGRATED_SIGNATORY);
  });

  it("puts two currencies on one client on ONE letter, its lines in their own (0345)", () => {
    const report = validateImport(
      { clients: [client()], people: [], engagements: [engagement(), engagement({ lineNo: 3, serviceCode: "H1", billed: "monthly", fee: "500", currency: "usd" })] },
      snapshot(),
    );
    expect(report.letters).toHaveLength(1);
    // The firm's own currency is the main one when any line is in it.
    expect(report.letters[0]?.currency).toBe("INR");
    expect(report.letters[0]?.lines.map((l) => l.currency).sort()).toEqual(["INR", "USD"]);
  });

  it("makes the most common currency the main one when none is the firm's", () => {
    expect(mainCurrency(["USD", "AED", "USD"], "INR")).toBe("USD");
    expect(mainCurrency(["USD", "AED"], "INR")).toBe("AED");
    expect(mainCurrency(["AED", "INR"], "INR")).toBe("INR");
  });

  it("bills a group's company on the group's letter, under the group's own country", () => {
    const report = validateImport(
      {
        clients: [
          client({ legalName: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }),
          client({ lineNo: 3, legalName: "Kaveri Foods", group: "Kaveri Group", identifiers: [] }),
        ],
        people: [],
        engagements: [engagement({ company: "Kaveri Foods" })],
      },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(report.letters[0]).toMatchObject({ clientName: "Kaveri Group", clientLineNo: 2, jurisdiction: "IN" });
    expect(report.letters[0]?.lines[0]).toMatchObject({ entityName: "Kaveri Foods", entityLineNo: 3 });
  });

  it("refuses a service the catalogue lacks, a future start, a fee with no currency, and a frequency it does not know", () => {
    const report = validateImport(
      {
        clients: [client()],
        people: [],
        engagements: [
          engagement({ serviceCode: "Z9" }),
          engagement({ lineNo: 3, serviceCode: "H1", startedOn: "2027-01-01", billed: "weekly", currency: null }),
        ],
      },
      snapshot(),
    );
    const messages = blockingMessages(report);
    expect(messages).toContain('no live service with the code "Z9" in the catalogue');
    expect(messages).toContain("Started On 2027-01-01 is in the future. A migrated engagement is one the firm is already delivering");
    expect(messages).toContain('Billed "weekly" is not one_time, monthly, quarterly, annually or custom');
    expect(messages).toContain("has a Fee with no Currency. Say which currency the fee is in");
  });

  it("refuses a blank Billed when the service states no recurrence", () => {
    const report = validateImport({ clients: [client()], people: [], engagements: [engagement({ serviceCode: "H1" })] }, snapshot());
    expect(blockingMessages(report)).toContain('Billed is blank and the service "Payroll" states no recurrence. Say how this one is billed');
  });

  it("refuses a company with no registration — a line names a legal entity", () => {
    const report = validateImport(
      {
        clients: [client({ legalName: "Kaveri Group", jurisdiction: null, entityType: null, identifiers: [] }), client({ lineNo: 3, legalName: "Kaveri Foods", group: "Kaveri Group", identifiers: [] })],
        people: [],
        engagements: [engagement({ company: "Kaveri Group" })],
      },
      snapshot(),
    );
    expect(blockingMessages(report)[0]).toMatch(/has no registration. A letter line names a legal entity/);
  });

  it("refuses the whole letter when the firm's clause library cannot cover its country", () => {
    const report = validateImport(
      { clients: [client({ jurisdiction: "SG", entityType: "pte_ltd", identifiers: [] })], people: [], engagements: [engagement()] },
      snapshot(),
    );
    expect(blockingMessages(report)[0]).toMatch(/no clause in the firm's library applies to SG/);
    expect(report.letters).toHaveLength(0);
    expect(report.rows.find((r) => r.sheet === "engagements")?.action).toBe("blocked");
    expect(report.counts).toMatchObject({ engagementsToCreate: 0, engagementsBlocked: 1 });
  });

  it("warns about a missing fee and about a Dept with no SPOC on the client", () => {
    const report = validateImport(
      { clients: [client({ spocs: [] })], people: [], engagements: [engagement({ fee: null, currency: null })] },
      snapshot(),
    );
    expect(report.blocking).toBe(0);
    expect(warningMessages(report)).toContain("no Fee. The line will read 'as per the paper letter' and carry no amount");
    expect(warningMessages(report)).toContain('GST filing is TRC\'s work and "Cobalt Foods Private Limited" names no SPOC for TRC');
  });

  it("skips an engagement the entity already has in force, on a re-run", () => {
    const onFile = { partyId: "party-cobalt", displayName: "Cobalt Foods Private Limited", registered: true, jurisdiction: "IN", billToPartyId: "party-cobalt", archived: false };
    const report = validateImport(
      { clients: [client()], people: [], engagements: [engagement()] },
      snapshot({ byIdentifier: new Map([["pan:AAACC1234F", onFile]]), activeEngagements: new Set(["party-cobalt:svc-a1"]) }),
    );
    expect(report.blocking).toBe(0);
    expect(report.rows.find((r) => r.sheet === "engagements")).toMatchObject({ action: "skip", detail: "GST filing already in force" });
    expect(report.letters).toHaveLength(0);
  });

  it("writes a letter for an entity already on file, billed through its group parent", () => {
    const parent: KnownOrganization = { partyId: "party-kaveri", displayName: "Kaveri Group", registered: false, jurisdiction: null, billToPartyId: "party-kaveri", archived: false };
    const sub: KnownOrganization = { partyId: "party-foods", displayName: "Kaveri Foods", registered: true, jurisdiction: "IN", billToPartyId: "party-kaveri", archived: false };
    const report = validateImport(
      { clients: [], people: [], engagements: [engagement({ company: "Kaveri Foods" })] },
      snapshot({ byName: new Map([["kaveri group", parent], ["kaveri foods", sub]]) }),
    );
    expect(report.blocking).toBe(0);
    expect(report.letters[0]).toMatchObject({ clientName: "Kaveri Group", clientPartyId: "party-kaveri", clientLineNo: null, jurisdiction: "IN" });
    expect(report.letters[0]?.lines[0]).toMatchObject({ entityPartyId: "party-foods", entityLineNo: null });
  });

  it("warns, once for the file, when engagements predate the calendar's reach-back and no floor is set", () => {
    const withFloor = validateImport({ clients: [client()], people: [], engagements: [engagement()] }, snapshot());
    expect(withFloor.compliance).toEqual({ floor: "2026-04-01", reachBackFrom: "2026-06-09", engagementsBeforeReachBack: 1 });
    expect(withFloor.findings.filter((f) => f.name === "Compliance calendar")).toHaveLength(0);

    const noFloor = validateImport({ clients: [client()], people: [], engagements: [engagement()] }, snapshot({ complianceFloor: null }));
    const finding = noFloor.findings.find((f) => f.name === "Compliance calendar");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toMatch(/1 engagement started before 2026-06-09/);
  });
});
