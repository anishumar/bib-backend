// DEMO HISTORY ONLY. Never run against a real firm's database.
//
// `demo-seed.sh` builds 10x Global in one sitting, and a firm that has been
// running for a while has an invoice that went out months ago and was never
// paid: the one the dunning ladder climbs to a credit hold. The product cannot
// make that today, on purpose: an invoice is dated the day it is issued, and
// since the audit of 2026-10-03 (B21) one is never issued already past its due
// date. So the seed issues it through the product, due today, and this moves
// that ONE invoice's two dates back, as if it had been issued N days ago with
// the firm's terms: issued_on = today - issuedDaysAgo, due_on = today -
// dueDaysAgo. It is the only write in the demo that walks past the product, and
// it says so.
//
// usage: node scripts/demo-history.mjs <invoiceId> <issuedDaysAgo> <dueDaysAgo>
//
// Runs as the migrator (BIB_DATABASE_URL in .env, the local superuser), with the
// invoice freeze trigger off for this one transaction only.
import "dotenv/config";
import postgres from "postgres";

const [invoiceId, issuedAgo, dueAgo] = process.argv.slice(2);
if (!invoiceId || !issuedAgo || !dueAgo) {
  process.stderr.write("usage: node scripts/demo-history.mjs <invoiceId> <issuedDaysAgo> <dueDaysAgo>\n");
  process.exit(2);
}
const url = process.env.BIB_DATABASE_URL;
if (!url) {
  process.stderr.write("BIB_DATABASE_URL is not set (.env)\n");
  process.exit(2);
}

const sql = postgres(url, { max: 1 });
try {
  const moved = await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    return tx`
      UPDATE crm.invoice
         SET issued_on = current_date - ${Number(issuedAgo)}::int,
             due_on    = current_date - ${Number(dueAgo)}::int
       WHERE id = ${invoiceId} AND status = 'issued'
         AND crm.financial_year_of(current_date - ${Number(issuedAgo)}::int) = financial_year
      RETURNING number, issued_on::text AS issued_on, due_on::text AS due_on
    `;
  });
  if (moved.length !== 1) {
    process.stderr.write(
      `demo-history: invoice ${invoiceId} was not moved (not issued, or the earlier date is in another financial year)\n`,
    );
    process.exitCode = 1;
  } else {
    const [row] = moved;
    process.stdout.write(`demo-history: ${row.number} issued ${row.issued_on}, due ${row.due_on}\n`);
  }
} finally {
  await sql.end();
}
