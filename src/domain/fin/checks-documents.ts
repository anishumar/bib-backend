// The document checks, lane `rule` (docs/FIN_BUILD_PLAN.md F4.3). Pure.
//
// Each reads committed document lines and the dated law, and says "check this".
// What each one means, in a sentence a partner would recognise:
//
//   doc.duplicate_invoice        the same counterparty, number and amount twice
//   doc.gst_rate                 GST not at the rate in force on the document's date
//                                (to the cent), or a printed rate that is not it
//   doc.invalid_tax_invoice      GST charged on a supplier's document that prints
//                                no supplier GST number (not a valid tax invoice)
//   doc.out_of_period            dated before the financial year being checked
//   doc.cutoff                   dated after the period, for services inside it
//   doc.gst_not_claimable        the client is not GST-registered and its
//                                purchases carry GST it cannot recover
//   doc.gst_charged_not_registered  a client not registered charged GST
//   doc.credit_note              a credit note, to reverse and settle against
//                                the invoice it credits
//
// ── WHY THE GST BASE IS TOTAL LESS GST, NOT `net` ───────────────────────────
//
// A restaurant bill charges GST on the subtotal PLUS the service charge, and a
// line has no field for the service charge, so `net` (the subtotal as printed)
// is the wrong base there: 9% of S$153.43 is S$13.81 and the bill rightly
// charges S$15.19. Total less GST is the amount the GST was charged on, on
// every document that charges one rate. A document mixing rates (some lines
// zero-rated) reads as "GST lower than the rate implies" and IS flagged: one
// line per document cannot say which part was which, and that is exactly a
// thing for a person to look at.
//
// ── WHAT IS NOT CHECKED, AND WHY ────────────────────────────────────────────
//
// A customs permit's GST is charged on the CIF value plus duty, which the
// permit's line does not carry, so its rate is not checked; and it needs no
// supplier GST number (the supplier is Singapore Customs). A credit note's
// direction (from a supplier, or the client's own) is not on the line either,
// so it is never counted as a purchase.
import { assertCheckable, financialYearStart, inStableOrder } from "./checks-input";
import type { CheckedDocumentLine, ClientFacts, DocumentCheckInput } from "./checks-input";
import { counterpartyKey, normaliseDocNumber, sameCounterparty } from "./checks-counterparty";
import {
  fromCents,
  impliedRateMatches,
  percentOf,
  rateText,
  sameRate,
  toCents,
  toRate,
} from "./checks-money";
import type { Cents } from "./checks-money";
import type { FindingDraft, FindingFact } from "./finding";
import type { Day, DocKind } from "./lines";

type DocType = CheckedDocumentLine["docType"];

/** Documents a supplier issues TO the client, on which the client would claim
 *  input tax. */
const SUPPLIER_DOCUMENTS: ReadonlySet<DocType> = new Set<DocType>(["purchase_invoice", "receipt"]);

/** Purchases whose GST a registered client recovers: a supplier's document,
 *  and import GST paid to Customs. */
const PURCHASES: ReadonlySet<DocType> = new Set<DocType>(["purchase_invoice", "receipt", "customs_permit"]);

/** The client's own sales documents. */
const OWN_SALES: ReadonlySet<DocType> = new Set<DocType>(["sales_invoice", "pos_summary"]);

/** Documents a credit note may credit. */
const INVOICES: ReadonlySet<DocKind> = new Set<DocKind>(["purchase_invoice", "sales_invoice"]);

export function checkDocuments(input: DocumentCheckInput): FindingDraft[] {
  assertCheckable(input.client, input.period, [...input.lines, ...input.history]);
  return inStableOrder([
    ...duplicateInvoices(input),
    ...gstRate(input),
    ...invalidTaxInvoices(input),
    ...outOfPeriod(input),
    ...cutoff(input),
    ...gstNotClaimable(input),
    ...gstChargedNotRegistered(input),
    ...creditNotes(input),
  ]);
}

function finding(
  input: DocumentCheckInput,
  checkKey: string,
  lineIds: readonly string[],
  facts: Record<string, FindingFact>,
  dedupeKey: string,
): FindingDraft {
  return {
    lane: "rule",
    checkKey,
    clientPartyId: input.client.clientPartyId,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    lineIds,
    facts,
    dedupeKey,
  };
}

/** The finding's key for a check about ONE line: the line's id is the firm's
 *  own and unique, so the check and the line say everything. */
function lineKey(checkKey: string, line: CheckedDocumentLine): string {
  return `${checkKey}:${line.id}`;
}

function nonZero(cents: Cents | null): cents is Cents {
  return cents !== null && cents !== 0n;
}

/** Whether the client was GST-registered on a day. An undated document at a
 *  client registered from some day cannot be told, so it is answered null. */
function registeredOn(client: ClientFacts, day: Day | null): boolean | null {
  if (client.gstRegisteredFrom === null) return false;
  if (day === null) return null;
  return day >= client.gstRegisteredFrom;
}

// ── doc.duplicate_invoice ────────────────────────────────────────────────────

/**
 * The same counterparty, document number and amount, received more than once.
 * Compared within one document type (a receipt and an invoice may share a
 * number) and across this period's lines and the client's history, so a copy
 * sent again in September is caught against August's. Raised when the group
 * holds at least one of THIS period's lines; a group wholly in history was
 * raised when it was this period's.
 *
 * The counterparty is compared on the strongest identifier both copies carry
 * (`sameCounterparty`), so a photo whose UEN was not read still matches the PDF
 * on the supplier's name. One finding per group; a third copy arriving later is
 * a new group of three and a new finding.
 */
function duplicateInvoices(input: DocumentCheckInput): FindingDraft[] {
  const current = new Set(input.lines.map((l) => l.id));
  const pool = [...input.lines, ...input.history];
  const buckets = new Map<string, CheckedDocumentLine[]>();
  for (const line of pool) {
    const number = normaliseDocNumber(line.docNumber);
    const total = toCents(line.total);
    if (number === null || total === null || counterpartyKey(line) === null) continue;
    const key = `${line.docType}|${number}|${total.toString()}|${line.currency ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [line]);
    else bucket.push(line);
  }
  const out: FindingDraft[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Groups within the bucket: lines naming the same counterparty, joined
    // transitively, in id order so the grouping never depends on input order.
    const lines = [...bucket].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const group = lines.map((_, i) => i);
    const root = (i: number): number => {
      let r = i;
      while (group[r] !== r) r = group[r] ?? r;
      return r;
    };
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i];
        const b = lines[j];
        if (a !== undefined && b !== undefined && sameCounterparty(a, b)) group[root(j)] = root(i);
      }
    }
    const groups = new Map<number, CheckedDocumentLine[]>();
    lines.forEach((line, i) => {
      const r = root(i);
      const g = groups.get(r);
      if (g === undefined) groups.set(r, [line]);
      else g.push(line);
    });
    for (const copies of groups.values()) {
      if (copies.length < 2 || !copies.some((c) => current.has(c.id))) continue;
      const first = copies[0];
      if (first === undefined) continue;
      out.push(
        finding(
          input,
          "doc.duplicate_invoice",
          copies.map((c) => c.id),
          {
            docType: first.docType,
            docNumber: first.docNumber,
            total: fromCents(toCents(first.total) ?? 0n),
            currency: first.currency,
            copies: copies.length,
            counterpartyKeyKind: counterpartyKey(first)?.kind ?? null,
          },
          `doc.duplicate_invoice:${first.id}:${String(copies.length)}`,
        ),
      );
    }
  }
  return out;
}

// ── doc.gst_rate ─────────────────────────────────────────────────────────────

/**
 * GST that is not the rate in force on the document's date, to the cent
 * (rounded half away from zero on total less GST), or a printed rate that is
 * not the rate in force. A credit note is held to the rate of the invoice it
 * credits when that invoice is among the lines (a credit adjusts the original
 * supply), else to its own date's.
 *
 * A POS summary is the sum of many sales, each rounded on its own, so it is
 * held to the rate to a hundredth of a percent rather than to the cent: 9%
 * charged reads 9.00% whatever the pennies did, and 8% reads 8.00%.
 *
 * Not checked: a document with no GST (zero-rated, exempt, out of scope, or not
 * a GST document at all), a customs permit (see the header), a document with
 * no date or no figures to check, and a day no seeded rate covers.
 */
function gstRate(input: DocumentCheckInput): FindingDraft[] {
  const pool = [...input.lines, ...input.history];
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (line.docType === "customs_permit" || line.docDate === null) continue;
    const gst = toCents(line.gst);
    if (!nonZero(gst)) continue;
    const total = toCents(line.total);
    const base = total !== null ? total - gst : toCents(line.net);
    if (!nonZero(base)) continue;
    const credited = line.docType === "credit_note" ? creditedInvoice(line, pool) : null;
    const rateDay = credited?.docDate ?? line.docDate;
    const inForce = input.parameters.inForce("gst.standard_rate", rateDay);
    if (inForce === null) continue;
    const rate = inForce.value.rate;
    const expected = percentOf(base, rate, "half_away_from_zero");
    const amountHolds =
      line.docType === "pos_summary" ? impliedRateMatches(gst, base, rate) : gst === expected;
    const printed = line.gstRate === null ? null : toRate(line.gstRate);
    const printedHolds = printed === null || sameRate(printed, rate);
    if (amountHolds && printedHolds) continue;
    out.push(
      finding(
        input,
        "doc.gst_rate",
        credited === null ? [line.id] : [line.id, credited.id],
        {
          docType: line.docType,
          docNumber: line.docNumber,
          docDate: line.docDate,
          rateDay,
          rateInForce: rateText(rate),
          printedRate: printed === null ? line.gstRate : rateText(printed),
          base: fromCents(base),
          gst: fromCents(gst),
          expectedGst: fromCents(expected),
          difference: fromCents(gst - expected),
          currency: line.currency,
          mismatch: !amountHolds && !printedHolds ? "amount_and_printed_rate" : amountHolds ? "printed_rate" : "amount",
        },
        lineKey("doc.gst_rate", line),
      ),
    );
  }
  return out;
}

// ── doc.invalid_tax_invoice ──────────────────────────────────────────────────

/**
 * A supplier's document that charges GST and prints no supplier GST
 * registration number is not a valid tax invoice: its GST cannot be claimed
 * (it is blocked input tax), and a supplier charging GST without a number may
 * not be registered at all. Raised at a registered client and at one that is
 * not: for the second the claim is moot, the supplier's charge is not.
 *
 * A number the reader was not sure of (`uncertain`) is flagged too, and says
 * so: "not sure" is a person's question, never a pass.
 */
function invalidTaxInvoices(input: DocumentCheckInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (!SUPPLIER_DOCUMENTS.has(line.docType)) continue;
    const gst = toCents(line.gst);
    if (gst === null || gst <= 0n) continue;
    const uncertain = line.uncertain.includes("counterpartyGstNo");
    const printed = line.counterpartyGstNo !== null && line.counterpartyGstNo.trim() !== "";
    if (printed && !uncertain) continue;
    out.push(
      finding(
        input,
        "doc.invalid_tax_invoice",
        [line.id],
        {
          docType: line.docType,
          docNumber: line.docNumber,
          docDate: line.docDate,
          gst: fromCents(gst),
          total: line.total === null ? null : fromCents(toCents(line.total) ?? 0n),
          currency: line.currency,
          gstNumberUncertain: uncertain,
          clientGstRegistered: registeredOn(input.client, line.docDate),
        },
        lineKey("doc.invalid_tax_invoice", line),
      ),
    );
  }
  return out;
}

// ── doc.out_of_period ────────────────────────────────────────────────────────

/** A document dated before the financial year the period is in: it belongs to
 *  an earlier year's books (look for it in the opening payables), not this
 *  one's. A document dated earlier in the SAME year is a late one, not this. */
function outOfPeriod(input: DocumentCheckInput): FindingDraft[] {
  const yearStart = financialYearStart(input.period.start, input.client.fiscalYearStartMonth);
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (line.docDate === null || line.docDate >= yearStart) continue;
    out.push(
      finding(
        input,
        "doc.out_of_period",
        [line.id],
        {
          docType: line.docType,
          docNumber: line.docNumber,
          docDate: line.docDate,
          financialYearStart: yearStart,
          total: line.total === null ? null : fromCents(toCents(line.total) ?? 0n),
          currency: line.currency,
        },
        lineKey("doc.out_of_period", line),
      ),
    );
  }
  return out;
}

// ── doc.cutoff ───────────────────────────────────────────────────────────────

/**
 * A document dated AFTER the period, received with it, for services that began
 * inside it: the cost (or the revenue) belongs to the period and is accrued,
 * while its GST follows the document's own date. When the line carries no
 * service period the question is still real, so it is raised with
 * `servicePeriodKnown: false` and a person decides; a document wholly for a
 * later period is that period's, and is not raised.
 */
function cutoff(input: DocumentCheckInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (line.docDate === null || line.docDate <= input.period.end) continue;
    const servicesFrom = line.servicePeriodFrom ?? line.servicePeriodTo;
    if (servicesFrom !== null && servicesFrom > input.period.end) continue;
    out.push(
      finding(
        input,
        "doc.cutoff",
        [line.id],
        {
          docType: line.docType,
          docNumber: line.docNumber,
          docDate: line.docDate,
          servicePeriodFrom: line.servicePeriodFrom,
          servicePeriodTo: line.servicePeriodTo,
          servicePeriodKnown: servicesFrom !== null,
          total: line.total === null ? null : fromCents(toCents(line.total) ?? 0n),
          currency: line.currency,
        },
        lineKey("doc.cutoff", line),
      ),
    );
  }
  return out;
}

// ── doc.gst_not_claimable ────────────────────────────────────────────────────

/**
 * A client that is not GST-registered cannot recover the GST on its purchases:
 * it is part of the cost. ONE finding per period and currency, listing every
 * purchase that carries GST, rather than one per document: the rule is about
 * the client, and forty findings saying the same sentence teach a person to
 * dismiss the forty-first. The key carries the count and the total, so a late
 * document arriving for the period raises the finding again with it included.
 */
function gstNotClaimable(input: DocumentCheckInput): FindingDraft[] {
  const byCurrency = new Map<string, { lines: CheckedDocumentLine[]; gst: Cents }>();
  for (const line of input.lines) {
    if (!PURCHASES.has(line.docType)) continue;
    const gst = toCents(line.gst);
    if (gst === null || gst <= 0n) continue;
    if (registeredOn(input.client, line.docDate) !== false) continue;
    const currency = line.currency ?? "";
    const entry = byCurrency.get(currency) ?? { lines: [], gst: 0n };
    entry.lines.push(line);
    entry.gst += gst;
    byCurrency.set(currency, entry);
  }
  const out: FindingDraft[] = [];
  for (const [currency, { lines, gst }] of byCurrency) {
    const ids = lines.map((l) => l.id).sort();
    out.push(
      finding(
        input,
        "doc.gst_not_claimable",
        ids,
        {
          documents: ids.length,
          gst: fromCents(gst),
          currency: currency === "" ? null : currency,
          gstRegisteredFrom: input.client.gstRegisteredFrom,
        },
        `doc.gst_not_claimable:${input.client.clientPartyId}:${input.period.start}:${input.period.end}:${currency}:${String(ids.length)}:${gst.toString()}`,
      ),
    );
  }
  return out;
}

// ── doc.gst_charged_not_registered ───────────────────────────────────────────

/** A client that is not GST-registered may not charge GST: a sale of its own
 *  that does is a document to withdraw and reissue, and money collected that
 *  is not the client's. */
function gstChargedNotRegistered(input: DocumentCheckInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (!OWN_SALES.has(line.docType)) continue;
    const gst = toCents(line.gst);
    if (gst === null || gst <= 0n) continue;
    if (registeredOn(input.client, line.docDate) !== false) continue;
    out.push(
      finding(
        input,
        "doc.gst_charged_not_registered",
        [line.id],
        {
          docType: line.docType,
          docNumber: line.docNumber,
          docDate: line.docDate,
          gst: fromCents(gst),
          total: line.total === null ? null : fromCents(toCents(line.total) ?? 0n),
          currency: line.currency,
        },
        lineKey("doc.gst_charged_not_registered", line),
      ),
    );
  }
  return out;
}

// ── doc.credit_note ──────────────────────────────────────────────────────────

/**
 * Every credit note is a thing to settle: revenue (or a purchase) and its GST
 * reversed, set against the invoice it credits, and any refund matched to the
 * money that moved. Raised with the invoice when it is among the lines, so a
 * person sees both; `invoiceFound: false` says the reference was not found.
 */
function creditNotes(input: DocumentCheckInput): FindingDraft[] {
  const pool = [...input.lines, ...input.history];
  const out: FindingDraft[] = [];
  for (const line of input.lines) {
    if (line.docType !== "credit_note") continue;
    const credited = creditedInvoice(line, pool);
    out.push(
      finding(
        input,
        "doc.credit_note",
        credited === null ? [line.id] : [line.id, credited.id],
        {
          docNumber: line.docNumber,
          docDate: line.docDate,
          creditNoteRef: line.creditNoteRef,
          invoiceFound: credited !== null,
          total: line.total === null ? null : fromCents(toCents(line.total) ?? 0n),
          gst: line.gst === null ? null : fromCents(toCents(line.gst) ?? 0n),
          currency: line.currency,
        },
        lineKey("doc.credit_note", line),
      ),
    );
  }
  return out;
}

/** The invoice a credit note refers to: an invoice whose number is the note's
 *  reference and whose counterparty is the note's, the first by id when (oddly)
 *  there are two. Null when the note names none or it is not among the lines. */
function creditedInvoice(
  note: CheckedDocumentLine,
  pool: readonly CheckedDocumentLine[],
): CheckedDocumentLine | null {
  const ref = normaliseDocNumber(note.creditNoteRef);
  if (ref === null) return null;
  const matches = pool
    .filter((l) => INVOICES.has(l.docType) && normaliseDocNumber(l.docNumber) === ref)
    .filter((l) => sameCounterparty(l, note))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matches[0] ?? null;
}
