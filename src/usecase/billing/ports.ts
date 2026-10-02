// The billing use case's seams (auto-invoice, phase 1). Each port is the one
// thing this use case needs from outside, stated in its own vocabulary and
// satisfied by an adapter in `infrastructure/postgres`.
import type { BillingTiming, ManagerHow, SpocWithManager } from "../../domain/billing/model";
import type { BillKind } from "../../domain/billing/advance";
import type { Actor } from "../../domain/ledger/model";

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
  /** An advance bill: when the work it held started, and how (0320). */
  readonly released: {
    readonly at: string;
    readonly how: "paid" | "approved";
    readonly by: PersonRef | null;
  } | null;
  /** An advance bill some engagement still waits on (`pending_advance`).
   *  False for every other kind of bill. Such an advance cannot be skipped
   *  (0321): the work it holds would never start. */
  readonly advanceHoldsWork: boolean;
}

/** An advance bill with its invoice's balance: where the advance stands. */
export interface AdvanceRecord extends BillingDueRecord {
  readonly balance: {
    readonly invoiced: string;
    readonly paid: string;
    readonly outstanding: string;
  } | null;
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

export interface DueFilters {
  readonly status?: DueStatus | undefined;
  readonly partyId?: string | undefined;
}

/** One client and Dept a person is SPOC for, on a given day. */
export interface SpocDuty {
  readonly clientPartyId: string;
  readonly deptCode: string;
}

export interface BillingDueDesk {
  list(tenantId: string, filters: DueFilters): Promise<readonly BillingDueRecord[]>;
  /** The clients and Depts this person is the SPOC for on `onDate` (the
   *  firm's day), as an active staff member. */
  spocDutiesOf(tenantId: string, userId: string, onDate: string): Promise<readonly SpocDuty[]>;
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
  /** The work this advance held started. `released_at IS NULL` in the write is
   *  the lock: answers false when somebody else got there first. */
  markReleased(tenantId: string, dueId: string, how: "paid" | "approved", byUserId: string | null): Promise<boolean>;
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
  claim(tenantId: string, dueIds: readonly string[]): Promise<boolean>;
  /** Let them go again; always called once the settling is over. */
  release(tenantId: string, dueIds: readonly string[]): Promise<void>;
  /** How an invoice is already used by bills (0321): as some bill's advance
   *  invoice, and how many bills name it as theirs. */
  invoiceUse(tenantId: string, invoiceId: string): Promise<{ readonly asAdvance: boolean; readonly byBills: number }>;
}

/** The slice of invoicing the desk uses, satisfied by `InvoiceService` in
 *  `setup/` so every rule an invoice has (the issuer, the client, the
 *  currency, the gapless number) is applied exactly as for a hand-raised one. */
export interface InvoiceDrafter {
  raise(
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
    actor: Actor,
  ): Promise<{ readonly id: string; readonly number: string | null }>;
  addLine(input: {
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly engagementId?: string | undefined;
    readonly description: string;
    readonly quantity: string;
    readonly unitAmount: string;
    readonly taxPercent?: string | undefined;
  }): Promise<{ readonly id: string }>;
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
  /** Signed letters with work waiting on an advance and no advance bill for it. */
  lettersOwingAdvanceBills(tenantId: string): Promise<readonly string[]>;
  /** GLOBAL, ids only: the firms with such letters. */
  firmsOwingAdvanceBills(): Promise<readonly string[]>;
}

/** Releases the work an advance held, satisfied structurally by the
 *  EngagementService so neither use case imports the other. */
export interface WorkRelease {
  /** The letter-wide advance: every engagement of the letter still waiting. */
  recordAdvance(tenantId: string, letterId: string, recordedByUserId: string, actor: Actor): Promise<unknown>;
  /** One service's own advance. */
  releaseEngagementAdvance(tenantId: string, engagementId: string, actor: Actor): Promise<unknown>;
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
}
