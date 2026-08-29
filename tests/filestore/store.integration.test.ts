// The document store, proven where its claims actually have to hold: the
// database (T3.6, migration 0037).
//
// Five properties, and not one of them can be tested with a fake, because a fake
// is exactly the thing that agrees with the service by construction:
//
//   1. RLS isolates a firm's documents. A fake filters by tenantId because it
//      was written to; Postgres has to be told, and this proves it was.
//   2. `files.document_version` is APPEND-ONLY, and it is append-only because
//      of a missing GRANT rather than a trigger. A trigger is a rule the table
//      carries; a missing grant is a permission the role does not hold, and an
//      import or an agent walks past the first and not the second.
//   3. The COMPOSITE foreign keys refuse a cross-tenant reference. This is the
//      failure RLS does not catch: a foreign-key check runs as a system
//      operation the row policies do not filter, so an id-only reference would
//      let one firm's document hang off another firm's party with every policy
//      satisfied.
//   4. One ACTIVE brand asset per (entity, kind), enforced by the partial unique
//      index — so "the current logo" is a lookup and not a sort over history.
//   5. `bib_app` holds no DELETE on any of these tables. Nothing in this product
//      destroys a document, and that is a permission rather than a convention.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface Ids {
  tenantA: string;
  tenantB: string;
  partyA: string;
  partyB: string;
  docA: string;
  versionA: string;
}
let ids: Ids;

beforeAll(async () => {
  // Two firms, deliberately. Isolation you cannot see is isolation you cannot
  // trust — with one tenant seeded, an RLS bug looks exactly like a working
  // system.
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`docstore-a-${stamp}`}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`docstore-b-${stamp}`}, 'Fern & Co', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("tenant seed failed");

  const [pa] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${a.id}, 'organization', 'Kaveri Foods') RETURNING id
  `;
  const [pb] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${b.id}, 'organization', 'Other Firm Client') RETURNING id
  `;
  if (!pa || !pb) throw new Error("party seed failed");

  const [doc] = await owner<{ id: string }[]>`
    INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
    VALUES (${a.id}, 'PAN card', 'uploaded', 'identity_proof', ${pa.id}) RETURNING id
  `;
  if (!doc) throw new Error("document seed failed");

  const [version] = await owner<{ id: string }[]>`
    INSERT INTO files.document_version
      (tenant_id, document_id, version_no, content_hash, byte_size, media_type,
       filename, storage_key)
    VALUES (${a.id}, ${doc.id}, 1, ${HASH_A}, 2048, 'application/pdf', 'pan.pdf',
            ${`${a.id}/aa/${HASH_A}`})
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    partyA: pa.id,
    partyB: pb.id,
    docA: doc.id,
    versionA: version.id,
  };
});

afterAll(async () => {
  // Newest-first, and as the OWNER: `bib_app` holds no DELETE grant on these
  // tables, which is the fifth property below.
  await owner`DELETE FROM files.brand_asset WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM files.document_link WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM files.document_version WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM files.document WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM core.party WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.tenant WHERE id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner.end();
  await app.end();
});

/** One transaction with the tenant key set, exactly as `withTenant` does it. */
async function asTenant<T>(
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe("RLS isolates one firm's documents from another's", () => {
  it("firm A sees its document", async () => {
    const rows = await asTenant(
      ids.tenantA,
      (tx) => tx<{ id: string }[]>`SELECT id FROM files.document`,
    );
    expect(rows.map((r) => r.id)).toContain(ids.docA);
  });

  it("firm B cannot see it, and gets an empty result rather than an error", async () => {
    // The shape matters: RLS filters, it does not refuse. A leak here would be
    // silent, which is why it is tested rather than assumed.
    const rows = await asTenant(
      ids.tenantB,
      (tx) => tx<{ id: string }[]>`SELECT id FROM files.document`,
    );
    expect(rows.map((r) => r.id)).not.toContain(ids.docA);
  });

  it("firm B cannot see firm A's versions or reach its storage key", async () => {
    // The storage key is the thing that would let bytes be fetched. RLS on the
    // version row is what makes it unreachable, which is the first half of "no
    // pre-signed URL escape".
    const rows = await asTenant(
      ids.tenantB,
      (tx) => tx`SELECT storage_key FROM files.document_version`,
    );
    expect(rows).toHaveLength(0);
  });

  it("firm B cannot INSERT a document into firm A's tenant", async () => {
    // WITH CHECK, not just USING. Without it a firm could write rows it could
    // not then read — invisible to itself and visible to the victim.
    await expect(
      asTenant(
        ids.tenantB,
        (tx) => tx`
          INSERT INTO files.document (tenant_id, title, origin, kind)
          VALUES (${ids.tenantA}, 'smuggled', 'uploaded', 'other')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("versions are append-only, by GRANT and not by trigger", () => {
  it("the app role cannot UPDATE a stored version", async () => {
    // A version that could be edited is a document whose history is a
    // suggestion. The content hash in particular is evidence.
    await expect(
      asTenant(
        ids.tenantA,
        (tx) => tx`
          UPDATE files.document_version SET content_hash = ${HASH_B} WHERE id = ${ids.versionA}
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the app role holds no UPDATE privilege on the table at all", async () => {
    const [row] = await app<{ can: boolean }[]>`
      SELECT has_table_privilege('bib_app', 'files.document_version', 'UPDATE') AS can
    `;
    expect(row?.can).toBe(false);
  });

  it("but CAN insert a further version — appending is the whole point", async () => {
    const inserted = await asTenant(
      ids.tenantA,
      (tx) => tx<{ id: string }[]>`
        INSERT INTO files.document_version
          (tenant_id, document_id, version_no, content_hash, byte_size, media_type,
           filename, storage_key)
        VALUES (${ids.tenantA}, ${ids.docA}, 2, ${HASH_B}, 4096, 'application/pdf',
                'pan-v2.pdf', ${`${ids.tenantA}/bb/${HASH_B}`})
        RETURNING id
      `,
    );
    expect(inserted).toHaveLength(1);
  });
});

describe("the composite foreign keys carry the tenant", () => {
  it("a document cannot point at another firm's party", async () => {
    // The failure RLS does NOT catch: the FK check runs as a system operation
    // the row policies do not filter, so an id-only reference would be accepted
    // with every policy satisfied.
    await expect(
      asTenant(
        ids.tenantA,
        (tx) => tx`
          INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
          VALUES (${ids.tenantA}, 'cross-tenant', 'uploaded', 'other', ${ids.partyB})
        `,
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a version cannot hang off another firm's document", async () => {
    const [otherDoc] = await owner<{ id: string }[]>`
      INSERT INTO files.document (tenant_id, title, origin, kind)
      VALUES (${ids.tenantB}, 'B document', 'uploaded', 'other') RETURNING id
    `;
    await expect(
      asTenant(
        ids.tenantA,
        (tx) => tx`
          INSERT INTO files.document_version
            (tenant_id, document_id, version_no, content_hash, byte_size, media_type,
             filename, storage_key)
          VALUES (${ids.tenantA}, ${otherDoc?.id ?? null}, 1, ${HASH_A}, 1, 'text/plain',
                  'x.txt', 'k')
        `,
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("one active brand asset per entity and kind", () => {
  it("refuses a second active logo for the same entity", async () => {
    await asTenant(
      ids.tenantA,
      (tx) => tx`
        INSERT INTO files.brand_asset (tenant_id, entity_party_id, kind, document_version_id)
        VALUES (${ids.tenantA}, ${ids.partyA}, 'logo', ${ids.versionA})
      `,
    );

    await expect(
      asTenant(
        ids.tenantA,
        (tx) => tx`
          INSERT INTO files.brand_asset (tenant_id, entity_party_id, kind, document_version_id)
          VALUES (${ids.tenantA}, ${ids.partyA}, 'logo', ${ids.versionA})
        `,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("but a superseded one may pile up freely", async () => {
    // A partial index rather than a constraint, precisely so history can
    // accumulate: the mark in force when a document was issued stays readable.
    await asTenant(
      ids.tenantA,
      (tx) => tx`
        UPDATE files.brand_asset SET is_active = false
        WHERE entity_party_id = ${ids.partyA} AND kind = 'logo'
      `,
    );
    const inserted = await asTenant(
      ids.tenantA,
      (tx) => tx<{ id: string }[]>`
        INSERT INTO files.brand_asset (tenant_id, entity_party_id, kind, document_version_id)
        VALUES (${ids.tenantA}, ${ids.partyA}, 'logo', ${ids.versionA})
        RETURNING id
      `,
    );
    expect(inserted).toHaveLength(1);

    const all = await asTenant(
      ids.tenantA,
      (tx) => tx`SELECT id FROM files.brand_asset WHERE entity_party_id = ${ids.partyA}`,
    );
    expect(all.length).toBeGreaterThan(1);
  });
});

describe("nothing is destroyed", () => {
  it("the app role holds no DELETE on any table in the files schema", async () => {
    const rows = await app<{ table_name: string; can: boolean }[]>`
      SELECT c.relname AS table_name,
             has_table_privilege('bib_app', c.oid, 'DELETE') AS can
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'files' AND c.relkind = 'r'
      ORDER BY 1
    `;
    // Derived from the catalogue rather than listed, so a table added to this
    // schema next month is covered the day it exists.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.can)).toEqual([]);
  });
});
