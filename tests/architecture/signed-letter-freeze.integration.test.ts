// The signed-letter freeze as a property of the TABLE. A signed letter is what the client
// agreed to, so it is frozen in the DATABASE (0017), where no migration, backfill or psql
// session gets past it. Since 0019 the trigger refuses ANY change except the allow-list
// `crm.signed_letter_mutable_columns()`, read from the DB here and its contents pinned below.
// Every column comes from the catalogue (like tenant-keys.integration.test.ts), so a new one
// is covered the day it exists. The line table (G1.6) is swept the same way with no
// allow-list: `crm.refuse_signed_child_change()` (0017) refuses every write.
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);

/** The columns with a written reason to move after signature (0019); pinned so the freeze
 *  cannot be widened quietly. */
const EXPECTED_MUTABLE = ["advance_recorded_at", "advance_recorded_by", "updated_at"];

/** Never changed: every one of the column sweep's updates must be refused. */
let frozenLetter = "";
/** A line on the frozen letter and one on the draft: the line sweep's subject and control. */
let frozenLine = "";
let draftLine = "";
/** The catalogue version both probe lines pin. */
let serviceVersion = "";
/** The signed letter `frozenLine` hangs off; its own, so the head sweep's row has no child. */
let frozenLineLetter = "";
/** The one the allow-list is exercised against, so the sweep's row never moves. */
let advanceLetter = "";
/** Unsigned control: a trigger that refused everything would pass and break drafting. */
let draftLetter = "";
let recorder = "";

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  readonly category: string;
}

/** One ref per probe letter, or `UNIQUE (tenant_id, ref)` (0020) fails before the freeze. */
let refCounter = 0;

async function insertSignedLetter(tenantId: string, partyId: string): Promise<string> {
  refCounter += 1;
  // Raw SQL: the freeze must hold when the app is bypassed. The trigger is BEFORE UPDATE OR
  // DELETE, so a row may be INSERTed already signed.
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title, status,
       currency, fx_rate, fx_rate_date,
       advance_required, advance_amount, sent_at, signed_at, signed_by_name,
       signature_method, signature_reference, signed_content_hash)
    VALUES (${tenantId}, ${`EL-2026-${String(refCounter).padStart(4, "0")}`}, ${partyId},
            ${partyId}, 'IN', 'Freeze probe — FY26', 'signed', 'INR', 1,
            '2026-07-01', true, 5000, now(), now(), 'Priya Menon', 'attested',
            'paper-freeze-probe', ${"a".repeat(64)})
    RETURNING id
  `;
  if (!row) throw new Error("could not create the signed probe letter");
  return row.id;
}

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`freeze-test-${stamp}`}, 'Freeze Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");

  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant.id}, 'organization', 'Freeze Probe Ltd') RETURNING id
  `;
  if (!party) throw new Error("could not create the test party");

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email)
    VALUES (${`freeze-${stamp}@example.test`}) RETURNING id
  `;
  if (!user) throw new Error("could not create the advance recorder");
  recorder = user.id;

  frozenLetter = await insertSignedLetter(tenant.id, party.id);
  advanceLetter = await insertSignedLetter(tenant.id, party.id);

  // A published service for the probe lines to pin.
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${tenant.id}, 'service', 'freeze-probe') RETURNING id
  `;
  if (!entry) throw new Error("could not create the probe service entry");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
    VALUES (${tenant.id}, ${entry.id}, 1, 'published',
            ${owner.json({ name: "Freeze probe service", billingBasis: "fixed" })}, now())
    RETURNING id
  `;
  if (!version) throw new Error("could not create the probe service version");
  serviceVersion = version.id;

  // The line must exist before signing: `trg_el_line_freeze` refuses an INSERT onto a
  // signed letter too. So draft, add the line, then sign.
  const lineLetter = await insertDraftLetter(tenant.id, party.id);
  frozenLine = await insertLine(tenant.id, lineLetter);
  await signLetter(lineLetter);
  frozenLineLetter = lineLetter;

  const [draft] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
       currency, fx_rate, fx_rate_date)
    VALUES (${tenant.id}, 'EL-2026-9999', ${party.id}, ${party.id}, 'IN',
            'Still being written', 'INR', 1, '2026-07-01')
    RETURNING id
  `;
  if (!draft) throw new Error("could not create the draft letter");
  draftLetter = draft.id;
  draftLine = await insertLine(tenant.id, draftLetter);
});

/** An UNSIGNED letter: a line cannot be inserted onto a signed one. */
async function insertDraftLetter(tenantId: string, partyId: string): Promise<string> {
  refCounter += 1;
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, ref, party_id, issuing_entity_party_id, jurisdiction, title,
       currency, fx_rate, fx_rate_date, advance_required)
    VALUES (${tenantId}, ${`EL-2026-${String(refCounter).padStart(4, "0")}`}, ${partyId},
            ${partyId}, 'IN', 'Freeze probe — line sweep', 'INR', 1, '2026-07-01', false)
    RETURNING id
  `;
  if (!row) throw new Error("could not create the draft probe letter");
  return row.id;
}

/** Sign in one statement: 0017's CHECKs refuse a signed letter with no signature. */
async function signLetter(letterId: string): Promise<void> {
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(),
           signed_by_name = 'Priya Menon', signature_method = 'attested',
           signature_reference = 'paper-line-sweep', signed_content_hash = ${"b".repeat(64)}
     WHERE id = ${letterId}
  `;
}

/** A line with EVERY nullable column filled: null-to-null is no change, so an empty line
 *  would pass the sweep vacuously. The four overrides hold real wording, a tamper's target. */
async function insertLine(tenantId: string, letterId: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, entity_party_id, service_version_id, description,
       position, quantity, unit_amount, currency, discount_percent, effective_from,
       jurisdiction, billing_frequency, scope_override, client_obligations_override,
       volume_limits_override, exclusions_override,
       oop_estimate_min, oop_estimate_max, oop_currency, pricing_note)
    SELECT ${tenantId}, ${letterId}, l.party_id, ${serviceVersion}, 'Freeze probe line',
           1, 12, 2000, 'INR', 5, '2026-08-01',
           'IN', 'quarterly', 'Scope as agreed with this client.',
           'Records by the 5th.', 'Under 1,000 entries.', 'Appeals are excluded.',
           5000, 6000, 'USD', 'Plus statutory fees at actuals'
    FROM crm.engagement_letter l WHERE l.id = ${letterId}
    RETURNING id
  `;
  if (!row) throw new Error("could not create the probe letter line");
  return row.id;
}

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

async function letterColumns(): Promise<readonly ColumnRow[]> {
  return owner<ColumnRow[]>`
    SELECT a.attname                              AS name,
           format_type(a.atttypid, a.atttypmod)   AS type,
           t.typcategory                          AS category
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'crm.engagement_letter'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
}

async function lineColumns(): Promise<readonly ColumnRow[]> {
  return owner<ColumnRow[]>`
    SELECT a.attname                              AS name,
           format_type(a.atttypid, a.atttypmod)   AS type,
           t.typcategory                          AS category
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'crm.engagement_letter_line'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
}

async function declaredMutableColumns(): Promise<readonly string[]> {
  const [row] = await owner<{ columns: string[] }[]>`
    SELECT crm.signed_letter_mutable_columns() AS columns
  `;
  if (!row) throw new Error("crm.signed_letter_mutable_columns() returned nothing");
  return row.columns;
}

/** A value that DIFFERS from the probe's, or the freeze rightly stays silent. NULL works for
 *  a filled column (NOT NULL is checked after BEFORE triggers); an empty column needs a typed
 *  literal, and a type with none fails the build rather than skipping the column. */
function probeValueFor(column: ColumnRow, currentlyNull: boolean): string {
  if (!currentlyNull) return "NULL";
  switch (column.category) {
    case "S":
      return `'tampered'::${column.type}`;
    case "N":
      return `7::${column.type}`;
    case "B":
      return `true::${column.type}`;
    case "D":
      return `'2001-02-03T04:05:06+00'::${column.type}`;
    case "U":
      if (column.type === "uuid") return `'11111111-1111-4111-8111-111111111111'::uuid`;
      // `printed_parties` (0334): what the letter printed, frozen with it.
      if (column.type === "jsonb") return `'{"probe": true}'::jsonb`;
      break;
    default:
      break;
  }
  throw new Error(
    `crm.engagement_letter.${column.name} is ${column.type} (pg_type.typcategory ` +
      `'${column.category}'), which this test has no probe value for — and it is NULL on the ` +
      `probe letter, so "set it to NULL" would change nothing and prove nothing. Add a case to ` +
      `probeValueFor(). The freeze is UNTESTED for this column until you do.`,
  );
}

describe("the freeze covers every column of crm.engagement_letter", () => {
  it("refuses an UPDATE to each frozen column, as the owner role", async () => {
    const columns = await letterColumns();
    const mutable = await declaredMutableColumns();
    const [current] = await owner<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(l) AS row FROM crm.engagement_letter l WHERE id = ${frozenLetter}
    `;
    if (!current) throw new Error("the probe letter vanished");

    const frozen = columns.filter((c) => !mutable.includes(c.name));
    // An empty sweep would pass vacuously.
    expect(frozen.length).toBeGreaterThan(0);

    const escaped: string[] = [];
    for (const column of frozen) {
      if (!/^[a-z_][a-z0-9_]*$/.test(column.name)) {
        throw new Error(`unexpected column name ${column.name}: this test builds SQL by hand`);
      }
      const probe = probeValueFor(column, current.row[column.name] === null);
      const outcome = await owner
        .unsafe(`UPDATE crm.engagement_letter SET "${column.name}" = ${probe} WHERE id = $1`, [
          frozenLetter,
        ])
        .then(() => "the UPDATE SUCCEEDED — this column is editable after signature")
        .catch((e: unknown) => {
          const code = (e as { code?: string }).code;
          // Only restrict_violation: a check or not-null violation means the freeze never fired.
          return code === "23001"
            ? null
            : `refused with SQLSTATE ${code ?? "(none)"}, not restrict_violation`;
        });
      if (outcome) escaped.push(`${column.name} (${column.type}): ${outcome}`);
    }

    expect(
      escaped,
      "each of these columns of a SIGNED engagement letter can be changed after the client " +
        "agreed to it. The freeze is crm.refuse_signed_change() (migration 0019) and it refuses " +
        "everything except crm.signed_letter_mutable_columns() — so a column reaching this list " +
        "means the trigger was weakened, or the column belongs on the allow-list and nobody " +
        "wrote down why.",
    ).toEqual([]);
  });

  it("refuses a DELETE of a signed letter", async () => {
    // A signed letter is superseded, never removed.
    const err = await owner`DELETE FROM crm.engagement_letter WHERE id = ${frozenLetter}`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("exempts exactly the three columns that have a reason, and they are real columns", async () => {
    const mutable = await declaredMutableColumns();
    expect([...mutable].sort()).toEqual([...EXPECTED_MUTABLE].sort());

    // A rename would silently leave a stale exemption while the real column goes unprotected.
    const names = (await letterColumns()).map((c) => c.name);
    expect(mutable.filter((m) => !names.includes(m))).toEqual([]);
  });
});

describe("the freeze covers every column of crm.engagement_letter_line", () => {
  it("refuses an UPDATE to each one, as the owner role", async () => {
    // No allow-list, by design: `crm.refuse_signed_child_change()` (0017) refuses ANY write
    // once the parent is signed, `updated_at` included. G1.6's four scope OVERRIDES are the
    // words the client agreed to; narrowing them later would make the issued document unreproducible.
    const columns = await lineColumns();
    const [current] = await owner<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(l) AS row FROM crm.engagement_letter_line l WHERE id = ${frozenLine}
    `;
    if (!current) throw new Error("the probe line vanished");
    expect(columns.length).toBeGreaterThan(0);

    const escaped: string[] = [];
    for (const column of columns) {
      if (!/^[a-z_][a-z0-9_]*$/.test(column.name)) {
        throw new Error(`unexpected column name ${column.name}: this test builds SQL by hand`);
      }
      const probe = probeValueFor(column, current.row[column.name] === null);
      const outcome = await owner
        .unsafe(`UPDATE crm.engagement_letter_line SET "${column.name}" = ${probe} WHERE id = $1`, [
          frozenLine,
        ])
        .then(() => "the UPDATE SUCCEEDED — this column is editable after signature")
        .catch((e: unknown) => {
          const code = (e as { code?: string }).code;
          return code === "23001"
            ? null
            : `refused with SQLSTATE ${code ?? "(none)"}, not restrict_violation`;
        });
      if (outcome) escaped.push(`${column.name} (${column.type}): ${outcome}`);
    }

    expect(
      escaped,
      "each of these columns of a line of a SIGNED engagement letter can be changed after the " +
        "client agreed to it. The freeze is crm.refuse_signed_child_change() (migration 0017) " +
        "and it refuses EVERY write to a signed letter's children — so a column reaching this " +
        "list means the trigger was weakened or dropped.",
    ).toEqual([]);
  });

  it("refuses MOVING a line off the signed letter onto a draft one", async () => {
    // The hole this sweep found, closed by 0024: 0017 resolved the parent from
    // NEW.engagement_letter_id only, so a signed letter's line could be repointed at a draft
    // (same firm, same currency) and silently leave the signed agreement.
    const err = await owner`
      UPDATE crm.engagement_letter_line
         SET engagement_letter_id = ${draftLetter}
       WHERE id = ${frozenLine}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
    // With two letters in the statement, the refusal must say the row was being moved.
    expect((err as Error).message).toContain("moves a engagement_letter_line");

    // And the line did not move.
    const [row] = await owner<{ engagement_letter_id: string }[]>`
      SELECT engagement_letter_id FROM crm.engagement_letter_line WHERE id = ${frozenLine}
    `;
    expect(row?.engagement_letter_id).toBe(frozenLineLetter);
  });

  it("refuses a DELETE, and an INSERT of a new line", async () => {
    // A term can be neither removed nor added; the add is the one an app rule forgets.
    const deleted = await owner`
      DELETE FROM crm.engagement_letter_line WHERE id = ${frozenLine}
    `.catch((e: unknown) => e);
    expect((deleted as { code?: string }).code).toBe("23001");

    const [letter] = await owner<{ tenant_id: string }[]>`
      SELECT tenant_id FROM crm.engagement_letter WHERE id = ${frozenLineLetter}
    `;
    const inserted = await insertLine(letter?.tenant_id ?? "", frozenLineLetter).catch(
      (e: unknown) => e,
    );
    expect((inserted as { code?: string }).code).toBe("23001");
  });

  it("leaves a DRAFT letter's line freely editable", async () => {
    // The control: a trigger that raised on everything would pass the tests above.
    await owner`
      UPDATE crm.engagement_letter_line
         SET scope_override = 'Rewritten while still a draft', billing_frequency = 'annually'
       WHERE id = ${draftLine}
    `;
    const [row] = await owner<{ scope_override: string; billing_frequency: string }[]>`
      SELECT scope_override, billing_frequency
      FROM crm.engagement_letter_line WHERE id = ${draftLine}
    `;
    expect(row?.scope_override).toBe("Rewritten while still a draft");
    expect(row?.billing_frequency).toBe("annually");
  });
});

describe("and it refuses only what it should", () => {
  it("still lets the advance be recorded on a signed letter", async () => {
    // Why the allow-list exists: the advance is recorded AFTER signature and releases the
    // engagements from `pending_advance`.
    await owner`
      UPDATE crm.engagement_letter
         SET advance_recorded_at = now(), advance_recorded_by = ${recorder}
       WHERE id = ${advanceLetter}
    `;
    const [row] = await owner<{ recorded_by: string | null }[]>`
      SELECT advance_recorded_by AS recorded_by
      FROM crm.engagement_letter WHERE id = ${advanceLetter}
    `;
    expect(row?.recorded_by).toBe(recorder);
  });

  it("lets updated_at be written explicitly on a signed letter", async () => {
    // Allow-listed though tenancy.set_updated_at() fires AFTER the freeze today: relying on
    // trigger order would let a rename freeze the advance gate.
    await owner`
      UPDATE crm.engagement_letter SET updated_at = now() WHERE id = ${advanceLetter}
    `;
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM crm.engagement_letter
      WHERE id = ${advanceLetter} AND status = 'signed'
    `;
    expect(Number(row?.n)).toBe(1);
  });

  it("leaves an UNSIGNED letter freely editable", async () => {
    // The control: a trigger that raised on everything would pass every test above.
    await owner`
      UPDATE crm.engagement_letter
         SET title = 'Rewritten while still a draft', jurisdiction = 'AE'
       WHERE id = ${draftLetter}
    `;
    const [row] = await owner<{ title: string; jurisdiction: string }[]>`
      SELECT title, jurisdiction FROM crm.engagement_letter WHERE id = ${draftLetter}
    `;
    expect(row?.title).toBe("Rewritten while still a draft");
    expect(row?.jurisdiction).toBe("AE");
  });

  it("names the columns the caller actually touched", async () => {
    // The refusal must say WHICH field was in the way.
    const err = await owner`
      UPDATE crm.engagement_letter
         SET title = 'quietly different', signature_reference = 'tampered'
       WHERE id = ${frozenLetter}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
    expect((err as Error).message).toContain("frozen");
    expect((err as Error).message).toContain("signature_reference, title");
  });
});

describe("and EVERY child of a signed letter is frozen, not just the ones we remember", () => {
  // Every TABLE with an `engagement_letter_id` column is a child of a letter and carries the
  // freeze, asked of the catalogue like the tenant-key guard. `line` and `clause` got hand-written
  // triggers in 0017; G1.7's `crm.document_block` showed a third child arrives unprotected otherwise.
  /**
   * Children DELIBERATELY not frozen: what the letter CAUSED or how it was OBTAINED, not what it
   * SAYS (lines, clauses, prose). Adding a name here needs an argument.
   * - `crm.engagement`: signing creates one per line in the signing transaction, and it moves on
   *   purpose (`pending_advance` -> `active` via `recordAdvance`).
   * - `crm.letter_signature_request` (0080): the DocuSign envelope; the sweep records
   *   `outcome = completed` one statement after the freeze lands. The envelope id that IS
   *   evidence is copied onto the letter's frozen `signature_reference`.
   * - `crm.recorded_acceptance` (0317): a yes by email or call, written in `signAndFanOut`'s
   *   transaction; append-only by GRANT (`bib_app` SELECT and INSERT only).
   * - `crm.billing_due` (0320): the advance bill, written at signing; its amount is copied from
   *   frozen columns and its settlement (raised, covered, released) must move; column GRANT per 0318.
   * - `crm.letter_originator` (0355, Q049): who won the work, for the revenue report; a wrong
   *   default (the lead's owner) must stay correctable. Only the person moves (column GRANT),
   *   ledgered as `engagement_letter.originator_set`, partner's route.
   * - `crm.advance_allocation` (0363, Q048 scenario 1): maps an earlier advance TO the letter at
   *   signing and may later be ended; what the letter agreed is the frozen
   *   `crm.engagement_letter_advance`.
   */
  const NOT_TERMS = [
    "crm.engagement",
    "crm.letter_signature_request",
    "crm.recorded_acceptance",
    "crm.billing_due",
    "crm.letter_originator",
    "crm.advance_allocation",
  ];

  it("finds no child table of an engagement letter without the freeze trigger", async () => {
    const unguarded = await owner<{ table: string }[]>`
      WITH children AS (
        SELECT c.oid, n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attname = 'engagement_letter_id' AND a.attnum > 0
        WHERE c.relkind = 'r'
      )
      SELECT ch.nspname || '.' || ch.relname AS table
      FROM children ch
      WHERE ch.nspname || '.' || ch.relname <> ALL(${NOT_TERMS})
        AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = ch.oid
          AND NOT t.tgisinternal
          AND t.tgfoid = 'crm.refuse_signed_child_change()'::regprocedure
      )
      ORDER BY 1
    `;

    expect(
      unguarded.map((u) => u.table),
      "each of these tables hangs off an engagement letter and is NOT frozen when that letter " +
        "is signed, so what the client agreed to can still be changed afterwards. Add:  " +
        "CREATE TRIGGER trg_<name>_freeze BEFORE INSERT OR UPDATE OR DELETE ON <table> " +
        "FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();",
    ).toEqual([]);
  });

  // A derived guard's own failure mode: matching nothing and passing vacuously.
  it("is actually looking at the child tables it thinks it is", async () => {
    const found = await owner<{ table: string }[]>`
      SELECT n.nspname || '.' || c.relname AS table
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'engagement_letter_id' AND a.attnum > 0
      WHERE c.relkind = 'r'
      ORDER BY 1
    `;
    expect(found.map((f) => f.table)).toEqual(
      expect.arrayContaining([
        "crm.document_block",
        "crm.engagement",
        "crm.engagement_letter_clause",
        "crm.engagement_letter_line",
      ]),
    );
  });
});
