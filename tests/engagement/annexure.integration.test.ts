// 0083's database half — the Annexure letter and the fee group, against a real
// Postgres. Each property here is one a fake could only pretend to have:
//
//   THE WALLS. A grouped line has no price of its own, a line cannot be priced by
//   another letter's group, a group still pricing services cannot be struck off,
//   a proposal carries no cover letter — refused by the schema, for every
//   writer, not only by the service.
//
//   THE FREEZE reaches a fee group and a letter's layout the day they exist.
//
//   THE ARITHMETIC. A group's fee is counted once in a letter's totals, and in
//   MRR it is shared across the engagements it covers so that the shares add up
//   to the fee EXACTLY.
//
//   THE DOCUMENT. A letter written the way the firm's own July 2026 letter is —
//   four companies, a one-off section and a retainer — prints as a cover letter,
//   Annexure 1 and Annexure 2, and the PDF is a pure function of it.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FeeGroupEmpty, FeeGroupNotEmpty } from "../../src/domain/engagement/errors";
import type { Flow } from "../../src/domain/render/model";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeAcceptedQuotes } from "../../src/testfakes/engagement";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: new PostgresMembershipRepository(app),
  axes: new PostgresServiceAxisRepository(app),
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
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  standardBlocks: new PostgresStandardBlockRepository(app),
  blocks: new PostgresDocumentBlockRepository(app),
  ids: systemIds,
  events: ledger,
});
const letters = new PostgresEngagementRepository(app);

/** The firm's standing signatory — a user this file creates, answered through
 *  the port rather than the tenancy service, whose provisioning is not what is
 *  being tested here. */
let signatoryUserId = "";
const service = new EngagementService({
  letters,
  library: configRepository,
  documents,
  firm: {
    firmSignatory: () =>
      Promise.resolve(signatoryUserId === "" ? null : { userId: signatoryUserId, title: "Director" }),
  },
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(app),
  quotes: new FakeAcceptedQuotes(),
  structure: new PostgresRelationshipRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  signatures: new PostgresSignatureRequestRepository(app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});
const source = new PostgresRenderSource(app, () => Promise.resolve(null));

const stamp = Date.now().toString(36);
let tenant = "";
let mydojo = "";
let prepworks = "";
let mathsGenie = "";
let hongKong = "";
let bowen = "";
const services: Record<string, string> = {};
const clauses: string[] = [];

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`annexure-${stamp}`}, 'Annexure Test', 'USD') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await documentRepository.seedFirmEntity(tenant, "10X Global Inc.");

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`skohli-${stamp}@example.test`}, 'Siddharth Kohli') RETURNING id
  `;
  if (!user) throw new Error("could not create the signatory");
  signatoryUserId = user.id;

  const org = async (legalName: string): Promise<string> =>
    (await party.createOrganization({ tenantId: tenant, legalName }, SYSTEM_ACTOR)).partyId;
  mydojo = await org("MyDojo, Inc.");
  prepworks = await org("PrepWorks");
  mathsGenie = await org("Maths Genie");
  hongKong = await org("MyDojo HK Limited");
  bowen = (await party.createPerson({ tenantId: tenant, fullName: "Bowen Liu" }, SYSTEM_ACTOR)).partyId;
  for (const company of [prepworks, mathsGenie, hongKong]) {
    await party.addRelationship(
      { tenantId: tenant, fromPartyId: mydojo, toPartyId: company, type: "parent_of", validFrom: "2024-01-01" },
      SYSTEM_ACTOR,
    );
  }
  await party.addRelationship(
    { tenantId: tenant, fromPartyId: bowen, toPartyId: mydojo, type: "director_of", validFrom: "2024-01-01" },
    SYSTEM_ACTOR,
  );

  const publish = async (key: string, body: Record<string, unknown>): Promise<string> => {
    const defined = await config.define(
      { tenantId: tenant, kind: "service", key, body: { billingBasis: "fixed", ...body } },
      SYSTEM_ACTOR,
    );
    await config.publish({ tenantId: tenant, kind: "service", key, version: 1 }, SYSTEM_ACTOR);
    return defined.draft.id;
  };
  services["cleanup"] = await publish("cleanup", {
    name: "Historical Transaction Review & Accounting Cleanup",
    recurrence: "one_time",
    scope:
      "- Review all financial transactions for FY2024 and FY2025.\n" +
      "- Reconcile transactions and recategorise entries into a standardised Chart of Accounts.",
  });
  services["tax2025"] = await publish("tax2025", {
    name: "Corporate Tax Compliance (FY2025)",
    recurrence: "one_time",
    scope: "- Prepare and file the corporate income tax return for FY2025.",
  });
  services["cas"] = await publish("cas", {
    name: "Accounting / CAS",
    recurrence: "monthly",
    scope: "- Daily bookkeeping across the group's bank accounts.\n- Monthly financial statements.",
    clientObligations: "- Provide timely bank and Stripe access.",
    exclusions: "- Statutory audit.",
  });
  services["tax"] = await publish("tax", {
    name: "Tax",
    recurrence: "annually",
    scope: "- Corporate tax filings in each jurisdiction.",
  });
  services["agent"] = await publish("agent", { name: "Registered agent", recurrence: "annually" });

  for (const [key, title, text] of [
    ["services", "Services", "Scope of Services requested by you is mentioned in Annexure 1."],
    ["fees", "Fees, Invoice & Payments", "Fees shall be as specifically mentioned in Annexure 1."],
  ] as const) {
    const defined = await config.define(
      { tenantId: tenant, kind: "clause", key, body: { title, text, jurisdictions: [] } },
      SYSTEM_ACTOR,
    );
    await config.publish({ tenantId: tenant, kind: "clause", key, version: 1 }, SYSTEM_ACTOR);
    clauses.push(defined.draft.id);
  }

  // The firm's STANDARD cover and acceptance, which every new letter copies.
  let order = 0;
  for (const [kind, body] of [
    ["cover", "This Engagement Letter confirms that you have engaged us to provide the services described in Annexure 1."],
    ["cover", "Please sign this letter in the space provided below to indicate your agreement."],
    ["acceptance", "The scope of the Services is sufficient for our purposes and the terms of this engagement are accepted."],
    ["commercial", "All fees are exclusive of applicable taxes."],
    ["exclusion", "Support in due diligence, investment rounds and M&A."],
  ] as const) {
    order += 1;
    await documents.addStandardBlock({ tenantId: tenant, kind, body, sortOrder: order }, SYSTEM_ACTOR);
  }
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** A draft written the way the firm's own July 2026 letter is: a one-off
 *  section for the parent, a retainer across all four companies, and one
 *  service priced on its own. */
async function mydojoLetter(): Promise<{
  id: string;
  a: string;
  b: string;
  lines: Record<string, string>;
}> {
  const letter = await service.draft(
    {
      tenantId: tenant,
      partyId: mydojo,
      jurisdiction: "US",
      title: "Engagement Letter for MyDojo, Inc.",
      currency: "USD",
      fxRate: "1",
      fxRateDate: "2026-06-28",
      advanceRequired: true,
      advanceAmount: "16000",
      background: "MyDojo, Inc. is the US parent of the RevisionDojo and OnePrep platforms.",
      addressedToPartyId: bowen,
      issuedOn: "2026-06-28",
      effectiveFrom: "2026-07-01",
    },
    SYSTEM_ACTOR,
  );
  const a = await service.addFeeGroup(tenant, letter.id, {
    title: "One-Time Initial Activities",
    billingFrequency: "one_time",
    amount: "40000",
    paymentTerms: "40% advance, 60% on completion",
    feeDescription: "One-time scope: historical review, cleanup and FY2025 corporate tax filing.",
    intro: "The one-time activities cover MyDojo, Inc. for FY2024 and FY2025.",
    deliverables: "- Cleaned, reconciled FY2024–FY2025 books.",
    clientObligations: "- Provide complete access to bank statements and records.",
  });
  const b = await service.addFeeGroup(tenant, letter.id, {
    title: "Ongoing Recurring Services",
    billingFrequency: "monthly",
    amount: "5000",
  });
  const lines: Record<string, string> = {};
  const add = async (
    name: string,
    service_: string,
    entity: string,
    description: string,
    feeGroupId?: string,
  ): Promise<void> => {
    const line = await service.addLine({
      tenantId: tenant,
      letterId: letter.id,
      entityPartyId: entity,
      serviceVersionId: services[service_] ?? "",
      description,
      quantity: "1",
      discountPercent: "0",
      ...(feeGroupId === undefined ? { unitAmount: "300" } : { feeGroupId }),
    });
    lines[name] = line.id;
  };
  await add("cleanup", "cleanup", mydojo, "Historical Transaction Review & Accounting Cleanup", a.id);
  await add("tax2025", "tax2025", mydojo, "Corporate Tax Compliance (FY2025)", a.id);
  for (const [name, entity] of [
    ["cas-us", mydojo],
    ["cas-prep", prepworks],
    ["cas-mg", mathsGenie],
    ["cas-hk", hongKong],
  ] as const) {
    await add(name, "cas", entity, "Accounting / CAS", b.id);
  }
  await add("tax-us", "tax", mydojo, "Tax", b.id);
  await add("tax-prep", "tax", prepworks, "Tax", b.id);
  await add("agent", "agent", mydojo, "Registered agent");
  for (const clause of clauses) await service.addClause(tenant, letter.id, clause);
  return { id: letter.id, a: a.id, b: b.id, lines };
}

describe("an Annexure letter and its fee groups, in the database (0083)", () => {
  it("drafts every new letter in the Annexure layout", async () => {
    const { id } = await mydojoLetter();
    const [row] = await owner<{ layout: string }[]>`
      SELECT layout FROM crm.engagement_letter WHERE id = ${id}
    `;
    expect(row?.layout).toBe("annexure");
  });

  it("counts each group's fee ONCE and does not call its services unpriced", async () => {
    const { id, a, b, lines } = await mydojoLetter();
    const record = await letters.describeLetter(tenant, id);

    expect(record?.feeGroups.map((g) => [g.code, g.group.title])).toEqual([
      ["A", "One-Time Initial Activities"],
      ["B", "Ongoing Recurring Services"],
    ]);
    expect(record?.feeGroups[0]?.lineIds).toEqual([lines["cleanup"], lines["tax2025"]]);
    expect(record?.feeGroups[1]?.lineIds).toHaveLength(6);
    // 40,000 + 5,000 + the one line priced on its own.
    expect(Number(record?.totals.net)).toBe(45300);
    expect(record?.totals.unpricedLineCount).toBe(0);
    // Grouped lines carry no price of their own.
    const grouped = record?.lines.filter((l) => l.line.feeGroupId !== null) ?? [];
    expect(grouped.every((l) => l.line.unitAmount === null && l.net === null)).toBe(true);
    expect(grouped.every((l) => l.line.feeGroupId === a || l.line.feeGroupId === b)).toBe(true);

    const [summary] = (await letters.listLetters(tenant, {})).filter((s) => s.letter.id === id);
    expect(Number(summary?.totals.net)).toBe(45300);
  });

  it("re-letters the sections when one is struck off, and refuses to strike one that prices services", async () => {
    const { id, a } = await mydojoLetter();
    const spare = await service.addFeeGroup(tenant, id, {
      title: "Spare",
      billingFrequency: "custom",
      amount: "1",
    });

    await expect(service.removeFeeGroup(tenant, id, a)).rejects.toBeInstanceOf(FeeGroupNotEmpty);
    // The WALL, for a writer that is not the service.
    await expect(
      owner`UPDATE crm.engagement_letter_fee_group SET removed_at = now() WHERE id = ${a}`,
    ).rejects.toThrow(/still covers 2 live service/);

    // An empty group cannot go out — a fee for nothing.
    await expect(service.send(tenant, id, SYSTEM_ACTOR)).rejects.toBeInstanceOf(FeeGroupEmpty);
    await service.removeFeeGroup(tenant, id, spare.id);
    const record = await letters.describeLetter(tenant, id);
    expect(record?.feeGroups.map((g) => g.code)).toEqual(["A", "B"]);
  });

  it("moves a service into a group and out again, price and all", async () => {
    const { id, a, lines } = await mydojoLetter();
    const agent = lines["agent"] ?? "";

    const grouped = await service.setLinePricing({
      tenantId: tenant,
      letterId: id,
      lineId: agent,
      feeGroupId: a,
    });
    expect([grouped.feeGroupId, grouped.unitAmount, grouped.pricingNote]).toEqual([a, null, null]);

    const alone = await service.setLinePricing({
      tenantId: tenant,
      letterId: id,
      lineId: agent,
      feeGroupId: null,
      unitAmount: "450",
    });
    expect([alone.feeGroupId, alone.unitAmount]).toEqual([null, "450.0000"]);
  });

  it("refuses, in the schema, a grouped line with a price and a line priced by another letter's group", async () => {
    const first = await mydojoLetter();
    const second = await mydojoLetter();

    await expect(
      owner`UPDATE crm.engagement_letter_line SET unit_amount = 1 WHERE id = ${first.lines["cas-us"] ?? ""}`,
    ).rejects.toThrow(/el_line_grouped_is_unpriced_chk/);
    await expect(
      owner`UPDATE crm.engagement_letter_line SET fee_group_id = ${second.b}
            WHERE id = ${first.lines["cas-us"] ?? ""}`,
    ).rejects.toThrow(/el_line_fee_group_fkey/);
  });

  it("refuses a live service in a struck-off group", async () => {
    const { id, lines } = await mydojoLetter();
    const spare = await service.addFeeGroup(tenant, id, {
      title: "Spare",
      billingFrequency: "monthly",
      amount: "1",
    });
    await service.removeFeeGroup(tenant, id, spare.id);
    await expect(
      owner`UPDATE crm.engagement_letter_line SET fee_group_id = ${spare.id}, unit_amount = NULL
            WHERE id = ${lines["agent"] ?? ""}`,
    ).rejects.toThrow(/has been struck off/);
  });

  it("keeps the cover letter and the acceptance off a proposal", async () => {
    // No proposal is needed to prove the rule: the CHECK is on the block row,
    // and a CHECK is evaluated before the foreign key would look for one.
    for (const kind of ["cover", "acceptance"]) {
      await expect(
        owner`INSERT INTO crm.document_block (tenant_id, proposal_id, kind, body, sort_order)
              VALUES (${tenant}, ${"00000000-0000-0000-0000-000000000000"}, ${kind}, 'x', 1)`,
      ).rejects.toThrow(/document_block_letter_only_kinds_chk/);
    }
  });

  it("copies the firm's cover and acceptance onto a new letter", async () => {
    const { id } = await mydojoLetter();
    const blocks = await documents.listBlocks(tenant, { kind: "engagement_letter", id });
    expect(blocks.filter((b) => b.kind === "cover")).toHaveLength(2);
    expect(blocks.filter((b) => b.kind === "acceptance")).toHaveLength(1);
  });
});

describe("signing an Annexure letter (0083)", () => {
  it("freezes its groups and its layout, and fans out one engagement per line", async () => {
    const { id, b } = await mydojoLetter();
    await service.send(tenant, id, SYSTEM_ACTOR);
    const signed = await service.sign(
      { tenantId: tenant, letterId: id, signedByName: "Bowen Liu", reference: "paper-mydojo" },
      SYSTEM_ACTOR,
    );
    expect(signed.engagements).toHaveLength(9);

    await expect(
      owner`UPDATE crm.engagement_letter_fee_group SET amount = 1 WHERE id = ${b}`,
    ).rejects.toThrow(/signed/);
    await expect(
      owner`UPDATE crm.engagement_letter SET layout = 'classic' WHERE id = ${id}`,
    ).rejects.toThrow(/layout/);
  });

  it("shares a retainer across its engagements in MRR so the shares add up to the fee exactly", async () => {
    const { id } = await mydojoLetter();
    await service.send(tenant, id, SYSTEM_ACTOR);
    await service.sign(
      { tenantId: tenant, letterId: id, signedByName: "Bowen Liu", reference: "paper-mrr" },
      SYSTEM_ACTOR,
    );
    // MRR counts ACTIVE engagements, which every signed one is since 0322 (the
    // advance no longer holds the work).

    const rows = await owner<
      { excluded_because: string | null; billing_frequency: string; monthly_amount: string | null }[]
    >`
      SELECT m.excluded_because, m.billing_frequency, m.monthly_amount::text
      FROM crm.engagement_mrr m
      JOIN crm.engagement e ON e.id = m.engagement_id
      WHERE e.engagement_letter_id = ${id}
    `;
    const retainer = rows.filter((r) => r.billing_frequency === "monthly");
    expect(retainer).toHaveLength(6);
    // 5,000 over six engagements: five of 833.3333 and one of 833.3335.
    const cents = retainer.reduce((sum, r) => sum + Math.round(Number(r.monthly_amount) * 10000), 0);
    expect(cents).toBe(5000 * 10000);
    // The one-off section is one-off, whatever its services' own recurrence.
    expect(rows.filter((r) => r.excluded_because === "one_time")).toHaveLength(2);
  });
});

describe("what an Annexure letter PRINTS (0083)", () => {
  const text = (flow: readonly Flow[]): string[] =>
    flow.flatMap((f) =>
      f.kind === "heading" || f.kind === "paragraph"
        ? [f.text]
        : f.kind === "table"
          ? f.table.rows.map((r) => r.join(" | "))
          : f.rows.map((r) => `${r.label}: ${r.value}`),
    );

  it("prints a cover letter, Annexure 1 by section, and the numbered terms", async () => {
    const { id } = await mydojoLetter();
    await service.send(tenant, id, SYSTEM_ACTOR);

    const described = await source.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: id });
    const letter = described?.document.annexureLetter;
    if (letter === undefined) throw new Error("an Annexure letter printed no annexures");

    expect(letter.cover.addressee).toEqual(["Bowen Liu", "MyDojo, Inc."]);
    expect(letter.cover.subject).toBe(
      "Subject: Engagement Letter for MyDojo, Inc. — period commencing 1 July 2026",
    );
    expect(letter.cover.salutation).toBe("Dear Bowen Liu,");
    expect(text(letter.cover.body)).toHaveLength(2);
    expect(letter.cover.firm?.lines).toEqual([
      "Siddharth Kohli",
      "Director",
      `skohli-${stamp}@example.test`,
    ]);
    expect(letter.cover.client.heading).toBe(
      "Accepted for and on behalf of MyDojo, Inc., for itself and on behalf of PrepWorks, " +
        "Maths Genie and MyDojo HK Limited",
    );

    const [scope, terms] = letter.annexures;
    const annexure1 = text(scope?.flow ?? []);
    expect(annexure1).toEqual(
      expect.arrayContaining([
        "Background",
        "A. One-Time Initial Activities",
        "A1. Historical Transaction Review & Accounting Cleanup",
        "A2. Corporate Tax Compliance (FY2025)",
        "Deliverables",
        "B. Ongoing Recurring Services",
        // One item for four companies, naming them.
        "B1. Accounting / CAS",
        "For MyDojo, Inc., PrepWorks, Maths Genie and MyDojo HK Limited.",
        "B2. Tax",
        "For MyDojo, Inc. and PrepWorks.",
        "C. Other services",
        "C1. Registered agent",
        "Summary of Fees",
        "A | One-time scope: historical review, cleanup and FY2025 corporate tax filing. | One-off | USD 40,000.00\n(40% advance, 60% on completion)",
        "B | Ongoing Recurring Services: Accounting / CAS, Tax | Monthly; starting from 1 July 2026 | USD 5,000.00 per month",
        "C1 | Registered agent (MyDojo, Inc.) | Annually; starting from 1 July 2026 | USD 300.00 per year",
        "Advance, payable before work begins: USD 16,000.00",
        "Commercials",
        "General scope exclusions",
      ]),
    );
    expect(text(terms?.flow ?? [])).toEqual([
      "1. Services",
      "Scope of Services requested by you is mentioned in Annexure 1.",
      "2. Fees, Invoice & Payments",
      "Fees shall be as specifically mentioned in Annexure 1.",
    ]);
  });

  it("renders to the same bytes every time", async () => {
    const { id } = await mydojoLetter();
    await service.send(tenant, id, SYSTEM_ACTOR);
    const described = await source.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: id });
    if (described === null) throw new Error("no letter");

    const renderer = new PdfLibRenderer();
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    const first = await renderer.render(described.document);
    const second = await renderer.render(described.document);

    expect(new TextDecoder().decode(first.slice(0, 5))).toBe("%PDF-");
    expect(sha(first)).toBe(sha(second));
  });
});
