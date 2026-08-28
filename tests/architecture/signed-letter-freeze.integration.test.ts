// THE SIGNED-LETTER FREEZE, as a property of the TABLE rather than a list of
// columns somebody maintains.
//
// A signed engagement letter is the record of what a client agreed to, so it is
// frozen in the DATABASE (migration 0017) and not in the service: "what did they
// sign" is a question a court asks, and an application rule cannot answer it
// against a migration, a backfill or a 2 a.m. psql session.
//
// The freeze used to compare an ENUMERATED list of columns, which meant a column
// not on that list was SILENTLY editable after signature — no error, nothing to
// notice, and six columns were already in that hole. Migration 0019 inverted it:
// the trigger now refuses ANY change except to the short allow-list published by
// `crm.signed_letter_mutable_columns()`.
//
// This test does not enumerate the columns either. It asks the CATALOGUE for
// every column of `crm.engagement_letter` and, for each one that is not on the
// allow-list, updates it on a signed letter AS THE OWNER ROLE and demands
// `restrict_violation` — the same shape as tenant-keys.integration.test.ts, and
// for the same reason: a column added next month is covered the day it exists
// rather than the day somebody remembers. G1.1–G1.8 add roughly a dozen.
//
// It reads the allow-list from the database rather than keeping a second copy,
// because a duplicated list drifts in exactly the direction that matters — the
// test keeps passing while the freeze has been widened. The list's CONTENTS are
// then pinned below, so widening it is a visible, argued edit to this file.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);

/** The three columns that have a written reason to move after signature, per
 *  migration 0019. Pinned here so that adding a fourth means editing this line
 *  and saying why — the freeze cannot be widened quietly. */
const EXPECTED_MUTABLE = ["advance_recorded_at", "advance_recorded_by", "updated_at"];

/** Untouched by every test in this file: the frozen-column sweep updates it two
 *  dozen times and every one of those updates must be refused. */
let frozenLetter = "";
/** The one the allow-list is exercised against, so the sweep's row never moves. */
let advanceLetter = "";
/** Not signed — the control. A trigger that refused everything would pass every
 *  assertion above and break drafting. */
let draftLetter = "";
let recorder = "";

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  readonly category: string;
}

/** Each probe letter needs its own reference: `UNIQUE (tenant_id, ref)` (0020)
 *  is real, and two probes sharing one would fail on the constraint rather than
 *  on the freeze this file is about. */
let refCounter = 0;

async function insertSignedLetter(tenantId: string, partyId: string): Promise<string> {
  refCounter += 1;
  // Raw SQL, no service: the freeze exists to hold when the application is
  // bypassed, so the fixture bypasses it too. The trigger is BEFORE UPDATE OR
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
});

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

async function declaredMutableColumns(): Promise<readonly string[]> {
  const [row] = await owner<{ columns: string[] }[]>`
    SELECT crm.signed_letter_mutable_columns() AS columns
  `;
  if (!row) throw new Error("crm.signed_letter_mutable_columns() returned nothing");
  return row.columns;
}

/** A value guaranteed to DIFFER from what the probe letter holds — otherwise the
 *  freeze is right not to fire and the test proves nothing. NULL does it for any
 *  column that holds a value (the NOT NULL check runs after BEFORE triggers, so
 *  the trigger still gets its say); a column that is already NULL needs a typed
 *  literal instead, and a type this has no literal for stops the build rather
 *  than skipping the column. */
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
    // A sweep over an empty set passes vacuously, which is the one way this
    // test could lie about the whole table.
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
          // restrict_violation, and nothing else: a check or not-null violation
          // means the statement was stopped by an unrelated rule and the freeze
          // itself never fired.
          return code === "23001"
            ? null
            : `refused with SQLSTATE ${code ?? "(none)"}, not restrict_violation`;
        });
      if (outcome) escaped.push(`${column.name} (${column.type}): ${outcome}`);
    }

    // The message is the fix, not just the failure.
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
    // The trigger's other arm. A signed letter is superseded, never removed.
    const err = await owner`DELETE FROM crm.engagement_letter WHERE id = ${frozenLetter}`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("exempts exactly the three columns that have a reason, and they are real columns", async () => {
    const mutable = await declaredMutableColumns();
    expect([...mutable].sort()).toEqual([...EXPECTED_MUTABLE].sort());

    // A rename would otherwise shrink the freeze's exemptions to nothing
    // silently — or, worse, leave a stale name exempting a column that no
    // longer exists while the real one goes unprotected.
    const names = (await letterColumns()).map((c) => c.name);
    expect(mutable.filter((m) => !names.includes(m))).toEqual([]);
  });
});

describe("and it refuses only what it should", () => {
  it("still lets the advance be recorded on a signed letter", async () => {
    // The reason the allow-list exists. The advance is attested AFTER signature
    // — that is the whole sequence — and recording it is what releases the
    // engagements from `pending_advance`. A freeze that refused this would look
    // exactly like a freeze that worked, right up to the first client payment.
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
    // updated_at is on the allow-list even though tenancy.set_updated_at()
    // currently writes it in a trigger that fires AFTER the freeze. Depending on
    // that ordering would mean a trigger renamed in 2027 freezes the advance
    // gate solid with nothing connecting the two.
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
    // The control. A trigger that raised on everything would satisfy every
    // assertion above and make drafting impossible.
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
    // A refusal that does not say WHICH field was in the way sends whoever hit
    // it into the trigger source to find out.
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
