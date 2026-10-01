// The billing use case's seams (auto-invoice, phase 1). Each port is the one
// thing this use case needs from outside, stated in its own vocabulary and
// satisfied by an adapter in `infrastructure/postgres`.
import type { ManagerHow, SpocWithManager } from "../../domain/billing/model";
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
 *  that was cancelled makes its due open again. */
export type DueStatus = "open" | "drafted" | "billed" | "skipped";

export interface PersonRef {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

/** One due as a screen shows it: names, not ids, in one query. */
export interface BillingDueRecord {
  readonly id: string;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly issuer: { readonly id: string; readonly displayName: string };
  readonly currency: string;
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  /** The engagements this bill covers: one, or a fee group's. The first is
   *  the one an invoice line names, so the PDF can print the letter. */
  readonly engagementIds: readonly string[];
  /** The service's name (a group's title for a fee group). */
  readonly serviceName: string;
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
  readonly invoice: { readonly id: string; readonly number: string; readonly status: string } | null;
  readonly skipped: {
    readonly at: string;
    readonly by: PersonRef | null;
    readonly reason: string;
  } | null;
  /** The tax rate on the last invoice line (not cancelled) that billed one of
   *  these engagements: a default for the raise form, never a rule. */
  readonly lastTaxPercent: string | null;
}

export interface DueFilters {
  readonly status?: DueStatus | undefined;
  readonly partyId?: string | undefined;
}

export interface BillingDueDesk {
  list(tenantId: string, filters: DueFilters): Promise<readonly BillingDueRecord[]>;
  findMany(tenantId: string, ids: readonly string[]): Promise<readonly BillingDueRecord[]>;
  /** Each refuses (answers false) when the due is no longer open, in the
   *  write's own WHERE: two people on one list must not both settle it. */
  skip(tenantId: string, dueId: string, byUserId: string | null, reason: string): Promise<boolean>;
  markInvoiced(tenantId: string, dueId: string, invoiceId: string, invoiceLineId: string | null): Promise<boolean>;
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
    },
    actor: Actor,
  ): Promise<{ readonly id: string; readonly number: string }>;
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
  set(tenantId: string, on: boolean): Promise<void>;
}
