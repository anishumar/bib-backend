// G2.1–G2.3's acceptance, against real Postgres — the two halves that only a
// database can settle.
//
//   REVENUE GROUPS BY DEPT. `module` is a reporting axis, and a reporting axis
//   is a claim about a GROUP BY, not about a TypeScript type. This walks the
//   real join a dashboard would: priced proposal lines → the catalogue version
//   each line is PINNED to → `body->>'module'`. A unit test cannot make that
//   claim, because the thing being tested is that the value stored verbatim in
//   jsonb groups correctly in SQL.
//
//   A PIN KEEPS ITS SLA. T3.1 copies `slaDays` onto a work item at creation
//   precisely so a later catalogue revision cannot make finished work
//   retroactively late. That promise rests on the freeze trigger in migration
//   0005, so it is proven here by revising the service and then reading the old
//   version back — and by trying to edit the frozen body directly, which is the
//   attack the trigger exists for.
//
//   AND IT IS SERVED ON THE LINE. Every assertion in this file used to resolve
//   the pin BY HAND — `config.readPinned` then `readServiceBody` — which is the
//   registry call per line that G2.1 left every consumer to make. The last test
//   in the SLA section reads the same value off `proposals.describe`, which is
//   the join that closes that gap.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: published config versions cannot be deleted, by any role —
// that is the property, not an oversight. Tenants are uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { DocumentService } from "../../src/usecase/document/service";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { readServiceBody } from "../../src/domain/config/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: new PostgresMembershipRepository(app),
  ids: systemIds,
  events: ledger,
});
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});
// G1.1/G1.2: a proposal now carries a reference and names the entity issuing
// it, both behind quoting's own narrow port. The real adapter, because a
// proposal that cannot be drafted proves nothing about the catalogue.
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  ids: systemIds,
  events: ledger,
});
const proposals = new ProposalService({
  proposals: new PostgresProposalRepository(app),
  catalogue: configRepository,
  policies: configRepository,
  documents,
  shareTokens: new RandomTokenFactory(),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = String(Date.now());
let tenant = "";
let client = "";

/** The three catalogue rows, across two Depts. FINCOMPLIANCE appears under both
 *  FRC and TRC — the case that makes module and group independent dimensions
 *  rather than a hierarchy, and the one a naive `GROUP BY group` would get
 *  wrong. */
const CATALOGUE = [
  {
    key: "gst-filing",
    body: {
      name: "GST monthly filing",
      ref: "A1",
      module: "TRC",
      group: "FINCOMPLIANCE",
      billingBasis: "fixed",
      recurrence: "monthly",
      slaDays: 7,
      listPrice: { amount: "25000.00", currency: "INR" },
      scope: "Preparation and filing of GSTR-1 and GSTR-3B for one GSTIN.",
      clientObligations: "Books and bank statements shared by the 5th of each month.",
      volumeLimits: "Under 1,000 entries per month; under 8 bank accounts.",
      exclusions: "Departmental representation, appeals and litigation support.",
    },
  },
  {
    key: "bookkeeping",
    body: {
      name: "Bookkeeping and management reporting",
      ref: "H1",
      module: "FRC",
      group: "FINCOMPLIANCE",
      billingBasis: "retainer",
      recurrence: "monthly",
      slaDays: 15,
      listPrice: { amount: "40000.00", currency: "INR" },
    },
  },
  {
    key: "internal-audit",
    body: {
      name: "Internal audit",
      ref: "R7",
      module: "RAA",
      group: "VCFO CONSOLE",
      billingBasis: "fixed",
      recurrence: "annually",
      slaDays: null,
      listPrice: null,
      pricingNote: "As mutually agreed",
    },
  },
];

/** version.id per key, as published — what a proposal line pins to. */
const pinned = new Map<string, string>();

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`catalogue-test-${stamp}`}, 'Catalogue Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await config.seedDefaultRoles(tenant, SYSTEM_ACTOR);
  // G1.2: `issuing_entity_party_id` is NOT NULL on a proposal, so a firm with no
  // entity of its own and no fallback cannot draft one at all. This tenant is
  // made by raw SQL rather than through TenancyService, so it does not get the
  // seeding provisioning does — and a catalogue test that cannot quote anything
  // would be testing nothing.
  await documentRepository.seedFirmEntity(tenant, "Catalogue Test");

  client = (
    await party.createOrganization(
      { tenantId: tenant, legalName: "Meridian Textiles Private Limited" },
      SYSTEM_ACTOR,
    )
  ).partyId;

  for (const row of CATALOGUE) {
    const defined = await config.define(
      { tenantId: tenant, kind: "service", key: row.key, body: row.body },
      SYSTEM_ACTOR,
    );
    await config.publish(
      { tenantId: tenant, kind: "service", key: row.key, version: 1 },
      SYSTEM_ACTOR,
    );
    pinned.set(row.key, defined.draft.id);
  }
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the catalogue survives the round trip through jsonb", () => {
  it("hands back the firm's own words, character for character", async () => {
    // Verbatim storage is what the whole design leans on: the four scope blocks
    // are assembled into an engagement letter, and a body Postgres reformatted
    // on the way in would change what a signed document says.
    const version = await config.readPinned(tenant, pinned.get("gst-filing") ?? "");
    const stored = readServiceBody(version.body);
    expect(stored.volumeLimits).toBe("Under 1,000 entries per month; under 8 bank accounts.");
    expect(stored.clientObligations).toBe(
      "Books and bank statements shared by the 5th of each month.",
    );
    expect(stored.ref).toBe("A1");
    expect(stored.module).toBe("TRC");
    expect(stored.group).toBe("FINCOMPLIANCE");
    expect(stored.recurrence).toBe("monthly");
  });

  it("keeps a null price with its reason", async () => {
    const version = await config.readPinned(tenant, pinned.get("internal-audit") ?? "");
    const stored = readServiceBody(version.body);
    expect(stored.listPrice).toBeNull();
    // The point of the field: null said there was no price and could not say why.
    expect(stored.pricingNote).toBe("As mutually agreed");
  });
});

describe("revenue groups by Dept", () => {
  it("splits a proposal's money across FRC, TRC and RAA", async () => {
    // The real join a dashboard walks: a priced line → the catalogue version it
    // is PINNED to → that version's module. Pinned rather than live on purpose —
    // revenue is reported against the Dept the work was SOLD under, and a
    // service refiled into another Dept next year must not restate last year.
    const proposal = await proposals.draft(
      {
        tenantId: tenant,
        partyId: client,
        title: "Meridian — FY26",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      SYSTEM_ACTOR,
    );
    const lines: readonly [string, string, string, string][] = [
      ["gst-filing", "GST monthly filing", "12", "25000.00"],
      ["bookkeeping", "Bookkeeping and management reporting", "12", "40000.00"],
      ["internal-audit", "Internal audit", "1", "150000.00"],
    ];
    for (const [key, description, quantity, unitAmount] of lines) {
      await proposals.addLine({
        tenantId: tenant,
        proposalId: proposal.id,
        serviceVersionId: pinned.get(key) ?? "",
        description,
        quantity,
        unitAmount,
        discountPercent: "0",
      });
    }

    const byDept = await withTenant(app, tenant, (db) =>
      db<{ module: string; revenue: string }[]>`
        SELECT v.body->>'module' AS module, SUM(a.net) AS revenue
        FROM crm.proposal_line l
        JOIN crm.proposal_line_amount a ON a.id = l.id
        JOIN config.version v ON v.id = l.service_version_id
        WHERE l.proposal_id = ${proposal.id} AND l.removed_at IS NULL
        GROUP BY 1
        ORDER BY 1
      `,
    );

    expect(byDept.map((r) => r.module)).toEqual(["FRC", "RAA", "TRC"]);
    expect(byDept.map((r) => Number(r.revenue))).toEqual([480000, 150000, 300000]);
  });

  it("groups the delivery team independently of the Dept", async () => {
    // FINCOMPLIANCE delivers under both FRC and TRC. Grouping by group alone
    // must therefore pull two Depts' services into one row — which is exactly
    // why the two are separate dimensions and neither is nested under the other.
    const rows = await withTenant(app, tenant, (db) =>
      db<{ group: string; modules: string[] }[]>`
        SELECT v.body->>'group' AS group,
               array_agg(DISTINCT v.body->>'module' ORDER BY v.body->>'module') AS modules
        FROM config.version v
        JOIN config.entry e ON e.id = v.entry_id
        WHERE e.kind = 'service' AND v.status = 'published' AND v.body ? 'group'
        GROUP BY 1
        ORDER BY 1
      `,
    );
    expect(rows).toEqual([
      { group: "FINCOMPLIANCE", modules: ["FRC", "TRC"] },
      { group: "VCFO CONSOLE", modules: ["RAA"] },
    ]);
  });

  it("counts one Dept per spelling, which is what the write-time rule buys", async () => {
    // Postgres groups strings, not intentions. The canonical form is required at
    // the write because there is no place downstream to fix it: a published body
    // is frozen, and "frc" beside "FRC" would show a dashboard two half-sized
    // Depts that both look plausible.
    const [row] = await withTenant(app, tenant, (db) =>
      db<{ depts: number }[]>`
        SELECT COUNT(DISTINCT v.body->>'module')::int AS depts
        FROM config.version v
        JOIN config.entry e ON e.id = v.entry_id
        WHERE e.kind = 'service' AND v.status = 'published' AND v.body ? 'module'
      `,
    );
    expect(row?.depts).toBe(3);
  });
});

describe("slaDays off a pinned version — what T3.1 stands on", () => {
  it("still reads the old SLA after the catalogue is revised", async () => {
    // The firm tightens its GST turnaround from 7 days to 3. Work already
    // created against the old version must keep the commitment that was in
    // force, or a revision retroactively makes finished work late.
    const before = pinned.get("gst-filing") ?? "";
    await config.addVersion({
      tenantId: tenant,
      kind: "service",
      key: "gst-filing",
      body: { ...CATALOGUE[0]?.body, slaDays: 3 },
    });
    await config.publish(
      { tenantId: tenant, kind: "service", key: "gst-filing", version: 2 },
      SYSTEM_ACTOR,
    );

    const pinnedRead = await config.readPinned(tenant, before);
    expect(readServiceBody(pinnedRead.body).slaDays).toBe(7);
    expect(pinnedRead.status).toBe("archived");

    const [live] = await config.list(tenant, "service").then((rows) =>
      rows.filter((r) => r.entry.key === "gst-filing"),
    );
    expect(readServiceBody(live?.published?.body ?? {}).slaDays).toBe(3);
  });

  it("serves the pinned SLA on the LINE, without resolving the pin by hand", async () => {
    // THE GAP G2.1 LEFT, and what T3.1 is blocked on. The two assertions above
    // are the ones this file could make before the read model carried the
    // catalogue: they go `config.readPinned` → `readServiceBody`, which is the
    // registry call PER LINE that CLAUDE.md names as the sign a join belongs in
    // the query — and a work item being created has no more reason to make it
    // than a screen does.
    //
    // So: publish a service with an SLA, quote it, revise the SLA, and read the
    // LINE back. The value it reports must be the one that was in force when it
    // was quoted, because that is the commitment somebody made.
    const defined = await config.define(
      {
        tenantId: tenant,
        kind: "service",
        key: "payroll",
        body: {
          name: "Payroll processing",
          ref: "P3",
          module: "FRC",
          group: "PAYROLL",
          billingBasis: "fixed",
          recurrence: "monthly",
          slaDays: 21,
          listPrice: { amount: "12000.00", currency: "INR" },
          scope: "Monthly payroll run and payslip issue for up to 50 employees.",
          clientObligations: "Attendance and variable-pay inputs by the 25th.",
          volumeLimits: "Up to 50 employees; one pay cycle a month.",
          exclusions: "Payroll tax litigation and PF assessments.",
        },
      },
      SYSTEM_ACTOR,
    );
    await config.publish(
      { tenantId: tenant, kind: "service", key: "payroll", version: 1 },
      SYSTEM_ACTOR,
    );

    const proposal = await proposals.draft(
      {
        tenantId: tenant,
        partyId: client,
        title: "Meridian — payroll",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-06-01",
      },
      SYSTEM_ACTOR,
    );
    await proposals.addLine({
      tenantId: tenant,
      proposalId: proposal.id,
      serviceVersionId: defined.draft.id,
      description: "Payroll processing, 12 months",
      quantity: "12",
      unitAmount: "12000.00",
      discountPercent: "0",
    });

    // The firm relaxes the turnaround and rewrites the scope — AFTER the quote
    // went out.
    await config.addVersion({
      tenantId: tenant,
      kind: "service",
      key: "payroll",
      body: {
        name: "Payroll processing",
        ref: "P3",
        module: "FRC",
        group: "PAYROLL",
        billingBasis: "fixed",
        recurrence: "quarterly",
        slaDays: 45,
        listPrice: { amount: "15000.00", currency: "INR" },
        scope: "REVISED 2027: monthly payroll run for up to 80 employees.",
      },
    });
    await config.publish(
      { tenantId: tenant, kind: "service", key: "payroll", version: 2 },
      SYSTEM_ACTOR,
    );

    const record = await proposals.describe(tenant, proposal.id);
    const service = record.lines[0]?.service;
    // THE ONE T3.1 STANDS ON: 21, not 45. A work item created off this line
    // copies the commitment that was actually made.
    expect(service?.slaDays).toBe(21);
    expect(service?.version).toBe(1);
    // G2.1's acceptance, in one field: the firm's OWN code, on the document,
    // with no second call to get it.
    expect(service?.ref).toBe("P3");
    expect(service?.module).toBe("FRC");
    expect(service?.group).toBe("PAYROLL");
    expect(service?.recurrence).toBe("monthly");
    expect(service?.listPrice).toEqual({ amount: "12000.00", currency: "INR" });
    // The catalogue's own words, which is what G2.2 says a letter is assembled
    // from and what G1.6's overrides will have something to override.
    expect(service?.scope).toBe(
      "Monthly payroll run and payslip issue for up to 50 employees.",
    );
    expect(service?.scope).not.toContain("REVISED");
    expect(service?.clientObligations).toBe(
      "Attendance and variable-pay inputs by the 25th.",
    );
    expect(service?.exclusions).toBe("Payroll tax litigation and PF assessments.");

    // …and the catalogue really has moved on, so none of the above is a
    // tautology about a service nobody revised.
    const [live] = await config
      .list(tenant, "service")
      .then((rows) => rows.filter((r) => r.entry.key === "payroll"));
    expect(readServiceBody(live?.published?.body ?? {}).slaDays).toBe(45);
    expect(readServiceBody(live?.published?.body ?? {}).recurrence).toBe("quarterly");
  });

  it("cannot be edited out from under the work item that copied it", async () => {
    // The freeze, at the level the promise actually needs: not a rule in the
    // service, but a trigger that binds the psql session at 2 a.m. too.
    const err = await withTenant(app, tenant, (db) =>
      db`
        UPDATE config.version
        SET body = jsonb_set(body, '{slaDays}', '1')
        WHERE id = ${pinned.get("bookkeeping") ?? ""}
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
    expect((err as Error).message).toContain("frozen");
  });
});
