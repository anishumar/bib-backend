// The PDF statement parser (docs/FIN_BUILD_PLAN.md F2.9 PDF half, F2.10), on
// small synthetic `PdfText` pages shaped like each of the training pack's
// layouts: split debit/credit columns, a signed amount, a CR/DR suffix, a
// reference column, a monospaced bank, and the two card statements. The real
// files are read by `statement-pdf-pack.test.ts`; these pin each rule alone.
import { describe, expect, it } from "vitest";
import type { PdfText, PdfTextItem, PdfTextPage, StatementLineDraft } from "../../src/domain/fin/lines";
import { parseStatementPdf, statementReadDraft } from "../../src/domain/fin/statement-pdf";
import type { ParsedStatement, StatementParse } from "../../src/domain/fin/statement-pdf";
import { headerOf, rowsOf } from "../../src/domain/fin/statement-pdf-layout";
import {
  centsToDecimal,
  readAmount,
  readDayToken,
  resolveDays,
} from "../../src/domain/fin/statement-pdf-values";

// ── Building pages ───────────────────────────────────────────────────────────

const H = 7.6;
const CHAR = 4;

interface Run {
  readonly text: string;
  readonly x: number;
  readonly width: number;
  readonly height: number;
}

/** A left-aligned run starting at `x`. */
function L(x: number, text: string, height = H): Run {
  return { text, x, width: text.length * CHAR, height };
}

/** A right-aligned run ending at `right`. */
function R(right: number, text: string, height = H): Run {
  const width = text.length * CHAR;
  return { text, x: right - width, width, height };
}

type Line = readonly [baseline: number, ...runs: Run[]];

function page(number: number, lines: readonly Line[]): PdfTextPage {
  const items: PdfTextItem[] = [];
  for (const [baseline, ...runs] of lines) {
    for (const r of runs) items.push({ text: r.text, x: r.x, y: baseline - r.height, width: r.width, height: r.height });
  }
  return { number, width: 595, height: 842, items };
}

function pdf(...pages: PdfTextPage[]): PdfText {
  return { pages, hasTextLayer: true };
}

function statementOf(parse: StatementParse): ParsedStatement {
  if (parse.kind !== "statement") throw new Error(`expected a statement, got ${JSON.stringify(parse)}`);
  return parse.statement;
}

/** Holder-signed: opening + Σ lines = closing, the read sweep's own check. */
function adds(s: ParsedStatement): boolean {
  const cents = (d: string | null): bigint => BigInt((d ?? "0").replace(".", ""));
  const sum = s.lines.reduce((acc, l) => acc + cents(l.amount), 0n);
  return cents(s.opening) + sum === cents(s.closing);
}

const BANK_HEAD = (bank: string, period = "01 Feb 2025 to 28 Feb 2025"): Line[] => [
  [42, L(36, bank), L(464, "Statement of Account")],
  [96, L(36, "LUMEN CLOUDWORKS PTE LTD"), L(345, "Account No."), R(559, "1742-180-967")],
  [108, L(345, "Statement period"), R(559, period)],
  [120, L(345, "Currency"), R(559, "SGD")],
];

// ── The five bank layouts ─────────────────────────────────────────────────────

describe("a bank statement with split Withdrawals / Deposits columns (Merlion)", () => {
  const text = pdf(
    page(1, [
      ...BANK_HEAD("Merlion Bank"),
      [156, L(36, "Date"), L(88, "Description"), L(301, "Cheque"), R(410, "Withdrawals"), R(480, "Deposits"), R(559, "Balance")],
      [172, L(88, "Balance Brought Forward"), R(559, "133,904.89")],
      [185, L(36, "03 Feb"), L(88, "GIRO DEBIT"), R(410, "503.58"), R(559, "133,401.31")],
      [194.5, L(88, "Singa Mobile and Fibre Pte Ltd")],
      [204, L(88, "K03454")],
      [217.5, L(36, "10 Feb"), L(88, "CHEQUE"), L(305, "363091"), R(410, "763.00"), R(559, "132,638.31")],
      [227, L(88, "FreshPantry Supplies Pte Ltd")],
      [240.5, L(36, "27 Feb"), L(88, "FAST PAYMENT"), R(480, "70,000.00"), R(559, "202,638.31")],
      [250, L(88, "FROM: Rahmah bin Osman")],
      [288, L(36, "Total Withdrawals / Debits"), L(260, "1,266.58")],
      [301, L(36, "Total Deposits / Credits"), L(260, "70,000.00")],
      [314, L(36, "Closing Balance"), L(260, "202,638.31")],
      [822, L(208, "SYNTHETIC TEST DATA - NOT A REAL BANK STATEMENT")],
    ]),
  );

  it("reads every transaction, signed by its column, with its multi-line narration", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.kind).toBe("bank");
    expect(s.lines.map((l) => [l.txnDate, l.amount, l.balance])).toEqual([
      ["2025-02-03", "-503.58", "133401.31"],
      ["2025-02-10", "-763.00", "132638.31"],
      ["2025-02-27", "70000.00", "202638.31"],
    ]);
    expect(s.lines[0]?.narration).toBe("GIRO DEBIT | Singa Mobile and Fibre Pte Ltd | K03454");
    expect(s.lines[2]?.narration).toBe("FAST PAYMENT | FROM: Rahmah bin Osman");
  });

  it("puts the cheque number in the reference, and reads no line from the totals or the footer", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.map((l) => l.reference)).toEqual([null, "363091", null]);
    expect(s.lines).toHaveLength(3);
  });

  it("takes the printed opening and closing, the currency and the account's last four digits", () => {
    const s = statementOf(parseStatementPdf(text));
    expect([s.opening, s.closing, s.currency, s.accountRef]).toEqual(["133904.89", "202638.31", "SGD", "0967"]);
    expect(adds(s)).toBe(true);
  });
});

describe("a bank statement with Debit / Credit columns and CR / DR balances (Straits Commercial)", () => {
  const text = pdf(
    page(1, [
      ...BANK_HEAD("STRAITS COMMERCIAL BANK"),
      [156, L(36, "Txn Date"), L(98, "Value Date"), L(162, "Description"), R(405, "Debit"), R(470, "Credit"), R(559, "Balance")],
      [172, L(98, "OPENING BALANCE"), R(559, "178,407.41 CR")],
      // A narration that runs on to within a few points of the debit column.
      [185, L(36, "03/02/2025"), L(98, "04/02/2025"), L(162, "GIRO DR SINGAPORE CUSTOMS GST PERMIT T2983"), R(405, "190.75"), R(559, "178,216.66 CR")],
      [199, L(36, "24/02/2025"), L(98, "24/02/2025"), L(162, "FAST/PAYNOW CR KAMPONG MART B25/0001"), R(470, "82,685.85"), R(559, "260,902.51 CR")],
      [212, L(36, "25/02/2025"), L(98, "25/02/2025"), L(162, "OUTW TT DONGGUAN METALWARE"), R(405, "300,000.00"), R(559, "39,097.49 DR")],
      [222, L(162, "USD 61,706.79 @1.3437")],
      [249, L(36, "Closing Balance"), L(239, "39,097.49"), L(280, "DR")],
    ]),
  );

  it("reads day-first dates, the value date, and a credit as money in", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.map((l) => [l.txnDate, l.valueDate, l.amount])).toEqual([
      ["2025-02-03", "2025-02-04", "-190.75"],
      ["2025-02-24", "2025-02-24", "82685.85"],
      ["2025-02-25", "2025-02-25", "-300000.00"],
    ]);
  });

  it("reads a DR balance as an overdraft, and a DR printed as its own run", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines[2]?.balance).toBe("-39097.49");
    expect([s.opening, s.closing]).toEqual(["178407.41", "-39097.49"]);
    expect(adds(s)).toBe(true);
  });

  it("joins a line the bank wrapped because the next word did not fit, and keeps a short line's break", () => {
    const wrapped = pdf(
      page(1, [
        ...BANK_HEAD("STRAITS COMMERCIAL BANK"),
        [156, L(36, "Txn Date"), L(98, "Value Date"), L(162, "Description"), R(405, "Debit"), R(470, "Credit"), R(559, "Balance")],
        [172, L(98, "OPENING BALANCE"), R(559, "100,000.00 CR")],
        // Runs to x=382, three points short of the Debit column: "USD" did not fit.
        [185, L(36, "25/02/2025"), L(98, "25/02/2025"), L(162, "OUTW TT DONGGUAN METALWARE INDUSTRIES LTD INV-2025-2445"), R(405, "1,000.00"), R(559, "99,000.00 CR")],
        [194.5, L(162, "USD 750.00 @1.3333")],
      ]),
    );
    const s = statementOf(parseStatementPdf(wrapped));
    expect(s.lines[0]?.narration).toBe("OUTW TT DONGGUAN METALWARE INDUSTRIES LTD INV-2025-2445 USD 750.00 @1.3333");
    // The fixture above: "OUTW TT DONGGUAN METALWARE" ends at x=266 with
    // room to spare, so its next line is a line of its own.
    expect(statementOf(parseStatementPdf(text)).lines[2]?.narration).toContain(" | ");
  });

  it("keeps a foreign-currency continuation in the narration of a bank line, and nowhere else", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines[2]?.narration).toBe("OUTW TT DONGGUAN METALWARE | USD 61,706.79 @1.3437");
    expect(s.lines[2]?.originalCurrency).toBeNull();
  });
});

describe("a bank statement with one signed amount column, over pages (Lion City)", () => {
  const head: Line = [112, L(36, "Date"), L(102, "Transaction Details"), R(440, "Amount (+/-)"), R(559, "Balance")];
  const text = pdf(
    page(1, [
      ...BANK_HEAD("Lion City Bank"),
      [156, L(36, "Date"), L(102, "Transaction Details"), R(440, "Amount (+/-)"), R(559, "Balance")],
      [172, L(102, "Opening balance"), R(559, "99,625.45")],
      [185, L(36, "03 Feb 2025"), L(102, "GIRO-OUT TAPPOS SYSTEMS PTE LTD"), R(440, "-392.40"), R(559, "99,233.05")],
      [194.5, L(102, "INV-2025-0696")],
      [822, L(208, "SYNTHETIC TEST DATA - NOT A REAL BANK STATEMENT")],
    ]),
    page(2, [
      [44, L(36, "Lion City Bank"), L(468, "CURRENT ACCOUNT")],
      [96, L(36, "KOPI AND KAYA HOSPITALITY PTE LTD - 5877414648 - 01 Feb 2025 to 28 Feb 2025"), L(362, "(page 2)")],
      head,
      [128, L(36, "04 Feb 2025"), L(102, "CARD SETTLEMENT"), R(440, "+2,178.63"), R(559, "101,411.68")],
      [138, L(102, "MID 885440W")],
      [147, L(102, "28JAN")],
      [176, L(36, "Closing Balance"), L(255, "101,411.68")],
    ]),
  );

  it("signs each amount by its own mark, and reads the second page under its repeated header", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.map((l) => [l.page, l.txnDate, l.amount])).toEqual([
      [1, "2025-02-03", "-392.40"],
      [2, "2025-02-04", "2178.63"],
    ]);
    expect(s.lines[1]?.narration).toBe("CARD SETTLEMENT | MID 885440W | 28JAN");
    expect([s.opening, s.closing]).toEqual(["99625.45", "101411.68"]);
    expect(adds(s)).toBe(true);
  });
});

describe("a bank statement with a reference column and two-digit years (Orchid)", () => {
  const text = pdf(
    page(1, [
      ...BANK_HEAD("Orchid Bank"),
      [156, L(36, "Posting Date"), L(98, "Reference"), L(166, "Description"), R(410, "Withdrawal"), R(478, "Deposit"), R(559, "Running Balance")],
      // Orchid prints its brought-forward label under the REFERENCE column.
      [172, L(98, "BALANCE B/F"), R(559, "378,726.55")],
      [185, L(36, "10-Feb-25"), L(98, "TT5932568", 7.0), L(166, "Funds Transfer - FAST"), R(410, "49,367.19"), R(559, "329,359.36")],
      [194.5, L(166, "Brightline M&E Engineering Pte Ltd")],
      [204, L(166, "Payment M01392")],
      [217.5, L(36, "28-Feb-25"), L(98, "CHQ8871356", 7.0), L(166, "Funds Transfer - FAST"), R(478, "124,372.87"), R(559, "453,732.23")],
      [822, L(208, "SYNTHETIC TEST DATA - NOT A REAL BANK STATEMENT")],
    ]),
    // The totals spill on to a page with no table header.
    page(2, [
      [42, L(36, "Orchid Bank"), L(475, "Account Statement")],
      [124, L(36, "Total Withdrawals / Debits"), L(260, "49,367.19")],
      [150, L(36, "Closing Balance"), L(255, "453,732.23")],
    ]),
  );

  it("reads the posting date as the transaction date and the reference column apart", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.map((l) => [l.txnDate, l.reference, l.amount])).toEqual([
      ["2025-02-10", "TT5932568", "-49367.19"],
      ["2025-02-28", "CHQ8871356", "124372.87"],
    ]);
    expect(s.lines[0]?.narration).toBe("Funds Transfer - FAST | Brightline M&E Engineering Pte Ltd | Payment M01392");
  });

  it("finds the brought-forward figure under the reference column, and the closing on page 2", () => {
    const s = statementOf(parseStatementPdf(text));
    expect([s.opening, s.closing]).toEqual(["378726.55", "453732.23"]);
    expect(adds(s)).toBe(true);
  });
});

describe("a monospaced bank statement whose words are separate runs (Pacific Union)", () => {
  const m = 7.2;
  const text = pdf(
    page(1, [
      [40, L(36, "PACIFIC", 14), L(103.2, "UNION", 14), L(153.6, "BANK", 14)],
      [52, L(36, "MONTHLY STATEMENT - BUSINESS", 8), L(175.2, "CURRENT", 8), L(213.6, "ACCOUNT", 8)],
      [96, L(36, "SPROUT LABS PTE LTD"), L(345, "Account No."), R(559, "7866-865-680")],
      [108, L(345, "Statement period"), R(559, "01 Feb 2025 to 28 Feb 2025")],
      [120, L(345, "Currency"), R(559, "SGD")],
      [156, L(36, "DATE"), L(94, "PARTICULARS"), R(410, "DR"), R(478, "CR"), R(559, "BAL")],
      [172, L(94, "B/F", m), R(559, "86,705.55", m)],
      [185, L(36, "04FEB25", m), L(94, "GIRO", m), L(115.6, "OUT", m), L(132.9, "SINGA", m), R(410, "90.01", m), R(559, "86,615.54", m)],
      [194.5, L(94, "INV2502610", m)],
      [208, L(36, "17FEB25", m), L(94, "FP IN BAYFRONT DENTAL", m), R(478, "1,250.00", m), R(559, "87,865.54", m)],
      [260, L(36, "Closing Balance"), L(260, "87,865.54")],
    ]),
  );

  it("joins a narration's words, reads ddMONyy dates, and signs by the DR / CR columns", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.map((l) => [l.txnDate, l.narration, l.amount])).toEqual([
      ["2025-02-04", "GIRO OUT SINGA | INV2502610", "-90.01"],
      ["2025-02-17", "FP IN BAYFRONT DENTAL", "1250.00"],
    ]);
    expect([s.opening, s.closing, s.accountRef]).toEqual(["86705.55", "87865.54", "5680"]);
    expect(adds(s)).toBe(true);
  });
});

// ── Cards ────────────────────────────────────────────────────────────────────

describe("a card statement with its summary as label / figure pairs (Merlion card)", () => {
  const text = pdf(
    page(1, [
      [40, L(36, "Merlion Bank", 16)],
      [56, L(36, "Business Platinum Card - Statement", 10)],
      [100, L(36, "LUMEN CLOUDWORKS PTE LTD"), L(421, "Card No: XXXX XXXX XXXX 1492")],
      [112, L(36, "144 Tai Seng Street #15-29, Singapore 539320"), L(442, "Statement Date: 25 Jan 2025")],
      [148, L(389, "Previous Balance"), R(559, "5,803.11")],
      [161, L(389, "Payments / Credits"), R(559, "-5,803.11")],
      [174, L(389, "New Charges"), R(559, "11,203.70")],
      [187, L(389, "Total Amount Due"), R(559, "11,203.70")],
      [219, L(36, "Payment due date: 17 Feb 2025"), L(176, "Credit limit: S$50,000.00")],
      [237, L(36, "Post Date"), L(96, "Trans Date"), L(161, "Description"), R(559, "Amount (SGD)")],
      [253, L(36, "26 Dec"), L(96, "26 Dec"), L(161, "PREVIOUS BALANCE"), R(559, "5,803.11")],
      [266, L(36, "02 Jan"), L(96, "01 Jan"), L(161, "OVERSEAS TRANSACTION FEE 3.25%"), R(559, "344.15")],
      [278, L(36, "02 Jan"), L(96, "01 Jan"), L(161, "STRATUS WEB SERVICES EMEA IR"), R(559, "10,589.30")],
      [288, L(161, "(USD 7,760.00 converted at card rate)")],
      [300, L(36, "08 Jan"), L(96, "07 Jan"), L(161, "OFFICEMART SG"), R(559, "270.25")],
      [313, L(36, "08 Jan"), L(96, "08 Jan"), L(161, "PAYMENT - THANK YOU (GIRO)"), R(559, "5,803.11 CR")],
      [399, L(389, "TOTAL AMOUNT DUE"), R(559, "11,203.70")],
    ]),
  );

  it("is a card statement: the previous balance is no line, a charge is out and the payment in", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.kind).toBe("card");
    expect(s.lines.map((l) => [l.txnDate, l.valueDate, l.amount])).toEqual([
      ["2025-01-01", "2025-01-02", "-344.15"],
      ["2025-01-01", "2025-01-02", "-10589.30"],
      ["2025-01-07", "2025-01-08", "-270.25"],
      ["2025-01-08", "2025-01-08", "5803.11"],
    ]);
  });

  it("keeps the overseas fee as its own line and the foreign amount on the charge it belongs to", () => {
    const s = statementOf(parseStatementPdf(text));
    const fee = s.lines[0];
    const charge = s.lines[1];
    expect([fee?.narration, fee?.originalCurrency]).toEqual(["OVERSEAS TRANSACTION FEE 3.25%", null]);
    expect([charge?.originalCurrency, charge?.originalAmount]).toEqual(["USD", "-7760.00"]);
  });

  it("signs what the holder owes as negative, so opening + lines = closing holds for a card too", () => {
    const s = statementOf(parseStatementPdf(text));
    expect([s.opening, s.closing, s.currency, s.accountRef]).toEqual(["-5803.11", "-11203.70", "SGD", "1492"]);
    expect(adds(s)).toBe(true);
  });

  it("dates last year's December days in last year", () => {
    const s = statementOf(parseStatementPdf(text));
    expect(s.lines.every((l) => l.txnDate.startsWith("2025-01"))).toBe(true);
  });
});

describe("a card statement with its summary as a row of labels over a row of figures (Straits card)", () => {
  const text = pdf(
    page(1, [
      [44, L(36, "STRAITS COMMERCIAL BANK", 16), L(497, "Corporate Visa")],
      [100, L(36, "HARBOURLINE TRADING PTE LTD"), L(421, "Card No: XXXX XXXX XXXX 6485")],
      [112, L(447, "Statement Date: 10/01/2025")],
      [150, L(40, "Previous Balance"), L(145, "Payments / Credits"), L(249, "New Charges"), L(354, "Total Amount Due"), L(459, "Minimum Payment")],
      [166, L(40, "6,357.24"), L(145, "-6,357.24"), L(249, "5.45"), L(354, "5.45"), L(459, "50.00")],
      [214, L(36, "Post Date"), L(96, "Trans Date"), L(161, "Description"), R(559, "Amount (SGD)")],
      [230, L(36, "11/12"), L(96, "11/12"), L(161, "PREVIOUS BALANCE"), R(559, "6,357.24")],
      [243, L(36, "08/01"), L(96, "08/01"), L(161, "PAYMENT - THANK YOU (GIRO)"), R(559, "6,357.24 CR")],
      [256, L(36, "09/01"), L(96, "08/01"), L(161, "PARKWISE CARPARK SG"), R(559, "5.45")],
    ]),
  );

  it("reads the figure under each label, and day-first dates with no year", () => {
    const s = statementOf(parseStatementPdf(text));
    expect([s.opening, s.closing]).toEqual(["-6357.24", "-5.45"]);
    expect(s.lines.map((l) => [l.txnDate, l.amount])).toEqual([
      ["2025-01-08", "6357.24"],
      ["2025-01-08", "-5.45"],
    ]);
    expect(adds(s)).toBe(true);
  });
});

// ── What is not a statement, and what cannot be read ─────────────────────────

describe("what the parser leaves to others", () => {
  it("an invoice, even one with a dated table and an amount column, is not a statement", () => {
    const invoice = pdf(
      page(1, [
        [42, L(36, "TAX INVOICE")],
        [60, L(36, "Invoice No: INV-25-1001"), L(345, "GST Reg No: 201912345K")],
        [156, L(36, "Date"), L(88, "Description"), R(400, "Qty"), R(559, "Amount")],
        [172, L(36, "03 Feb 2025"), L(88, "Cloud hosting"), R(400, "1"), R(559, "1,000.00")],
      ]),
    );
    expect(parseStatementPdf(invoice)).toEqual({ kind: "not_statement" });
  });

  it("a scan is not a statement this reads", () => {
    expect(parseStatementPdf({ pages: [page(1, [])], hasTextLayer: false })).toEqual({ kind: "not_statement" });
  });

  it("a statement with no table header it knows is unrecognised, not someone else's", () => {
    const parse = parseStatementPdf(
      pdf(page(1, [...BANK_HEAD("Merlion Bank"), [156, L(36, "Datum"), L(88, "Omschrijving"), R(559, "Saldo")]])),
    );
    expect(parse.kind).toBe("unrecognised");
  });

  it("a dated row whose amount sits under no money column is unrecognised, never a dropped line", () => {
    const parse = parseStatementPdf(
      pdf(
        page(1, [
          ...BANK_HEAD("Merlion Bank"),
          [156, L(36, "Date"), L(88, "Description"), R(410, "Withdrawals"), R(480, "Deposits"), R(559, "Balance")],
          [185, L(36, "03 Feb"), L(88, "GIRO DEBIT"), L(250, "503.58")],
        ]),
      ),
    );
    expect(parse.kind).toBe("unrecognised");
  });

  it("a statement that prints no currency is unrecognised: the reader does not guess one", () => {
    const parse = parseStatementPdf(
      pdf(
        page(1, [
          [42, L(36, "Merlion Bank"), L(464, "Statement of Account")],
          [108, L(345, "Statement period"), R(559, "01 Feb 2025 to 28 Feb 2025")],
          [156, L(36, "Date"), L(88, "Description"), R(410, "Withdrawals"), R(480, "Deposits"), R(559, "Balance")],
          [185, L(36, "03 Feb"), L(88, "GIRO DEBIT"), R(410, "503.58"), R(559, "133,401.31")],
        ]),
      ),
    );
    expect(parse).toEqual({ kind: "unrecognised", why: "the statement prints no currency" });
  });

  it("days with no year and no period to take one from are unrecognised", () => {
    const parse = parseStatementPdf(
      pdf(
        page(1, [
          [42, L(36, "Merlion Bank"), L(464, "Statement of Account")],
          [120, L(345, "Currency"), R(559, "SGD")],
          [156, L(36, "Date"), L(88, "Description"), R(410, "Withdrawals"), R(480, "Deposits"), R(559, "Balance")],
          [185, L(36, "03 Feb"), L(88, "GIRO DEBIT"), R(410, "503.58"), R(559, "133,401.31")],
        ]),
      ),
    );
    expect(parse.kind).toBe("unrecognised");
  });
});

describe("an unsigned amount column, signed from the running balance", () => {
  const head: Line[] = [
    ...BANK_HEAD("Harbour Bank"),
    [156, L(36, "Date"), L(88, "Description"), R(440, "Amount"), R(559, "Balance")],
    [172, L(88, "Balance b/f"), R(559, "1,000.00")],
  ];

  it("takes the sign the balance moved by", () => {
    const s = statementOf(
      parseStatementPdf(
        pdf(
          page(1, [
            ...head,
            [185, L(36, "03 Feb"), L(88, "FEE"), R(440, "10.00"), R(559, "990.00")],
            [198, L(36, "04 Feb"), L(88, "DEPOSIT"), R(440, "500.00"), R(559, "1,490.00")],
          ]),
        ),
      ),
    );
    expect(s.lines.map((l) => l.amount)).toEqual(["-10.00", "500.00"]);
  });

  it("refuses an amount the balance does not explain", () => {
    const parse = parseStatementPdf(
      pdf(page(1, [...head, [185, L(36, "03 Feb"), L(88, "FEE"), R(440, "10.00"), R(559, "975.00")]])),
    );
    expect(parse.kind).toBe("unrecognised");
  });
});

describe("the read draft a statement becomes", () => {
  it("is a deterministic pdf_text read: statement lines pointing at their page, the printed figures as control", () => {
    const statement: ParsedStatement = {
      kind: "card",
      accountRef: "1492",
      currency: "SGD",
      opening: "-5803.11",
      closing: "-270.25",
      lines: [
        {
          page: 1,
          txnDate: "2025-01-07",
          valueDate: "2025-01-08",
          narration: "OFFICEMART SG",
          reference: null,
          amount: "-270.25",
          balance: null,
          originalCurrency: null,
          originalAmount: null,
        },
      ],
    };
    const draft = statementReadDraft(statement, "00000000-0000-4000-8000-0000000000aa");
    expect(draft).toMatchObject({
      docKind: "card_statement",
      reader: "pdf_text",
      control: { opening: "-5803.11", closing: "-270.25", lineCount: null, declaredTotal: null },
      confidence: null,
      model: null,
      promptVersion: null,
      formatId: null,
    });
    const line = draft.lines[0] as StatementLineDraft;
    expect(line).toMatchObject({
      kind: "statement",
      statementType: "card",
      accountRef: "1492",
      currency: "SGD",
      amount: "-270.25",
      provenance: { documentVersionId: "00000000-0000-4000-8000-0000000000aa", page: 1, row: null },
      uncertain: [],
    });
  });
});

// ── The pieces ───────────────────────────────────────────────────────────────

describe("reading a printed amount", () => {
  it.each([
    ["133,904.89", 13390489n, null, null],
    ["-392.40", 39240n, "-", null],
    ["+2,178.63", 217863n, "+", null],
    ["(25.00)", 2500n, "-", null],
    ["25.00-", 2500n, "-", null],
    ["178,407.41 CR", 17840741n, null, "CR"],
    ["5,803.11 Dr", 580311n, null, "DR"],
    ["0.00", 0n, null, null],
  ] as const)("%s", (text, cents, sign, suffix) => {
    expect(readAmount(text)).toEqual({ cents, sign, suffix });
  });

  it.each(["1,234", "12.3", "1,23.45", "USD 8,334.00", "(25.00", "-(25.00)", "MID 885440W", ""])(
    "%s is not an amount",
    (text) => {
      expect(readAmount(text)).toBeNull();
    },
  );

  it("writes cents back as a decimal string, never through a number", () => {
    expect([centsToDecimal(-123450n), centsToDecimal(5n), centsToDecimal(0n), centsToDecimal(100000000000001n)]).toEqual([
      "-1234.50",
      "0.05",
      "0.00",
      "1000000000000.01",
    ]);
  });
});

describe("reading a printed day", () => {
  it.each([
    ["03 Feb", { kind: "named", day: 3, month: 2, year: null }],
    ["03 Feb 2025", { kind: "named", day: 3, month: 2, year: 2025 }],
    ["10-Feb-25", { kind: "named", day: 10, month: 2, year: 2025 }],
    ["04FEB25", { kind: "named", day: 4, month: 2, year: 2025 }],
    ["Feb 3, 2025", { kind: "named", day: 3, month: 2, year: 2025 }],
    ["03/02/2025", { kind: "numeric", first: 3, second: 2, year: 2025 }],
    ["13/01", { kind: "numeric", first: 13, second: 1, year: null }],
    ["2025-02-03", { kind: "iso", day: 3, month: 2, year: 2025 }],
  ] as const)("%s", (text, token) => {
    expect(readDayToken(text)).toEqual(token);
  });

  it.each(["Opening balance", "28 Foo", "MID 885440W", "1/2/3/4"])("%s is not a day", (text) => {
    expect(readDayToken(text)).toBeNull();
  });
});

describe("deciding a statement's days together", () => {
  const jan = { start: null, end: { year: 2025, month: 1, day: 25 } };
  const tok = (t: string) => {
    const token = readDayToken(t);
    if (token === null) throw new Error(t);
    return token;
  };

  it("puts a December day on a January statement in last year", () => {
    expect(resolveDays([tok("26 Dec"), tok("02 Jan")], jan)).toMatchObject({ days: ["2024-12-26", "2025-01-02"] });
  });

  it("reads all-numbers days day-first, unless only month-first makes them real", () => {
    expect(resolveDays([tok("03/02/2025")], null)).toMatchObject({ days: ["2025-02-03"], order: "day_first" });
    expect(resolveDays([tok("12/28"), tok("01/13")], jan)).toMatchObject({
      days: ["2024-12-28", "2025-01-13"],
      order: "month_first",
    });
  });

  it("refuses days that are real in neither order, and a 29 February that never was", () => {
    expect(resolveDays([tok("13/13/2025")], null).ok).toBe(false);
    expect(resolveDays([tok("29 Feb 2025")], null).ok).toBe(false);
  });
});

describe("rows and the header", () => {
  it("groups runs by baseline, so a smaller run on the same line stays on it", () => {
    const rows = rowsOf(page(1, [[185, L(36, "10-Feb-25"), L(98, "TT5932568", 7.0), R(410, "49,367.19")], [194.5, L(166, "next line")]]));
    expect(rows.map((r) => r.items.map((i) => i.text))).toEqual([["10-Feb-25", "TT5932568", "49,367.19"], ["next line"]]);
  });

  it("reads a card's Post Date as the value date beside its Trans Date, and a lone Posting Date as the date", () => {
    const card = headerOf(rowsOf(page(1, [[237, L(36, "Post Date"), L(96, "Trans Date"), L(161, "Description"), R(559, "Amount (SGD)")]]))[0]!);
    expect(card?.columns.map((c) => c.role)).toEqual(["value_date", "date", "description", "amount"]);
    expect(card?.currency).toBe("SGD");
    const bank = headerOf(rowsOf(page(1, [[156, L(36, "Posting Date"), L(98, "Reference"), L(166, "Description"), R(410, "Withdrawal"), R(559, "Running Balance")]]))[0]!);
    expect(bank?.columns.map((c) => c.role)).toEqual(["date", "reference", "description", "debit", "balance"]);
  });

  it("does not read a card's summary labels as a table header", () => {
    const row = rowsOf(page(1, [[150, L(40, "Previous Balance"), L(145, "Payments / Credits"), L(249, "New Charges"), L(354, "Total Amount Due")]]))[0]!;
    expect(headerOf(row)).toBeNull();
  });
});
