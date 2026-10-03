// DEMO HISTORY ONLY. Never run against a real firm's database.
//
// `demo-seed.sh` builds 10x Global in one sitting, and a firm that has been
// running for a while has an invoice that went out months ago and was never
// paid: the one the dunning ladder climbs to a credit hold. The product cannot
// make that today, on purpose: an invoice is dated the day it is issued, and
// since the audit of 2026-10-03 (B21) one is never issued already past its due
// date. So the seed issues it through the product, due today, and this moves
// that ONE invoice's two dates back, as if it had been issued N days ago:
// issued_on = today - issuedDaysAgo, due_on = today - dueDaysAgo. It is the
// only write in the demo that walks past the product, and it says so.
//
//   npx tsx src/cmd/demo-history.ts <invoiceId> <issuedDaysAgo> <dueDaysAgo>
//
// Runs as the migrator (BIB_DATABASE_URL, the local superuser), with the
// invoice freeze trigger off for this one transaction only, and only within
// the invoice's own financial year (its number stays true).
import postgres from "postgres";
import { load } from "../config/config";

async function main(): Promise<void> {
  const [invoiceId, issuedAgo, dueAgo] = process.argv.slice(2);
  if (invoiceId === undefined || issuedAgo === undefined || dueAgo === undefined) {
    console.error("usage: npx tsx src/cmd/demo-history.ts <invoiceId> <issuedDaysAgo> <dueDaysAgo>");
    process.exit(2);
  }
  const cfg = load();
  if (cfg.environment !== "development") {
    console.error(`demo-history runs only in development (this is ${cfg.environment}): it rewrites an issued invoice's dates.`);
    process.exit(2);
  }
  const sql = postgres(cfg.db.ownerUrl, { max: 1 });
  try {
    const moved = await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      return tx<{ number: string; issued_on: string; due_on: string }[]>`
        UPDATE crm.invoice
           SET issued_on = current_date - ${Number(issuedAgo)}::int,
               due_on    = current_date - ${Number(dueAgo)}::int
         WHERE id = ${invoiceId} AND status = 'issued'
           AND crm.financial_year_of(current_date - ${Number(issuedAgo)}::int) = financial_year
        RETURNING number, issued_on::text AS issued_on, due_on::text AS due_on
      `;
    });
    const [row] = moved;
    if (row === undefined) {
      console.error(`demo-history: invoice ${invoiceId} was not moved (not issued, or that day is in another financial year)`);
      process.exitCode = 1;
      return;
    }
    console.log(`demo-history: ${row.number} issued ${row.issued_on}, due ${row.due_on}`);
  } finally {
    await sql.end();
  }
}

void main();
