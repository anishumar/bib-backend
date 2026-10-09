# Invoicing and GST

Tax invoices: gapless numbering, the freeze, payments and credit notes, the 2026-10-03 audit rules,
the GST tax invoice and TDS (S5), Round off (Q087), and dunning (T3.5). Billing dues and advances
are in `billing-and-advances.md`; revenue figures in `revenue-and-reports.md`.

## Invoicing — the one number that may not gap (T3.4)

- A proposal reference may gap (`crm.document_ref_series` burns numbers on purpose). **A tax
  invoice number may not**: Indian GST wants a consecutive series, and an auditor may read a
  missing number as a suppressed sale.
- **Numbered at ISSUE, not at the draft (0322).** GST's consecutive rule is about ISSUED invoices
  (Tally and Zoho number at issue too). `InvoiceRepository.create` writes an UNNUMBERED draft (its
  FY there is provisional); `InvoiceRepository.issue` allocates and writes the next number of the
  series of the ISSUE DATE's year (B03, 0326) in the same transaction as the status change.
  - Mechanism: a counter row under `SELECT … FOR UPDATE`; a rollback releases the number because
    the counter never moved. **Never a sequence** (`nextval` survives rollback), never
    `max(number)+1` (reads a snapshot).
  - A draft cancelled before issue spends nothing and stays unnumbered. Drafts made before 0322
    keep the number they drew (removing it would leave a gap; see B51 below).
  - CHECKs: `number` and `sequence_number` both or neither; an issued invoice is always numbered.
    Screens and APIs read `number: null` as "Draft".
  - `tests/invoice/numbering.integration.test.ts` (24).
- **Series per (entity, financial year)**: each of a firm's companies files its own returns and owes
  its own series, so two can both issue `INV/2026-27/0001`; `UNIQUE` is `(tenant, entity, number)`;
  the series row's `prefix` tells them apart.
- **Whose year (0337):** the ISSUING COMPANY's year start (`InvoiceService.startMonthOf` ->
  `yearStartOfCompany` over `companyCalendars`), else the firm's compliance policy
  `fiscalYearStartMonth`, else April. Read at issue, so a change moves only numbers not yet drawn.
  A January year is labelled as one year (`INV/2027/0001`), April's as `INV/2026-27/0001`.
  - **A series keeps its year:** `crm.invoice_series.start_month` is fixed when the series row is
    made; a mid-series year change keeps the label until the new year; the invoice read's
    `financialYearLabel` is read off the frozen number. A number is never drawn in a series OLDER
    than the newest the company has drawn in (`seriesYearFor`). Full calendar rules:
    `dates-and-timezones.md`.
- **Number, series and an issued invoice's money are frozen by a trigger** (0322 admits one change:
  an empty number filled by the write that issues). A wrong invoice is CANCELLED and reissued; the
  cancelled row stays in the sequence. Never deleted (`ledger-and-records.md`).
- **No `paid` status, no `amount_paid` column** — caches of an addition that drift on the first
  corrected payment. `crm.invoice_balance` computes invoiced − paid − credited in `numeric`; totals
  are `security_invoker` views, like the proposal's.
- **A payment is SIGNED (T3.5).** A bounced cheque is a negative payment with its own date and
  note; `bib_app` holds no DELETE grant. `isSignedAmount` beside `isAmount` in the money domain
  says which fields may go negative. Overpayment allowed. Money attaches only to an ISSUED invoice
  (trigger + service).
- **A credit note has its own consecutive series** (`document_type = 'credit_note'`). **Its reason
  is mandatory and a closed set** (so "how much did we write off to service failures" is a GROUP
  BY) and travels in the ledger payload.

## Invoice correctness (audit 2026-10-03, billing cluster; 0325-0327)

From `bib/qa/audit-2026-10-03/fix-billing.md`; each has a test.

- **Whole minor units (B02, 0325).** `crm.invoice_line_amount` rounds each line's gross, net and
  tax (on the rounded net) half up to the currency's minor unit (`crm.currency_minor_unit`: INR 2,
  JPY 0, KWD 3), scale 4 on the wire; every total is a sum of rounded lines.
- **Positions among live lines (B04/B36, 0326):** partial unique index; `addLine` holds the invoice
  row before `MAX(position)+1`.
- **The year at issue (B03):** above. A credit note is dated between its invoice's issue and today
  (`CREDIT_NOTE_DATE_OUT_OF_RANGE`, B45) and numbered in its own date's year.
- **No cancelling with money on it (B05, 0326):** `INVOICE_HAS_PAYMENTS`; a trigger too, and the
  payment guard reads the invoice `FOR SHARE`. Reverse a mistaken payment first.
- **Outstanding means issued (B22, 0326):** `crm.invoice_balance.outstanding` is 0 for a draft or a
  cancelled invoice; a credit hold over nothing owed is `DUNNING_NOTHING_OWED`; the portal policy
  admits only invoices that were issued (F06).
- **A credit note on an advance (B06/B15)** gives back only what bills have not taken
  (`CREDIT_EXCEEDS_UNUSED_ADVANCE`), checked in the writing transaction under the invoice row and
  the advance's advisory lock.
- **The rate (B07):** required when the currency is not the reporting one (`FX_RATE_REQUIRED`),
  exactly 1 otherwise (`FX_RATE_NOT_ONE`).
- **Due dates (B20/B21, 0327):** `PUT /invoices/{id}/due-date` on a draft (today or later); issue
  refuses a due date before the issue date (`DUE_BEFORE_ISSUE`); the firm's terms
  `tenancy.tenant.invoice_due_days` (NO default) fill an empty due date at issue.
- **The desk** raises in ONE transaction (`raiseAtomically`, B34), lets a claim go only with its
  token (B35), pages forward past 60 periods (B23), says when "Bill from" is before the work
  started (CA#35); the invoice read suggests a manual line's tax (`taxSuggestions`, CA#5).
- **Quantity is how many each billing period** (the user, 2026-10-03, F03): a monthly line bills
  quantity x fee x (1 - discount) every month. Screens say so; the demo seed uses 1.
- The payment `reference` stays out of the ledger (`hasReference`, B26).
- **A number drawn before 0322 is never renumbered (B51, the user, 2026-10-03).** Such a draft
  issues as it is while its number is in order, else `INVOICE_NUMBER_OUT_OF_ORDER` (409: "Cancel
  this draft and raise it again: the new draft is numbered when it is issued"). Out of order
  (`preDrawnNumberOrder`, domain): a later number of its series (same company, same year) carries
  an issue date (issued, or issued then cancelled; a later draft cancelled before issue does not
  count), or today's issue date is in another FY than its series. Decided in `issue` under the
  series' row lock (`tests/invoice/predrawn.integration.test.ts` holds the lock and watches issue
  wait). The read carries `issueBlocked` (the refusal's sentence) for the screen.

## The GST tax invoice and the TDS line (Q056, Q057, S5, 0369-0371)

10x: bib's invoice IS the final GST invoice (e-invoicing deferred to S6); a client that deducts TDS
sees "Less: TDS" and the net it remits. Tests: `tests/invoice/gst*.test.ts`,
`gst.integration.test.ts`.

- **Who decides what — `domain/invoice/gst.ts` (pure).** Supplier state = the issuing company's
  GSTIN's first two digits. Place of supply (IGST Act s.12/13) = a state a PERSON chose on the
  draft, else the client's GSTIN's state, else its billing address's state (`stateCodeOfRegion`:
  exact names and usual spellings, never a guess at a city), else, with NO address on record, the
  supplier's own state (s.12(2)(b)); an address whose state cannot be read is `unknown` and blocks
  Issue. Treatment: same state CGST + SGST; same UT without a legislature (04, 26, 31, 35, 38, 97)
  CGST + UTGST; another state IGST; client outside India + an LUT for the issue date's year
  zero-rated (`gst_export_lut`), else IGST (`gst_export_igst`); a company outside India or an
  Indian one with no GSTIN `plain` (one tax figure). `tax_treatment` NULL = invoice from before 0370.
- **The arithmetic is done twice and must agree.** `crm.invoice_line_amount` (0370) computes it
  (only the database adds money); `lineTax` states the same rule; the integration test feeds both
  10 lines x 7 treatments x INR/JPY/KWD. Each component rounded per line on the rounded net, half
  away from zero; CGST and SGST each at half the rate (18% on 1,000.05 = 90.00 + 90.00, not
  180.01). NULL and `plain` compute exactly as 0325. `crm.invoice_totals` adds
  `cgst/sgst/utgst/igst`, `tds` (client's rate on the PRE-TAX net, CBDT Circular 23/2017) and
  `net_payable`. Lines round to paise with no round-off line; the TOTAL may round (Q087 below).
- **A draft follows the world; Issue freezes it.** `InvoiceService.refreshTax` re-decides a draft
  (and fills empty line SACs from the catalogue) on raise, add line, describe, and after the billing
  desk writes one (`InvoiceDrafter.refreshTax`). Issue decides for the issue date and writes the
  snapshot (treatment, both GSTINs, supplier state, place of supply, chosen place, LUT id, bank
  account id, TDS section + rate) in the numbering UPDATE; `trg_invoice_tax_frozen` refuses any
  change after. Refusals: `PLACE_OF_SUPPLY_UNKNOWN`, `INVOICE_LINE_NEEDS_SAC` (409, also as
  `issueBlocked`), `INVALID_SAC`, `INVALID_PLACE_OF_SUPPLY`, `INVALID_TDS` (400).
- **SAC and rate live on the catalogue service** (`body.tax = { IN: { sac, ratePercent } }`, keyed
  by the ISSUING company's country so UAE VAT can sit beside it; no migration). A line billing an
  engagement takes its service's SAC, and its rate when none is typed. `invoice_line.sac` (99 + 4
  digits) is settable on a draft (`PUT /invoices/{id}/lines/{lineId}/sac`).
- **Bank accounts and LUTs (0369) are WRITTEN ONCE** (bib_app: INSERT + UPDATE(retired_at) only;
  0369 REVOKEs the default UPDATE first, as 0313 does): a correction retires and inserts in one
  transaction, and an issued invoice points at the row it printed. One live account per (company,
  currency) plus one general (currency NULL); the invoice prints its currency's, else the general
  one. One live LUT per (company, year it starts in). Routes `/firm-entities/{id}/bank-accounts|luts`
  (`tenant:admin`), list `GET /invoicing/companies`.
- **TDS (0371).** `crm.client_tds` (one row per client: section + rate, or both null), `GET/PUT
  /clients/{id}/tds`. `crm.payment.tds_amount` (signed like amount; a payment may be TDS only);
  `invoice_balance.tds`; outstanding = invoiced − paid − tds − credited. Cancel refused with TDS
  on it; a TDS reversal larger than the TDS recorded refused. `paid` stays money in the bank.
- **The PDF** (`domain/invoice/gst-print.ts` decides the words; `RenderableDocument.taxInvoice`
  draws them): SAC and GST % columns, taxable value, CGST/SGST or IGST rows with the shared rate,
  Less TDS and Net amount payable (any invoice whose client deducts), tax in words, SAC-wise
  summary, "Whether tax is payable on reverse charge: No", the LUT declaration, tax in INR on a
  foreign invoice charging IGST, bank details, "For <company> / Authorised signatory", "State: X
  (NN)" under each party, and "Original for recipient" under the reference
  (`RenderableDocument.copyMark`, S7). A plain or pre-0370 invoice is byte-identical (its layout
  hash did not move); the GST layout has its own pinned hash. **Rasterize a page after any change.**
- **A company's GSTIN is read on the company's day** (`crm.issuer_zone`), never `current_date`:
  between 00:00 and 05:30 IST a GSTIN valid from today was invisible (found by the walk).
- **Readiness** `tax_invoice` (after `services`): an Indian company's GSTIN and bank account, each
  service's SAC and rate; nothing to check without an Indian company (`firm-setup-and-structure.md`).
- **Not built:** e-invoicing (IRN/QR, S6; every IRP field is now on the invoice), SEZ recipients,
  pure-agent reimbursements, Form 16A tracking, GST on credit notes' own PDF. The 16-character
  number rule (Q080) is a warning on the series screen, never a refusal.

## Round off (Q087, 0375, 0380)

Ashish, 2026-10-05: "round off".

- `crm.firm_entity.round_off_total`: ON for a company registered in India (0380 switched every
  existing one on; a BEFORE INSERT trigger on `crm.firm_entity` starts a new one on, whichever road
  it joins by), OFF elsewhere until the firm turns it on. Shrestha's call (2026-10-05), knowing it
  re-renders Indian companies' DRAFTS on deploy; issued invoices are frozen.
- `crm.invoice.round_off` is written by the issuing UPDATE (`crm.company_rounds_off`) and guarded
  by 0370's freeze trigger. `crm.invoice_totals.total` rounds half away from zero where the invoice
  rounds (a draft follows its company); `round_off` (appended column) is the difference;
  `net_payable` is the rounded total less TDS; every balance follows.
- PDF and invoice page print "Round off" above the Total, GST and plain alike. `PUT
  /firm-entities/{id}/round-off` (`tenant:admin`), `roundOff` on `/invoicing/companies` and on
  invoice totals, ledger `firm_entity.round_off_set`. 0375's down cannot drop the view's column; it
  leaves it always zero.
- Tests: `tests/invoice/gst-print.test.ts`, integration `gst.integration` (round off).

## Chasing a receivable — dunning, and the rung a machine may not climb (T3.5)

- The dunning ladder is **config**, the registry's fifth kind (`dunning`): D+3, D+7, D+15 are the
  firm's numbers. One entry holds the whole ladder (rungs are read together; order is meaning).
- **`credit_hold` and `legal` are terminal rungs the worker may REACH and may not APPLY:** the row
  lands `pending_approval` and a partner decides. Enforced in the schema —
  `dunning_action_gate_chk`, plus a decider NOT NULL exactly when a decision exists — not only in
  the sweep. A rejection is recorded as loudly as an approval.
- **At-least-once:** `UNIQUE (tenant_id, invoice_id, step)`; the event is written only when a row
  was created. The sweep takes every DUE rung, so downtime needs no catch-up sweeps.
- `DunningService` is its own use case, not invoicing: they meet only at `outstanding()`, which is
  why paying an invoice stops the chasing with no flag to clear. Sweep isolation per firm and the
  firm's day: `delivery-engine-and-workflow.md`, `dates-and-timezones.md`.
