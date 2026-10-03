// The advance (auto-invoice, phase 2, 0320; reshaped by 0322): the bill a
// signed letter owes, its invoice drafted at once, and the reminders that chase
// it. No I/O, no SQL.
//
// ── EVERY ADVANCE IS A TAX INVOICE (Ashish, 2026-10-01) ─────────────────────
//
// Signing writes an ADVANCE BILL (one for the letter, or one per service that
// has its own), and the advance invoice is a GST tax invoice like any other.
//
// ── AND IT NO LONGER HOLDS THE WORK (Ashish, 2026-10-02) ───────────────────
//
// "The invoice for advance should be created as draft invoice and job as per EL
// should be created simultaneously and work can be started and parallelly the
// system should keep on notifying the spoc key manager and partner ... and once
// every week it should escalate to ceo coo". So since 0322:
//
//   - signing starts the work (the engagement use case), and this file drafts
//     the advance invoice straight away (`AdvanceDrafter`, the billing desk's
//     raise). A draft has no number until it is issued (0322), so a draft the
//     firm withdraws spends nothing in the gapless series;
//   - `AdvanceDesk` says where each advance stands and who is reminded: the
//     client's SPOC for the work, its Key Manager and the partner above the Key
//     Manager, on My day, until it is paid; the admins too once it is a week
//     old, or while it waits for one of them to issue it;
//   - `AdvanceDigest` emails the admins one summary a week.
//
// Nothing here releases work any more: the 0320 gate (paid in full starts it,
// part paid needs Approve start) is gone. Work signed before 0322 and still
// waiting is started by the daily catch-up.
//
// ── IDEMPOTENT ──────────────────────────────────────────────────────────────
//
// The partial unique indexes refuse a second advance bill for one letter or
// service; a draft is made only for a bill never on an invoice, under the
// desk's claim; the weekly summary is claimed per firm per week.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import {
  advanceReminder,
  NOT_CHASED,
  advanceStage,
  advancesOwed,
  digestDueOn,
  type AdvanceReminder,
  type AdvanceStage,
} from "../../domain/billing/advance";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AdvanceBillFacts,
  AdvanceDigestRow,
  AdvanceDigestStore,
  AdvanceDraftBlock,
  AdvanceDrafter,
  AdvancePeople,
  AdvancePolicySource,
  AdvanceRecord,
  AdvanceReminderFacts,
  BillingDueDesk,
  BillingDueWriter,
  BillingManagerFacts,
  BillingMailer,
  FirmTimeZone,
  IssuerTaxDefaults,
  NewBillingDue,
  WorkRelease,
} from "./ports";

export interface AdvanceBillerDeps {
  readonly facts: AdvanceBillFacts;
  readonly dues: BillingDueWriter;
  readonly managers: BillingManagerFacts;
  readonly ids: IdGen;
  readonly events: EventSink;
  /** Drafts the advance invoice (0322). Absent: the bill waits for a person. */
  readonly drafter?: AdvanceDrafter | null;
  /** Starts work signed before 0322 that still waits on its advance. Absent:
   *  the catch-up only writes and drafts. */
  readonly work?: WorkRelease | null;
}

export interface AdvanceCatchUpReport {
  readonly tenantId: string;
  /** Advance bills written. */
  readonly created: number;
  /** Advance invoices drafted. */
  readonly drafted: number;
  /** Engagements started that were waiting on an advance (from before 0322). */
  readonly started: number;
  readonly failure?: string;
}

export class AdvanceBiller {
  constructor(private readonly deps: AdvanceBillerDeps) {}

  /**
   * The advance bill(s) a signed letter owes, dated the day it was signed, and
   * each one's invoice drafted (0322). Not for an advance recorded by hand
   * before 0320: that work started long ago and a bill now would ask the
   * client to pay twice.
   */
  async billAdvances(
    input: { readonly tenantId: string; readonly letterId: string },
    actor: Actor,
    cache: ManagerCache = new Map(),
  ): Promise<{ readonly created: number; readonly drafted: number }> {
    const facts = await this.deps.facts.advanceFactsOf(input.tenantId, input.letterId);
    if (facts === null) return { created: 0, drafted: 0 };
    if (facts.advanceRequired && facts.advanceRecorded) return { created: 0, drafted: 0 };
    // Work the firm has called off is not asked to pay an advance.
    const live = facts.lines.filter((l) => l.status !== "cancelled");

    const planned: NewBillingDue[] = [];
    for (const advance of advancesOwed({
      advanceRequired: facts.advanceRequired,
      advanceAmount: facts.advanceAmount,
      lines: live,
    })) {
      const manager = await billingManagerFor(
        this.deps.managers,
        { tenantId: input.tenantId, partyId: facts.partyId, deptCodes: advance.deptCodes, today: facts.signedOn },
        cache,
      );
      planned.push({
        id: this.deps.ids.newId(),
        kind: "advance",
        engagementLetterId: facts.letterId,
        partyId: facts.partyId,
        issuingEntityPartyId: facts.issuingEntityPartyId,
        currency: facts.currency,
        engagementId: advance.engagementId,
        feeGroupId: null,
        // Not a period: the day it fell due, counted as one whole day of one,
        // so the amount is the advance itself (0320).
        periodStart: facts.signedOn,
        periodEnd: facts.signedOn,
        periodLabel: "Advance",
        billOn: facts.signedOn,
        fullAmount: advance.amount,
        servedDays: 1,
        periodDays: 1,
        managerUserId: manager.userId,
        managerHow: manager.how,
        managerNote: manager.note,
      });
    }

    const created = new Set(planned.length === 0 ? [] : await this.deps.dues.insert(input.tenantId, planned));
    for (const due of planned) {
      if (!created.has(due.id)) continue;
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.created",
        objectId: due.id,
        actor,
        payload: {
          kind: "advance",
          partyId: due.partyId,
          engagementLetterId: facts.letterId,
          engagementId: due.engagementId,
          feeGroupId: null,
          periodStart: due.periodStart,
          billOn: due.billOn,
          managerHow: due.managerHow,
        },
      });
    }
    return { created: created.size, drafted: await this.draftWaiting(input.tenantId, input.letterId, actor) };
  }

  /**
   * The draft for every advance bill of the letter never on an invoice. One
   * that cannot be drafted (no tax rate yet, or already invoiced by hand)
   * stays on To raise and is tried again by the catch-up; a failure is never
   * the signature's, which the client has already given.
   */
  private async draftWaiting(tenantId: string, letterId: string, actor: Actor): Promise<number> {
    const drafter = this.deps.drafter ?? null;
    if (drafter === null) return 0;
    let drafted = 0;
    for (const dueId of await this.deps.facts.undraftedAdvanceBills(tenantId, letterId)) {
      try {
        if ("invoiceId" in (await drafter.draftAdvance(tenantId, dueId, actor))) drafted += 1;
      } catch {
        // Deliberately swallowed: see above. The bill is still on To raise.
      }
    }
    return drafted;
  }

  /**
   * Every firm's signed letters whose advance still needs something (0322):
   * work signed before 0322 that waits on it is STARTED (the user's call for
   * letters stuck at deploy: "kaam shuru + draft"), a missing bill is written,
   * and an undrafted one drafted. One firm's failure never stops the others,
   * and it is REPORTED.
   */
  async catchUp(): Promise<readonly AdvanceCatchUpReport[]> {
    const reports: AdvanceCatchUpReport[] = [];
    for (const tenantId of await this.deps.facts.firmsOwingAdvance()) {
      try {
        let created = 0;
        let drafted = 0;
        let started = 0;
        const cache: ManagerCache = new Map();
        for (const letterId of await this.deps.facts.lettersOwingAdvance(tenantId)) {
          if (this.deps.work) started += (await this.deps.work.startWaitingWork(tenantId, letterId, SYSTEM_ACTOR)).started;
          const out = await this.billAdvances({ tenantId, letterId }, SYSTEM_ACTOR, cache);
          created += out.created;
          drafted += out.drafted;
        }
        reports.push({ tenantId, created, drafted, started });
      } catch (err) {
        reports.push({ tenantId, created: 0, drafted: 0, started: 0, failure: err instanceof Error ? err.message : String(err) });
      }
    }
    return reports;
  }
}

// ── Where each advance stands, and who is reminded ─────────────────────────

export interface AdvanceDeskDeps {
  readonly desk: BillingDueDesk;
  readonly policy: AdvancePolicySource;
  readonly people: AdvanceReminderFacts;
  readonly taxDefaults: IssuerTaxDefaults;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
}

export interface AdvanceOnDesk extends AdvanceRecord {
  readonly stage: AdvanceStage;
  readonly reminder: AdvanceReminder;
  readonly people: AdvancePeople;
  /** Why it has no invoice yet, when it has none and the reason is known. */
  readonly draftBlocked: AdvanceDraftBlock | null;
}

/** Why an advance is on a person's My day (0322). */
export type AdvanceDuty = "spoc" | "key_manager" | "partner" | "admin";

export interface AdvanceForMe extends AdvanceOnDesk {
  /** Every reason this advance is the caller's, in the order above. */
  readonly duties: readonly AdvanceDuty[];
}

const NOBODY: AdvancePeople = { spocs: [], keyManager: null, partner: null };

export class AdvanceDesk {
  constructor(private readonly deps: AdvanceDeskDeps) {}

  /** Every advance bill, where it stands, and who is reminded about it. */
  async list(tenantId: string): Promise<{ readonly today: string; readonly advances: readonly AdvanceOnDesk[] }> {
    const today = await this.today(tenantId);
    const [records, policy, defaults] = await Promise.all([
      this.deps.desk.advances(tenantId, {}),
      this.deps.policy.policyFor(tenantId),
      this.deps.taxDefaults.list(tenantId),
    ]);
    const people = await this.deps.people.peopleFor(
      tenantId,
      records.filter((r) => r.status !== "skipped").map((r) => ({ dueId: r.id, partyId: r.party.id, deptCodes: r.deptCodes })),
      today,
      policy.partnerMinRank,
    );
    const advances = records.map((r): AdvanceOnDesk => {
      const status = r.invoice?.status;
      const stage = advanceStage({
        invoiceStatus: status === "draft" || status === "issued" || status === "cancelled" ? status : null,
        paid: r.balance?.paid ?? null,
        outstanding: r.balance?.outstanding ?? null,
      });
      const reminder =
        r.status === "skipped"
          ? NOT_CHASED
          : advanceReminder({ stage, billOn: r.billOn, issuedOn: r.invoiceIssuedOn, today, policy });
      const hasRate = r.lastTaxPercent !== null || defaults.some((d) => d.entityPartyId === r.issuer.id);
      const draftBlocked: AdvanceDraftBlock | null =
        r.status !== "open" || r.invoice !== null ? null : r.handRaised !== null ? "billed_by_hand" : hasRate ? null : "no_tax_rate";
      return { ...r, stage, reminder, people: people.get(r.id) ?? NOBODY, draftBlocked };
    });
    return { today, advances };
  }

  /**
   * What the caller must chase (0322): every pending advance where they are
   * the client's SPOC for that work, its Key Manager or the partner above the
   * Key Manager; and, for an administrator, one waiting for an admin to raise
   * or issue it, or a week old and still not paid.
   */
  async mine(
    tenantId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ readonly today: string; readonly advances: readonly AdvanceForMe[] }> {
    const { today, advances } = await this.list(tenantId);
    const out: AdvanceForMe[] = [];
    for (const a of advances) {
      if (!a.reminder.pending) continue;
      const duties: AdvanceDuty[] = [];
      if (a.people.spocs.some((p) => p.userId === userId)) duties.push("spoc");
      if (a.people.keyManager?.userId === userId) duties.push("key_manager");
      if (a.people.partner?.userId === userId) duties.push("partner");
      if (isAdmin && (a.stage === "not_raised" || a.stage === "on_draft" || a.reminder.escalated)) duties.push("admin");
      if (duties.length > 0) out.push({ ...a, duties });
    }
    return { today, advances: out };
  }

  private async today(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

// ── The weekly summary to the admins ───────────────────────────────────────

export interface AdvanceDigestDeps {
  readonly store: AdvanceDigestStore;
  readonly advances: AdvanceDesk;
  readonly people: AdvanceReminderFacts;
  readonly policy: AdvancePolicySource;
  readonly mailer: BillingMailer;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
  readonly events: EventSink;
  /** The Advances list in the app, for the letter's button. */
  readonly advancesUrl: string;
}

export interface AdvanceDigestReport {
  readonly tenantId: string;
  /** The firm's day this week's summary went out on. */
  readonly weekOf: string;
  readonly sent: boolean;
  readonly advances: number;
  readonly recipients: number;
  readonly failure?: string;
}

export class AdvanceDigest {
  constructor(private readonly deps: AdvanceDigestDeps) {}

  /**
   * One pass over the firms. For each whose day it is (its weekday, from its
   * hour, in its zone): claim the week, then email every administrator one
   * summary of the advances still a draft or unpaid a week or more after
   * signing. A week with none is claimed and sends nothing. Each letter is one
   * recipient's, so a reader who may not see fees gets it without amounts.
   */
  async sweep(): Promise<readonly AdvanceDigestReport[]> {
    const reports: AdvanceDigestReport[] = [];
    for (const tenantId of await this.deps.store.firmsWithPendingAdvances()) {
      let weekOf = "";
      try {
        const [policy, zone] = await Promise.all([
          this.deps.policy.policyFor(tenantId),
          this.deps.timeZones.timeZoneFor(tenantId),
        ]);
        const dueOn = digestDueOn({
          now: this.deps.clock.now().toISOString(),
          timeZone: zone,
          weekday: policy.digestWeekday,
          hour: policy.digestHour,
        });
        if (dueOn === null) continue;
        weekOf = dueOn;
        if (!(await this.deps.store.claim(tenantId, weekOf))) continue;
        const listed = await this.deps.advances.list(tenantId);
        const due = listed.advances.filter((a) => a.reminder.pending && a.reminder.escalated);
        let recipients = 0;
        if (due.length > 0) {
          const [admins, firmName] = await Promise.all([this.deps.people.admins(tenantId), this.deps.store.firmName(tenantId)]);
          for (const admin of admins) {
            try {
              await this.deps.mailer.sendAdvanceDigest({
                to: admin.email,
                recipientName: admin.displayName,
                firmName,
                weekOf,
                advancesUrl: this.deps.advancesUrl,
                rows: due.map((a) => digestRow(a, admin.seesFees, listed.today)),
              });
              recipients += 1;
            } catch {
              // One address refusing must not stop the others; the count says
              // how many went, and the adapter logged why this one did not.
            }
          }
        }
        await this.deps.store.markSent(tenantId, weekOf, recipients, due.length);
        await this.deps.events.recordEvent({
          tenantId,
          verb: "tenant.advance_digest_sent",
          objectId: tenantId,
          actor: SYSTEM_ACTOR,
          payload: { weekOf, advances: due.length, recipients },
        });
        reports.push({ tenantId, weekOf, sent: recipients > 0, advances: due.length, recipients });
      } catch (err) {
        reports.push({
          tenantId,
          weekOf,
          sent: false,
          advances: 0,
          recipients: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }
}

/** One advance as a reader sees it: what is still owed on an issued invoice
 *  (with tax), the advance itself (before tax) until then, nothing without
 *  fees. */
function digestRow(a: AdvanceOnDesk, seesFees: boolean, today: string): AdvanceDigestRow {
  return {
    clientName: a.party.displayName,
    letterRef: a.letter.ref,
    serviceName: a.serviceName,
    stage: a.stage,
    invoiceNumber: a.invoice?.status === "cancelled" ? null : (a.invoice?.number ?? null),
    daysSinceSigned: daysFrom(a.billOn, today),
    amount: !seesFees
      ? null
      : a.stage === "unpaid" || a.stage === "part_paid"
        ? (a.balance?.outstanding ?? a.amount)
        : a.amount,
    currency: a.currency,
  };
}

function daysFrom(from: string, to: string): number {
  const ms = (s: string): number => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}
