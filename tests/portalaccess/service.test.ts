// Gate 4's WRITER (G3.4). Migration 0059 built the wall and shipped with
// nothing that could write a grant, so the gate could only ever deny; these are
// the rules of the half that lets somebody in.
//
// The refusals are most of this file on purpose. Every one of them is a check
// the DATABASE cannot make — a composite foreign key proves the membership and
// the party belong to this firm and says nothing about whether the login is a
// client's, still works, or names a client the firm has archived.
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalAccessService } from "../../src/usecase/portalaccess/service";
import {
  FakePortalAccessRepo,
  FakePortalClients,
  FakePortalMemberships,
} from "../../src/testfakes/portalaccess";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const FIRM = "00000000-0000-4000-8000-00000000f001";
const PORTAL_LOGIN = "00000000-0000-4000-8000-00000000m001";
const STAFF_LOGIN = "00000000-0000-4000-8000-00000000m002";
const REVOKED_LOGIN = "00000000-0000-4000-8000-00000000m003";
const COBALT = "00000000-0000-4000-8000-00000000c001";
const KAVERI = "00000000-0000-4000-8000-00000000c002";
const GONE = "00000000-0000-4000-8000-00000000c003";
const PARTNER = "00000000-0000-4000-8000-00000000u001";

// Fixed so "today" is a value the assertions can name. The service's own
// fallback is the SERVER's day, which is exactly what a caller with a browser
// must override — see `today()`.
const NOW = new Date("2026-09-01T09:00:00.000Z");

function world() {
  const grants = new FakePortalAccessRepo();
  const memberships = new FakePortalMemberships();
  const clients = new FakePortalClients();
  const events = new RecordingEventSink();

  memberships.rows.set(PORTAL_LOGIN, {
    id: PORTAL_LOGIN,
    audience: "CLIENT_PORTAL",
    isActive: true,
  });
  memberships.rows.set(STAFF_LOGIN, { id: STAFF_LOGIN, audience: "STAFF", isActive: true });
  memberships.rows.set(REVOKED_LOGIN, {
    id: REVOKED_LOGIN,
    audience: "CLIENT_PORTAL",
    isActive: false,
  });
  clients.rows.set(COBALT, { id: COBALT, displayName: "Cobalt Foods", archivedAt: null });
  clients.rows.set(KAVERI, { id: KAVERI, displayName: "Kaveri Foods", archivedAt: null });
  clients.rows.set(GONE, { id: GONE, displayName: "Gone Traders", archivedAt: "2026-01-31" });
  grants.contacts.set(PORTAL_LOGIN, { email: "cfo@cobalt.test", displayName: "Meera Rao" });
  grants.clientNames.set(COBALT, "Cobalt Foods");
  grants.clientNames.set(KAVERI, "Kaveri Foods");
  grants.people.set(PARTNER, { email: "partner@10xglobal.in", displayName: "Siddharth Rao" });

  const service = new PortalAccessService({
    grants,
    memberships,
    clients,
    ids: new FakeIds(),
    clock: new FakeClock(NOW),
    timeZones: new FakeFirmTimeZone(),
    events,
  });
  return { service, grants, memberships, clients, events };
}

describe("granting a client to a portal login", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it("records the grant, from the caller's own day, with who decided it", async () => {
    const granted = await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    expect(granted).toMatchObject({
      membershipId: PORTAL_LOGIN,
      clientPartyId: COBALT,
      validFrom: "2026-09-01",
      validTo: null,
      grantedBy: PARTNER,
    });
    expect(w.events.verbs()).toContain("portal_access.granted");
  });

  it("takes the CALLER's calendar day when it is given one", async () => {
    // The server is in UTC and the firm is not. A grant meant to start today in
    // Delhi is dated tomorrow by a UTC server for five and a half hours every
    // morning — and this value decides what a client can see.
    const granted = await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-09-02",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    expect(granted.validFrom).toBe("2026-09-02");
  });

  it("NEVER puts a name in the ledger", async () => {
    // The client's name and the contact's email are personal data about people
    // OUTSIDE the firm, and this log cannot be erased. The row carries them.
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    const payload = JSON.stringify(w.events.recorded[0]?.payload ?? {});
    expect(payload).not.toMatch(/Cobalt|cobalt\.test|Meera/i);
    expect(payload).toContain(COBALT);
  });

  it("refuses a STAFF login — the grant would govern nothing", async () => {
    // Gate 2 already admits a colleague to the whole staff workspace, so this
    // row would record a permission that does nothing and read as though it did.
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: STAFF_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/CLIENT_PORTAL/);
  });

  it("refuses a revoked login", async () => {
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: REVOKED_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/revoked/i);
  });

  it("refuses a membership and a client this firm does not have", async () => {
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: "00000000-0000-4000-8000-0000000000ff", clientPartyId: COBALT, grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/no membership/i);
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: "00000000-0000-4000-8000-0000000000fe", grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/no party/i);
  });

  it("refuses an ARCHIVED client, and says archiving is what that means", async () => {
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: GONE, grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/archived/i);
  });

  it("refuses dates that describe a grant in force on no day", async () => {
    await expect(
      w.service.grant(
        {
          tenantId: FIRM,
          membershipId: PORTAL_LOGIN,
          clientPartyId: COBALT,
          validFrom: "2026-09-01",
          validTo: "2026-09-01",
          grantedBy: PARTNER,
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/LATER than validFrom/);
  });

  it("refuses an overlapping duplicate IN WORDS, before the constraint says 500", async () => {
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    await expect(
      w.service.grant(
        { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/already has access to Cobalt Foods/);
  });

  it("allows the SAME client again once the earlier grant is over", async () => {
    // Somebody leaves and comes back. The old row stays and still answers "could
    // they see this in March"; the new one is a separate decision.
    await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-01-01",
        validTo: "2026-04-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    const again = await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-09-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    expect(again.validFrom).toBe("2026-09-01");
    expect(w.grants.rows).toHaveLength(2);
  });

  it("ONE CLIENT PER CALL — a second company is a second decision", async () => {
    // The whole design: a group's contact who may see four companies has four
    // rows and four events, so who decided each is answerable. Nothing here
    // walks core.party_relationship to add the rest.
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: KAVERI, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    expect(w.events.verbs().filter((v) => v === "portal_access.granted")).toHaveLength(2);
  });
});

describe("ending a grant", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  async function granted() {
    return w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
  }

  it("REMOVE MEANS NOW: it ends today, and the scope is empty on the next read", async () => {
    // This defaulted to tomorrow until 0061, and walking it over HTTP settled
    // the argument: the firm pressed remove, asked what the session could see,
    // and the client was still there until midnight. The row understates that
    // person by part of a day; `portal_access.ended` still carries the instant.
    const grant = await granted();
    const ended = await w.service.end({ tenantId: FIRM, grantId: grant.id }, SYSTEM_ACTOR);
    expect(ended.validTo).toBe("2026-09-01");
    expect(w.events.verbs()).toContain("portal_access.ended");
    // The half that matters, and the reason the date alone is not the test.
    expect((await w.service.scopeFor(FIRM, PORTAL_LOGIN)).clientPartyIds).toEqual([]);
  });

  it("takes back a grant made the same morning — an EMPTY range, in force on no day", async () => {
    // Granted at 10:00, withdrawn at 10:01. Unrepresentable before 0061: the
    // firm's only options were to leave it standing until tomorrow or to have
    // never made the mistake.
    const grant = await granted();
    const ended = await w.service.end(
      { tenantId: FIRM, grantId: grant.id, validTo: "2026-09-01" },
      SYSTEM_ACTOR,
    );
    expect(ended.validFrom).toBe("2026-09-01");
    expect(ended.validTo).toBe("2026-09-01");
    expect((await w.service.scopeFor(FIRM, PORTAL_LOGIN, "2026-09-01")).clientPartyIds).toEqual([]);
  });

  it("still refuses to GRANT one in force on no day — that is a typo, not a decision", async () => {
    // The asymmetry, deliberately: the database allows the shape and the
    // service allows only the act that legitimately produces it.
    await expect(
      w.service.grant(
        {
          tenantId: FIRM,
          membershipId: PORTAL_LOGIN,
          clientPartyId: KAVERI,
          validFrom: "2026-09-01",
          validTo: "2026-09-01",
          grantedBy: PARTNER,
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/LATER than validFrom/);
  });

  it("keeps the row — the grant is closed, never deleted", async () => {
    const grant = await granted();
    await w.service.end({ tenantId: FIRM, grantId: grant.id }, SYSTEM_ACTOR);
    expect(w.grants.rows).toHaveLength(1);
    expect(w.grants.rows[0]?.clientPartyId).toBe(COBALT);
  });

  it("refuses to re-close one, so a date already recorded cannot be moved", async () => {
    const grant = await granted();
    await w.service.end({ tenantId: FIRM, grantId: grant.id }, SYSTEM_ACTOR);
    await expect(
      w.service.end({ tenantId: FIRM, grantId: grant.id }, SYSTEM_ACTOR),
    ).rejects.toThrow(/already stopped being in force/);
  });

  it("refuses an end date that is not after the day it started", async () => {
    const grant = await granted();
    await expect(
      w.service.end({ tenantId: FIRM, grantId: grant.id, validTo: "2026-08-01" }, SYSTEM_ACTOR),
    ).rejects.toThrow(/do not/);
  });

  it("refuses a grant this firm does not have", async () => {
    await expect(
      w.service.end(
        { tenantId: FIRM, grantId: "00000000-0000-4000-8000-0000000000fd" },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/no portal grant/i);
  });
});

describe("the scope one session gets", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it("is EMPTY for a login that has been granted nothing — and that is an answer", async () => {
    // Every portal login is in this state between being invited and being
    // granted anything. Empty means NOTHING, and `withPortal` must still set the
    // scope rather than skip it — the one silent mistake available here.
    const scope = await w.service.scopeFor(FIRM, PORTAL_LOGIN);
    expect(scope).toEqual({ membershipId: PORTAL_LOGIN, clientPartyIds: [] });
  });

  it("holds exactly the clients in force on the day asked about", async () => {
    await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-01-01",
        validTo: "2026-04-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: KAVERI,
        validFrom: "2026-03-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );

    // Half-open: on the day a grant ends it is already out.
    expect((await w.service.scopeFor(FIRM, PORTAL_LOGIN, "2026-02-01")).clientPartyIds).toEqual([
      COBALT,
    ]);
    expect(
      [...(await w.service.scopeFor(FIRM, PORTAL_LOGIN, "2026-03-15")).clientPartyIds].sort(),
    ).toEqual([COBALT, KAVERI].sort());
    expect((await w.service.scopeFor(FIRM, PORTAL_LOGIN, "2026-04-01")).clientPartyIds).toEqual([
      KAVERI,
    ]);
  });

  it("does not repeat a client that was re-granted on the changeover day", async () => {
    // A grant closed at D and another opened at D is what a re-grant looks like,
    // and the scope becomes a SQL `= ANY` — a duplicate there is noise in a
    // value read on every portal request.
    await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-01-01",
        validTo: "2026-06-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    await w.service.grant(
      {
        tenantId: FIRM,
        membershipId: PORTAL_LOGIN,
        clientPartyId: COBALT,
        validFrom: "2026-06-01",
        grantedBy: PARTNER,
      },
      SYSTEM_ACTOR,
    );
    expect((await w.service.scopeFor(FIRM, PORTAL_LOGIN, "2026-06-02")).clientPartyIds).toEqual([
      COBALT,
    ]);
  });
});

describe("reading who can see what", () => {
  it("carries NAMES, and both halves of every person", async () => {
    // The read-model rule, caught seven times in this codebase now:
    // `display_name` is nullable and genuinely empty at real firms, so a name
    // alone collapses "we hold no name" into "there is no person".
    const w = world();
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    const [row] = await w.service.listForMembership(FIRM, PORTAL_LOGIN);
    expect(row).toMatchObject({
      clientName: "Cobalt Foods",
      contactEmail: "cfo@cobalt.test",
      contactDisplayName: "Meera Rao",
      grantedByEmail: "partner@10xglobal.in",
    });
  });

  it("still returns the grant when the granter's account has been erased", async () => {
    // The audit trail's rule applied to a row: an account that stops resolving
    // must not take the grant off the screen, because who could see a client in
    // March is not corrected by somebody leaving.
    const w = world();
    w.grants.people.delete(PARTNER);
    await w.service.grant(
      { tenantId: FIRM, membershipId: PORTAL_LOGIN, clientPartyId: COBALT, grantedBy: PARTNER },
      SYSTEM_ACTOR,
    );
    const [row] = await w.service.listForClient(FIRM, COBALT);
    expect(row?.grantedByEmail).toBeNull();
    expect(row?.clientName).toBe("Cobalt Foods");
  });
});
