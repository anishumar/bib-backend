// Which MONTH a document falls in, proven against a real database (0071).
//
// ── THE BUG, AS A SENTENCE ─────────────────────────────────────────────────
//
// `/portal/month` answered *"what did the firm do for me in September"* by
// casting a `timestamptz` to a `date`. An unqualified cast uses the SESSION's
// TimeZone, which nothing in this product sets — so the answer was the SERVER's.
// For an Indian firm that is wrong for five and a half hours every night: a
// document filed at 02:00 IST on 1 October is 20:30 UTC on 30 September and
// landed in SEPTEMBER's digest.
//
// ── AND WHY ONLY A DATABASE CAN SAY SO ─────────────────────────────────────
//
// The fake stores days as `YYYY-MM-DD` strings, so there is no instant for a
// zone to convert and its `digest` ignores the argument entirely — correctly.
// The whole effect lives in SQL. A unit test here would assert that a string
// comparison still works.
//
// The subject instant is chosen so the two zones DISAGREE, which is the only
// kind of fixture that can fail: 2026-09-30T20:30:00Z is 30 September in UTC
// and 1 October in Asia/Kolkata. A document at midday would pass under any
// implementation, including the broken one.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresPortalLibraryRepository } from "../../src/infrastructure/postgres/portal-library-repository";
import { isTimeZone } from "../../src/domain/tenancy/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const library = new PostgresPortalLibraryRepository(app);

/** 30 September in UTC · 1 October in Asia/Kolkata. The whole test. */
const ON_THE_BOUNDARY = "2026-09-30T20:30:00.000Z";
const SEPTEMBER = { from: "2026-09-01", to: "2026-10-01" };
const OCTOBER = { from: "2026-10-01", to: "2026-11-01" };

const stamp = String(Date.now());
let tenantId = "";
let clientId = "";
let staffUser = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`tz-${stamp}`}, 'Timezone Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the tenant");
  tenantId = tenant.id;

  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Foods Private Limited') RETURNING id
  `;
  if (!client) throw new Error("could not create the client");
  clientId = client.id;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, status)
    VALUES (${`tz-${stamp}@example.com`}, 'active') RETURNING id
  `;
  if (!user) throw new Error("could not create the user");
  staffUser = user.id;

  // `created_at` is written EXPLICITLY rather than defaulted, which is the only
  // way to sit a row on a boundary a test can reason about.
  const [doc] = await owner<{ id: string }[]>`
    INSERT INTO files.document
      (tenant_id, title, origin, kind, party_id, is_client_visible, created_by, created_at)
    VALUES (${tenantId}, 'gst-challan', 'uploaded', 'statutory_filing', ${clientId},
            true, ${staffUser}, ${ON_THE_BOUNDARY}::timestamptz)
    RETURNING id
  `;
  if (!doc) throw new Error("could not create the document");
  await owner`
    INSERT INTO files.document_version
      (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename,
       storage_key, created_by)
    VALUES (${tenantId}, ${doc.id}, 1, ${"a".repeat(64)}, 12, 'application/pdf',
            'gst-challan.pdf', ${`k/tz-${stamp}`}, ${staffUser})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

const titles = (rows: readonly { readonly label: string }[]): readonly string[] =>
  rows.map((r) => r.label);

describe("the month a document belongs to is the FIRM's, not the server's", () => {
  it("is September for a firm on UTC", async () => {
    const digest = await library.digest(tenantId, [clientId], SEPTEMBER, "UTC");
    expect(titles(digest.documentsAdded)).toEqual(["gst-challan"]);
    expect(digest.documentsAdded[0]?.on).toBe("2026-09-30");
  });

  it("is OCTOBER for a firm on Asia/Kolkata — the same row, the other month", async () => {
    // The assertion this file exists for. Before 0071 both of these returned the
    // September answer, because the cast asked the server.
    const september = await library.digest(tenantId, [clientId], SEPTEMBER, "Asia/Kolkata");
    expect(titles(september.documentsAdded)).toEqual([]);

    const october = await library.digest(tenantId, [clientId], OCTOBER, "Asia/Kolkata");
    expect(titles(october.documentsAdded)).toEqual(["gst-challan"]);
    expect(october.documentsAdded[0]?.on).toBe("2026-10-01");
  });

  it("moves the other way too, so this is a ZONE and not an offset that was added", async () => {
    // A firm west of Greenwich puts the same instant on 30 September at 16:30
    // local — still September, and a day EARLIER than Kolkata's. If the fix had
    // been a hardcoded shift rather than a real zone conversion, one of these
    // three cases would be wrong.
    const september = await library.digest(tenantId, [clientId], SEPTEMBER, "America/New_York");
    expect(titles(september.documentsAdded)).toEqual(["gst-challan"]);
    expect(september.documentsAdded[0]?.on).toBe("2026-09-30");
  });

  it("keeps the range HALF-OPEN in every zone, so no month claims a row twice", async () => {
    // `[from, to)` is the rule everywhere in this schema, and converting the
    // bounds to instants is where it would quietly become inclusive. Under
    // Kolkata the row belongs to October and to October only.
    const both = await Promise.all([
      library.digest(tenantId, [clientId], SEPTEMBER, "Asia/Kolkata"),
      library.digest(tenantId, [clientId], OCTOBER, "Asia/Kolkata"),
    ]);
    const counted = both.reduce((n, d) => n + d.documentsAdded.length, 0);
    expect(counted).toBe(1);
  });
});

describe("the domain's check and the database's agree on the zones that matter", () => {
  it("accepts the same names Postgres does", async () => {
    // PINNING A MEASUREMENT, not asserting a belief. `isTimeZone` deliberately
    // does NOT use `Intl.supportedValuesOf`, because that list omits `UTC` and
    // `Asia/Kolkata` — this product's default and its first customer's zone —
    // and canonicalises Kolkata to `Asia/Calcutta`, which this database does not
    // know. If a runtime or a tzdata upgrade ever moves either list, this is
    // where it surfaces, rather than on a firm's settings screen.
    const names = ["UTC", "Asia/Kolkata", "Europe/London", "America/New_York"];
    const known = await owner<{ name: string }[]>`
      SELECT name FROM pg_timezone_names WHERE name IN ${owner(names)}
    `;
    expect(known.map((r) => r.name).sort()).toEqual([...names].sort());
    for (const name of names) expect(isTimeZone(name)).toBe(true);
  });

  it("refuses an OFFSET, which Intl takes and Postgres does not", async () => {
    // The one class the domain check has to reject on its own, and the product
    // reason is better than the technical one: an offset cannot express
    // daylight saving, so a firm on `+01:00` would cut its months an hour wrong
    // for half the year.
    expect(isTimeZone("+05:30")).toBe(false);
    const known = await owner<{ name: string }[]>`
      SELECT name FROM pg_timezone_names WHERE name = '+05:30'
    `;
    expect(known).toEqual([]);
  });
});
