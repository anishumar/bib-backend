// Setup readiness (V2.6): is this firm set up well enough for the product to
// run its work? Fourteen lines, each one a fact the database can answer and a
// screen that fixes it.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// Setting up a firm is about sixteen ordered steps, and several of them fail
// SILENTLY: a client with no SPOC gets its work on nobody's desk, a firm with no
// ladder escalates nothing, a rule nobody confirmed files nothing. The QA firm
// stopped half-way on 27 Sep 2026 and nothing on any screen said so. This is
// the list that says so, and it is computed, never ticked by hand: fixing a gap
// turns its line done on the next read.
//
// ── NOTHING TO CHECK IS NOT DONE (audit 2026-10-03, CA#15) ──────────────────
//
// A line about clients on a firm with no clients has nothing missing, and it
// used to say Done: an empty firm read "4 of 8 done" on its first morning, a
// progress it had not made. A line with nothing to look at now says so
// (`nothing_to_check`) and is neither done nor to do, so the count is of the
// lines that apply. The first-week blockers that exist as data (the firm's
// company details, its time zone, its people, a service, standard terms) are
// lines of their own: they were the ones a new firm actually stopped on.
//
// ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────
//
// The NUMBERS on a ladder (decision D3 is open: the firm has not given its
// chaser, nudge and escalation days). The line is "a ladder is published",
// never "these days". Nor does it decide which services OUGHT to file: a
// bookkeeping service may owe nothing, so the rules line asks that the calendar
// has something confirmed to generate from, and that nothing linked is left
// unconfirmed. The firm's own GSTIN is checked (since Q056) only where it
// decides something: an Indian company without one issues plain invoices.
//
// Pure: facts in, lines out. The adapter gathers the facts; this decides.
import { isZoneChosen, zoneForCountries } from "../tenancy/model";

/** The lines, in the order a firm sets itself up (handover-flow.md). */
export const READINESS_KEYS = [
  "company_details",
  "time_zone",
  "staff",
  "deadlines",
  "services",
  "tax_invoice",
  "standard_terms",
  "reporting_lines",
  "request_routing",
  "processes",
  "compliance_rules",
  "ladders",
  "client_details",
  "account_team",
  "portal_contacts",
  // LAST, so a line added beside it in another branch merges cleanly.
  "return_periods",
] as const;

export type ReadinessKey = (typeof READINESS_KEYS)[number];

/** Done, to do, or nothing to look at yet (no clients, no services). */
export const READINESS_STATES = ["done", "to_do", "nothing_to_check"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/**
 * One thing that is missing, on one subject.
 *
 * `missing` is a closed vocabulary per line (see `ReadinessFacts`), so the
 * screen words it; the API never ships a sentence here, because the screen's
 * copy is the screen's.
 */
export interface ReadinessGap {
  /** The subject's id (a client's party id, a person's user id, a rule's id,
   *  one of the firm's companies), or null when the gap is the firm's own. */
  readonly id: string | null;
  /** A key the screen can link with (a service's catalogue key), or on
   *  `time_zone` the zone the firm's companies settle, or null. */
  readonly ref: string | null;
  /** The subject's name as the firm wrote it; empty for the firm's own gap. */
  readonly name: string;
  readonly missing: readonly string[];
}

export interface ReadinessLine {
  readonly key: ReadinessKey;
  readonly state: ReadinessState;
  /** `state === "done"`. Kept because every reader before 2026-10-03 reads it. */
  readonly done: boolean;
  readonly gaps: readonly ReadinessGap[];
  /** Names that explain WHY a line applies at all (the check rules that read
   *  reporting lines). Empty for every other line. */
  readonly context: readonly string[];
}

/** Everything the lines are computed from. One read, gathered by the adapter. */
export interface ReadinessFacts {
  /** The firm's day the account team and portal grants were read on. */
  readonly day: string;
  /** The firm's own companies, not archived or retired, and whether each has
   *  its country and its registered address. */
  readonly companies: readonly {
    readonly partyId: string;
    readonly name: string;
    /** ISO 3166-1 alpha-2, or null when the company is not registered. */
    readonly country: string | null;
    readonly hasAddress: boolean;
    /** A GSTIN in force today (Q056). */
    readonly hasGstin: boolean;
    /** A live bank account its invoices print (0369). */
    readonly hasBankAccount: boolean;
  }[];
  /** `tenancy.tenant.time_zone`. 'UTC' is the default nobody chose (0071). */
  readonly timeZone: string;
  /** Active staff logins, the person reading included. */
  readonly activeStaff: number;
  /** Standard terms (clauses) with a version in force. */
  readonly publishedTerms: number;
  /**
   * Client companies the firm has QUOTED OR ENGAGED (a proposal, a letter, or
   * a letter line or engagement naming them), not archived, not the firm's
   * own (Q076): their registration as it stands. A lead's prospect nobody has
   * quoted yet is not here; a new proposal for one is refused in words.
   */
  readonly clientCompanies: readonly {
    readonly partyId: string;
    readonly name: string;
    /** ISO 3166-1 alpha-2, or null when the company has no registration. */
    readonly country: string | null;
    /** MM-DD, or null. India's is fixed and never a gap. */
    readonly yearEnd: string | null;
  }[];
  /** Every client with an active engagement, not archived. */
  readonly activeClients: readonly {
    readonly partyId: string;
    readonly name: string;
    readonly hasKeyManager: boolean;
    /** Dept codes a service of the client names, with no SPOC in force. */
    readonly deptsWithoutSpoc: readonly string[];
    readonly hasPortalLogin: boolean;
  }[];
  /** Labels of the PUBLISHED check rules that read reporting lines alone. */
  readonly reportingLinePolicies: readonly string[];
  /** Active staff with no manager recorded, below the firm's top grade. */
  readonly staffWithoutManager: readonly { readonly userId: string; readonly name: string }[];
  /** Which ladders have a published version. */
  readonly ladders: { readonly escalation: boolean; readonly chaser: boolean; readonly nudge: boolean };
  /** The published compliance policy's two answers, or null for each unset. */
  readonly missedFromOn: string | null;
  readonly fiscalYearStartMonth: number | null;
  /** Rules that generate: active, dated, confirmed and linked to a service. */
  readonly generatingRules: number;
  /** Active rules linked to a service that the firm has not confirmed. */
  readonly linkedUnconfirmedRules: readonly { readonly id: string; readonly name: string }[];
  /** Every live service and the process it names. */
  readonly services: readonly {
    readonly key: string;
    readonly name: string;
    /** `workflowTemplateKey`, or null when it names none. */
    readonly processKey: string | null;
    /** Whether that process has a published version. */
    readonly processPublished: boolean;
    /** The service's Indian SAC and GST rate (Q056), or null each. */
    readonly sac: string | null;
    readonly taxRate: string | null;
  }[];
  /** `tenancy.tenant.client_request_routing`: 'none' is the unset default. */
  readonly requestRouting: string;
  /** Confirmed, linked rules on an authority-assigned period (0359). */
  readonly assignedPeriodRules: number;
  /** Client companies such a rule reaches with no period recorded for its
   *  tax: they get no filing for it until one is (Q073). */
  readonly companiesWithoutReturnPeriod: readonly {
    readonly partyId: string;
    readonly name: string;
    readonly taxes: readonly string[];
  }[];
}

function line(key: ReadinessKey, gaps: readonly ReadinessGap[], context: readonly string[] = []): ReadinessLine {
  const state: ReadinessState = gaps.length === 0 ? "done" : "to_do";
  return { key, state, done: state === "done", gaps, context };
}

/** A line with no subject yet: neither done nor to do. */
function nothingToCheck(key: ReadinessKey): ReadinessLine {
  return { key, state: "nothing_to_check", done: false, gaps: [], context: [] };
}

const firm = (missing: string): ReadinessGap => ({ id: null, ref: null, name: "", missing: [missing] });

/** The lines, in `READINESS_KEYS` order. */
export function readinessLines(f: ReadinessFacts): readonly ReadinessLine[] {
  const lines: Record<ReadinessKey, ReadinessLine> = {
    // Every company the firm issues from has its country (which law its
    // letters and filings follow) and its registered address (what a letter
    // and an invoice print). A firm always has at least itself.
    company_details: line(
      "company_details",
      f.companies.length === 0
        ? [firm("company")]
        : f.companies
            .filter((c) => c.country === null || !c.hasAddress)
            .map((c) => ({
              id: c.partyId,
              ref: null,
              name: c.name,
              missing: [...(c.country === null ? ["country"] : []), ...(c.hasAddress ? [] : ["address"])],
            })),
    ),

    // UTC is the default nobody chose. `ref` is the zone the firm's companies
    // settle between them, when they settle one, so the screen can offer it.
    // It is never applied for the firm: the zone is the firm's call.
    time_zone: line(
      "time_zone",
      isZoneChosen(f.timeZone)
        ? []
        : [
            {
              id: null,
              ref: zoneForCountries(f.companies.map((c) => c.country)),
              name: "",
              missing: ["time_zone"],
            },
          ],
    ),

    // Somebody besides the one person a new firm is created with.
    staff: line("staff", f.activeStaff >= 2 ? [] : [firm("colleagues")]),

    // The go-live floor and the financial year's first month.
    deadlines: line("deadlines", [
      ...(f.missedFromOn === null ? [firm("go_live_floor")] : []),
      ...(f.fiscalYearStartMonth === null ? [firm("fiscal_year_start")] : []),
    ]),

    services: line("services", f.services.length > 0 ? [] : [firm("service")]),

    // A GST TAX INVOICE (Q056): each Indian company has its GSTIN (without one
    // it issues plain invoices) and the bank account its invoices print, and
    // each service its SAC and GST rate (an invoice is refused at issue
    // without a SAC). Only a firm with an Indian company has anything here.
    tax_invoice: !f.companies.some((c) => c.country === "IN")
      ? nothingToCheck("tax_invoice")
      : line("tax_invoice", [
          ...f.companies
            .filter((c) => c.country === "IN" && (!c.hasGstin || !c.hasBankAccount))
            .map((c) => ({
              id: c.partyId,
              ref: null,
              name: c.name,
              missing: [...(c.hasGstin ? [] : ["gstin"]), ...(c.hasBankAccount ? [] : ["bank_account"])],
            })),
          ...f.services
            .filter((sv) => sv.sac === null || sv.taxRate === null)
            .map((sv) => ({
              id: null,
              ref: sv.key,
              name: sv.name,
              missing: [...(sv.sac === null ? ["sac"] : []), ...(sv.taxRate === null ? ["tax_rate"] : [])],
            })),
        ]),

    // A letter cannot be written without a term in force (CA#3).
    standard_terms: line("standard_terms", f.publishedTerms > 0 ? [] : [firm("standard_terms")]),

    // Only where a check rule reads them. `reporting_line_or_rank` falls back
    // to rank, so a person with no manager can still be checked there.
    reporting_lines:
      f.reportingLinePolicies.length === 0
        ? nothingToCheck("reporting_lines")
        : line(
            "reporting_lines",
            f.staffWithoutManager.map((p) => ({ id: p.userId, ref: null, name: p.name, missing: ["manager"] })),
            f.reportingLinePolicies,
          ),

    request_routing: line("request_routing", f.requestRouting === "none" ? [firm("routing")] : []),

    processes:
      f.services.length === 0
        ? nothingToCheck("processes")
        : line(
            "processes",
            f.services
              .filter((s) => s.processKey === null || !s.processPublished)
              .map((s) => ({
                id: null,
                ref: s.key,
                name: s.name,
                missing: [s.processKey === null ? "process" : "published_process"],
              })),
          ),

    compliance_rules: line("compliance_rules", [
      ...(f.generatingRules === 0 ? [firm("confirmed_linked_rule")] : []),
      ...f.linkedUnconfirmedRules.map((r) => ({ id: r.id, ref: null, name: r.name, missing: ["confirmed"] })),
    ]),

    // Published at all. Never the days on it (D3).
    ladders: line("ladders", [
      ...(f.ladders.escalation ? [] : [firm("escalation")]),
      ...(f.ladders.chaser ? [] : [firm("chaser")]),
      ...(f.ladders.nudge ? [] : [firm("nudge")]),
    ]),

    account_team:
      f.activeClients.length === 0
        ? nothingToCheck("account_team")
        : line(
            "account_team",
            f.activeClients
              .filter((c) => !c.hasKeyManager || c.deptsWithoutSpoc.length > 0)
              .map((c) => ({
                id: c.partyId,
                ref: null,
                name: c.name,
                missing: [
                  ...(c.hasKeyManager ? [] : ["key_manager"]),
                  ...c.deptsWithoutSpoc.map((d) => `spoc:${d}`),
                ],
              })),
          ),

    // Q076: every client company the firm has quoted or engaged has its
    // country and company type (registered), and outside India its year end.
    // Nothing is backfilled: the firm fills these in.
    client_details:
      f.clientCompanies.length === 0
        ? nothingToCheck("client_details")
        : line(
            "client_details",
            f.clientCompanies
              .map((c) => ({
                id: c.partyId,
                ref: null,
                name: c.name,
                missing:
                  c.country === null
                    ? ["country", "company_type"]
                    : c.country !== "IN" && c.yearEnd === null
                      ? ["year_end"]
                      : [],
              }))
              .filter((g) => g.missing.length > 0),
          ),

    portal_contacts:
      f.activeClients.length === 0
        ? nothingToCheck("portal_contacts")
        : line(
            "portal_contacts",
            f.activeClients
              .filter((c) => !c.hasPortalLogin)
              .map((c) => ({ id: c.partyId, ref: null, name: c.name, missing: ["portal_login"] })),
          ),

    // A filing on the period the tax authority assigned (the UAE VAT stagger)
    // is generated only for a company whose period is recorded; the rest get
    // nothing, never a guess, and are listed here by tax (Q073, 0359).
    return_periods:
      f.assignedPeriodRules === 0
        ? nothingToCheck("return_periods")
        : line(
            "return_periods",
            f.companiesWithoutReturnPeriod.map((c) => ({
              id: c.partyId,
              ref: null,
              name: c.name,
              missing: c.taxes.map((t) => `return_period:${t}`),
            })),
          ),
  };
  return READINESS_KEYS.map((k) => lines[k]);
}
