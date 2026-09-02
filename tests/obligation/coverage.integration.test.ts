// "Is this engagement's work already on the compliance calendar?" — asked three
// times in this codebase, and until now answered differently by one of them.
//
// ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
//
// `obligation-coverage.ts` opens by promising to be *"the GENERATOR'S OWN
// PREDICATE rather than a convenient approximation of it"*, and says what
// happens if the two drift: **"a recurring client gets either two tasks for one
// filing or none at all."** It then drifted, and nothing caught it, because the
// port was only ever exercised against a fake — a fake agrees with whatever it
// was written to agree with.
//
// The bug was one operator. A rule's `service_entry_id` is NULLABLE and NULL
// MEANS "every service" — the rules screen writes it as *"Owed by clients who
// bought: Any service"* and it is the DEFAULT. `subjectsFor` and `gaps` both
// read it as `IS NULL OR =`; coverage used a bare `=`, which is never true
// against NULL. So **every rule in the shipped India pack — all 57, none of
// which names a service, because a pack cannot know a firm's catalogue keys —
// reported every engagement UNCOVERED while the calendar generated for it.**
// `spawnForEngagements` then raised its own engagement-level task on top of the
// per-period ones. Measured on the seeded demo firm before the fix: coverage
// said 0 rules, the generator said 10, for all six live engagements.
//
// So the test is not "coverage returns the row". It is **all three predicates,
// on one database, against the same fixtures**, because three comments claiming
// to agree is exactly what was already there.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationCoverage } from "../../src/infrastructure/postgres/obligation-coverage";
import { PostgresCalendarSource } from "../../src/infrastructure/postgres/obligation-instance-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const coverage = new PostgresObligationCoverage(app);
const generator = new PostgresCalendarSource(app);

const stamp = Date.now().toString(36);
let tenantId = "";
let clientId = "";
let entityId = "";
/** The service the client actually signed for. */
let boughtEntryId = "";
/** A different catalogue line the client did NOT buy. */
let otherEntryId = "";
let engagementId = "";

/** A `service` entry plus one published version, and the entry id back. */
async function service(key: string): Promise<{ entryId: string; versionId: string }> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${tenantId}, 'service', ${key}) RETURNING id
  `;
  if (!entry) throw new Error("entry seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: key })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return { entryId: entry.id, versionId: version.id };
}

/**
 * A rule, and the id back.
 *
 * `serviceEntryId` null is the case the whole file is about: the shipped pack's
 * every row looks like this.
 */
async function rule(input: {
  name: string;
  serviceEntryId: string | null;
  generating?: boolean;
}): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack, service_entry_id,
       unresolved_reason)
    VALUES (${tenantId}, 'IN', ${input.name}, 'monthly', 4,
            ${input.generating === false ? null : "day_of_month"},
            ${input.generating === false ? null : 1},
            ${input.generating === false ? null : 20},
            ${`cov-${stamp}@1`}, ${input.serviceEntryId},
            ${input.generating === false ? "the firm has not given the day" : null})
    RETURNING id
  `;
  if (!row) throw new Error("rule seed failed");
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`cov-${stamp}`}, 'Coverage Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;

  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Foods Private Limited') RETURNING id
  `;
  const [entity] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Foods Private Limited') RETURNING id
  `;
  if (!client || !entity) throw new Error("party seed failed");
  clientId = client.id;
  entityId = entity.id;

  // REGISTERED, because a rule matches an entity's jurisdiction exactly and an
  // unregistered company matches nothing at all — which is its own coverage
  // reason and not the one under test here.
  // `legal_entity` hangs off the ORGANIZATION subtype, not the bare party —
  // the composite key insists, which is the tenant wall doing its job.
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name)
    VALUES (${entityId}, ${tenantId}, 'Cobalt Foods Private Limited')
  `;
  await owner`
    INSERT INTO core.legal_entity (tenant_id, party_id, jurisdiction, entity_type, status)
    VALUES (${tenantId}, ${entityId}, 'IN', 'private_limited', 'active')
  `;

  const bought = await service(`gst-monthly-${stamp}`);
  const other = await service(`payroll-${stamp}`);
  boughtEntryId = bought.entryId;
  otherEntryId = other.entryId;

  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${clientId}, 'draft', 'INR', 1, CURRENT_DATE,
            'EL-2026-0001', ${entityId}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");

  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity,
       unit_amount, currency, discount_percent, billing_frequency, entity_party_id,
       description, pricing_note)
    VALUES (${tenantId}, ${letter.id}, 1, ${bought.versionId}, 1, 5000, 'INR', 0,
            'monthly', ${entityId}, 'Monthly compliance retainer', 'Priced on the schedule')
    RETURNING id
  `;
  if (!line) throw new Error("line seed failed");

  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(),
           signed_by_name = 'A Director', signature_method = 'attested',
           signed_content_hash = ${"a".repeat(64)}
     WHERE id = ${letter.id}
  `;

  const [engagement] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id,
       engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${tenantId}, ${clientId}, ${entityId}, ${letter.id}, ${line.id},
            CURRENT_DATE, 'active', now())
    RETURNING id
  `;
  if (!engagement) throw new Error("engagement seed failed");
  engagementId = engagement.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** Does the GENERATOR reach this engagement's entity for this rule? */
async function generatorReaches(ruleId: string): Promise<boolean> {
  const [row] = await owner<{ jurisdiction: string; entity_type: string | null; service_entry_id: string | null }[]>`
    SELECT jurisdiction, entity_type, service_entry_id
      FROM delivery.obligation_template WHERE id = ${ruleId}
  `;
  if (!row) throw new Error("rule vanished");
  const subjects = await generator.subjectsFor(tenantId, {
    jurisdiction: row.jurisdiction,
    entityType: row.entity_type,
    serviceEntryId: row.service_entry_id,
  });
  return subjects.some((s: { engagementId: string | null }) => s.engagementId === engagementId);
}

describe("a rule that names NO service — the shipped pack's every row", () => {
  it("covers the engagement, and the GENERATOR agrees", async () => {
    // The regression. A bare `=` against NULL is never true, so this returned
    // empty while the calendar generated — two tasks for one filing.
    const id = await rule({ name: `GSTR-3B any ${stamp}`, serviceEntryId: null });

    const covered = await coverage.coveredEngagements(tenantId, [engagementId]);
    expect(covered.has(engagementId)).toBe(true);

    // AND the same answer from the other side. Asserting only the first would
    // pass on an implementation that covers everything unconditionally.
    expect(await generatorReaches(id)).toBe(true);

    await owner`DELETE FROM delivery.obligation_template WHERE id = ${id}`;
  });
});

describe("a rule that DOES name a service", () => {
  it("covers the engagement when it is the service the client bought", async () => {
    const id = await rule({ name: `GSTR-3B bought ${stamp}`, serviceEntryId: boughtEntryId });

    const covered = await coverage.coveredEngagements(tenantId, [engagementId]);
    expect(covered.has(engagementId)).toBe(true);
    expect(await generatorReaches(id)).toBe(true);

    await owner`DELETE FROM delivery.obligation_template WHERE id = ${id}`;
  });

  it("does NOT cover it when it names a service the client did not buy", async () => {
    // The negative half, and it is what stops the fix being "return everything".
    const id = await rule({ name: `Payroll only ${stamp}`, serviceEntryId: otherEntryId });

    const covered = await coverage.coveredEngagements(tenantId, [engagementId]);
    expect(covered.has(engagementId)).toBe(false);
    expect(await generatorReaches(id)).toBe(false);

    await owner`DELETE FROM delivery.obligation_template WHERE id = ${id}`;
  });
});

describe("a rule that cannot produce a date does not count as coverage", () => {
  it("is uncovered while its formula is missing — 46 of the 57 shipped rules", async () => {
    // Coverage means "the calendar will produce work for this". A rule the firm
    // has not finished answering produces nothing, so the engagement still needs
    // its own task — the opposite mistake to the one above, and just as silent.
    const id = await rule({
      name: `MSME-1 unanswered ${stamp}`,
      serviceEntryId: null,
      generating: false,
    });

    const covered = await coverage.coveredEngagements(tenantId, [engagementId]);
    expect(covered.has(engagementId)).toBe(false);

    await owner`DELETE FROM delivery.obligation_template WHERE id = ${id}`;
  });

  it("is uncovered while it is retired, even with a formula", async () => {
    const id = await rule({ name: `Retired ${stamp}`, serviceEntryId: null });
    await owner`UPDATE delivery.obligation_template SET is_active = false WHERE id = ${id}`;

    const covered = await coverage.coveredEngagements(tenantId, [engagementId]);
    expect(covered.has(engagementId)).toBe(false);

    await owner`DELETE FROM delivery.obligation_template WHERE id = ${id}`;
  });
});
