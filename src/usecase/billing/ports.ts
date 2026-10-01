// The billing use case's seams (auto-invoice, phase 1). Each port is the one
// thing this use case needs from outside, stated in its own vocabulary and
// satisfied by an adapter in `infrastructure/postgres`.
import type { ManagerHow, SpocWithManager } from "../../domain/billing/model";

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
