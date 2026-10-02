// In-memory fakes for the billing use case (auto-invoice, phase 1).
//
// The writer models the two things the database guarantees and a test must
// not be able to forget: a subject's `duePeriodStarts` is READ from the dues
// already written (the anti-join), and a second due for the same subject and
// period is refused (the partial unique indexes), answering no id for it.
import type { SpocWithManager } from "../domain/billing/model";
import { DEFAULT_ADVANCE_POLICY, type AdvancePolicy } from "../domain/billing/advance";
import { compareAmounts, subtractAmounts } from "../domain/money/model";
import type { Actor } from "../domain/ledger/model";
import type {
  AdvanceBillFacts,
  AdvanceDigestLetter,
  AdvanceDigestStore,
  AdvanceDraftBlock,
  AdvanceDrafter,
  AdvancePeople,
  AdvancePolicySource,
  AdvanceRecord,
  AdvanceReminderFacts,
  AutoBillingFirms,
  AutoBillingSetting,
  BillingDueDesk,
  BillingDueRecord,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSchedules,
  BillingSubject,
  DueFilters,
  BillingMailer,
  FinalBillFacts,
  FinalBillSubject,
  FiscalYearSource,
  InvoiceDrafter,
  IssuerTaxDefaults,
  LetterAdvanceFacts,
  NewBillingDue,
  PersonRef,
  RefundCandidate,
  ScheduleRecord,
  WorkRelease,
} from "../usecase/billing/ports";

export interface StoredDue extends NewBillingDue {
  readonly tenantId: string;
}

export class FakeBillingDueWriter implements BillingDueWriter {
  /** Subjects by firm; `duePeriodStarts` is ignored and derived from `dues`. */
  readonly subjects = new Map<string, BillingSubject[]>();
  readonly dues: StoredDue[] = [];

  add(tenantId: string, subject: Omit<BillingSubject, "duePeriodStarts">): void {
    const list = this.subjects.get(tenantId) ?? [];
    list.push({ ...subject, duePeriodStarts: [] });
    this.subjects.set(tenantId, list);
  }

  subjectsFor(tenantId: string): Promise<readonly BillingSubject[]> {
    return Promise.resolve(
      (this.subjects.get(tenantId) ?? []).map((s) => ({
        ...s,
        duePeriodStarts: this.dues
          .filter((d) => d.tenantId === tenantId && (d.kind ?? "period") === "period" && sameSubject(d, s))
          .map((d) => d.periodStart),
      })),
    );
  }

  insert(tenantId: string, dues: readonly NewBillingDue[]): Promise<readonly string[]> {
    const created: string[] = [];
    for (const due of dues) {
      // The partial unique indexes, per kind (0318, 0320).
      const clash = this.dues.some((d) => d.tenantId === tenantId && sameDue(d, due));
      if (clash) continue;
      this.dues.push({ ...due, tenantId });
      created.push(due.id);
    }
    return Promise.resolve(created);
  }
}

function sameDue(a: NewBillingDue, b: NewBillingDue): boolean {
  const kind = a.kind ?? "period";
  if (kind !== (b.kind ?? "period")) return false;
  if (kind === "advance") {
    return a.engagementLetterId === b.engagementLetterId && a.engagementId === b.engagementId;
  }
  return sameSubject(a, b) && (kind !== "period" || a.periodStart === b.periodStart);
}

function sameSubject(
  a: { readonly engagementId: string | null; readonly feeGroupId: string | null },
  b: { readonly engagementId: string | null; readonly feeGroupId: string | null },
): boolean {
  return a.engagementId !== null ? a.engagementId === b.engagementId : a.feeGroupId === b.feeGroupId;
}

export class FakeBillingManagerFacts implements BillingManagerFacts {
  /** `${client}|${dept}` → SPOCs with their managers. */
  readonly spocs = new Map<string, SpocWithManager[]>();
  /** client → Key Manager. */
  readonly keyManagers = new Map<string, { userId: string; displayName: string | null }>();

  spocsFor(_t: string, clientPartyId: string, deptCode: string): Promise<readonly SpocWithManager[]> {
    return Promise.resolve(this.spocs.get(`${clientPartyId}|${deptCode}`) ?? []);
  }

  keyManagerFor(
    _t: string,
    clientPartyId: string,
  ): Promise<{ readonly userId: string; readonly displayName: string | null } | null> {
    return Promise.resolve(this.keyManagers.get(clientPartyId) ?? null);
  }
}

export class FakeAutoBillingFirms implements AutoBillingFirms {
  constructor(readonly firms: string[] = []) {}

  firmsWithAutoBilling(): Promise<readonly string[]> {
    return Promise.resolve(this.firms);
  }
}

export class FakeFiscalYearSource implements FiscalYearSource {
  constructor(private readonly month: number | null = 4) {}

  fiscalYearStartMonth(): Promise<number | null> {
    return Promise.resolve(this.month);
  }
}

// ── The desk ────────────────────────────────────────────────────────────────

/**
 * Dues as the desk reads them. `status` is DERIVED from what the fake
 * recorded, the way the query derives it: a skip is final, a cancelled
 * invoice reopens, so a test cannot set a status the database could not give.
 */
export class FakeBillingDueDesk implements BillingDueDesk {
  readonly rows: BillingDueRecord[] = [];
  /** Who is SPOC for which client and Dept (the fake ignores the day). */
  readonly spocs: { userId: string; clientPartyId: string; deptCode: string }[] = [];
  /** What `mine` lists were asked, so a test can see the day they were cut on. */
  readonly mineAskedOn: { userId: string; onDate: string }[] = [];
  /** advance invoice id → the day it was issued. */
  readonly issuedOn = new Map<string, string>();
  /** advance bill id → an invoice raised by hand that bills its work (0322). */
  readonly handRaised = new Map<string, { invoiceId: string; number: string }>();
  /** invoice id → status, for the derivation. */
  readonly invoiceStatus = new Map<string, string>();
  /** Bills the advance paid in full (0320). */
  readonly covered = new Set<string>();
  /** invoice id → its balance, for the advance's state. */
  readonly balances = new Map<string, { invoiced: string; paid: string; outstanding: string }>();
  /** advance invoice id → what is left of it; the lock's re-check. */
  readonly poolLeft = new Map<string, string>();
  /** What `refundCandidates` answers; a test states it. */
  readonly refunds: RefundCandidate[] = [];
  readonly waived: { dueId: string; byUserId: string; reason: string }[] = [];

  private derive(r: BillingDueRecord): BillingDueRecord {
    if (r.skipped !== null) return { ...r, status: "skipped" };
    if (this.covered.has(r.id)) return { ...r, status: "covered" };
    if (r.invoice === null) return { ...r, status: "open" };
    const status = this.invoiceStatus.get(r.invoice.id) ?? r.invoice.status;
    return {
      ...r,
      invoice: { ...r.invoice, status },
      status: status === "cancelled" ? "open" : status === "draft" ? "drafted" : "billed",
    };
  }

  /** The adapter's filters, in the same order of meaning: pending unless
   *  asked, `all` newest first, and `mine` decided before anything is cut. */
  list(_t: string, filters: DueFilters): Promise<readonly BillingDueRecord[]> {
    const status = filters.status ?? "pending";
    const mine = filters.mine;
    if (mine !== undefined) this.mineAskedOn.push({ userId: mine.userId, onDate: mine.today });
    const rows = this.rows
      .map((r) => this.derive(r))
      .filter((r) =>
        status === "all" ? true : status === "pending" ? r.status === "open" || r.status === "drafted" : r.status === status,
      )
      .filter((r) => filters.partyId === undefined || r.party.id === filters.partyId)
      .filter((r) => {
        if (mine === undefined) return true;
        if ((r.status !== "open" && r.status !== "drafted") || r.kind === "advance") return false;
        const escalated = daysFrom(r.billOn, mine.today) >= mine.escalateAfterDays;
        const spoc = this.spocs.some(
          (s) => s.userId === mine.userId && s.clientPartyId === r.party.id && r.deptCodes.includes(s.deptCode),
        );
        return (
          r.manager?.userId === mine.userId ||
          (escalated && r.managerReportsTo?.userId === mine.userId) ||
          (r.fullAmount === null && r.status === "open" && (mine.isAdmin || spoc))
        );
      });
    return Promise.resolve(status === "all" ? rows.reverse() : rows);
  }

  findMany(_t: string, ids: readonly string[]): Promise<readonly BillingDueRecord[]> {
    return Promise.resolve(this.rows.filter((r) => ids.includes(r.id)).map((r) => this.derive(r)));
  }


  skip(_t: string, dueId: string, byUserId: string | null, reason: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === dueId);
    const row = this.rows[i];
    if (row === undefined || this.derive(row).status !== "open") return Promise.resolve(false);
    this.rows[i] = {
      ...row,
      skipped: {
        at: "2026-12-05T06:00:00.000Z",
        by: byUserId === null ? null : { userId: byUserId, displayName: null, email: "x@example.test" },
        reason,
      },
    };
    return Promise.resolve(true);
  }

  markInvoiced(
    _t: string,
    dueId: string,
    invoiceId: string,
    _lineId: string | null,
    applied: { readonly invoiceId: string; readonly amount: string } | null = null,
  ): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === dueId);
    const row = this.rows[i];
    if (row === undefined || this.derive(row).status !== "open") return Promise.resolve(false);
    if (applied !== null && !this.take(applied)) return Promise.resolve(false);
    this.rows[i] = {
      ...row,
      // A draft has no number until it is issued (0322).
      invoice: { id: invoiceId, number: null, status: this.invoiceStatus.get(invoiceId) ?? "draft" },
      advanceApplied: applied === null ? null : { invoiceId: applied.invoiceId, invoiceNumber: "?", amount: applied.amount },
    };
    return Promise.resolve(true);
  }

  markCovered(_t: string, dueId: string, applied: { readonly invoiceId: string; readonly amount: string }): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === dueId);
    const row = this.rows[i];
    if (row === undefined || this.derive(row).status !== "open") return Promise.resolve(false);
    if (!this.take(applied)) return Promise.resolve(false);
    this.covered.add(dueId);
    this.rows[i] = { ...row, advanceApplied: { invoiceId: applied.invoiceId, invoiceNumber: "?", amount: applied.amount } };
    return Promise.resolve(true);
  }

  /** The adapter's re-check under its lock: no more than is left. */
  private take(applied: { readonly invoiceId: string; readonly amount: string }): boolean {
    const left = this.poolLeft.get(applied.invoiceId);
    if (left === undefined) return true;
    if (compareAmounts(left, applied.amount) < 0) return false;
    this.poolLeft.set(applied.invoiceId, subtractAmounts(left, applied.amount));
    return true;
  }

  advances(
    _t: string,
    filter: { readonly invoiceId?: string | undefined; readonly dueId?: string | undefined },
  ): Promise<readonly AdvanceRecord[]> {
    return Promise.resolve(
      this.rows
        .map((r) => this.derive(r))
        .filter((r) => r.kind === "advance")
        .filter((r) => filter.dueId === undefined || r.id === filter.dueId)
        .filter((r) => filter.invoiceId === undefined || r.invoice?.id === filter.invoiceId)
        .map((r) => ({
          ...r,
          balance: r.invoice === null ? null : (this.balances.get(r.invoice.id) ?? null),
          invoiceIssuedOn: r.invoice === null ? null : (this.issuedOn.get(r.invoice.id) ?? null),
          handRaised: r.status === "open" ? (this.handRaised.get(r.id) ?? null) : null,
        })),
    );
  }

  refundCandidates(_t: string, filter: { readonly dueId?: string | undefined } = {}): Promise<readonly RefundCandidate[]> {
    return Promise.resolve(
      this.refunds
        .filter((r) => filter.dueId === undefined || r.advance.id === filter.dueId)
        .map((r) => {
          const w = this.waived.find((x) => x.dueId === r.advance.id);
          return w === undefined
            ? r
            : { ...r, waived: { at: "2026-12-05T06:00:00.000Z", by: null, reason: w.reason } };
        }),
    );
  }

  waiveRefund(_t: string, dueId: string, byUserId: string, reason: string): Promise<boolean> {
    if (this.waived.some((w) => w.dueId === dueId)) return Promise.resolve(false);
    this.waived.push({ dueId, byUserId, reason });
    return Promise.resolve(true);
  }

  /** Bills somebody else holds (0321): a test puts an id here to be "busy". */
  readonly heldElsewhere = new Set<string>();
  /** Every claim and release, in order, so a test sees what was held. */
  readonly claims: { readonly op: "claim" | "release"; readonly ids: readonly string[] }[] = [];
  private readonly held = new Set<string>();

  claim(_t: string, dueIds: readonly string[]): Promise<boolean> {
    if (dueIds.some((id) => this.held.has(id) || this.heldElsewhere.has(id))) return Promise.resolve(false);
    for (const id of dueIds) this.held.add(id);
    this.claims.push({ op: "claim", ids: [...dueIds] });
    return Promise.resolve(true);
  }

  release(_t: string, dueIds: readonly string[]): Promise<void> {
    for (const id of dueIds) this.held.delete(id);
    this.claims.push({ op: "release", ids: [...dueIds] });
    return Promise.resolve();
  }

  /** Held right now (a test asserts it is empty after an act). */
  get holding(): readonly string[] {
    return [...this.held];
  }

  invoiceUse(_t: string, invoiceId: string): Promise<{ readonly asAdvance: boolean; readonly byBills: number }> {
    const rows = this.rows.filter((r) => r.invoice?.id === invoiceId && r.skipped === null);
    return Promise.resolve({ asAdvance: rows.some((r) => r.kind === "advance"), byBills: rows.length });
  }
}

export interface DraftedInvoice {
  readonly id: string;
  /** Null: a draft is numbered when it is issued (0322). */
  readonly number: string | null;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly dueOn: string | undefined;
  readonly managerUserId: string | undefined;
  status: string;
  readonly lines: {
    readonly id: string;
    readonly engagementId: string | undefined;
    readonly description: string;
    readonly unitAmount: string;
    readonly taxPercent: string | undefined;
  }[];
}

/** Records what the desk asked invoicing for. The rules invoicing applies to
 *  every line are InvoiceService's, and tested there. */
export class FakeInvoiceDrafter implements InvoiceDrafter {
  readonly invoices: DraftedInvoice[] = [];
  private n = 0;

  /** Who asked for each draft, in order. */
  readonly actors: Actor[] = [];

  raise(input: Parameters<InvoiceDrafter["raise"]>[0], actor: Actor): Promise<{ id: string; number: string | null }> {
    this.n += 1;
    this.actors.push(actor);
    const id = `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const invoice: DraftedInvoice = {
      id,
      number: null,
      partyId: input.partyId,
      entityPartyId: input.entityPartyId,
      currency: input.currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      dueOn: input.dueOn,
      managerUserId: input.managerUserId,
      status: "draft",
      lines: [],
    };
    this.invoices.push(invoice);
    return Promise.resolve({ id, number: invoice.number });
  }

  addLine(input: Parameters<InvoiceDrafter["addLine"]>[0]): Promise<{ id: string }> {
    const invoice = this.invoices.find((i) => i.id === input.invoiceId);
    if (invoice === undefined) return Promise.reject(new Error("no such invoice"));
    const id = `00000000-0000-4000-9000-${String(this.invoices.indexOf(invoice) * 100 + invoice.lines.length + 1).padStart(12, "0")}`;
    invoice.lines.push({
      id,
      engagementId: input.engagementId,
      description: input.description,
      unitAmount: input.unitAmount,
      taxPercent: input.taxPercent,
    });
    return Promise.resolve({ id });
  }

  readonly creditNotes: { invoiceId: string; amount: string; reason: string; note: string | undefined }[] = [];

  issueCreditNote(input: Parameters<InvoiceDrafter["issueCreditNote"]>[0]): Promise<{ id: string; number: string }> {
    this.creditNotes.push({ invoiceId: input.invoiceId, amount: input.amount, reason: input.reason, note: input.note });
    return Promise.resolve({ id: `cn-${String(this.creditNotes.length)}`, number: `CN/2026-27/${String(this.creditNotes.length).padStart(4, "0")}` });
  }

  find(_t: string, invoiceId: string): ReturnType<InvoiceDrafter["find"]> {
    const i = this.invoices.find((x) => x.id === invoiceId);
    return Promise.resolve(
      i === undefined
        ? null
        : { id: i.id, partyId: i.partyId, entityPartyId: i.entityPartyId, currency: i.currency, status: i.status },
    );
  }
}

export class FakeBillingSchedules implements BillingSchedules {
  readonly rows: ScheduleRecord[] = [];
  /** fee group → engagement ids. */
  readonly groups = new Map<string, string[]>();

  unscheduled(): Promise<readonly ScheduleRecord[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.billingFrom === null &&
          ["monthly", "quarterly", "annually"].includes(r.billingFrequency ?? "") &&
          ["active", "paused", "pending_advance"].includes(r.status),
      ),
    );
  }

  find(_t: string, engagementId: string): Promise<ScheduleRecord | null> {
    return Promise.resolve(this.rows.find((r) => r.engagementId === engagementId) ?? null);
  }

  groupMembers(_t: string, feeGroupId: string): Promise<readonly string[]> {
    return Promise.resolve(this.groups.get(feeGroupId) ?? []);
  }

  set(_t: string, ids: readonly string[], billingFrom: string | null, firstInvoiceOn: string | null): Promise<void> {
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i];
      if (row !== undefined && ids.includes(row.engagementId)) {
        this.rows[i] = { ...row, billingFrom, firstInvoiceOn };
      }
    }
    return Promise.resolve();
  }
}

// ── The advance and the final bill (0320) ───────────────────────────────────

export class FakeAdvanceBillFacts implements AdvanceBillFacts {
  /** `${tenant}|${letter}` → facts. */
  readonly letters = new Map<string, LetterAdvanceFacts>();
  /** tenant → letters the catch-up visits; a test states it. */
  readonly owing = new Map<string, string[]>();
  /** Advance bills already put on an invoice (a test, or the drafter, says). */
  readonly drafted = new Set<string>();

  /** With the writer, the undrafted advance bills are READ from the bills
   *  written, as the adapter reads them. */
  constructor(private readonly writer: FakeBillingDueWriter | null = null) {}

  advanceFactsOf(tenantId: string, letterId: string): Promise<LetterAdvanceFacts | null> {
    return Promise.resolve(this.letters.get(`${tenantId}|${letterId}`) ?? null);
  }

  lettersOwingAdvance(tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(this.owing.get(tenantId) ?? []);
  }

  firmsOwingAdvance(): Promise<readonly string[]> {
    return Promise.resolve([...this.owing.keys()]);
  }

  undraftedAdvanceBills(tenantId: string, letterId: string): Promise<readonly string[]> {
    return Promise.resolve(
      (this.writer?.dues ?? [])
        .filter((d) => d.tenantId === tenantId && d.kind === "advance" && d.engagementLetterId === letterId)
        .filter((d) => !this.drafted.has(d.id))
        .map((d) => d.id),
    );
  }
}

/** Records which letters' waiting work was started; the start itself is the
 *  EngagementService's, tested there. */
export class FakeWorkRelease implements WorkRelease {
  readonly letters: string[] = [];
  /** letter → how many engagements it had waiting. */
  readonly waiting = new Map<string, number>();

  startWaitingWork(_t: string, letterId: string): Promise<{ readonly started: number }> {
    this.letters.push(letterId);
    const started = this.waiting.get(letterId) ?? 0;
    this.waiting.delete(letterId);
    return Promise.resolve({ started });
  }
}

/** Drafts what it is asked to, or answers the block a test states; records
 *  every ask, and marks the bill drafted on the facts it is given. */
export class FakeAdvanceDrafter implements AdvanceDrafter {
  readonly asked: { dueId: string; actor: Actor }[] = [];
  /** due id → the block to answer instead of drafting. */
  readonly blocks = new Map<string, AdvanceDraftBlock>();
  /** due ids that throw, as a failing raise would. */
  readonly failing = new Set<string>();

  constructor(private readonly facts: FakeAdvanceBillFacts | null = null) {}

  draftAdvance(_t: string, dueId: string, actor: Actor): Promise<{ readonly invoiceId: string } | { readonly blocked: AdvanceDraftBlock }> {
    this.asked.push({ dueId, actor });
    if (this.failing.has(dueId)) return Promise.reject(new Error("the raise failed"));
    const blocked = this.blocks.get(dueId);
    if (blocked !== undefined) return Promise.resolve({ blocked });
    this.facts?.drafted.add(dueId);
    return Promise.resolve({ invoiceId: `inv-${dueId}` });
  }
}

export class FakeIssuerTaxDefaults implements IssuerTaxDefaults {
  /** entity → rate. */
  readonly rates = new Map<string, string>();

  list(): Promise<readonly { readonly entityPartyId: string; readonly taxPercent: string }[]> {
    return Promise.resolve([...this.rates].map(([entityPartyId, taxPercent]) => ({ entityPartyId, taxPercent })));
  }

  set(_t: string, entityPartyId: string, taxPercent: string): Promise<void> {
    this.rates.set(entityPartyId, taxPercent);
    return Promise.resolve();
  }
}

export class FakeAdvancePolicy implements AdvancePolicySource {
  policy: AdvancePolicy = DEFAULT_ADVANCE_POLICY;

  policyFor(): Promise<AdvancePolicy> {
    return Promise.resolve(this.policy);
  }

  setPolicy(_t: string, policy: AdvancePolicy): Promise<void> {
    this.policy = policy;
    return Promise.resolve();
  }
}

/** Who is reminded, as a test states it: per client, its SPOCs by Dept, its
 *  Key Manager and the partner above. The partner walk itself is SQL, and
 *  proven against Postgres. */
export class FakeAdvanceReminderFacts implements AdvanceReminderFacts {
  /** `${client}|${dept}` → SPOCs. */
  readonly spocs = new Map<string, PersonRef[]>();
  readonly keyManagers = new Map<string, PersonRef>();
  /** client → the partner above its Key Manager. */
  readonly partners = new Map<string, PersonRef>();
  readonly adminList: (PersonRef & { readonly seesFees: boolean })[] = [];
  /** The rank each `peopleFor` was asked with. */
  readonly askedRanks: number[] = [];

  peopleFor(
    _t: string,
    advances: readonly { readonly dueId: string; readonly partyId: string; readonly deptCodes: readonly string[] }[],
    _onDate: string,
    partnerMinRank: number,
  ): Promise<ReadonlyMap<string, AdvancePeople>> {
    this.askedRanks.push(partnerMinRank);
    const out = new Map<string, AdvancePeople>();
    for (const a of advances) {
      const spocs = a.deptCodes.flatMap((d) => this.spocs.get(`${a.partyId}|${d}`) ?? []);
      out.set(a.dueId, {
        spocs: spocs.filter((p, i) => spocs.findIndex((q) => q.userId === p.userId) === i),
        keyManager: this.keyManagers.get(a.partyId) ?? null,
        partner: this.partners.get(a.partyId) ?? null,
      });
    }
    return Promise.resolve(out);
  }

  admins(): Promise<readonly (PersonRef & { readonly seesFees: boolean })[]> {
    return Promise.resolve(this.adminList);
  }
}

/** The week's claim, as the table's unique key and six-day rule make it. */
export class FakeAdvanceDigestStore implements AdvanceDigestStore {
  readonly firms: string[] = [];
  readonly names = new Map<string, string>();
  /** `${tenant}|${weekOf}` → what was recorded. */
  readonly weeks = new Map<string, { sent: boolean; recipients: number; advances: number }>();

  firmsWithPendingAdvances(): Promise<readonly string[]> {
    return Promise.resolve(this.firms);
  }

  firmName(tenantId: string): Promise<string | null> {
    return Promise.resolve(this.names.get(tenantId) ?? null);
  }

  claim(tenantId: string, weekOf: string): Promise<boolean> {
    const key = `${tenantId}|${weekOf}`;
    if (this.weeks.has(key)) return Promise.resolve(false);
    const recent = [...this.weeks.keys()].some((k) => {
      const [t, w = ""] = k.split("|");
      const back = daysFrom(w, weekOf);
      return t === tenantId && back > 0 && back < 6;
    });
    if (recent) return Promise.resolve(false);
    this.weeks.set(key, { sent: false, recipients: 0, advances: 0 });
    return Promise.resolve(true);
  }

  markSent(tenantId: string, weekOf: string, recipients: number, advances: number): Promise<void> {
    this.weeks.set(`${tenantId}|${weekOf}`, { sent: true, recipients, advances });
    return Promise.resolve();
  }
}

export class FakeBillingMailer implements BillingMailer {
  readonly sent: AdvanceDigestLetter[] = [];
  /** Addresses the relay refuses. */
  readonly refusing = new Set<string>();

  sendAdvanceDigest(letter: AdvanceDigestLetter): Promise<void> {
    if (this.refusing.has(letter.to)) return Promise.reject(new Error(`relay refused ${letter.to}`));
    this.sent.push(letter);
    return Promise.resolve();
  }
}

function daysFrom(from: string, to: string): number {
  const ms = (s: string): number => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export class FakeFinalBillFacts implements FinalBillFacts {
  readonly subjects: (FinalBillSubject & { readonly tenantId: string; readonly jobIds: readonly string[] })[] = [];

  /** With the writer, `hasFinalBill` is READ from the bills written, as the
   *  adapter's anti-join reads it. */
  constructor(private readonly writer: FakeBillingDueWriter | null = null) {}

  oneTimeSubjects(
    tenantId: string,
    filter: { readonly jobId?: string | undefined; readonly engagementId?: string | undefined; readonly partyId?: string | undefined },
  ): Promise<readonly FinalBillSubject[]> {
    return Promise.resolve(
      this.subjects
        .filter((s) => s.tenantId === tenantId)
        .filter((s) => filter.jobId === undefined || s.jobIds.includes(filter.jobId))
        .filter((s) => filter.engagementId === undefined || s.engagements.some((e) => e.engagementId === filter.engagementId))
        .filter((s) => filter.partyId === undefined || s.partyId === filter.partyId)
        .map((s) => ({
          ...s,
          hasFinalBill:
            s.hasFinalBill ||
            (this.writer?.dues.some(
              (d) =>
                d.tenantId === tenantId &&
                d.kind === "final" &&
                (s.feeGroupId !== null ? d.feeGroupId === s.feeGroupId : d.engagementId === s.engagementId),
            ) ?? false),
        })),
    );
  }

  describe(
    _t: string,
    subjects: readonly FinalBillSubject[],
  ): Promise<ReadonlyMap<string, { readonly clientName: string; readonly serviceName: string; readonly letterRef: string }>> {
    return Promise.resolve(
      new Map(
        subjects.map((s) => [
          s.feeGroupId ?? s.engagementId ?? "",
          { clientName: "Kaveri Foods", serviceName: "Statutory audit", letterRef: "EL-2026-0001" },
        ]),
      ),
    );
  }
}

export class FakeAutoBillingSetting implements AutoBillingSetting {
  private readonly on = new Set<string>();
  /** The day each firm last switched on (0321). */
  readonly since = new Map<string, string>();

  isOn(tenantId: string): Promise<boolean> {
    return Promise.resolve(this.on.has(tenantId));
  }

  set(tenantId: string, on: boolean, since?: string): Promise<void> {
    if (on) this.on.add(tenantId);
    else this.on.delete(tenantId);
    if (on && since !== undefined) this.since.set(tenantId, since);
    return Promise.resolve();
  }
}
