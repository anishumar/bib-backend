// The billing use case's seams (auto-invoice, phase 1). Each port is the one
// thing this use case needs from outside, stated in its own vocabulary and
// satisfied by an adapter in `infrastructure/postgres`.
import type { BillingTiming, ManagerHow, SpocWithManager } from "../../domain/billing/model";
import type { AdvancePolicy, AdvanceStage, BillKind } from "../../domain/billing/advance";
import type { Actor } from "../../domain/ledger/model";
import type { Invoice } from "../../domain/invoice/model";
import type { NewInvoice, NewInvoiceLine } from "../invoice/ports";

/**
 * Something that is billed on a schedule: one engagement priced on its own, or
 * one fee group (0083) whose single fee covers several engagements.
 *
 * Only subjects whose billing is SET UP (a `billingFrom` and a
 * `firstInvoiceOn`), at a recurring frequency, on an engagement that has begun
 * its commercial life (active, paused, or ended with an end day) are offered.
 * One waiting for its advance has not started and is billed by phase 2.
 */
export interface BillingSubject {
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  /** The client billed, the firm's company that signed the letter, and the
   *  letter line's currency: what one invoice must share. */
  readonly partyId: string;
  readonly issuingEntityPartyId: string;
  readonly currency: string;
  /** `monthly` | `quarterly` | `annually`: the line's, or its group's. */
  readonly billingFrequency: string;
  readonly billingFrom: string;
  readonly firstInvoiceOn: string;
  /** The letter's amount for ONE WHOLE period, as a decimal string, or null
   *  when the letter names no price ("as mutually agreed"). */
  readonly fullAmount: string | null;
  /** One per engagement the bill covers (several for a fee group). */
  readonly engagements: readonly BilledEngagement[];
  /** Periods (by their first day) that already have a due. */
  readonly duePeriodStarts: readonly string[];
}

export interface BilledEngagement {
  readonly engagementId: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly endsOn: string | null;
  readonly pausedOn: string | null;
  readonly resumedOn: string | null;
  /** The LIVE published service's Dept (`module`), the router's read. */
  readonly deptCode: string | null;
}

export interface NewBillingDue {
  readonly id: string;
  /** Absent = `period` (0318's). */
  readonly kind?: BillKind | undefined;
  /** The letter an advance is for (0320); null for every other kind. */
  readonly engagementLetterId?: string | null | undefined;
  readonly partyId: string;
  readonly issuingEntityPartyId: string;
  readonly currency: string;
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodLabel: string;
  readonly billOn: string;
  readonly fullAmount: string | null;
  readonly servedDays: number;
  readonly periodDays: number;
  readonly managerUserId: string | null;
  readonly managerHow: ManagerHow;
  readonly managerNote: string | null;
}

export interface BillingDueWriter {
  subjectsFor(tenantId: string): Promise<readonly BillingSubject[]>;
  /** Writes the dues `ON CONFLICT DO NOTHING` and answers the ids actually
   *  created, so a redelivered sweep records no second event. */
  insert(tenantId: string, dues: readonly NewBillingDue[]): Promise<readonly string[]>;
}

/** Whose kitty: the client's SPOCs for a Dept with the person each reports
 *  to, and the client's Key Manager. Active staff only, in force on the day. */
export interface BillingManagerFacts {
  spocsFor(
    tenantId: string,
    clientPartyId: string,
    deptCode: string,
    onDate: string,
  ): Promise<readonly SpocWithManager[]>;
  keyManagerFor(
    tenantId: string,
    clientPartyId: string,
    onDate: string,
  ): Promise<{ readonly userId: string; readonly displayName: string | null } | null>;
}

/** The firms that have turned auto-billing on (0318). A GLOBAL read of ids
 *  only; everything after it is scoped to one of them. */
export interface AutoBillingFirms {
  firmsWithAutoBilling(): Promise<readonly string[]>;
}

/** The month the firm's financial year starts, without which a quarter or a
 *  year cannot be cut (the compliance policy, as the scheduler reads it). */
export interface FiscalYearSource {
  fiscalYearStartMonth(tenantId: string): Promise<number | null>;
}

/** Which calendar "today" is cut on, for a sweep with no caller (T6.14). */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

// ── The desk: what a person does with a due ────────────────────────────────

/** A due's state, DERIVED on read (never stored): a skip is final; an invoice
 *  that was cancelled makes its due open again; `covered` is a bill the
 *  advance paid in full, so no invoice was raised (0320). */
export type DueStatus = "open" | "drafted" | "billed" | "skipped" | "covered";

/** What is left of an advance invoice, before tax (0320). */
export interface AdvancePoolRef {
  /** The advance BILL it is, which a raise taking from it claims (0321). */
  readonly advanceDueId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly remaining: string;
}

export interface PersonRef {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

/** One due as a screen shows it: names, not ids, in one query. */
export interface BillingDueRecord {
  readonly id: string;
  /** period | advance | final (0320). */
  readonly kind: BillKind;
  /** The letter a LETTER-WIDE advance is for; null otherwise (a service's
   *  advance names its engagement). */
  readonly engagementLetterId: string | null;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly issuer: { readonly id: string; readonly displayName: string };
  readonly currency: string;
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  /** The engagements this bill covers: one, or a fee group's. The first is
   *  the one an invoice line names, so the PDF can print the letter. */
  readonly engagementIds: readonly string[];
  /** What the client signed for: the letter line's own wording (a group's
   *  title for a fee group), never the catalogue's name. The invoice line's text. */
  readonly serviceName: string;
  /** The Dept codes of the services billed (the live service's `module`), so a
   *  bill with no price can find the client's SPOC for that work. */
  readonly deptCodes: readonly string[];
  /** Which of the client's companies the work is for; null when a fee group
   *  covers several. */
  readonly entityName: string | null;
  readonly letter: {
    readonly id: string;
    readonly ref: string;
    readonly fxRate: string;
    readonly fxRateDate: string;
  };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodLabel: string;
  readonly billOn: string;
  readonly fullAmount: string | null;
  readonly amount: string | null;
  readonly servedDays: number;
  readonly periodDays: number;
  readonly manager: PersonRef | null;
  readonly managerHow: string;
  readonly managerNote: string | null;
  /** The person the manager reports to: where an overdue bill escalates. */
  readonly managerReportsTo: PersonRef | null;
  readonly status: DueStatus;
  /** The invoice it is on. `number` is null while that invoice is a draft
   *  (0322: the number is drawn at issue). */
  readonly invoice: { readonly id: string; readonly number: string | null; readonly status: string } | null;
  readonly skipped: {
    readonly at: string;
    readonly by: PersonRef | null;
    readonly reason: string;
  } | null;
  /** The tax rate on the last invoice line (not cancelled) that billed one of
   *  these engagements: a default for the raise form, never a rule. */
  readonly lastTaxPercent: string | null;
  /** The advance this bill will be taken off when raised, and what is left of
   *  it now (0320): the service's own advance, else the letter's. Null for an
   *  advance bill, or when no advance invoice has been issued. */
  readonly advancePool: AdvancePoolRef | null;
  /** What this bill WAS reduced by, once raised or covered. */
  readonly advanceApplied: {
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly amount: string;
  } | null;
  /** An advance bill some engagement still waits on (`pending_advance`, only
   *  work signed before 0322 until the catch-up starts it). False for every
   *  other kind of bill. Such an advance cannot be skipped (0321). */
  readonly advanceHoldsWork: boolean;
}

/** An advance bill with its invoice's balance: where the advance stands. */
export interface AdvanceRecord extends BillingDueRecord {
  readonly balance: {
    readonly invoiced: string;
    readonly paid: string;
    readonly outstanding: string;
  } | null;
  /** The advance invoice's date, once issued: unpaid is counted from it. */
  readonly invoiceIssuedOn: string | null;
  /** An issued invoice not cancelled already bills this advance's work and is
   *  on no bill: very likely the advance raised by hand before 0322. The
   *  automatic draft is not made; Link it instead (0322, review item 12). */
  readonly handRaised: { readonly invoiceId: string; readonly number: string } | null;
}

/** An advance on an issued invoice, with what is left of it and whether the
 *  work it covered is finished (0320). */
export interface RefundCandidate {
  readonly advance: BillingDueRecord;
  readonly invoice: { readonly id: string; readonly number: string };
  /** Before tax: the advance's money, what bills took, what is left. */
  readonly advanceNet: string;
  readonly applied: string;
  readonly remaining: string;
  /** The credit note that gives `remaining` back: its share of the tax added,
   *  worked out by the database, never more than the invoice still carries. */
  readonly refundAmount: string;
  /** Every engagement it covered has ended, or (one-time) had its final bill,
   *  and no bill of them is still open. */
  readonly finished: boolean;
  /** What the client actually paid on the advance invoice, with tax (0321):
   *  the most that can be paid BACK. A credit note on an advance nobody paid
   *  only cancels the demand; nothing goes back. */
  readonly paid: string;
  readonly waived: { readonly at: string; readonly by: PersonRef | null; readonly reason: string } | null;
}

/**
 * Which bills a list returns. `pending` (open or drafted) is the default:
 * the bills still to raise or issue. `all` is history as well, NEWEST first,
 * so the list's ceiling drops the oldest rather than today's (review item 14).
 */
export type DueStatusFilter = DueStatus | "pending" | "all";

export interface DueFilters {
  readonly status?: DueStatusFilter | undefined;
  readonly partyId?: string | undefined;
  /**
   * What this person must act on, decided IN THE QUERY before the list's
   * ceiling (review item 14: applied after it, a large firm's newest bills
   * fell off My day silently). Pending bills that are theirs as the manager,
   * their reports' once `escalateAfterDays` have passed, and a bill with no
   * price where they are the client's SPOC for that Dept or an admin. Advance
   * bills are left out: their reminders are the advance's own (0322).
   */
  readonly mine?: {
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly today: string;
    readonly escalateAfterDays: number;
  } | undefined;
}

/**
 * One raise, written as ONE transaction (B34): the bills the advance pays in
 * full marked covered, and the draft invoice with a line per remaining bill,
 * each bill marked raised on its line. It was several transactions, so a crash
 * or a conflict half-way left a draft with some lines, or a "less advance"
 * line on no bill. A bill somebody else settled meanwhile is left out and
 * reported; the draft is written only when at least one bill goes on it.
 */
export interface RaisePlan {
  readonly draft: NewInvoice | null;
  readonly covered: readonly {
    readonly dueId: string;
    readonly applied: { readonly invoiceId: string; readonly amount: string };
  }[];
  readonly invoiced: readonly {
    readonly dueId: string;
    readonly line: NewInvoiceLine;
    readonly applied: { readonly invoiceId: string; readonly amount: string } | null;
  }[];
}

export interface RaiseWritten {
  /** The draft, when any bill went on it. */
  readonly invoice: Invoice | null;
  readonly covered: readonly string[];
  readonly invoiced: readonly { readonly dueId: string; readonly lineId: string }[];
  /** Bills somebody else settled meanwhile, or whose advance ran out. */
  readonly conflicts: readonly string[];
}

/** Whose claim it is (B35): an opaque token `claim` hands back and `release`
 *  must show. Null from `claim` means somebody else holds a bill. */
export type ClaimToken = string;

export interface BillingDueDesk {
  list(tenantId: string, filters: DueFilters): Promise<readonly BillingDueRecord[]>;
  findMany(tenantId: string, ids: readonly string[]): Promise<readonly BillingDueRecord[]>;
  /** Each refuses (answers false) when the due is no longer open, in the
   *  write's own WHERE: two people on one list must not both settle it. */
  skip(tenantId: string, dueId: string, byUserId: string | null, reason: string): Promise<boolean>;
  /** With `applied`, the advance taken off it (0320), re-checked against what
   *  is left of that advance under a lock: answers false when another bill
   *  took it first. */
  markInvoiced(
    tenantId: string,
    dueId: string,
    invoiceId: string,
    invoiceLineId: string | null,
    applied?: { readonly invoiceId: string; readonly amount: string } | null,
  ): Promise<boolean>;
  /** A whole raise in one transaction (B34); see `RaisePlan`. */
  raiseAtomically(tenantId: string, plan: RaisePlan): Promise<RaiseWritten>;
  /** The advance paid this bill in full: no invoice (0320). Same re-check. */
  markCovered(
    tenantId: string,
    dueId: string,
    applied: { readonly invoiceId: string; readonly amount: string },
  ): Promise<boolean>;
  /** Advance bills with their invoices' balances, narrowed to one invoice or
   *  one bill when asked. */
  advances(
    tenantId: string,
    filter: { readonly invoiceId?: string | undefined; readonly dueId?: string | undefined },
  ): Promise<readonly AdvanceRecord[]>;
  refundCandidates(tenantId: string, filter?: { readonly dueId?: string | undefined }): Promise<readonly RefundCandidate[]>;
  waiveRefund(tenantId: string, dueId: string, byUserId: string, reason: string): Promise<boolean>;
  /**
   * CLAIM these bills before settling them (0321), in one statement: answers
   * whether all of them were claimed (or none). An id that is no bill here is
   * ignored, for the caller's read to report as not found. A claim another request
   * holds, younger than two minutes, refuses the lot. Claimed before an invoice
   * number is drawn, so a second raise of the same bill, or of a bill taking the
   * same advance, is refused while nothing is numbered.
   */
  claim(tenantId: string, dueIds: readonly string[]): Promise<ClaimToken | null>;
  /**
   * Let them go again; always called once the settling is over. ONLY the claim
   * this token names (B35): a request that ran past the claim's lifetime must
   * not clear a newer request's claim on the same bills.
   */
  release(tenantId: string, dueIds: readonly string[], token: ClaimToken): Promise<void>;
  /** How an invoice is already used by bills (0321): as some bill's advance
   *  invoice, and how many bills name it as theirs. */
  invoiceUse(tenantId: string, invoiceId: string): Promise<{ readonly asAdvance: boolean; readonly byBills: number }>;
}

/** The slice of invoicing the desk uses, satisfied by `InvoiceService` in
 *  `setup/` so every rule an invoice has (the issuer, the client, the
 *  currency, the gapless number) is applied exactly as for a hand-raised one. */
export interface InvoiceDrafter {
  /** Every rule a new draft answers to, and its row, unwritten (B34). */
  prepareDraft(
    input: {
      readonly tenantId: string;
      readonly partyId: string;
      readonly entityPartyId: string;
      readonly currency: string;
      readonly fxRate: string;
      readonly fxRateDate: string;
      readonly dueOn?: string | undefined;
      readonly asOf?: string | undefined;
      readonly managerUserId?: string | undefined;
      /** Always true from the desk: the bills resolved the manager. */
      readonly managerFromBills?: boolean | undefined;
    },
  ): Promise<NewInvoice>;
  /** Every rule a line answers to, for that unwritten draft, and its row. */
  prepareLine(
    draft: NewInvoice,
    input: {
      readonly tenantId: string;
      readonly engagementId?: string | undefined;
      readonly description: string;
      readonly quantity: string;
      readonly unitAmount: string;
      readonly taxPercent?: string | undefined;
    },
  ): Promise<NewInvoiceLine>;
  /** The ledger's `invoice.raised`, once the draft's transaction committed. */
  recordRaised(invoice: Invoice, actor: Actor): Promise<void>;
  find(
    tenantId: string,
    invoiceId: string,
  ): Promise<{
    readonly id: string;
    readonly partyId: string;
    readonly entityPartyId: string;
    readonly currency: string;
    readonly status: string;
  } | null>;
  /** A credit note, through invoicing's own rules (the cap, the series). */
  issueCreditNote(
    input: {
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly amount: string;
      readonly reason: string;
      readonly note?: string | undefined;
      readonly asOf?: string | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly id: string; readonly number: string }>;
}

// ── The advance (0320) ──────────────────────────────────────────────────────

/** One signed letter's advance terms, for its advance bill(s). */
export interface LetterAdvanceFacts {
  readonly letterId: string;
  readonly partyId: string;
  readonly issuingEntityPartyId: string;
  readonly currency: string;
  /** The firm's day the letter was signed: the advance's bill date. */
  readonly signedOn: string;
  readonly advanceRequired: boolean;
  readonly advanceAmount: string | null;
  /** The letter-wide advance was recorded by hand before 0320 (the old tick). */
  readonly advanceRecorded: boolean;
  readonly lines: readonly {
    readonly engagementId: string;
    readonly status: string;
    readonly advanceAmount: string | null;
    readonly deptCode: string | null;
  }[];
}

export interface AdvanceBillFacts {
  advanceFactsOf(tenantId: string, letterId: string): Promise<LetterAdvanceFacts | null>;
  /**
   * Signed letters whose advance still needs the catch-up (0322): work
   * waiting on it from before 0322 (`pending_advance`), an advance asked for
   * with no bill written, or an advance bill never drafted (no tax rate when
   * it was written, say). Not letters whose advance was recorded by hand
   * before 0320: that work started long ago.
   */
  lettersOwingAdvance(tenantId: string): Promise<readonly string[]>;
  /** GLOBAL, ids only: the firms with such letters. */
  firmsOwingAdvance(): Promise<readonly string[]>;
  /** The letter's advance bills that were never on an invoice and are not
   *  skipped: the ones an automatic draft is for. */
  undraftedAdvanceBills(tenantId: string, letterId: string): Promise<readonly string[]>;
}

/** Starts work that was signed while the advance still held it (before 0322),
 *  satisfied structurally by the EngagementService so neither use case
 *  imports the other. Answers how many engagements started. */
export interface WorkRelease {
  startWaitingWork(tenantId: string, letterId: string, actor: Actor): Promise<{ readonly started: number }>;
}

/** Why an advance bill was not drafted (0322). */
export type AdvanceDraftBlock = "no_tax_rate" | "billed_by_hand" | "not_open";

/** Drafts an advance bill's invoice (0322), satisfied by the billing desk. */
export interface AdvanceDrafter {
  draftAdvance(
    tenantId: string,
    dueId: string,
    actor: Actor,
  ): Promise<{ readonly invoiceId: string } | { readonly blocked: AdvanceDraftBlock }>;
}

/** A company's default tax rate (0322): what an automatic draft puts on its
 *  line when the work was never invoiced. */
export interface IssuerTaxDefaults {
  list(tenantId: string): Promise<readonly { readonly entityPartyId: string; readonly taxPercent: string }[]>;
  set(tenantId: string, entityPartyId: string, taxPercent: string): Promise<void>;
}

/** The firm's advance reminder policy (0322, on the tenant row). */
export interface AdvancePolicySource {
  policyFor(tenantId: string): Promise<AdvancePolicy>;
  setPolicy(tenantId: string, policy: AdvancePolicy): Promise<void>;
}

/** Who is reminded about one advance (0322): active staff only, in force on
 *  the day. */
export interface AdvancePeople {
  /** The client's SPOCs for the Depts of the work the advance covers. */
  readonly spocs: readonly PersonRef[];
  readonly keyManager: PersonRef | null;
  /** The first person above the Key Manager on the reporting line whose grade
   *  rank is at least the firm's `partnerMinRank`. */
  readonly partner: PersonRef | null;
}

export interface AdvanceReminderFacts {
  peopleFor(
    tenantId: string,
    advances: readonly { readonly dueId: string; readonly partyId: string; readonly deptCodes: readonly string[] }[],
    onDate: string,
    partnerMinRank: number,
  ): Promise<ReadonlyMap<string, AdvancePeople>>;
  /** The firm's administrators (the CEO and the COO at the first firm), active
   *  staff holding `tenant:admin`, with whether each may see fees. */
  admins(tenantId: string): Promise<readonly (PersonRef & { readonly seesFees: boolean })[]>;
}

/** The weekly summary's record (0322). */
export interface AdvanceDigestStore {
  /** GLOBAL, ids only: firms with at least one advance still pending. */
  firmsWithPendingAdvances(): Promise<readonly string[]>;
  firmName(tenantId: string): Promise<string | null>;
  /** Claim this week's summary: false when it was sent (or is being sent) for
   *  this day already, or another went out in the six days before it. */
  claim(tenantId: string, weekOf: string): Promise<boolean>;
  markSent(tenantId: string, weekOf: string, recipients: number, advances: number): Promise<void>;
  /** Give up this week's claim without sending, so the next pass may claim it
   *  again: every send failed (audit 2026-10-03, B16). A week already sent is
   *  left alone. */
  release(tenantId: string, weekOf: string): Promise<void>;
}

/** One advance on the weekly summary. */
export interface AdvanceDigestRow {
  readonly clientName: string;
  readonly letterRef: string;
  readonly serviceName: string;
  readonly stage: AdvanceStage;
  /** Null while a draft. */
  readonly invoiceNumber: string | null;
  readonly daysSinceSigned: number;
  /** Null for a reader who may not see fees. */
  readonly amount: string | null;
  readonly currency: string;
}

/** The weekly summary as one administrator receives it. */
export interface AdvanceDigestLetter {
  readonly to: string;
  readonly recipientName: string | null;
  readonly firmName: string | null;
  readonly weekOf: string;
  /** Where the Advances list is, for the button. */
  readonly advancesUrl: string;
  readonly rows: readonly AdvanceDigestRow[];
}

/** Sending it: `SmtpMailer` satisfies this structurally, beside the letters it
 *  already writes. */
export interface BillingMailer {
  sendAdvanceDigest(letter: AdvanceDigestLetter): Promise<void>;
}

// ── The final bill (0320) ───────────────────────────────────────────────────

/** A one-time engagement, or a one-time fee group, as its final bill needs it. */
export interface FinalBillSubject {
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  readonly partyId: string;
  readonly issuingEntityPartyId: string;
  readonly currency: string;
  readonly billingFrequency: string | null;
  /** The letter's price for the whole service (a group's fee), before tax;
   *  null when the letter names none. */
  readonly fullAmount: string | null;
  /** The earliest first day of the engagements it covers. */
  readonly effectiveFrom: string;
  /** One per engagement it covers. */
  readonly engagements: readonly {
    readonly engagementId: string;
    readonly status: string;
    readonly deptCode: string | null;
    /** Its job, or null when none was ever spawned. */
    readonly job: {
      readonly status: string;
      readonly hasProcess: boolean;
      /** The firm's day it finished; null until done. */
      readonly doneOn: string | null;
    } | null;
  }[];
  readonly hasFinalBill: boolean;
  /** An invoice line not cancelled already bills one of its engagements (other
   *  than an advance bill's own line): the firm billed it by hand (0321). */
  readonly billedByHand: boolean;
  /** The firm's day automatic billing was last switched on; null when it was
   *  never switched on through the app (0321). */
  readonly autoBillingSince: string | null;
}

export interface FinalBillFacts {
  /** One-time subjects, narrowed to the engagements of one job, one
   *  engagement, or one client when asked. */
  oneTimeSubjects(
    tenantId: string,
    filter: {
      readonly jobId?: string | undefined;
      readonly engagementId?: string | undefined;
      readonly partyId?: string | undefined;
    },
  ): Promise<readonly FinalBillSubject[]>;
  /** Names for a screen: client, service, letter ref, per subject. */
  describe(
    tenantId: string,
    subjects: readonly FinalBillSubject[],
  ): Promise<ReadonlyMap<string, { readonly clientName: string; readonly serviceName: string; readonly letterRef: string }>>;
}

/** One engagement's billing schedule, and what a screen needs to set it. */
export interface ScheduleRecord {
  readonly engagementId: string;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly entityName: string;
  readonly serviceName: string;
  readonly letterRef: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly endsOn: string | null;
  /** The line's, or its group's. */
  readonly billingFrequency: string | null;
  readonly feeGroup: { readonly id: string; readonly title: string } | null;
  readonly billingFrom: string | null;
  readonly firstInvoiceOn: string | null;
  /** When the LETTER says it is billed (0319): the group's for a grouped
   *  line, else the line's. Null = the letter said nothing (arrears). */
  readonly billingTiming: BillingTiming | null;
  readonly billingOn: string | null;
}

export interface BillingSchedules {
  /** Live engagements billed monthly, quarterly or yearly with no schedule. */
  unscheduled(tenantId: string): Promise<readonly ScheduleRecord[]>;
  find(tenantId: string, engagementId: string): Promise<ScheduleRecord | null>;
  /** Every engagement a fee group prices. */
  groupMembers(tenantId: string, feeGroupId: string): Promise<readonly string[]>;
  set(
    tenantId: string,
    engagementIds: readonly string[],
    billingFrom: string | null,
    firstInvoiceOn: string | null,
  ): Promise<void>;
}

/** The firm's switch (0318). */
export interface AutoBillingSetting {
  isOn(tenantId: string): Promise<boolean>;
  /** Switching on also records the firm's day it went on (0321), `since`:
   *  final bills are written only for work finished from then. */
  set(tenantId: string, on: boolean, since: string): Promise<void>;
  /** The firm's own payment terms (0327): days from an invoice's date to its
   *  due date when none was typed. Null: none. */
  dueInDays(tenantId: string): Promise<number | null>;
  setDueInDays(tenantId: string, days: number | null): Promise<void>;
}
