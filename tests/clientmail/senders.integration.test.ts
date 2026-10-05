// Who a client email is from, on a real database (Q059, 0350).
//
//   1. A proposal about ONE Dept is from that Dept's SPOC; one spanning two
//      Depts, or with no SPOC for its Dept, from the Key Manager.
//   2. A portal letter (invite, or sent again) is from the Key Manager.
//   3. The From is the person's own address only when the firm listed their
//      domain; the CHECK refuses a malformed list even past the service.
//   4. Nobody in the seat, or somebody who has left: null, and the letter goes
//      from the firm as before.
//   5. THE TENANT WALL: another firm's id finds nobody.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/clientmail/senders.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresClientSenders } from "../../src/infrastructure/postgres/client-senders";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const senders = new PostgresClientSenders(app);

const stamp = Date.now().toString(36);
let tenantId = "";
let otherTenant = "";
let client = "";
let bare = "";
let priya = ""; // FRC SPOC
let ravi = ""; // Key Manager
let frcVersion = "";
let trcVersion = "";
let proposalFrc = "";
let proposalBoth = "";
let proposalTrc = "";
let contact = "";

async function user(name: string, domain: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name}-${stamp}@${domain}`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  await owner`INSERT INTO tenancy.membership (tenant_id, user_id, audience, role) VALUES (${tenantId}, ${u.id}, 'STAFF', 'manager')`;
  return u.id;
}

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

async function service(key: string, dept: string): Promise<string> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`${key}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: key, recurrence: "monthly", module: dept })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return version.id;
}

let refs = 0;
async function proposal(versions: readonly string[]): Promise<string> {
  refs += 1;
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.proposal
      (tenant_id, ref, party_id, issuing_entity_party_id, title, status, currency, fx_rate, fx_rate_date)
    VALUES (${tenantId}, ${`PR-2026-${String(refs).padStart(4, "0")}`}, ${client}, ${client}, 'Sender probe',
            'draft', 'INR', 1, '2026-07-01')
    RETURNING id
  `;
  if (!row) throw new Error("proposal seed failed");
  let position = 0;
  for (const v of versions) {
    position += 1;
    await owner`
      INSERT INTO crm.proposal_line
        (tenant_id, proposal_id, entity_party_id, service_version_id, description, position, quantity, unit_amount, currency, discount_percent)
      VALUES (${tenantId}, ${row.id}, ${client}, ${v}, 'probe', ${position}, 1, 100, 'INR', 0)
    `;
  }
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`senders-${stamp}`}, 'Senders Test', 'INR') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`senders-other-${stamp}`}, 'Other Firm', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("tenant seed failed");
  tenantId = t.id;
  otherTenant = o.id;

  priya = await user("Priya", "10xglobal.in");
  ravi = await user("Ravi", "gmail.com");
  client = await company(`Kaveri Foods ${stamp}`);
  bare = await company(`Nobody's Client ${stamp}`);
  const axes = await owner<{ id: string; code: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${tenantId}, 'dept', 'FRC', 'Financial Reporting'), (${tenantId}, 'dept', 'TRC', 'Tax')
    RETURNING id, code
  `;
  const frc = axes.find((a) => a.code === "FRC")?.id ?? "";
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
    VALUES (${tenantId}, ${client}, 'spoc', ${frc}, ${priya}, '2026-01-01'),
           (${tenantId}, ${client}, 'key_manager', NULL, ${ravi}, '2026-01-01')
  `;
  frcVersion = await service("books", "FRC");
  trcVersion = await service("gst", "TRC");
  proposalFrc = await proposal([frcVersion]);
  proposalBoth = await proposal([frcVersion, trcVersion]);
  proposalTrc = await proposal([trcVersion]);

  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name) VALUES (${`cfo-${stamp}@kaveri.test`}, 'CFO') RETURNING id
  `;
  const [m] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
    VALUES (${tenantId}, ${u?.id ?? ""}, 'CLIENT_PORTAL', 'client_contact') RETURNING id
  `;
  contact = m?.id ?? "";
  await owner`
    INSERT INTO crm.portal_access (tenant_id, membership_id, client_party_id, valid_from, granted_by)
    VALUES (${tenantId}, ${contact}, ${client}, '2026-01-01', ${ravi})
  `;
});

afterAll(async () => {
  const both = [tenantId, otherTenant];
  await owner`DELETE FROM crm.portal_access WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM crm.proposal_line WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM crm.proposal WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM crm.client_assignment WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.service_axis WHERE tenant_id IN ${owner(both)}`;
  // Published config versions are frozen by trigger and stay, in two throwaway firms.
  await owner`DELETE FROM core.organization WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id IN ${owner(both)}`;
  await owner.end();
  await app.end();
});

describe("who a client email is from", () => {
  it("a one-Dept proposal is from that Dept's SPOC; two Depts, or none there, from the Key Manager", async () => {
    expect((await senders.senderForProposal(tenantId, proposalFrc))?.name).toBe("Priya");
    expect((await senders.senderForProposal(tenantId, proposalBoth))?.name).toBe("Ravi");
    // TRC has no SPOC for this client: the Key Manager.
    expect((await senders.senderForProposal(tenantId, proposalTrc))?.name).toBe("Ravi");
  });

  it("a portal letter is from the Key Manager, sent first or again", async () => {
    expect((await senders.senderForClient(tenantId, client))?.name).toBe("Ravi");
    expect((await senders.senderForContact(tenantId, contact))?.name).toBe("Ravi");
  });

  it("sent again to a group's contact, skips a company with no Key Manager", async () => {
    // An EARLIER grant on a company nobody was named for, as a group's contact has.
    await owner`
      INSERT INTO crm.portal_access (tenant_id, membership_id, client_party_id, valid_from, granted_by)
      VALUES (${tenantId}, ${contact}, ${bare}, '2025-06-01', ${ravi})
    `;
    expect((await senders.senderForContact(tenantId, contact))?.name).toBe("Ravi");
    await owner`DELETE FROM crm.portal_access WHERE tenant_id = ${tenantId} AND client_party_id = ${bare}`;
  });

  it("goes from the person's own address only once the firm lists the domain", async () => {
    expect(await senders.sendFromDomains(tenantId)).toEqual([]);
    expect((await senders.senderForProposal(tenantId, proposalFrc))?.ownAddress).toBe(false);
    await senders.setSendFromDomains(tenantId, ["10xglobal.in"]);
    const listed = await senders.senderForProposal(tenantId, proposalFrc);
    expect(listed?.name).toBe("Priya");
    expect(listed?.email.toLowerCase()).toBe(`priya-${stamp}@10xglobal.in`);
    expect(listed?.ownAddress).toBe(true);
    // Ravi's gmail address is never claimed.
    expect((await senders.senderForClient(tenantId, client))?.ownAddress).toBe(false);
    await senders.setSendFromDomains(tenantId, []);
  });

  it("refuses a malformed list in the database itself", async () => {
    await expect(
      owner`UPDATE tenancy.tenant SET send_from_domains = ARRAY['Not A Domain'] WHERE id = ${tenantId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner`UPDATE tenancy.tenant SET send_from_domains = ARRAY['priya@10xglobal.in'] WHERE id = ${tenantId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("finds nobody for a client with no account team, or one whose person has left", async () => {
    expect(await senders.senderForClient(tenantId, bare)).toBeNull();
    await owner`UPDATE tenancy.membership SET is_active = false WHERE tenant_id = ${tenantId} AND user_id = ${ravi}`;
    expect(await senders.senderForClient(tenantId, client)).toBeNull();
    // Priya is still there for her Dept.
    expect((await senders.senderForProposal(tenantId, proposalFrc))?.name).toBe("Priya");
    await owner`UPDATE tenancy.membership SET is_active = true WHERE tenant_id = ${tenantId} AND user_id = ${ravi}`;
  });

  it("finds nobody across the tenant wall", async () => {
    expect(await senders.senderForClient(otherTenant, client)).toBeNull();
    expect(await senders.senderForProposal(otherTenant, proposalFrc)).toBeNull();
    expect(await senders.senderForContact(otherTenant, contact)).toBeNull();
  });
});
