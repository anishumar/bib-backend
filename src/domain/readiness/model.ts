// Setup readiness (V2.6): is this firm set up well enough for the product to
// run its work? Eight lines, each one a fact the database can answer and a
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
// ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────
//
// The NUMBERS on a ladder (decision D3 is open: the firm has not given its
// chaser, nudge and escalation days). The line is "a ladder is published",
// never "these days". Nor does it decide which services OUGHT to file: a
// bookkeeping service may owe nothing, so the rules line asks that the calendar
// has something confirmed to generate from, and that nothing linked is left
// unconfirmed.
//
// Pure: facts in, lines out. The adapter gathers the facts; this decides.

/** The lines, in the order a firm sets itself up (handover-flow.md). */
export const READINESS_KEYS = [
  "deadlines",
  "reporting_lines",
  "request_routing",
  "processes",
  "compliance_rules",
  "ladders",
  "account_team",
  "portal_contacts",
] as const;

export type ReadinessKey = (typeof READINESS_KEYS)[number];

/**
 * One thing that is missing, on one subject.
 *
 * `missing` is a closed vocabulary per line (see `ReadinessFacts`), so the
 * screen words it; the API never ships a sentence here, because the screen's
 * copy is the screen's.
 */
export interface ReadinessGap {
  /** The subject's id (a client's party id, a person's user id, a rule's id),
   *  or null when the gap is the firm's own. */
  readonly id: string | null;
  /** A key the screen can link with (a service's catalogue key), or null. */
  readonly ref: string | null;
  /** The subject's name as the firm wrote it; empty for the firm's own gap. */
  readonly name: string;
  readonly missing: readonly string[];
}

export interface ReadinessLine {
  readonly key: ReadinessKey;
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
  }[];
  /** `tenancy.tenant.client_request_routing`: 'none' is the unset default. */
  readonly requestRouting: string;
}

function line(key: ReadinessKey, gaps: readonly ReadinessGap[], context: readonly string[] = []): ReadinessLine {
  return { key, done: gaps.length === 0, gaps, context };
}

const firm = (missing: string): ReadinessGap => ({ id: null, ref: null, name: "", missing: [missing] });

/** The eight lines, in `READINESS_KEYS` order. */
export function readinessLines(f: ReadinessFacts): readonly ReadinessLine[] {
  const lines: Record<ReadinessKey, ReadinessLine> = {
    // The go-live floor and the financial year's first month.
    deadlines: line("deadlines", [
      ...(f.missedFromOn === null ? [firm("go_live_floor")] : []),
      ...(f.fiscalYearStartMonth === null ? [firm("fiscal_year_start")] : []),
    ]),

    // Only where a check rule reads them. `reporting_line_or_rank` falls back
    // to rank, so a person with no manager can still be checked there.
    reporting_lines: line(
      "reporting_lines",
      f.reportingLinePolicies.length === 0
        ? []
        : f.staffWithoutManager.map((p) => ({ id: p.userId, ref: null, name: p.name, missing: ["manager"] })),
      f.reportingLinePolicies,
    ),

    request_routing: line("request_routing", f.requestRouting === "none" ? [firm("routing")] : []),

    processes: line(
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

    account_team: line(
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

    portal_contacts: line(
      "portal_contacts",
      f.activeClients
        .filter((c) => !c.hasPortalLogin)
        .map((c) => ({ id: c.partyId, ref: null, name: c.name, missing: ["portal_login"] })),
    ),
  };
  return READINESS_KEYS.map((k) => lines[k]);
}
