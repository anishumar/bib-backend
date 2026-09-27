// 0086's database half, proven against real Postgres: a lead, a draft proposal
// and a draft letter made by mistake can be DELETED — hidden, never erased —
// only while nothing rests on them and they have not left the firm; a deleted
// row is final, and so are its lines, terms, fee groups and prose (0087);
// nothing new may point at one; and every structure that holds "one live row"
// stops counting it.
//
// Every refusal below is asserted as the APP role with raw SQL — the import /
// agent / psql path, which no service stands in front of — because that is what
// the triggers exist for. The services' own refusals are unit-tested beside
// them (tests/{lead,proposal,engagement}/deletion.test.ts).
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: this test leaves its rows behind — none of these tables has
// a DELETE grant, which is asserted below. The tenant is uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresDocumentBlockRepository } from "../../src/infrastructure/postgres/block-repository";
import { ProposalCitedByLetter } from "../../src/domain/proposal/errors";
import { LeadHasProposals } from "../../src/domain/lead/errors";
import { DocumentDeleted } from "../../src/domain/document/errors";
import { randomUUID } from "node:crypto";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const leads = new PostgresLeadRepository(app);
const proposals = new PostgresProposalRepository(app);
const letters = new PostgresEngagementRepository(app);
const blocks = new PostgresDocumentBlockRepository(app);

const stamp = String(Date.now());
let tenant = "";
let deleter = "";
/** A published service of this tenant's own, for the lines the archive guard's
 *  two line probes look at. */
let serviceVersion = "";
let counter = 0;

function next(): string {
  counter += 1;
  return String(counter).padStart(4, "0");
}

/** A client, written by hand: this file is about three other tables. */
async function party(name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', ${`${name} ${stamp}`}) RETURNING id
  `;
  if (!row) throw new Error("could not create a party");
  return row.id;
}

async function lead(partyId: string, stage = "new"): Promise<string> {
  const closed = ["converted", "lost", "abandoned"].includes(stage);
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.lead (tenant_id, party_id, source, title, stage, closed_at, lost_reason)
    VALUES (${tenant}, ${partyId}, 'inbound', 'Deletion probe', ${stage},
            ${closed ? new Date() : null}, ${stage === "lost" || stage === "abandoned" ? "probe" : null})
    RETURNING id
  `;
  if (!row) throw new Error("could not create a lead");
  return row.id;
}

async function proposal(
  partyId: string,
  over: { leadId?: string; status?: "draft" | "sent" } = {},
): Promise<{ id: string; ref: string }> {
  const ref = `PR-2026-${next()}`;
  const sent = over.status === "sent";
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.proposal
      (tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title, status,
       currency, fx_rate, fx_rate_date, sent_at)
    VALUES (${tenant}, ${ref}, ${partyId}, ${partyId}, ${over.leadId ?? null}, 'Deletion probe',
            ${sent ? "sent" : "draft"}, 'INR', 1, '2026-07-01', ${sent ? new Date() : null})
    RETURNING id
  `;
  if (!row) throw new Error("could not create a proposal");
  return { id: row.id, ref };
}

async function letter(
  partyId: string,
  over: { proposalId?: string; status?: "draft" | "sent" | "signed"; supersedesId?: string } = {},
): Promise<{ id: string; ref: string }> {
  const ref = `EL-2026-${next()}`;
  const status = over.status ?? "draft";
  const signed = status === "signed";
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, ref, party_id, issuing_entity_party_id, proposal_id, supersedes_id,
       jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required,
       sent_at, signed_at, signed_by_name, signature_method, signed_content_hash)
    VALUES (${tenant}, ${ref}, ${partyId}, ${partyId}, ${over.proposalId ?? null},
            ${over.supersedesId ?? null}, 'IN', 'Deletion probe', ${status}, 'INR', 1,
            '2026-07-01', false,
            ${status === "draft" ? null : new Date()}, ${signed ? new Date() : null},
            ${signed ? "Priya Menon" : null}, ${signed ? "attested" : null},
            ${signed ? "c".repeat(64) : null})
    RETURNING id
  `;
  if (!row) throw new Error("could not create a letter");
  return { id: row.id, ref };
}

/** Run a statement as the APP role, under RLS, with no service in front of it.
 *  Returns the error, or null when it went through. */
async function raw(
  statement: (db: postgres.Sql) => Promise<unknown>,
): Promise<{ code?: string; message: string; detail?: string } | null> {
  return withTenant(app, tenant, (db) => statement(db)).then(
    () => null,
    (e: unknown) => e as { code?: string; message: string; detail?: string },
  );
}

const deleteLead = (id: string) =>
  raw((db) => db`UPDATE crm.lead SET deleted_at = now(), deleted_by_user_id = ${deleter} WHERE id = ${id}`);
const deleteProposal = (id: string) =>
  raw((db) => db`UPDATE crm.proposal SET deleted_at = now(), deleted_by_user_id = ${deleter} WHERE id = ${id}`);
const deleteLetter = (id: string) =>
  raw(
    (db) =>
      db`UPDATE crm.engagement_letter SET deleted_at = now(), deleted_by_user_id = ${deleter} WHERE id = ${id}`,
  );

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`deletion-test-${stamp}`}, 'Deletion Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`deleter-${stamp}@example.test`}, 'Probe Deleter') RETURNING id
  `;
  if (!u) throw new Error("could not create the deleting account");
  deleter = u.id;
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${tenant}, 'service', 'deletion-probe') RETURNING id
  `;
  if (!entry) throw new Error("could not create the probe service entry");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
    VALUES (${tenant}, ${entry.id}, 1, 'published',
            ${owner.json({ name: "Deletion probe service", billingBasis: "fixed" })}, now())
    RETURNING id
  `;
  if (!version) throw new Error("could not create the probe service version");
  serviceVersion = version.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("hidden, never erased", () => {
  it("the app role still holds no DELETE on any of the three tables", async () => {
    const rows = await app<{ table: string; can_delete: boolean }[]>`
      SELECT t AS table, has_table_privilege(t, 'DELETE') AS can_delete
      FROM unnest(ARRAY['crm.lead', 'crm.proposal', 'crm.engagement_letter']) AS t
    `;
    expect(rows.filter((r) => r.can_delete)).toEqual([]);
  });
});

describe("a lead", () => {
  it("leaves the pipeline, keeps its stage, and still resolves by id with who deleted it", async () => {
    const p = await party("Lead list probe");
    const id = await lead(p);
    const done = await leads.markDeleted(tenant, id, deleter);
    expect(done?.deletedAt).not.toBeNull();
    expect(done?.stage).toBe("new");

    const listed = await leads.list(tenant, null);
    expect(listed.some((r) => r.lead.id === id)).toBe(false);
    expect((await leads.list(tenant, "new")).some((r) => r.lead.id === id)).toBe(false);
    const detail = await leads.findRecord(tenant, id);
    expect(detail?.lead.deletedAt).not.toBeNull();
    expect(detail?.deletedBy?.displayName).toBe("Probe Deleter");
    // The transition is its own lock: a second press gets nothing.
    expect(await leads.markDeleted(tenant, id, deleter)).toBeNull();
  });

  it("is refused once converted", async () => {
    const err = await deleteLead(await lead(await party("Converted probe"), "converted"));
    expect(err?.code).toBe("23001");
    expect(err?.message).toContain("converted");
  });

  it("is refused while a live proposal was drafted from it — and allowed once that is deleted", async () => {
    const p = await party("Drafted-from probe");
    const id = await lead(p);
    const quote = await proposal(p, { leadId: id });

    const err = await deleteLead(id);
    expect(err?.code).toBe("23001");
    expect(err?.detail).toBe(quote.ref);
    expect(await leads.liveProposalRefs(tenant, id)).toEqual([quote.ref]);
    // The adapter turns the wall's refusal into the domain's sentence.
    await expect(leads.markDeleted(tenant, id, deleter)).rejects.toBeInstanceOf(LeadHasProposals);

    expect(await deleteProposal(quote.id)).toBeNull();
    expect(await leads.liveProposalRefs(tenant, id)).toEqual([]);
    expect(await deleteLead(id)).toBeNull();
  });

  it("is final: nothing about a deleted lead changes, however it is asked", async () => {
    const id = await lead(await party("Final lead probe"));
    expect(await deleteLead(id)).toBeNull();
    const err = await raw((db) => db`UPDATE crm.lead SET title = 'renamed' WHERE id = ${id}`);
    expect(err?.code).toBe("23001");
    expect(err?.message).toContain("final");
  });

  it("cannot be deleted and changed in one statement", async () => {
    const id = await lead(await party("Pure lead probe"));
    const err = await raw(
      (db) => db`UPDATE crm.lead SET deleted_at = now(), stage = 'converted', closed_at = now() WHERE id = ${id}`,
    );
    expect(err?.code).toBe("23001");
  });

  it("stops holding its client's one open slot", async () => {
    const p = await party("Open slot probe");
    const first = await lead(p);
    // While it is live, a second open lead for the client is the duplicate the
    // index exists to stop.
    await expect(lead(p)).rejects.toMatchObject({ code: "23505" });
    expect(await deleteLead(first)).toBeNull();
    // Deleted, it is not open for anybody: the client can be captured again,
    // and the merge lookup finds the new lead, never the mistake.
    const second = await lead(p);
    expect((await leads.findOpenForParty(tenant, p))?.id).toBe(second);
  });

  it("gains no new proposal", async () => {
    const p = await party("No new quote probe");
    const id = await lead(p);
    expect(await deleteLead(id)).toBeNull();
    const err = await raw(
      (db) => db`
        INSERT INTO crm.proposal
          (tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title,
           currency, fx_rate, fx_rate_date)
        VALUES (${tenant}, ${`PR-2026-${next()}`}, ${p}, ${p}, ${id}, 'x', 'INR', 1, '2026-07-01')
      `,
    );
    expect(err?.code).toBe("23514");
  });
});

describe("a proposal", () => {
  it("leaves the list, under every filter, and still resolves by id", async () => {
    const p = await party("Quote list probe");
    const quote = await proposal(p);
    expect((await proposals.markDeleted(tenant, quote.id, deleter))?.deletedAt).not.toBeNull();

    expect((await proposals.list(tenant, {})).some((s) => s.proposal.id === quote.id)).toBe(false);
    expect(
      (await proposals.list(tenant, { status: "draft", partyId: p })).some(
        (s) => s.proposal.id === quote.id,
      ),
    ).toBe(false);
    const described = await proposals.describe(tenant, quote.id);
    expect(described?.proposal.deletedAt).not.toBeNull();
    expect(described?.deletedBy?.displayName).toBe("Probe Deleter");
  });

  it("is refused once sent", async () => {
    const quote = await proposal(await party("Sent quote probe"), { status: "sent" });
    const err = await deleteProposal(quote.id);
    expect(err?.code).toBe("23001");
    expect(err?.message).toContain("only a draft");
    // The adapter's WHERE clause refuses it too, without a trigger's help.
    expect(await proposals.markDeleted(tenant, quote.id, deleter)).toBeNull();
  });

  it("is refused while a live letter cites it — and allowed once that is deleted", async () => {
    const p = await party("Cited quote probe");
    const quote = await proposal(p);
    const cites = await letter(p, { proposalId: quote.id });

    const err = await deleteProposal(quote.id);
    expect(err?.code).toBe("23001");
    expect(err?.detail).toBe(cites.ref);
    await expect(proposals.markDeleted(tenant, quote.id, deleter)).rejects.toBeInstanceOf(
      ProposalCitedByLetter,
    );

    expect(await deleteLetter(cites.id)).toBeNull();
    expect(await proposals.liveLetterRefs(tenant, quote.id)).toEqual([]);
    expect(await deleteProposal(quote.id)).toBeNull();
  });

  it("is final", async () => {
    const quote = await proposal(await party("Final quote probe"));
    expect(await deleteProposal(quote.id)).toBeNull();
    const err = await raw(
      (db) => db`UPDATE crm.proposal SET status = 'sent', sent_at = now() WHERE id = ${quote.id}`,
    );
    expect(err?.code).toBe("23001");
  });

  it("gains no letter citing it", async () => {
    const p = await party("No new letter probe");
    const quote = await proposal(p);
    expect(await deleteProposal(quote.id)).toBeNull();
    const err = await raw(
      (db) => db`
        INSERT INTO crm.engagement_letter
          (tenant_id, ref, party_id, issuing_entity_party_id, proposal_id, jurisdiction, title,
           currency, fx_rate, fx_rate_date, advance_required)
        VALUES (${tenant}, ${`EL-2026-${next()}`}, ${p}, ${p}, ${quote.id}, 'IN', 'x',
                'INR', 1, '2026-07-01', false)
      `,
    );
    expect(err?.code).toBe("23514");
  });
});

describe("an engagement letter", () => {
  it("leaves the list, and still resolves by id", async () => {
    const draft = await letter(await party("Letter list probe"));
    expect((await letters.markDeleted(tenant, draft.id, deleter))?.deletedAt).not.toBeNull();
    expect((await letters.listLetters(tenant, {})).some((l) => l.letter.id === draft.id)).toBe(false);
    const described = await letters.describeLetter(tenant, draft.id);
    expect(described?.letter.deletedAt).not.toBeNull();
    expect(described?.deletedBy?.displayName).toBe("Probe Deleter");
  });

  it("is refused once sent", async () => {
    const sent = await letter(await party("Sent letter probe"), { status: "sent" });
    const err = await deleteLetter(sent.id);
    expect(err?.code).toBe("23001");
    expect(err?.message).toContain("withdrawn");
  });

  it("is refused once signed — by the freeze, before the deletion guard is asked", async () => {
    const signed = await letter(await party("Signed letter probe"), { status: "signed" });
    const err = await deleteLetter(signed.id);
    expect(err?.code).toBe("23001");
    expect(err?.message).toContain("frozen");
  });

  it("is final", async () => {
    const draft = await letter(await party("Final letter probe"));
    expect(await deleteLetter(draft.id)).toBeNull();
    const err = await raw(
      (db) => db`UPDATE crm.engagement_letter SET title = 'renamed' WHERE id = ${draft.id}`,
    );
    expect(err?.code).toBe("23001");
  });

  it("a deleted draft replacement frees the signed letter to be replaced again", async () => {
    const p = await party("Successor probe");
    const signed = await letter(p, { status: "signed" });
    const first = await letter(p, { supersedesId: signed.id });
    // One live replacement at a time: the second is refused while the first stands.
    await expect(letter(p, { supersedesId: signed.id })).rejects.toMatchObject({ code: "23505" });
    expect((await letters.findSuccessor(tenant, signed.id))?.id).toBe(first.id);

    expect(await deleteLetter(first.id)).toBeNull();
    expect(await letters.findSuccessor(tenant, signed.id)).toBeNull();
    expect((await letters.describeLetter(tenant, signed.id))?.supersededBy).toBeNull();
    const second = await letter(p, { supersedesId: signed.id });
    expect((await letters.findSuccessor(tenant, signed.id))?.id).toBe(second.id);
  });
});

describe("a deleted draft's lines, terms, fee groups and prose are final too (0087)", () => {
  const newBlock = (owner: { kind: "proposal" | "engagement_letter"; id: string }) =>
    blocks.add({
      id: randomUUID(),
      tenantId: tenant,
      owner,
      kind: "exclusion",
      body: "Probe exclusion.",
      isHeading: false,
      sortOrder: 1,
      sourceId: null,
    });

  it("refuses prose on a deleted proposal, and the adapter says DELETED, never SIGNED", async () => {
    const quote = await proposal(await party("Prose quote probe"));
    const kept = await newBlock({ kind: "proposal", id: quote.id });
    expect(await deleteProposal(quote.id)).toBeNull();

    await expect(newBlock({ kind: "proposal", id: quote.id })).rejects.toBeInstanceOf(DocumentDeleted);
    await expect(blocks.edit(tenant, kept.id, { body: "Rewritten." })).rejects.toBeInstanceOf(
      DocumentDeleted,
    );
    await expect(blocks.remove(tenant, kept.id)).rejects.toBeInstanceOf(DocumentDeleted);
  });

  it("refuses prose, lines and terms on a deleted letter — as the app role, with no service", async () => {
    const p = await party("Prose letter probe");
    const draft = await letter(p);
    const kept = await newBlock({ kind: "engagement_letter", id: draft.id });
    expect(await deleteLetter(draft.id)).toBeNull();

    const edit = await raw(
      (db) => db`UPDATE crm.document_block SET body = 'Rewritten.' WHERE id = ${kept.id}`,
    );
    expect(edit?.code).toBe("55000");
    expect(edit?.message).toContain("deleted as made by mistake");
    const line = await raw(
      (db) => db`
        INSERT INTO crm.engagement_letter_line
          (tenant_id, engagement_letter_id, entity_party_id, service_version_id, description,
           position, quantity, unit_amount, currency, discount_percent)
        VALUES (${tenant}, ${draft.id}, ${p}, ${serviceVersion}, 'probe', 1, 1, 100, 'INR', 0)
      `,
    );
    expect(line?.code).toBe("55000");
  });

  it("refuses a line on a deleted proposal", async () => {
    const p = await party("Line quote probe");
    const quote = await proposal(p);
    expect(await deleteProposal(quote.id)).toBeNull();
    const err = await raw(
      (db) => db`
        INSERT INTO crm.proposal_line
          (tenant_id, proposal_id, entity_party_id, service_version_id, description,
           position, quantity, unit_amount, currency, discount_percent)
        VALUES (${tenant}, ${quote.id}, ${p}, ${serviceVersion}, 'probe', 1, 1, 100, 'INR', 0)
      `,
    );
    expect(err?.code).toBe("55000");
  });

  it("leaves a LIVE draft's prose and lines editable — the control", async () => {
    const p = await party("Live prose probe");
    const quote = await proposal(p);
    const kept = await newBlock({ kind: "proposal", id: quote.id });
    await expect(blocks.edit(tenant, kept.id, { body: "Still a draft." })).resolves.toMatchObject({
      body: "Still a draft.",
    });
    expect(
      await raw(
        (db) => db`
          INSERT INTO crm.proposal_line
            (tenant_id, proposal_id, entity_party_id, service_version_id, description,
             position, quantity, unit_amount, currency, discount_percent)
          VALUES (${tenant}, ${quote.id}, ${p}, ${serviceVersion}, 'probe', 1, 1, 100, 'INR', 0)
        `,
      ),
    ).toBeNull();
  });
});

describe("the archive guard (0035, 0036) counts only live rows", () => {
  const archive = (partyId: string) =>
    raw((db) => db`UPDATE core.party SET archived_at = now() WHERE id = ${partyId}`);

  it("still refuses a client a live lead points at", async () => {
    const p = await party("Live lead archive probe");
    await lead(p);
    expect((await archive(p))?.code).toBe("23001");
  });

  it("archives a client whose lead, quote and letter were all deleted as mistakes", async () => {
    const p = await party("Deleted refs archive probe");
    const l = await lead(p);
    const quote = await proposal(p, { leadId: l });
    const draft = await letter(p, { proposalId: quote.id });
    // A line on each naming the client as the company the work is for, so the
    // guard's two LINE probes are exercised too, not only the heads.
    await owner`
      INSERT INTO crm.proposal_line
        (tenant_id, proposal_id, entity_party_id, service_version_id, description,
         position, quantity, unit_amount, currency, discount_percent)
      VALUES (${tenant}, ${quote.id}, ${p}, ${serviceVersion}, 'probe', 1, 1, 100, 'INR', 0)
    `;
    await owner`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, entity_party_id, service_version_id, description,
         position, quantity, unit_amount, currency, discount_percent)
      VALUES (${tenant}, ${draft.id}, ${p}, ${serviceVersion}, 'probe', 1, 1, 100, 'INR', 0)
    `;

    expect((await archive(p))?.code).toBe("23001");
    expect(await deleteLetter(draft.id)).toBeNull();
    expect(await deleteProposal(quote.id)).toBeNull();
    expect(await deleteLead(l)).toBeNull();
    expect(await archive(p)).toBeNull();
  });
});
