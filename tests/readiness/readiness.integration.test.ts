// Setup readiness (V2.6) against a real database: the QA firm's state on
// 27 Sep 2026 (bib/qa/qa-extract-2026-09-27-full/REPORT.md §§2,7,9,10),
// rebuilt as a fixture, read through the adapter. Every gap the extract found
// must be named, and fixing one must turn its line done on the next read.
//
// What the QA firm had, and so what this fixture has:
//   §2  a Partner at the top rung, an Associate and an ungraded partner, and
//       NOBODY with a manager recorded; the Depts FRC, TRC and RAA;
//   §7  one check rule, "manager review", on reporting lines alone; no
//       compliance policy, no escalation, chaser or nudge ladder;
//   §4  one active client, "test company", with no Key Manager and no SPOC,
//       and one portal login (shrey);
//   §5  one service, Monthly Accounting (Dept FRC), naming a published process;
//   §9  client-request routing set to the Key Manager;
//   §10 compliance rules loaded and none confirmed or linked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresReadinessFacts } from "../../src/infrastructure/postgres/readiness-facts";
import { readinessLines } from "../../src/domain/readiness/model";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const facts = new PostgresReadinessFacts(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();
const DAY = "2026-09-27";

let tenant: string;
let client: string;
let issuer: string;
let partner: string;
let associate: string;
let ungraded: string;
let frc: string;
let serviceEntry: string;

async function party(name: string): Promise<string> {
  const id = ref();
  await owner`INSERT INTO core.party (id, tenant_id, kind, display_name) VALUES (${id}, ${tenant}, 'organization', ${name})`;
  return id;
}

async function staff(name: string, gradeId: string | null): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name.toLowerCase().replace(/\s+/g, ".")}-${stamp}@readiness.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("no user");
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active, grade_id)
    VALUES (${tenant}, ${u.id}, 'STAFF', 'partner', true, ${gradeId})
  `;
  return u.id;
}

async function publish(kind: string, key: string, body: Record<string, unknown>): Promise<string> {
  const entryId = ref();
  await owner`INSERT INTO config.entry (id, tenant_id, kind, key) VALUES (${entryId}, ${tenant}, ${kind}, ${key})`;
  const versionId = ref();
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${versionId}, ${tenant}, ${entryId}, 1, 'published', ${owner.json(body as postgres.JSONValue)}, now())
  `;
  if (kind === "service") serviceEntry = entryId;
  return versionId;
}

async function read() {
  return readinessLines({ ...(await facts.factsFor(tenant, DAY)), day: DAY });
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone, client_request_routing)
    VALUES (${`ready-${stamp}`}, 'Readiness QA', 'INR', 'Asia/Kolkata', 'key_manager') RETURNING id
  `;
  if (!t) throw new Error("no firm");
  tenant = t.id;

  // A complete task and filing vocabulary: calendar.integration.test.ts checks
  // every firm in the database has them.
  await owner`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
           (${tenant}, 'completed', 'Completed', false, true, true, 90)
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10)
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90)
  `;

  const [assoc, top] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
    VALUES (${tenant}, 'associate', 'Associate', 3), (${tenant}, 'partner', 'Partner', 10)
    RETURNING id
  `;
  if (!assoc || !top) throw new Error("no grades");
  partner = await staff("Ashish Jain", top.id);
  associate = await staff("Shrestha Pandit", assoc.id);
  ungraded = await staff("Siddharth Kohli", null);

  const [d] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name, sort_order)
    VALUES (${tenant}, 'dept', 'FRC', 'Financial Reporting and Compliance', 1),
           (${tenant}, 'dept', 'TRC', 'Tax, Transactions, Regulatory and Consulting', 2),
           (${tenant}, 'dept', 'RAA', 'Risk Assurance and Advisory', 3)
    RETURNING id
  `;
  if (!d) throw new Error("no dept");
  frc = d.id;

  await publish("verification_policy", "manager", { rule: "reporting_line", label: "manager review", minGradeCode: null, minGradeRank: null });
  await publish("workflow_template", "monthly_accounting", { label: "Monthly Accounting & Bookkeeping", steps: [] });
  const serviceV = await publish("service", "monthly-accounting", {
    name: "Monthly Accounting & Bookkeeping",
    module: "FRC",
    jurisdictions: ["IN"],
    billingBasis: "retainer",
    recurrence: "monthly",
    workflowTemplateKey: "monthly_accounting",
  });

  // The one client, signed, active.
  client = await party("test company");
  issuer = await party("10x Global");
  const letterId = ref();
  const lineId = ref();
  await owner`
    INSERT INTO crm.engagement_letter
      (id, tenant_id, party_id, jurisdiction, title, status, currency, fx_rate,
       fx_rate_date, ref, issuing_entity_party_id)
    VALUES (${letterId}, ${tenant}, ${client}, 'IN', 'proposal 2026', 'draft', 'INR', 1,
            current_date, ${`EL-2026-${String(9000 + Math.floor(Math.random() * 999))}`}, ${issuer})
  `;
  await owner`
    INSERT INTO crm.engagement_letter_line
      (id, tenant_id, engagement_letter_id, service_version_id, description, position,
       quantity, unit_amount, currency, entity_party_id)
    VALUES (${lineId}, ${tenant}, ${letterId}, ${serviceV}, 'MONTHLY ACCOUNTING', 1, 1, 23333, 'INR', ${client})
  `;
  await owner`
    INSERT INTO crm.engagement
      (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
       entity_party_id, status, activated_at, effective_from)
    VALUES (${ref()}, ${tenant}, ${letterId}, ${lineId}, ${client}, ${client}, 'active', now(), '2026-09-25')
  `;
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'shrey',
        signature_method = 'attested', signed_content_hash = repeat('a', 64)
    WHERE id = ${letterId}
  `;

  // shrey, the client's portal login, granted on the 26th.
  const [shrey] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`shrey-${stamp}@readiness.test`}, 'shrey') RETURNING id
  `;
  if (!shrey) throw new Error("no contact");
  const [pm] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenant}, ${shrey.id}, 'CLIENT_PORTAL', 'client_contact', true) RETURNING id
  `;
  if (!pm) throw new Error("no portal membership");
  await owner`
    INSERT INTO crm.portal_access (tenant_id, membership_id, client_party_id, valid_from, granted_by)
    VALUES (${tenant}, ${pm.id}, ${client}, '2026-09-26', ${partner})
  `;

  // The rule pack, loaded and unconfirmed, linked to nothing (two of 57).
  await owner`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack, status)
    VALUES (${tenant}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, ${`ready-${stamp}@1`}, 'unconfirmed'),
           (${tenant}, 'IN', 'TDS deposit', 'monthly', 4, 'day_of_month', 1, 7, ${`ready-${stamp}@1`}, 'unconfirmed')
  `;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("the QA firm on 27 Sep 2026, read back", () => {
  it("names every gap the extract found", async () => {
    const lines = await read();
    const at = (k: string) => lines.find((l) => l.key === k);

    // §7: no compliance policy.
    expect(at("deadlines")?.gaps.map((g) => g.missing[0])).toEqual(["go_live_floor", "fiscal_year_start"]);
    // §2 + §7: a reporting-line check rule and nobody below the top with a manager.
    expect(at("reporting_lines")?.context).toEqual(["manager review"]);
    expect(at("reporting_lines")?.gaps.map((g) => g.id).sort()).toEqual([associate, ungraded].sort());
    // §7: no escalation, chaser or nudge ladder.
    expect(at("ladders")?.gaps.map((g) => g.missing[0])).toEqual(["escalation", "chaser", "nudge"]);
    // §10: nothing confirmed or linked.
    expect(at("compliance_rules")?.gaps.map((g) => g.missing[0])).toEqual(["confirmed_linked_rule"]);
    // §4 + §9: the client has no Key Manager and no SPOC for FRC, which is why
    // its one task had no owner.
    expect(at("account_team")?.gaps).toEqual([
      { id: client, ref: null, name: "test company", missing: ["key_manager", "spoc:FRC"] },
    ]);
    // What the QA firm HAD done.
    expect(at("request_routing")?.done).toBe(true);
    expect(at("processes")?.done).toBe(true);
    expect(at("portal_contacts")?.done).toBe(true);
    // And three of the lines added on 2026-10-03: this fixture's firm is on
    // India's calendar, has three people and one service.
    expect(at("time_zone")?.done).toBe(true);
    expect(at("staff")?.done).toBe(true);
    expect(at("services")?.done).toBe(true);
    expect(lines.filter((l) => l.done)).toHaveLength(6);
  });

  it("reads the firm's companies, zone, people and terms (audit 2026-10-03)", async () => {
    const at = async (k: string) => (await read()).find((l) => l.key === k);
    // No company of the firm's own exists in this fixture yet.
    expect((await at("company_details"))?.gaps.map((g) => g.missing)).toEqual([["company"]]);
    expect((await at("standard_terms"))?.state).toBe("to_do");

    // The firm itself, registered in India with no address yet.
    await owner`
      INSERT INTO core.organization (party_id, tenant_id, legal_name, is_firm_self)
      VALUES (${issuer}, ${tenant}, '10x Global', true)
    `;
    await owner`
      INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
      VALUES (${issuer}, ${tenant}, 'IN', 'llp')
    `;
    expect((await at("company_details"))?.gaps).toEqual([
      { id: issuer, ref: null, name: "10x Global", missing: ["address"] },
    ]);
    await owner`
      UPDATE core.legal_entity SET registered_address = ${owner.json({ lines: ["1 MG Road", "New Delhi"] })}
       WHERE party_id = ${issuer}
    `;
    expect((await at("company_details"))?.state).toBe("done");

    // Back on the zone nobody chose: to do, and India's offered.
    await owner`UPDATE tenancy.tenant SET time_zone = 'UTC' WHERE id = ${tenant}`;
    expect((await at("time_zone"))?.gaps).toEqual([{ id: null, ref: "Asia/Kolkata", name: "", missing: ["time_zone"] }]);
    await owner`UPDATE tenancy.tenant SET time_zone = 'Asia/Kolkata' WHERE id = ${tenant}`;
    expect((await at("time_zone"))?.state).toBe("done");

    // One term in force.
    await publish("clause", "confidentiality", { title: "Confidentiality", text: "We keep it private." });
    expect((await at("standard_terms"))?.state).toBe("done");
  });

  it("turns a line done on the next read once its gap is fixed", async () => {
    await owner`
      INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
      VALUES (${tenant}, ${client}, 'key_manager', NULL, ${partner}, '2026-09-27'),
             (${tenant}, ${client}, 'spoc', ${frc}, ${associate}, '2026-09-27')
    `;
    expect((await read()).find((l) => l.key === "account_team")?.done).toBe(true);

    // And a link plus a confirmation is what the compliance line waits for.
    const [rule] = await owner<{ id: string; lineage_id: string }[]>`
      UPDATE delivery.obligation_template SET status = 'confirmed'
       WHERE tenant_id = ${tenant} AND name = 'GSTR-3B' RETURNING id, lineage_id
    `;
    if (!rule) throw new Error("no rule");
    await owner`
      INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
      VALUES (${tenant}, ${rule.lineage_id}, ${serviceEntry})
    `;
    expect((await read()).find((l) => l.key === "compliance_rules")?.done).toBe(true);
  });

  it("reads assignments and portal grants on the day asked, half-open", async () => {
    // The Key Manager above starts on the 27th: on the 26th the client had none.
    const before = await facts.factsFor(tenant, "2026-09-26");
    expect(before.activeClients.find((c) => c.partyId === client)?.hasKeyManager).toBe(false);

    // Removing shrey's access TODAY (valid_to = today, the first day not in
    // force) leaves the client with no portal login today, and with one yesterday.
    await owner`UPDATE crm.portal_access SET valid_to = ${DAY} WHERE tenant_id = ${tenant} AND client_party_id = ${client}`;
    expect((await read()).find((l) => l.key === "portal_contacts")?.gaps.map((g) => g.id)).toEqual([client]);
    const yesterday = await facts.factsFor(tenant, "2026-09-26");
    expect(yesterday.activeClients.find((c) => c.partyId === client)?.hasPortalLogin).toBe(true);
  });
});
