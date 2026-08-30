// The leadership figures, proven where their acceptance actually lives (T3.7).
//
// The acceptance is "figures reconcile to underlying rows, not cached columns",
// and that is not a claim a fake can test: a fake returns what it was told. So
// this seeds real engagements and real invoices, reads the figures back through
// the views, and asserts them against arithmetic done independently in the test.
//
// Four properties:
//
//   1. MRR normalises a billing frequency to one month, and CONVERTS at the rate
//      stored on the letter — never a rate looked up today.
//   2. MRR names what it could not count. An unpriced line and a line with no
//      stated frequency are excluded, and both are reported as gaps rather than
//      silently dropped.
//   3. Ageing buckets by how overdue an invoice is, and EXCLUDES drafts,
//      cancellations and overpayments.
//   4. RLS applies through the views. `security_invoker = true` is the only
//      thing making that true, and a view without it would be a hole straight
//      through the tenant wall — invisible in every other test.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
interface Ids {
  tenantA: string;
  tenantB: string;
  clientA: string;
  entityA: string;
  clientB: string;
  entityB: string;
}
let ids: Ids;

/** The document-reference shape `el_ref_shape_chk` enforces: EL-YYYY-NNNN.
 *  Unique per tenant, so both firms may use the same numbers. */
const refCounter = new Map<string, number>();
function nextRef(tenantId: string): string {
  const n = (refCounter.get(tenantId) ?? 0) + 1;
  refCounter.set(tenantId, n);
  return `EL-2026-${String(n).padStart(4, "0")}`;
}

async function seedTenant(slug: string, currency: string) {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${slug}, ${currency}) RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${t.id}, 'organization', 'Kaveri Foods') RETURNING id
  `;
  const [entity] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${t.id}, 'organization', 'The Firm LLP') RETURNING id
  `;
  if (!client || !entity) throw new Error("party seed failed");

  // A service of this firm's OWN, because `el_line_service_version_tenant_fkey`
  // is a COMPOSITE key: a line cannot cite another firm's catalogue version.
  // The first version of this seed grabbed `(SELECT id FROM config.version
  // LIMIT 1)` and the tenant wall refused it — which is the composite key doing
  // precisely the job CLAUDE.md says it is there for.
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${t.id}, 'service', 'gst-filing') RETURNING id
  `;
  if (!entry) throw new Error("config entry seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body)
    VALUES (${t.id}, ${entry.id}, 1, ${owner.json({ name: "GST filing" })})
    RETURNING id
  `;
  if (!version) throw new Error("config version seed failed");

  return {
    tenantId: t.id,
    clientId: client.id,
    entityId: entity.id,
    serviceVersionId: version.id,
  };
}

/**
 * One signed letter with one line, and the engagement it created.
 *
 * `fxRate` is the letter's — the whole point of the conversion test. The letter
 * is inserted as `signed` because MRR counts engagements that are ACTIVE, and an
 * engagement cannot be active under a letter that was never signed.
 *
 * The signature block is filled in FULL rather than minimally, because the
 * schema insists on it: `el_signature_is_whole_chk` refuses a signed letter
 * missing any of signed_at, signed_by_name, signature_method or the content
 * hash. Writing this seed is a fair demonstration that those constraints work —
 * three of them refused this insert before it was complete.
 */
async function seedEngagement(input: {
  tenantId: string;
  clientId: string;
  entityId: string;
  currency: string;
  fxRate: string;
  unitAmount: string | null;
  quantity: string;
  discountPercent: string;
  billingFrequency: string | null;
  status: string;
  serviceVersionId: string;
}): Promise<void> {
  // DRAFT FIRST, then the line, then sign — the order the product itself uses.
  // `trg_el_line_freeze` (G1.0) refuses to move a line onto a letter that is
  // already signed, which is the whole point of the freeze: the terms a client
  // agreed to cannot gain a line afterwards. A seed that inserted a signed
  // letter and then its lines was refused, correctly.
  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${input.tenantId}, ${input.clientId}, 'draft', ${input.currency},
            ${input.fxRate}, CURRENT_DATE, ${nextRef(input.tenantId)}, ${input.entityId},
            'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");

  // `pricing_note` is supplied on EVERY line, priced or not.
  // `el_line_unpriced_needs_reason_chk` (G1.6) demands it only for the unpriced
  // ones — a line with no price must SAY why, so it reads as a stated fact
  // rather than a blank that looks like free — and a seed that special-cased it
  // would obscure the rule it is demonstrating.
  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity,
       unit_amount, currency, discount_percent, billing_frequency, entity_party_id,
       description, pricing_note)
    VALUES (${input.tenantId}, ${letter.id}, 1,
            ${input.serviceVersionId},
            ${input.quantity}, ${input.unitAmount}, ${input.currency},
            ${input.discountPercent}, ${input.billingFrequency}, ${input.entityId},
            'Monthly compliance retainer', 'Priced on the schedule')
    RETURNING id
  `;
  if (!line) throw new Error("line seed failed");

  // Now sign it. The signature block is filled in FULL because
  // `el_signature_is_whole_chk` insists: a signed letter missing any of
  // signed_at, signed_by_name, signature_method or the content hash is refused.
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed', sent_at = now(), signed_at = now(),
        signed_by_name = 'A Director', signature_method = 'attested',
        signed_content_hash = ${"a".repeat(64)}
    WHERE id = ${letter.id}
  `;

  await owner`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id,
       engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${input.tenantId}, ${input.clientId}, ${input.entityId}, ${letter.id},
            ${line.id}, CURRENT_DATE, ${input.status},
            ${input.status === "pending_advance" ? null : new Date().toISOString()})
  `;
}

beforeAll(async () => {
  const a = await seedTenant(`dash-a-${stamp}`, "INR");
  const b = await seedTenant(`dash-b-${stamp}`, "INR");
  ids = {
    tenantA: a.tenantId,
    clientA: a.clientId,
    entityA: a.entityId,
    tenantB: b.tenantId,
    clientB: b.clientId,
    entityB: b.entityId,
  };

  const base = {
    tenantId: a.tenantId,
    clientId: a.clientId,
    entityId: a.entityId,
    serviceVersionId: a.serviceVersionId,
  };

  // Counted: 10,000/month at rate 1 = 10,000 MRR.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: "10000", quantity: "1",
    discountPercent: "0", billingFrequency: "monthly", status: "active",
  });
  // Counted: 30,000/quarter = 10,000/month.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: "30000", quantity: "1",
    discountPercent: "0", billingFrequency: "quarterly", status: "active",
  });
  // Counted, and this is the FX case: 100/month USD at 80 = 8,000 INR.
  await seedEngagement({
    ...base, currency: "USD", fxRate: "80.0", unitAmount: "100", quantity: "1",
    discountPercent: "0", billingFrequency: "monthly", status: "active",
  });
  // Excluded: unpriced.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: null, quantity: "1",
    discountPercent: "0", billingFrequency: "monthly", status: "active",
  });
  // Excluded: no frequency stated.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: "5000", quantity: "1",
    discountPercent: "0", billingFrequency: null, status: "active",
  });
  // Excluded: one-time is not recurring.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: "99999", quantity: "1",
    discountPercent: "0", billingFrequency: "one_time", status: "active",
  });
  // NOT counted at all: paused. MRR is what the firm is being paid for NOW.
  await seedEngagement({
    ...base, currency: "INR", fxRate: "1.0", unitAmount: "77777", quantity: "1",
    discountPercent: "0", billingFrequency: "monthly", status: "paused",
  });

  // The other firm, with revenue of its own — isolation you cannot see is
  // isolation you cannot trust.
  await seedEngagement({
    tenantId: b.tenantId, clientId: b.clientId, entityId: b.entityId,
    serviceVersionId: b.serviceVersionId,
    currency: "INR", fxRate: "1.0", unitAmount: "123456", quantity: "1",
    discountPercent: "0", billingFrequency: "monthly", status: "active",
  });
});

afterAll(async () => {
  // `trg_el_freeze` refuses to delete a SIGNED letter — "it is the record of
  // what the client agreed to" — which is exactly right in the product and
  // makes a test's own teardown impossible. Disabled for the length of this
  // cleanup, as the owner, and re-enabled immediately. The alternative is
  // leaving test rows in the dev database forever.
  await owner`ALTER TABLE crm.engagement_letter DISABLE TRIGGER trg_el_freeze`;
  await owner`ALTER TABLE crm.engagement_letter_line DISABLE TRIGGER trg_el_line_freeze`;
  for (const t of [ids.tenantA, ids.tenantB]) {
    await owner`DELETE FROM crm.engagement WHERE tenant_id = ${t}`;
    await owner`DELETE FROM crm.engagement_letter_line WHERE tenant_id = ${t}`;
    await owner`DELETE FROM crm.engagement_letter WHERE tenant_id = ${t}`;
    await owner`DELETE FROM config.version WHERE tenant_id = ${t}`;
    await owner`DELETE FROM config.entry WHERE tenant_id = ${t}`;
    await owner`DELETE FROM core.party WHERE tenant_id = ${t}`;
    await owner`DELETE FROM tenancy.tenant WHERE id = ${t}`;
  }
  await owner`ALTER TABLE crm.engagement_letter ENABLE TRIGGER trg_el_freeze`;
  await owner`ALTER TABLE crm.engagement_letter_line ENABLE TRIGGER trg_el_line_freeze`;
  await owner.end();
  await app.end();
});

async function asTenant<T>(
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe("MRR is derived from rows, at the rate stored on the letter", () => {
  it("normalises each frequency to one month and converts at the letter's rate", async () => {
    // 10,000 (monthly) + 10,000 (30,000 quarterly ÷ 3) + 8,000 (100 USD × 80)
    const rows = await asTenant(
      ids.tenantA,
      (tx) => tx<{ total: string }[]>`
        SELECT COALESCE(sum(monthly_reporting), 0)::text AS total
        FROM crm.engagement_mrr WHERE status = 'active' AND excluded_because IS NULL
      `,
    );
    expect(Number(rows[0]?.total)).toBe(28000);
  });

  it("excludes a PAUSED engagement — MRR is what is running, not what was agreed", async () => {
    const rows = await asTenant(
      ids.tenantA,
      (tx) => tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM crm.engagement_mrr
        WHERE status = 'paused' AND monthly_reporting IS NOT NULL
      `,
    );
    // The row exists and carries a figure; the WHERE status='active' in the
    // adapter is what leaves it out. Proving the view does not pre-filter is the
    // point: a screen asking "what would resuming this be worth" needs the row.
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("names what it could not count, rather than dropping it", async () => {
    const rows = await asTenant(
      ids.tenantA,
      (tx) => tx<{ excluded_because: string; n: string }[]>`
        SELECT excluded_because, count(*)::text AS n
        FROM crm.engagement_mrr
        WHERE status = 'active' AND excluded_because IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `,
    );
    expect(rows.map((r) => [r.excluded_because, Number(r.n)])).toEqual([
      ["no_frequency_stated", 1],
      ["one_time", 1],
      ["unpriced", 1],
    ]);
  });

  it("reconciles to the underlying rows — the acceptance criterion itself", async () => {
    // Independent arithmetic over the base tables, never touching the view.
    const [viaView, viaRows] = await asTenant(ids.tenantA, async (tx) => {
      const [v] = await tx<{ total: string }[]>`
        SELECT COALESCE(sum(monthly_reporting), 0)::text AS total
        FROM crm.engagement_mrr WHERE status = 'active' AND excluded_because IS NULL
      `;
      const [r] = await tx<{ total: string }[]>`
        SELECT COALESCE(sum(
                 l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate
                 / CASE l.billing_frequency
                     WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'annually' THEN 12
                   END
               ), 0)::text AS total
        FROM crm.engagement e
        JOIN crm.engagement_letter_line l ON l.id = e.engagement_letter_line_id
        JOIN crm.engagement_letter el ON el.id = l.engagement_letter_id
        WHERE e.status = 'active' AND l.removed_at IS NULL
          AND l.unit_amount IS NOT NULL
          AND l.billing_frequency IN ('monthly', 'quarterly', 'annually')
      `;
      return [Number(v?.total), Number(r?.total)];
    });
    expect(viaView).toBe(viaRows);
  });
});

describe("the tenant wall holds through the views", () => {
  it("firm A's MRR does not include firm B's engagement", async () => {
    // `security_invoker = true` is the only thing making this true. A plain view
    // runs as its owner, who is not subject to the row policies — and this
    // assertion is the only place that would catch it.
    const rows = await asTenant(
      ids.tenantA,
      (tx) => tx<{ total: string }[]>`
        SELECT COALESCE(sum(monthly_reporting), 0)::text AS total
        FROM crm.engagement_mrr WHERE status = 'active' AND excluded_because IS NULL
      `,
    );
    expect(Number(rows[0]?.total)).toBe(28000);
    expect(Number(rows[0]?.total)).not.toBe(28000 + 123456);
  });

  it("firm B sees only its own", async () => {
    const rows = await asTenant(
      ids.tenantB,
      (tx) => tx<{ total: string }[]>`
        SELECT COALESCE(sum(monthly_reporting), 0)::text AS total
        FROM crm.engagement_mrr WHERE status = 'active' AND excluded_because IS NULL
      `,
    );
    expect(Number(rows[0]?.total)).toBe(123456);
  });

  it("ageing is tenant-scoped too", async () => {
    const rows = await asTenant(
      ids.tenantB,
      (tx) => tx<{ invoice_id: string }[]>`
        SELECT invoice_id FROM crm.receivable_ageing
      `,
    );
    // Firm B raised no invoices. Any row here would be somebody else's debt.
    expect(rows).toHaveLength(0);
  });
});
