// The two SQL facts behind re-sending a portal invitation (T7.0b).
//
// Both are things only a real Postgres can answer, and both are load-bearing:
//
//   `consumeUnusedFor` decides whether a contact can end up holding SEVERAL
//   live password setters at once. A fake can assert that our code called it;
//   only the database can assert that the predicate — right user, right
//   purpose, not already spent, NOT ALREADY EXPIRED — selects the rows we mean
//   and leaves every other row alone. Getting the `user_id` clause wrong would
//   spend somebody else's invitation, and nothing above this layer could see it.
//
//   `contact_accepted` is an EXISTS over `tenancy.credential`, and it is what
//   the screen uses to decide whether to offer the resend at all. It is
//   computed in the query rather than derived anywhere else, so this is the
//   only place it can be checked.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresMagicLinkRepository } from "../../src/infrastructure/postgres/identity-repository";
import { PostgresPortalAccessRepository } from "../../src/infrastructure/postgres/portal-access-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
let clientId = "";
/** Two accounts, because the sharp edge of `consumeUnusedFor` is the `user_id`
 *  clause: a query that spent every unused invite would be silent, correct on
 *  one row, and wrong the moment a firm has two contacts waiting. */
let invited = "";
let accepted = "";
let invitedMembership = "";
let acceptedMembership = "";

const links = new PostgresMagicLinkRepository(app);
const grants = new PostgresPortalAccessRepository(app);

/** A magic link, inserted as the owner so the test controls the expiry. */
async function link(userId: string, purpose: string, expiresAt: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.magic_link (user_id, token_hash, purpose, expires_at)
    VALUES (${userId}, ${`h-${stamp}-${Math.random()}`}, ${purpose}, ${expiresAt}::timestamptz)
    RETURNING id
  `;
  if (!row) throw new Error("could not insert a magic link");
  return row.id;
}

async function consumedAt(id: string): Promise<string | null> {
  const [row] = await owner<{ consumed_at: string | null }[]>`
    SELECT consumed_at FROM tenancy.magic_link WHERE id = ${id}
  `;
  return row?.consumed_at ?? null;
}

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`portal-resend-${stamp}`}, 'Portal Resend Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${`Client ${stamp}`}) RETURNING id
  `;
  if (!party) throw new Error("could not create the client");
  clientId = party.id;

  const account = async (email: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email) VALUES (${email}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${email}`);
    return row.id;
  };
  invited = await account(`invited-${stamp}@example.test`);
  accepted = await account(`accepted-${stamp}@example.test`);

  const membership = async (userId: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
      VALUES (${tenantId}, ${userId}, 'CLIENT_PORTAL', 'client_contact') RETURNING id
    `;
    if (!row) throw new Error("could not create the membership");
    return row.id;
  };
  invitedMembership = await membership(invited);
  acceptedMembership = await membership(accepted);

  // ONE of them has a password. That single row is the whole of
  // `contact_accepted`, and 0004 says so: an account with no row here is
  // somebody invited who has never set one.
  await owner`
    INSERT INTO tenancy.credential (user_id, password_hash)
    VALUES (${accepted}, 'scrypt$16384$8$1$salt$hash')
  `;

  const grant = async (membershipId: string): Promise<void> => {
    await owner`
      INSERT INTO crm.portal_access (tenant_id, membership_id, client_party_id, valid_from, granted_by)
      VALUES (${tenantId}, ${membershipId}, ${clientId}, CURRENT_DATE, ${invited})
    `;
  };
  await grant(invitedMembership);
  await grant(acceptedMembership);
});

afterAll(async () => {
  await owner`DELETE FROM tenancy.magic_link WHERE user_id IN (${invited}, ${accepted})`;
  await owner`DELETE FROM crm.portal_access WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.credential WHERE user_id = ${accepted}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.user_account WHERE id IN (${invited}, ${accepted})`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("consumeUnusedFor — what a re-issued invitation spends", () => {
  it("spends the LIVE invites of ONE user, and reports how many", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const mineA = await link(invited, "invite", future);
    const mineB = await link(invited, "invite", future);
    const somebodyElses = await link(accepted, "invite", future);

    const spent = await links.consumeUnusedFor(invited, "invite", new Date().toISOString());

    expect(spent).toBe(2);
    expect(await consumedAt(mineA)).not.toBeNull();
    expect(await consumedAt(mineB)).not.toBeNull();
    // THE ASSERTION THAT MATTERS. A `user_id` clause left off would pass every
    // test above this line and would quietly cancel another contact's
    // invitation — on a route any member of the firm can press.
    expect(await consumedAt(somebodyElses)).toBeNull();
  });

  it("leaves another PURPOSE alone — a sign-in link is not an invitation", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const signIn = await link(invited, "login", future);
    const welcome = await link(invited, "welcome", future);

    await links.consumeUnusedFor(invited, "invite", new Date().toISOString());

    expect(await consumedAt(signIn)).toBeNull();
    expect(await consumedAt(welcome)).toBeNull();
  });

  it("does not touch an ALREADY EXPIRED link, so the count stays honest", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const dead = await link(invited, "invite", past);

    // Zero is the ordinary answer when the first link has run out, which is the
    // commonest reason anybody presses "Send it again" — and it is the number
    // the ledger event carries, so an expired row counted here would be a
    // permanent record saying a live invitation was replaced when none was.
    const spent = await links.consumeUnusedFor(invited, "invite", new Date().toISOString());

    expect(spent).toBe(0);
    expect(await consumedAt(dead)).toBeNull();
  });

  it("is idempotent — a second call spends nothing", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await link(invited, "invite", future);

    const now = new Date().toISOString();
    expect(await links.consumeUnusedFor(invited, "invite", now)).toBe(1);
    expect(await links.consumeUnusedFor(invited, "invite", now)).toBe(0);
  });
});

describe("contactAccepted — the fact the screen offers the button on", () => {
  it("is false for somebody invited and true for somebody who set a password", async () => {
    const rows = await grants.listForClient(tenantId, clientId);

    const byMembership = new Map(rows.map((r) => [r.access.membershipId, r.contactAccepted]));
    expect(byMembership.get(invitedMembership)).toBe(false);
    expect(byMembership.get(acceptedMembership)).toBe(true);
  });

  it("flips the moment a credential row exists, and nothing else changes", async () => {
    await owner`
      INSERT INTO tenancy.credential (user_id, password_hash)
      VALUES (${invited}, 'scrypt$16384$8$1$salt$hash')
    `;
    try {
      const rows = await grants.listForClient(tenantId, clientId);
      const row = rows.find((r) => r.access.membershipId === invitedMembership);
      expect(row?.contactAccepted).toBe(true);
      // The GRANT is untouched. Accepting an invitation is an identity act and
      // says nothing about what the firm decided this person may see.
      expect(row?.access.validTo).toBeNull();
    } finally {
      await owner`DELETE FROM tenancy.credential WHERE user_id = ${invited}`;
    }
  });
});
