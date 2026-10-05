// T6.18 · D11 — a letter drafted from a quote carries the quote's prose.
//
// The client accepted a QUOTE whose exclusions were negotiated: one reworded,
// one written by hand, the team block struck off. Re-seeding the letter from
// the standard set threw all of that away. Against real Postgres, through
// `ProposalService` and `EngagementService.draftFromQuote`: the letter's
// exclusions, commercials and team are the quote's (bodies, headings, order),
// its cover and acceptance come from the issuer's standard set, and a line
// changed on the quote comes across marked as this client's, not as standard.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/engagement/quote-prose.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { EngagementService } from "../../src/usecase/engagement/service";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { FakeFirmSignatory } from "../../src/testfakes/engagement";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { composeProposals } from "../proposal/compose-postgres";

const c = composeProposals();
const letters = new EngagementService({
  letters: new PostgresEngagementRepository(c.app),
  library: new PostgresConfigRepository(c.app),
  documents: c.documents,
  firm: new FakeFirmSignatory(),
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(c.app),
  // The REAL quote: the proposal service over the same database.
  quotes: c.proposals,
  structure: new PostgresRelationshipRepository(c.app),
  timeZones: new PostgresFirmTimeZone(c.app),
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  signatures: new PostgresSignatureRequestRepository(c.app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: c.ledger,
});

const stamp = String(Date.now());
let tenant = "";
let client = "";
let gst = "";

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`quote-prose-${stamp}`}, 'Quote Prose Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await c.documentRepository.seedFirmEntity(tenant, "Quote Prose Test LLP");
  client = (await c.party.createClientCompany({ tenantId: tenant, legalName: "Nexus Fintech", jurisdiction: "IN", entityType: "private_limited" }, SYSTEM_ACTOR)).partyId;

  let order = 0;
  for (const [kind, body, isHeading] of [
    ["exclusion", "The scope of work does not include following-", true],
    ["exclusion", "Any certification unless included in the scope.", false],
    ["exclusion", "Representation before any authority.", false],
    ["commercial", "All fees are exclusive of taxes.", false],
    ["team", "Engagement Partner: a Qualified CA.", false],
    ["cover", "Thank you for choosing us.", false],
    ["acceptance", "We accept the terms above.", false],
  ] as const) {
    order += 1;
    await c.documents.addStandardBlock({ tenantId: tenant, kind, body, isHeading, sortOrder: order }, SYSTEM_ACTOR);
  }

  const defined = await c.config.define(
    { tenantId: tenant, kind: "service", key: "gst", body: { name: "GST returns", billingBasis: "fixed" } },
    SYSTEM_ACTOR,
  );
  await c.config.publish({ tenantId: tenant, kind: "service", key: "gst", version: 1 }, SYSTEM_ACTOR);
  gst = defined.draft.id;
});

afterAll(() => c.end());

describe("a letter from a quote carries the quote's prose (T6.18, D11)", () => {
  it("copies what the client accepted, and takes only the cover and acceptance from the standard set", async () => {
    const quote = await c.proposals.draft(
      { tenantId: tenant, partyId: client, clientJurisdiction: "IN", title: "Nexus FY27", currency: "INR", fxRate: "1", fxRateDate: "2026-09-28" },
      SYSTEM_ACTOR,
    );
    const owner = { kind: "proposal" as const, id: quote.id };
    const seeded = await c.documents.listBlocks(tenant, owner);
    const find = (body: string) => seeded.find((b) => b.body === body);

    // What the negotiation did to the quote's prose.
    await c.documents.editBlock(tenant, find("Representation before any authority.")?.id ?? "", {
      body: "Representation before any authority, other than the GST officer.",
    });
    await c.documents.addBlock({
      tenantId: tenant,
      owner,
      kind: "exclusion",
      body: "Nexus's Singapore subsidiary is out of scope.",
      sortOrder: 4,
    });
    await c.documents.removeBlock(tenant, find("Engagement Partner: a Qualified CA.")?.id ?? "");

    await c.proposals.addLine({
      tenantId: tenant,
      proposalId: quote.id,
      entityPartyId: client,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "15000",
      discountPercent: "0",
    });
    await c.proposals.send(tenant, quote.id, SYSTEM_ACTOR);
    await c.proposals.decide(tenant, quote.id, "accepted", SYSTEM_ACTOR);

    const { letter } = await letters.draftFromQuote(
      { tenantId: tenant, proposalId: quote.id, jurisdiction: "IN", advanceRequired: false },
      SYSTEM_ACTOR,
    );

    const rows = await c.owner<{ kind: string; body: string; is_heading: boolean; sort_order: number; standard: boolean }[]>`
      SELECT kind, body, is_heading, sort_order, source_id IS NOT NULL AS standard
      FROM crm.document_block
      WHERE engagement_letter_id = ${letter.id} AND removed_at IS NULL
      ORDER BY kind, sort_order
    `;
    expect(rows).toEqual([
      { kind: "acceptance", body: "We accept the terms above.", is_heading: false, sort_order: 1, standard: true },
      { kind: "commercial", body: "All fees are exclusive of taxes.", is_heading: false, sort_order: 1, standard: true },
      { kind: "cover", body: "Thank you for choosing us.", is_heading: false, sort_order: 1, standard: true },
      { kind: "exclusion", body: "The scope of work does not include following-", is_heading: true, sort_order: 1, standard: true },
      { kind: "exclusion", body: "Any certification unless included in the scope.", is_heading: false, sort_order: 2, standard: true },
      // Reworded on the quote: carried, and no longer claimed as standard.
      { kind: "exclusion", body: "Representation before any authority, other than the GST officer.", is_heading: false, sort_order: 3, standard: false },
      // Written by hand on the quote: carried.
      { kind: "exclusion", body: "Nexus's Singapore subsidiary is out of scope.", is_heading: false, sort_order: 4, standard: false },
      // The team line struck off the quote stays off the letter.
    ]);

    const [event] = await c.owner<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM ledger.event
      WHERE object_id = ${letter.id} AND verb = 'engagement_letter.drafted_from_proposal'
    `;
    expect(event?.payload).toMatchObject({ proseLinesCarried: 5 });
  });

  it("a letter drafted on its own still takes the whole standard set", async () => {
    const letter = await letters.draft(
      { tenantId: tenant, partyId: client, jurisdiction: "IN", title: "Standalone", currency: "INR", fxRate: "1", fxRateDate: "2026-09-28", advanceRequired: false },
      SYSTEM_ACTOR,
    );
    const [row] = await c.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.document_block
      WHERE engagement_letter_id = ${letter.id} AND removed_at IS NULL
    `;
    expect(row?.n).toBe(7);
  });
});

// ── T6.18 · D6 — every standard term that fits, in one call ─────────────────
//
// Through the real clause library (config.entry / config.version) and the
// same `addClause` rules: a term for another country is skipped, a term naming
// a law that is not the issuer's is skipped, each with the sentence adding it
// by hand would have been refused with, and a second call adds nothing twice.
describe("adding all the issuer's standard terms at once (T6.18, D6)", () => {
  it("adds what fits the letter's country and the issuer's law, and says why it skipped the rest", async () => {
    const india = (await c.party.createOrganization({ tenantId: tenant, legalName: "Terms India Pvt Ltd" }, SYSTEM_ACTOR)).partyId;
    await c.party.registerLegalEntity(
      { tenantId: tenant, organizationPartyId: india, jurisdiction: "IN", entityType: "private_limited" },
      SYSTEM_ACTOR,
    );
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "IN", firmEntityPartyId: india }, SYSTEM_ACTOR);
    for (const [key, body] of [
      ["scope", { title: "Scope of work", text: "The firm performs the services above.", jurisdictions: [] }],
      ["liability-ae", { title: "Liability (UAE)", text: "As UAE law permits.", jurisdictions: ["AE"] }],
      ["law-in", {
        title: "Governing law",
        text: "Indian law, Delhi courts.",
        jurisdictions: [],
        governingLaw: { jurisdiction: "IN", text: "the laws of the Republic of India" },
        courts: { jurisdiction: "IN", text: "the courts at New Delhi" },
      }],
      ["law-us", {
        title: "Governing law (US)",
        text: "Delaware law.",
        jurisdictions: [],
        governingLaw: { jurisdiction: "US", text: "the laws of the State of Delaware" },
        courts: { jurisdiction: "US", text: "the courts of Delaware" },
      }],
    ] as const) {
      await c.config.define({ tenantId: tenant, kind: "clause", key, body: { ...body } }, SYSTEM_ACTOR);
      await c.config.publish({ tenantId: tenant, kind: "clause", key, version: 1 }, SYSTEM_ACTOR);
    }

    const letter = await letters.draft(
      { tenantId: tenant, partyId: client, issuingEntityPartyId: india, jurisdiction: "IN", title: "Terms", currency: "INR", fxRate: "1", fxRateDate: "2026-09-28", advanceRequired: false },
      SYSTEM_ACTOR,
    );
    const first = await letters.addStandardClauses(tenant, letter.id);
    expect(first.added.map((a) => a.clauseKey)).toEqual(["law-in", "scope"]);
    // In key order, the library's own.
    expect(first.skipped.map((k) => k.clauseKey)).toEqual(["law-us", "liability-ae"]);
    expect(first.skipped[0]?.reason).toMatch(/governing law|courts/i);

    const [row] = await c.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.engagement_letter_clause WHERE engagement_letter_id = ${letter.id}
    `;
    expect(row?.n).toBe(2);

    const again = await letters.addStandardClauses(tenant, letter.id);
    expect(again.added).toEqual([]);
    expect(again.skipped.filter((k) => k.reason === "Already on this letter.").map((k) => k.clauseKey)).toEqual([
      "law-in",
      "scope",
    ]);
  });
});
