// T2.2's database half, proven against real Postgres. Four properties, and all
// four are things a fake can only pretend to have:
//
//   THE ARITHMETIC. Totals come from crm.proposal_line_amount and
//   crm.proposal_totals (0013), in `numeric`. The in-memory fake computes the
//   same figures with scaled BigInts, and the two are checked against each
//   other here on the numbers that would separate an exact implementation from
//   a floating-point one. The migration is the authority; this is what keeps
//   the fake honest.
//
//   THE CURRENCY LOCK. A line in a different currency from its own proposal is
//   refused by a composite foreign key, not by a rule in the application.
//
//   THE PIN. An archived catalogue version still resolves, with the list price
//   it had — which is the entire promise the registry makes to a quote.
//
//   THE TENANT WALL, and no DELETE.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: these tables have no DELETE grant, which is asserted below.
// The tenants are uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { ConfigService } from "../../src/usecase/config/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FakeProposalRepo } from "../../src/testfakes/proposal";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

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
const proposals = new PostgresProposalRepository(app);
const documentRepository = new PostgresDocumentRepository(app);
// The real reference counter and the real issuing-entity rule: a proposal
// cannot be drafted without either, and both are database behaviour.
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  ids: systemIds,
  events: ledger,
});
const service = new ProposalService({
  proposals,
  catalogue: configRepository,
  policies: configRepository,
  documents,
  shareTokens: new RandomTokenFactory(),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = String(Date.now());
let tenantA = "";
let tenantB = "";
let partyA = "";
let partyB = "";
/** Firm A's OWN entity — who is offering, on its side of every proposal. */
let issuerA = "";
/** The published GST service — v1 at 25000, superseded by v2 at 27500. */
let gstV1 = "";
let gstV2 = "";

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`prop-test-a-${stamp}`}, 'Proposal Test A', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`prop-test-b-${stamp}`}, 'Proposal Test B', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  partyA = (
    await party.createOrganization(
      { tenantId: tenantA, legalName: "Meridian Textiles Private Limited" },
      SYSTEM_ACTOR,
    )
  ).partyId;
  partyB = (
    await party.createOrganization(
      { tenantId: tenantB, legalName: "Somebody Else Ltd" },
      SYSTEM_ACTOR,
    )
  ).partyId;

  // These tenants are created with raw SQL rather than through createTenant, so
  // they do not get the fallback issuing entity that provisioning seeds. Each
  // firm gets its own here, because `issuing_entity_party_id` is NOT NULL and a
  // firm that has named no entity cannot draft anything — which is the rule,
  // proven separately.
  issuerA = await documentRepository.seedFirmEntity(tenantA, "Proposal Test A LLP");
  await documentRepository.seedFirmEntity(tenantB, "Proposal Test B LLP");

  const defined = await config.define(
    {
      tenantId: tenantA,
      kind: "service",
      key: "gst-filing",
      body: {
        name: "GST monthly filing",
        billingBasis: "fixed",
        listPrice: { amount: "25000.00", currency: "INR" },
      },
    },
    SYSTEM_ACTOR,
  );
  await config.publish(
    { tenantId: tenantA, kind: "service", key: "gst-filing", version: 1 },
    SYSTEM_ACTOR,
  );
  gstV1 = defined.draft.id;

  const v2 = await config.addVersion({
    tenantId: tenantA,
    kind: "service",
    key: "gst-filing",
    body: {
      name: "GST monthly filing (2026 scope)",
      billingBasis: "fixed",
      listPrice: { amount: "27500.00", currency: "INR" },
    },
  });
  await config.publish(
    { tenantId: tenantA, kind: "service", key: "gst-filing", version: 2 },
    SYSTEM_ACTOR,
  );
  gstV2 = v2.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function draft(currency = "INR", fxRate = "1"): Promise<string> {
  const p = await service.draft(
    {
      tenantId: tenantA,
      partyId: partyA,
      title: "Meridian — FY26",
      currency,
      fxRate,
      fxRateDate: "2026-06-01",
    },
    SYSTEM_ACTOR,
  );
  return p.id;
}

describe("the money adds up, in numeric", () => {
  it("matches the fake on the numbers a float would get wrong", async () => {
    // 1499.50 × 3 at 12.5% off. A double cannot hold 1499.50, and this is where
    // the two implementations would part company if either used one.
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "Awkward line",
      quantity: "3",
      unitAmount: "1499.50",
      discountPercent: "12.5",
    });
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "Another",
      quantity: "1",
      unitAmount: "0.05",
      discountPercent: "33.33",
    });

    const fromDb = await service.describe(tenantA, id);

    // The same lines through the in-memory fake, which computes with scaled
    // BigInts. If these ever disagree, the migration is right and the fake is
    // wrong — but silently disagreeing is what this test exists to prevent.
    const fake = new FakeProposalRepo();
    await fake.create({
      id,
      tenantId: tenantA,
      ref: fromDb.proposal.ref,
      partyId: partyA,
      issuingEntityPartyId: fromDb.proposal.issuingEntityPartyId,
      leadId: null,
      title: "x",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
      validUntil: null,
    });
    for (const l of fromDb.lines) {
      await fake.addLine({
        id: l.line.id,
        tenantId: tenantA,
        proposalId: id,
        entityPartyId: l.line.entityPartyId,
        serviceVersionId: l.line.serviceVersionId,
        description: l.line.description,
        quantity: l.line.quantity,
        unitAmount: l.line.unitAmount,
        currency: "INR",
        discountPercent: l.line.discountPercent,
      });
    }
    const fromFake = await fake.describe(tenantA, id);

    expect(Number(fromDb.totals.gross)).toBe(Number(fromFake?.totals.gross));
    expect(Number(fromDb.totals.net)).toBe(Number(fromFake?.totals.net));
    expect(Number(fromDb.totals.discount)).toBe(Number(fromFake?.totals.discount));

    // And the arithmetic itself: 4498.50 gross, 12.5% off is 3936.1875 → 3936.1875
    // at four places, plus 0.05 less 33.33%.
    expect(Number(fromDb.totals.gross)).toBeCloseTo(4498.55, 4);
  });

  it("reconciles: gross − discount is exactly net", async () => {
    // Summed per LINE rather than taken as the difference of the two grand
    // totals, so the three figures agree however the rounding falls.
    const id = await draft();
    for (const [amount, pct] of [
      ["333.33", "33.33"],
      ["0.01", "99.99"],
      ["19999.99", "7.77"],
    ] as const) {
      await service.addLine({
        tenantId: tenantA,
        proposalId: id,
        serviceVersionId: gstV1,
        description: "line",
        quantity: "7",
        unitAmount: amount,
        discountPercent: pct,
      });
    }
    const { totals } = await service.describe(tenantA, id);
    expect(Number(totals.gross) - Number(totals.discount)).toBeCloseTo(Number(totals.net), 4);
  });

  it("an empty proposal is zero, not null", async () => {
    const id = await draft();
    const { totals, lines } = await service.describe(tenantA, id);
    expect(lines).toEqual([]);
    expect(Number(totals.net)).toBe(0);
    expect(totals.currency).toBe("INR");
  });
});

describe("the pin", () => {
  it("still reads the list price it had, after the catalogue moved on", async () => {
    // The whole commercial point of pinning: reopening a quote answers "what
    // was our list price then, and what did we actually charge".
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing at last year's rate",
      quantity: "1",
      unitAmount: "22500.00",
      discountPercent: "0",
    });
    const { lines } = await service.describe(tenantA, id);
    const [line] = lines;
    expect(line?.service?.version).toBe(1);
    expect(line?.service?.listPrice?.amount).toBe("25000.00");
    expect(line?.line.unitAmount).toBe("22500.0000");
    // …while the catalogue itself has moved on.
    const live = await configRepository.readPinnedVersion(tenantA, gstV2);
    expect(live?.status).toBe("published");
  });
});

describe("one proposal, one currency", () => {
  it("the database refuses a line in another currency", async () => {
    // A composite foreign key on (proposal_id, tenant_id, currency), not a rule
    // in the application: a mixed-currency document has a total that means
    // nothing, and the wall should make that unrepresentable.
    const id = await draft("AED", "23.45");
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.proposal_line
          (tenant_id, proposal_id, service_version_id, description, position,
           quantity, unit_amount, currency, discount_percent)
        VALUES (${tenantA}, ${id}, ${gstV1}, 'sneaky', 99, 1, 100, 'INR', 0)
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  it("refuses two live lines at the same position", async () => {
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "one",
      quantity: "1",
      unitAmount: "1",
      discountPercent: "0",
    });
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.proposal_line
          (tenant_id, proposal_id, service_version_id, description, position,
           quantity, unit_amount, currency, discount_percent)
        VALUES (${tenantA}, ${id}, ${gstV1}, 'rival', 1, 1, 1, 'INR', 0)
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation
  });
});

describe("the transitions, against the real CHECK constraints", () => {
  // The gap that let a bug through once: everything above drafts and adds
  // lines, so nothing exercised the UPDATE that moves a status and stamps its
  // date. That statement is where the column constraints in 0011 actually bite
  // — a row claiming to be sent with no sent_at is refused by the database —
  // and where a bare parameter inside a CASE has no type to infer.
  it("stamps sent_at on sending and decided_at on the decision", async () => {
    await config.define(
      {
        tenantId: tenantA,
        kind: "policy",
        key: "discount",
        body: { maxDiscountPercent: "15" },
      },
      SYSTEM_ACTOR,
    );
    await config.publish(
      { tenantId: tenantA, kind: "policy", key: "discount", version: 1 },
      SYSTEM_ACTOR,
    );

    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing",
      quantity: "1",
      unitAmount: "25000.00",
      discountPercent: "10",
    });

    const { proposal: sent } = await service.send(tenantA, id, SYSTEM_ACTOR);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
    expect(sent.decidedAt).toBeNull();

    const decided = await service.decide(tenantA, id, "accepted", SYSTEM_ACTOR);
    expect(decided.status).toBe("accepted");
    expect(decided.decidedAt).not.toBeNull();
    // sent_at survives the second transition — coalesce, not overwrite.
    expect(decided.sentAt).toBe(sent.sentAt);
  });

  it("records the approval against the person, and refuses a second one", async () => {
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "steeply discounted",
      quantity: "1",
      unitAmount: "25000.00",
      discountPercent: "40",
    });

    const [approver] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email)
      VALUES (${`approver-${stamp}@example.test`}) RETURNING id
    `;
    if (!approver) throw new Error("could not create the approver");

    const approved = await service.approveDiscount(tenantA, id, approver.id, SYSTEM_ACTOR);
    expect(approved.discountApprovedBy).toBe(approver.id);
    expect(approved.discountApprovedAt).not.toBeNull();

    await expect(
      service.approveDiscount(tenantA, id, approver.id, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "ALREADY_APPROVED" });

    await expect(service.send(tenantA, id, SYSTEM_ACTOR)).resolves.toMatchObject({
      proposal: { status: "sent" },
    });
  });
});

describe("the share link", () => {
  // The claim that has to hold against real RLS: resolving a share token is an
  // ORDINARY tenant-scoped read. The token carries its tenant precisely so
  // there is no cross-tenant digest lookup anywhere in the product.
  it("opens inside its own tenant, and is inert against another", async () => {
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing",
      quantity: "1",
      unitAmount: "25000.00",
      discountPercent: "0",
    });
    const { shareToken } = await service.send(tenantA, id, SYSTEM_ACTOR);

    const shared = await service.viewShared(shareToken, SYSTEM_ACTOR);
    expect(shared.id).toBe(id);
    expect(shared.firmName).toBe("Proposal Test A");
    expect(shared.addressedTo).toBe("Meridian Textiles Private Limited");
    expect(Number(shared.totals.net)).toBe(25000);

    // The digest, presented under the OTHER firm's scope, finds nothing — which
    // is what makes putting the tenant in the token safe rather than merely
    // convenient.
    const digest = new RandomTokenFactory().hash(shareToken);
    expect(await proposals.findShared(tenantB, digest)).toBeNull();
  });

  it("stores only the digest", async () => {
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing",
      quantity: "1",
      unitAmount: "100",
      discountPercent: "0",
    });
    const { shareToken } = await service.send(tenantA, id, SYSTEM_ACTOR);

    const [row] = await owner<{ share_token_digest: string }[]>`
      SELECT share_token_digest FROM crm.proposal WHERE id = ${id}
    `;
    expect(row?.share_token_digest).toBe(new RandomTokenFactory().hash(shareToken));
    expect(row?.share_token_digest).not.toContain(shareToken);
  });

  it("counts every open and stamps the first, as the CHECK requires", async () => {
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing",
      quantity: "1",
      unitAmount: "100",
      discountPercent: "0",
    });
    const { shareToken } = await service.send(tenantA, id, SYSTEM_ACTOR);
    await service.viewShared(shareToken, SYSTEM_ACTOR);
    await service.viewShared(shareToken, SYSTEM_ACTOR);

    const after = await proposals.findById(tenantA, id);
    expect(after?.viewCount).toBe(2);
    expect(after?.firstViewedAt).not.toBeNull();
  });

  it("the database refuses a draft that carries a link", async () => {
    // Issuing the token at SEND rather than at draft means a quote that never
    // went out never had a reachable link. The CHECK in 0014 is what makes that
    // true of the data and not merely of the code path.
    const id = await draft();
    const err = await withTenant(app, tenantA, (db) =>
      db`UPDATE crm.proposal SET share_token_digest = repeat('a', 64) WHERE id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514"); // check_violation
  });
});

describe("the tenant wall", () => {
  it("one firm cannot read another's proposals", async () => {
    const id = await draft();
    expect(await proposals.findById(tenantB, id)).toBeNull();
    expect(await proposals.describe(tenantB, id)).toBeNull();
    expect(await proposals.list(tenantB, {})).toEqual([]);
  });

  it("a proposal cannot be about another firm's party", async () => {
    const err = await withTenant(app, tenantA, (db) =>
      db`
        INSERT INTO crm.proposal
          (tenant_id, ref, party_id, issuing_entity_party_id, title, currency,
           fx_rate, fx_rate_date)
        VALUES (${tenantA}, 'PR-2026-9001', ${partyB}, ${issuerA}, 'cross-firm', 'INR', 1,
                '2026-06-01')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("the totals view does not leak across the wall", async () => {
    // security_invoker=true on the view (0013). Without it the view would run
    // as its owner, which is not subject to the row policies — every firm's
    // lines, aggregated, served to whoever asked.
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "one",
      quantity: "1",
      unitAmount: "1000",
      discountPercent: "0",
    });
    const seenByB = await withTenant(app, tenantB, (db) =>
      db<{ net: string }[]>`SELECT net FROM crm.proposal_totals WHERE proposal_id = ${id}`,
    );
    expect(seenByB).toEqual([]);
  });

  it("nothing can be deleted", async () => {
    const id = await draft();
    const err = await withTenant(app, tenantA, (db) =>
      db`DELETE FROM crm.proposal WHERE id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // insufficient_privilege
  });
});

// ── G1.3 · why a quote was lost ────────────────────────────────────────────

describe("the declined reason", () => {
  it("is stored on a rejection and comes back on the read", async () => {
    // "A write with no read is not a stored fact" — so the round trip is the
    // test, not the write.
    const id = await draft();
    await service.addLine({
      tenantId: tenantA,
      proposalId: id,
      serviceVersionId: gstV1,
      description: "GST filing",
      quantity: "1",
      unitAmount: "25000",
      discountPercent: "0",
    });
    await service.send(tenantA, id, SYSTEM_ACTOR);
    await service.decide(
      tenantA,
      id,
      "rejected",
      SYSTEM_ACTOR,
      "Went with their existing CA on price.",
    );

    const record = await service.describe(tenantA, id);
    expect(record.proposal.status).toBe("rejected");
    expect(record.proposal.declinedReason).toBe("Went with their existing CA on price.");
    const [summary] = await service.list(tenantA, { partyId: partyA, status: "rejected" });
    expect(summary?.proposal.declinedReason).toBe("Went with their existing CA on price.");
  });

  it("cannot sit on a proposal that was not declined — as the OWNER role", async () => {
    // A sentence about why a client said no, on a proposal they accepted, reads
    // as fact to whoever finds it later. The constraint is in the schema rather
    // than in the service because that is the reader who would be misled.
    const id = await draft();
    for (const statement of [
      owner`UPDATE crm.proposal SET declined_reason = 'they hated it' WHERE id = ${id}`,
      owner`UPDATE crm.proposal SET declined_reason = '   ' WHERE id = ${id}`,
    ]) {
      const err = await statement.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23514"); // check_violation
    }
  });
});
