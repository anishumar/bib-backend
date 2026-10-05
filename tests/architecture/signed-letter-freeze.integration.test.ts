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
// AND THE SAME SWEEP OVER THE LINE TABLE, added by G1.6. The head's freeze was
// a property of the TABLE and the line's was a property of nobody checking: a
// column added to `crm.engagement_letter_line` was protected by
// `crm.refuse_signed_child_change()` (0017, which refuses ANY write) and
// nothing said so, so the ten columns G1.6 added — the four scope OVERRIDES
// among them, which are the words the client actually agreed to — would have
// gone in with no test claiming they cannot move after signature. The line
// sweep asks the catalogue the same way, so the eleventh column is covered the
// day it exists. It needs no allow-list: nothing on a signed letter's line may
// change, and that is the whole rule.
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
/** A live line on the frozen letter, and one on the draft — the line sweep's
 *  subject and its control. */
let frozenLine = "";
let draftLine = "";
/** The catalogue version both probe lines pin. */
let serviceVersion = "";
/** The signed letter `frozenLine` hangs off — its own, so the head sweep's row
 *  never gains a child. */
let frozenLineLetter = "";
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

  // A published service for the probe lines to pin. Raw SQL, like everything
  // else here: this file bypasses the application on purpose.
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

  // THE LINE HAS TO EXIST BEFORE THE SIGNATURE. `trg_el_line_freeze` refuses an
  // INSERT onto a signed letter as firmly as an UPDATE — which is the rule, not
  // an obstacle — so the sweep's letter is drafted, given its line, and only
  // then signed.
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

/** An UNSIGNED letter. The line sweep needs one, because a line cannot be
 *  inserted onto a signed letter at all. */
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

/** Sign it, in the one statement the CHECKs allow: a letter that claims to be
 *  signed with no signature is refused by 0017. */
async function signLetter(letterId: string): Promise<void> {
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(),
           signed_by_name = 'Priya Menon', signature_method = 'attested',
           signature_reference = 'paper-line-sweep', signed_content_hash = ${"b".repeat(64)}
     WHERE id = ${letterId}
  `;
}

/**
 * A line on a letter, with EVERY nullable column filled in.
 *
 * Filled in because a freeze is only exercised by columns that hold something:
 * "set a null column to null" is not a change, and the sweep below would pass
 * vacuously on a line that stated nothing. The four overrides in particular have
 * to hold real wording — they are what a tamper would target.
 */
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

describe("the freeze covers every column of crm.engagement_letter_line", () => {
  it("refuses an UPDATE to each one, as the owner role", async () => {
    // The LINE table has no allow-list, and that asymmetry is the design:
    // `crm.refuse_signed_child_change()` (0017) refuses ANY write once the
    // parent is signed, because nothing on a term of a signed agreement has a
    // reason to move. So every column is swept, `updated_at` included — a
    // trigger that tried to touch it on a signed line would itself be refused,
    // which is correct.
    //
    // G1.6's ten columns are the reason this sweep exists. The four scope
    // OVERRIDES are the words the client agreed to; a letter whose scope could
    // be quietly narrowed after signature would make the whole G1.6 argument —
    // "this is what makes an issued document reproducible" — false.
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
    // THE HOLE THIS SWEEP FOUND, and what migration 0024 closed.
    // `crm.refuse_signed_child_change()` (0017) resolved the parent from
    // NEW.engagement_letter_id on an UPDATE, so it asked about the letter the
    // row was moving TO and never about the one it was moving FROM. Repointing
    // a signed letter's line at any draft letter of the same firm in the same
    // currency succeeded — a term removed from a signed agreement, the letter's
    // totals changed, and nothing raised.
    //
    // It is the same SHAPE of bug as the one 0019 fixed on the head: a trigger
    // asking a narrower question than the rule it enforces.
    const err = await owner`
      UPDATE crm.engagement_letter_line
         SET engagement_letter_id = ${draftLetter}
       WHERE id = ${frozenLine}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
    // The refusal names WHICH letter objected and says the row was being moved,
    // because "the letter is signed" with two letters in the statement sends
    // the reader to the trigger source.
    expect((err as Error).message).toContain("moves a engagement_letter_line");

    // The line is still where it was. A refusal that left it moved would be the
    // bug with an error message.
    const [row] = await owner<{ engagement_letter_id: string }[]>`
      SELECT engagement_letter_id FROM crm.engagement_letter_line WHERE id = ${frozenLine}
    `;
    expect(row?.engagement_letter_id).toBe(frozenLineLetter);
  });

  it("refuses a DELETE, and an INSERT of a new line", async () => {
    // The other two arms. A term cannot be removed from a signed agreement, and
    // one cannot be added to it either — the second is the one an application
    // rule forgets.
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
    // The control. A trigger that raised on everything would satisfy both
    // assertions above and make drafting impossible.
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

describe("and EVERY child of a signed letter is frozen, not just the ones we remember", () => {
  // THE GAP THIS CLOSES. The sweep above enumerates the COLUMNS of
  // `engagement_letter_line` from the catalogue, so a column added next month
  // is covered the day it exists. Nothing did the same for the TABLES: `line`
  // and `clause` got their triggers in 0017 because somebody wrote two CREATE
  // TRIGGER statements, and a third child table would have arrived unprotected
  // with every test in this file still green.
  //
  // That is not hypothetical — G1.7 added `crm.document_block`, and the prose a
  // client agreed to is exactly as much a term of the agreement as a line is.
  // So the rule is asked of the catalogue, the way the tenant-key guard is: any
  // table with an `engagement_letter_id` column is a child of a letter, and a
  // child of a letter carries the freeze.
  /**
   * `crm.engagement` is a child of a letter and is DELIBERATELY not frozen, and
   * the exception is named here rather than left as a hole the query happens
   * not to look at.
   *
   * It is not a TERM of the agreement; it is a CONSEQUENCE of one. Signing
   * CREATES these rows — the fan-out is one engagement per line, in the same
   * transaction as the signature — so a trigger refusing every write to a
   * signed letter's children would refuse the act of signing itself. And they
   * keep moving afterwards on purpose: an engagement starts `pending_advance`
   * and becomes `active` when the advance is recorded, which is `recordAdvance`
   * updating a row that hangs off a signed letter, by design.
   *
   * The line is: what the letter SAYS is frozen (its lines, its clauses, its
   * prose); what the letter CAUSED has its own lifecycle. Adding a name to this
   * list is the thing that needs an argument.
   *
   * `crm.letter_signature_request` (0080) is the second, and it is the other
   * side of the same line: not what the letter SAYS but how its signature was
   * OBTAINED — whom DocuSign was asked to email, which envelope, and how that
   * envelope ended. It must move after the letter freezes, because the sweep
   * records `outcome = completed` in the pass that signs, one statement after
   * the freeze lands. Nothing in it is evidence of the agreement: the envelope
   * id that IS evidence is copied onto the letter's own frozen
   * `signature_reference` at signature.
   *
   * `crm.recorded_acceptance` (0317) is the third, for the same reason as the
   * second: it is how the client's yes was OBTAINED when it came by email or on
   * a call, not a term of what they agreed to. It is written inside the very
   * transaction that signs the letter (`signAndFanOut`), so a freeze on it
   * would refuse the act of signing the way it would for `crm.engagement`. And
   * it needs no trigger to stay put: it is append-only by GRANT (`bib_app`
   * holds SELECT and INSERT only), which binds every writer a trigger would.
   *
   * `crm.billing_due` (0320) is the fourth, and it is the first's kind: what
   * the letter CAUSED. An advance bill names its letter because the letter's
   * advance is what it bills, and it can only exist AFTER the signature (it is
   * written when the letter is signed); a freeze would refuse it the moment it
   * is due. Nothing in it is a term: the advance's amount is copied from the
   * letter's own frozen columns, and the bill's settlement (raised, covered,
   * released) is what must move. What a person may change on it is limited by
   * a column GRANT, as 0318 set for every bill.
   *
   * `crm.letter_originator` (0355, Q049) is the fifth: WHO WON the work, the
   * salesperson the firm's revenue report credits. The client agreed to no
   * such thing, and a wrong default (the lead's owner) must stay correctable
   * after signature, which is when revenue starts to be counted. Only its
   * person moves (a column GRANT), every change is ledgered
   * (`engagement_letter.originator_set`), and the route is a partner's.
   */
  const NOT_TERMS = [
    "crm.engagement",
    "crm.letter_signature_request",
    "crm.recorded_acceptance",
    "crm.billing_due",
    "crm.letter_originator",
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
