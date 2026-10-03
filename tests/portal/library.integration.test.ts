// THE LIBRARY'S OWN WALL (T6.7, migration 0066) — and it TRIES.
//
// `gate4.integration.test.ts` proved 0059's policy, `portal-reads` proved
// 0062's two, `client-ask` proved 0063's five. This is the same discipline
// applied to what 0066 added, and to the one thing it CHANGED:
//
//   `document_portal_scope`      — NARROWED to `portal_sees(party_id) AND
//                                  is_client_visible`. The change is the
//                                  interesting half of this file.
//   `invoice_portal_scope`       — whose invoices, and never a DRAFT
//   `invoice_line_portal_scope`  — by an EXISTS on the invoice
//   `payment_portal_scope`       — the same
//   `credit_note_portal_scope`   — the same
//
// ── WHY THE NARROWING NEEDED ITS OWN MIGRATION AND ITS OWN TESTS ──────────
//
// `crm.portal_sees(party_id)` alone was CORRECT while the only route that
// reached a document was a client reading back the filename of a file they had
// just sent. T6.7 is the first route that LISTS documents, and the moment a list
// exists, `party_id` alone hands the client every working paper the firm has
// filed against them — the audit team's notes, the queries they raised
// internally, the draft they rejected. Every row of that is genuinely about that
// client and a partner would still never send it.
//
// ── HOW THIS FILE WAS CHECKED, WHICH IS THE POINT OF IT ───────────────────
//
// Each assertion was watched go RED with its policy dropped or its narrowing
// removed, and green with it back:
//
//   BEGIN;
//   ALTER POLICY document_portal_scope ON files.document
//     USING (crm.portal_sees(party_id)) WITH CHECK (crm.portal_sees(party_id));
//   -- run this file: the working-paper tests fail — the client sees it
//   ROLLBACK;
//
//   BEGIN; DROP POLICY invoice_portal_scope ON crm.invoice;
//   -- run this file: the invoice tests fail — another client's, and the DRAFT
//   ROLLBACK;
//
//   BEGIN; DROP POLICY invoice_line_portal_scope ON crm.invoice_line;
//   -- run this file: the line test fails
//   ROLLBACK;
//
//   BEGIN; DROP POLICY payment_portal_scope ON crm.payment;
//   -- run this file: the payment test fails
//   ROLLBACK;
//
//   BEGIN; DROP POLICY credit_note_portal_scope ON crm.credit_note;
//   -- run this file: the credit-note test fails
//   ROLLBACK;
//
// A test that passes with the wall removed proves only that the rows exist.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";
import { PostgresPortalLibraryRepository } from "../../src/infrastructure/postgres/portal-library-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
/** Two clients of ONE firm — gate 1 is not what is under test here. */
let mine = "";
let theirs = "";
/** One of the FIRM's own entities: who charges, which is never who is billed. */
let firmEntity = "";
let staffUser = "";

let sharedDoc = "";
let workingPaper = "";
let theirDoc = "";
let firmDoc = "";

let myInvoice = "";
let myDraft = "";
let theirInvoice = "";
let myLine = "";
let myPayment = "";
let myCreditNote = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`library-${stamp}`}, 'Library Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`library-${stamp}@example.test`}, 'Library Tester') RETURNING id
  `;
  if (!user) throw new Error("could not create the test user");
  staffUser = user.id;

  const party = async (name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${name}`);
    return row.id;
  };
  mine = await party(`Mine ${stamp}`);
  theirs = await party(`Theirs ${stamp}`);
  firmEntity = await party(`10x ${stamp}`);

  const document = async (
    partyId: string | null,
    title: string,
    kind: string,
    visible: boolean,
  ): Promise<string> => {
    const [doc] = await owner<{ id: string }[]>`
      INSERT INTO files.document
        (tenant_id, title, origin, kind, party_id, is_client_visible, created_by)
      VALUES (${tenantId}, ${title}, 'uploaded', ${kind}, ${partyId}, ${visible}, ${staffUser})
      RETURNING id
    `;
    if (!doc) throw new Error(`could not create ${title}`);
    await owner`
      INSERT INTO files.document_version
        (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename,
         storage_key, created_by)
      VALUES (${tenantId}, ${doc.id}, 1, ${"a".repeat(64)}, 12, 'application/pdf',
              ${`${title}.pdf`}, ${`k/${title}-${stamp}`}, ${staffUser})
    `;
    return doc.id;
  };

  // THE FOUR CASES THE POLICY HAS TO TELL APART.
  sharedDoc = await document(mine, "gst-challan", "statutory_filing", true);
  // The one 0066 exists for: genuinely THIS client's, and the firm's own
  // thinking about them.
  workingPaper = await document(mine, "audit-queries", "working_paper", false);
  theirDoc = await document(theirs, "their-challan", "statutory_filing", true);
  // The firm's own — `party_id` NULL, denied by arithmetic (0063), and it stays
  // denied whatever the flag says. Set VISIBLE deliberately, so this test would
  // fail if somebody ever "tidied" the policy to `OR party_id IS NULL`.
  firmDoc = await document(null, "letterhead", "brand_asset", true);

  // The issuer is one of the firm's own companies (0306): the firm's rule names
  // it, as every tenant's seeded entity is.
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenantId}, '*', ${firmEntity})
  `;
  const [series] = await owner<{ financial_year: number }[]>`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix)
    VALUES (${tenantId}, ${firmEntity}, 2026, 0, 'INV')
    RETURNING financial_year
  `;
  if (!series) throw new Error("could not create the invoice series");

  const invoice = async (
    partyId: string,
    number: string,
    sequence: number,
    status: string,
  ): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO crm.invoice
        (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
         status, currency, fx_rate, fx_rate_date, issued_on, due_on)
      VALUES (${tenantId}, ${partyId}, ${firmEntity}, ${number}, 2026, ${sequence},
              ${status}, 'INR', 1.0, '2026-03-01', null, '2026-03-31')
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${number}`);
    return row.id;
  };
  // ISSUED IN TWO STEPS, because the schema is right and this fixture was not:
  // `refuse_issued_invoice_line_change` (0027) freezes an issued invoice's
  // lines, since a tax authority holds a copy. So the lines go on while it is a
  // draft and the status moves afterwards — which is also the real order a firm
  // works in.
  myInvoice = await invoice(mine, "INV/2026-27/0001", 1, "draft");
  myDraft = await invoice(mine, "INV/2026-27/0002", 2, "draft");
  theirInvoice = await invoice(theirs, "INV/2026-27/0003", 3, "draft");

  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice_line
      (tenant_id, invoice_id, description, position, quantity, unit_amount, currency, tax_percent)
    VALUES (${tenantId}, ${myInvoice}, 'GST filings — March', 1, 1, 10000, 'INR', 18)
    RETURNING id
  `;
  if (!line) throw new Error("could not create the invoice line");
  myLine = line.id;

  // Now issue the two that are meant to be issued. `myDraft` stays a draft on
  // purpose — it is the row the policy has to refuse.
  await owner`
    UPDATE crm.invoice SET status = 'issued', issued_on = '2026-03-01'
     WHERE id IN (${myInvoice}, ${theirInvoice})
  `;

  const [payment] = await owner<{ id: string }[]>`
    INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
    VALUES (${tenantId}, ${myInvoice}, 5000, 'INR', '2026-03-15', 'bank_transfer')
    RETURNING id
  `;
  if (!payment) throw new Error("could not create the payment");
  myPayment = payment.id;

  const [credit] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
    VALUES (${tenantId}, ${firmEntity}, 2026, 0, 'CN', 'credit_note')
    ON CONFLICT DO NOTHING
    RETURNING financial_year
  `;
  void credit;
  const [note] = await owner<{ id: string }[]>`
    INSERT INTO crm.credit_note
      (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number,
       amount, currency, issued_on, reason)
    VALUES (${tenantId}, ${myInvoice}, ${firmEntity}, ${`CN/2026-27/0001`}, 2026, 1,
            1000, 'INR', '2026-03-20', 'goodwill')
    RETURNING id
  `;
  if (!note) throw new Error("could not create the credit note");
  myCreditNote = note.id;
});

afterAll(async () => {
  // AN ISSUED INVOICE CANNOT BE UN-ISSUED OR HAVE ITS LINES TOUCHED, which is
  // exactly right in the product — a tax authority holds a copy — and makes a
  // test's own teardown impossible. Disabled for the length of this cleanup, as
  // the owner, and re-enabled immediately; `figures.integration.test.ts` does
  // the same thing to `trg_el_freeze` for the same reason. The alternative is
  // leaving test rows in the dev database forever.
  await owner`ALTER TABLE crm.invoice DISABLE TRIGGER trg_invoice_number_freeze`;
  await owner`ALTER TABLE crm.invoice_line DISABLE TRIGGER trg_invoice_line_freeze`;
  await owner`ALTER TABLE crm.credit_note DISABLE TRIGGER trg_credit_note_freeze`;
  await owner`DELETE FROM crm.credit_note WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM crm.payment WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM crm.invoice_line WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM crm.invoice WHERE tenant_id = ${tenantId}`;
  await owner`ALTER TABLE crm.invoice ENABLE TRIGGER trg_invoice_number_freeze`;
  await owner`ALTER TABLE crm.invoice_line ENABLE TRIGGER trg_invoice_line_freeze`;
  await owner`ALTER TABLE crm.credit_note ENABLE TRIGGER trg_credit_note_freeze`;
  await owner`DELETE FROM crm.invoice_series WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM crm.firm_entity_preference WHERE tenant_id = ${tenantId}`;
  // 0313 made a routed company a MEMBER of the firm (crm.firm_entity), which
  // references the party; it goes before the parties do.
  await owner`DELETE FROM crm.firm_entity WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM files.document_version WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM files.document WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${staffUser}`;
  await app.end();
  await owner.end();
});

describe("the document library, and the narrowing T6.7 needed", () => {
  it("a STAFF session is untouched: all four documents are readable", async () => {
    // The first thing to check whenever a restrictive policy is narrowed. If
    // this fails, 0066 has narrowed the staff workspace — the opposite mistake,
    // and the one that gets blamed on everything else first.
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(4);
  });

  it("AND IT TRIES: the client's OWN working paper, asked for BY ID, comes back empty", async () => {
    // THE TEST THIS MIGRATION EXISTS FOR. `party_id` is this client's, so the
    // 0063 policy alone would hand it over — every row of it is genuinely about
    // them, and a partner would still never send it.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE id = ${workingPaper}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("sees exactly the one document the firm shared, and nothing else", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE tenant_id = ${tenantId}`;
    });
    expect(rows.map((r) => r.id)).toEqual([sharedDoc]);
  });

  it("another client's shared document is unreachable BY ID", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE id = ${theirDoc}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("the firm's OWN document stays denied even when marked visible", async () => {
    // `party_id` is NULL and `crm.portal_sees(NULL)` is `NULL = ANY(...)`, which
    // is not true. 0063 wrote that down because it does not look deliberate in
    // the SQL — somebody "tidying" it to `OR party_id IS NULL` would hand every
    // client the firm's stationery cupboard. The fixture is VISIBLE so this
    // test can only pass for the right reason.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE id = ${firmDoc}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a portal session with NO grants sees no documents at all", async () => {
    // The empty list is a real scope and must reach the database as one. If
    // `withPortal` were skipped for an empty list, `app.portal` would be unset,
    // which means STAFF, and this would return four.
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM files.document WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("the BYTES, and why there is no pre-signed URL", () => {
  it("the version of a working paper — its storage key — is unreachable", async () => {
    // THE CLAIM T3.6 MADE AND 0063 MADE TRUE, now inheriting 0066's narrowing
    // for free: `document_version_portal_scope` is an EXISTS on the parent, so
    // one edit decided both. The KEY is what a download needs, and it is behind
    // RLS — which is why the product can say "bytes leave by one route" rather
    // than hoping nobody guesses a URL.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ storage_key: string }[]>`
        SELECT storage_key FROM files.document_version WHERE document_id = ${workingPaper}
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("the version of the SHARED document is reachable, so a download can work", async () => {
    // The positive half, and it is not decoration: a wall that denied everything
    // would pass every test above and ship a library that opens nothing.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ storage_key: string }[]>`
        SELECT storage_key FROM files.document_version WHERE document_id = ${sharedDoc}
      `;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("the invoice, which 0062 said out loud was not here yet", () => {
  it("a STAFF session is untouched: all three invoices are readable", async () => {
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(3);
  });

  it("AND IT TRIES: another client's invoice, asked for BY ID, comes back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE id = ${theirInvoice}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a DRAFT invoice of the client's OWN is unreachable", async () => {
    // In the POLICY and not in a query, for `is_client_visible`'s reason: a
    // portal read that forgets a WHERE returns a demand nobody has made yet,
    // with a 200. A client who saw one would either pay it or argue about it,
    // and both are worse than not seeing it.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE id = ${myDraft}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("sees exactly its own ISSUED invoice", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE tenant_id = ${tenantId}`;
    });
    expect(rows.map((r) => r.id)).toEqual([myInvoice]);
  });

  it("a portal session with NO grants sees no invoices at all", async () => {
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("the three tables that hang off an invoice", () => {
  it("a line of the client's own invoice is readable", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice_line WHERE id = ${myLine}`;
    });
    expect(rows.map((r) => r.id)).toEqual([myLine]);
  });

  it("a payment against it is readable, so 'have I paid this' is answerable", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.payment WHERE id = ${myPayment}`;
    });
    expect(rows.map((r) => r.id)).toEqual([myPayment]);
  });

  it("a credit note against it is readable", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.credit_note WHERE id = ${myCreditNote}`;
    });
    expect(rows.map((r) => r.id)).toEqual([myCreditNote]);
  });

  it("a portal session with NO grants reaches none of the three", async () => {
    // The children carry no party column: what denies them is the EXISTS on a
    // parent that is itself denied. This is that inheritance, asserted.
    const counts = await withPortal(app, tenantId, [], async (db) => {
      const [lines] = await db<{ n: string }[]>`SELECT count(*) AS n FROM crm.invoice_line`;
      const [payments] = await db<{ n: string }[]>`SELECT count(*) AS n FROM crm.payment`;
      const [notes] = await db<{ n: string }[]>`SELECT count(*) AS n FROM crm.credit_note`;
      return [lines?.n, payments?.n, notes?.n];
    });
    expect(counts).toEqual(["0", "0", "0"]);
  });

  it("and the balance VIEW follows, with nothing written for it", async () => {
    // `crm.invoice_balance` is `security_invoker = true`, so it evaluates the
    // policies of whoever is asking. That is why 0066 wrote four TABLE policies
    // and no view policy — a view with `security_definer` would have been a hole
    // with a SELECT grant on it.
    //
    // 11800 invoiced (10000 + 18% tax), 5000 paid, 1000 credited → 5800.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ invoice_id: string; outstanding: string }[]>`
        SELECT invoice_id, outstanding::text AS outstanding
          FROM crm.invoice_balance WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoice_id).toBe(myInvoice);
    expect(Number(rows[0]?.outstanding)).toBeCloseTo(5800, 4);
  });
});

describe("only an invoice that was ISSUED reaches the client (F06, 0326)", () => {
  // The audit: the client saw INV/2026-27/0002, "Cancelled · Not issued", a
  // draft the firm withdrew before ever sending it. The policy let every
  // cancelled row through; it now asks whether the invoice was ever issued.
  async function unissued(status: "draft" | "cancelled"): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO crm.invoice
        (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
         status, currency, fx_rate, fx_rate_date, issued_on, due_on)
      VALUES (${tenantId}, ${mine}, ${firmEntity}, NULL, 2026, NULL,
              'draft', 'INR', 1.0, '2026-03-01', NULL, '2026-03-31')
      RETURNING id
    `;
    if (!row) throw new Error("could not create the draft");
    if (status === "cancelled") await owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${row.id}`;
    return row.id;
  }

  it("never shows a draft cancelled before it was issued, by id or in the list", async () => {
    const withdrawn = await unissued("cancelled");
    const byId = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM crm.invoice WHERE id = ${withdrawn}`;
    });
    expect(byId).toHaveLength(0);
    const listed = await new PostgresPortalLibraryRepository(app).invoices(tenantId, [mine]);
    expect(listed.map((i) => i.invoiceId)).not.toContain(withdrawn);
  });

  it("still shows one cancelled AFTER it was issued, which the client did receive", async () => {
    const sent = await unissued("draft");
    await owner`UPDATE crm.invoice SET status = 'issued', issued_on = '2026-03-02', number = ${`INV/2026-27/9${stamp.slice(-3)}`}, sequence_number = ${900 + Number(stamp.slice(-2))} WHERE id = ${sent}`;
    await owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${sent}`;
    const listed = await new PostgresPortalLibraryRepository(app).invoices(tenantId, [mine]);
    const row = listed.find((i) => i.invoiceId === sent);
    expect(row?.status).toBe("cancelled");
    expect(row?.outstanding).toMatch(/^0(\.0+)?$/);
  });
});
