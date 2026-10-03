-- Down for 0328. The function holds no data; the view's 0038 comment returns.
SET ROLE bib_owner;

DROP FUNCTION IF EXISTS crm.receivable_ageing_on(date);

COMMENT ON VIEW crm.receivable_ageing IS
  'One row per invoice the firm is still owed money on, bucketed by how overdue it is and converted at the rate stored on the invoice. Excludes drafts, cancellations and overpayments — an overpayment is money owed the other way and is not ageing.';

RESET ROLE;
