// Q042 (Ashish, 2026-10-04): an arrears bill is made on its period's LAST
// day, not the day after. Migration 0339 moves the first bill day of every
// arrears schedule already set ("the 1st after the period") back one day, so
// the sweep reads it as "on each period's last day"; nothing else moves.
//
// The migration's own SQL is run against rows made here, so the rule it
// applies is the one tested. It is idempotent: a moved row no longer matches.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/arrears-last-day.integration.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const MIGRATION = path.join(__dirname, "../../migrations/0339_arrears_last_day.up.sql");

const stamp = Date.now().toString(36);
let tenantId = "";
let client = "";
let issuer = "";
let lines = 0;

async function organization(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  return p.id;
}

/** An active engagement on one line of a signed letter, with this schedule. */
async function scheduled(o: {
  frequency: "monthly" | "quarterly" | "annually";
  timing: "arrears" | "advance" | "on_date" | null;
  billingFrom: string;
  firstInvoiceOn: string;
}): Promise<string> {
  lines += 1;
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`q042-${String(lines)}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: "Books", recurrence: o.frequency, module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-04-01', ${`EL-2026-${String(lines).padStart(4, "0")}`},
            ${issuer}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
       discount_percent, billing_frequency, entity_party_id, description, billing_timing, billing_on)
    VALUES (${tenantId}, ${l.id}, 1, ${version.id}, 1, 15000, 'INR', 0, ${o.frequency}, ${client}, 'Books',
            ${o.timing}, ${o.timing === "on_date" ? o.firstInvoiceOn : null}::date)
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"e".repeat(64)}
     WHERE id = ${l.id}
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from,
       status, activated_at, billing_from, first_invoice_on)
    VALUES (${tenantId}, ${client}, ${client}, ${l.id}, ${ln.id}, ${o.billingFrom}::date, 'active', now(),
            ${o.billingFrom}::date, ${o.firstInvoiceOn}::date)
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  return e.id;
}

async function firstInvoiceOn(engagementId: string): Promise<string | null> {
  const [r] = await owner<{ d: string | null }[]>`
    SELECT first_invoice_on::text AS d FROM crm.engagement WHERE id = ${engagementId}
  `;
  return r?.d ?? null;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`q042-${stamp}`}, ${`q042-${stamp}`}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  client = await organization("Kaveri Foods Private Limited");
  issuer = await organization("The Firm LLP");
});

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("0339 moves arrears schedules to the period's last day (Q042)", () => {
  it("moves the 1st after the first period back to its last day, for arrears and for a letter that said nothing", async () => {
    const monthly = await scheduled({ frequency: "monthly", timing: null, billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" });
    const quarter = await scheduled({ frequency: "quarterly", timing: null, billingFrom: "2026-10-01", firstInvoiceOn: "2027-01-01" });
    const year = await scheduled({ frequency: "annually", timing: "arrears", billingFrom: "2026-04-01", firstInvoiceOn: "2027-04-01" });
    const advance = await scheduled({ frequency: "monthly", timing: "advance", billingFrom: "2026-10-01", firstInvoiceOn: "2026-10-01" });
    const onDate = await scheduled({ frequency: "monthly", timing: "on_date", billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" });
    const typed = await scheduled({ frequency: "monthly", timing: null, billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-05" });

    await owner.unsafe(fs.readFileSync(MIGRATION, "utf8"));
    // Run twice: a moved row no longer matches.
    await owner.unsafe(fs.readFileSync(MIGRATION, "utf8"));

    expect(await firstInvoiceOn(monthly)).toBe("2026-10-31");
    expect(await firstInvoiceOn(quarter)).toBe("2026-12-31");
    expect(await firstInvoiceOn(year)).toBe("2027-03-31");
    // A letter that chose its own day, an advance, and a day a person typed stay as they are.
    expect(await firstInvoiceOn(advance)).toBe("2026-10-01");
    expect(await firstInvoiceOn(onDate)).toBe("2026-11-01");
    expect(await firstInvoiceOn(typed)).toBe("2026-11-05");
  });
});
