// How a proposal is ORGANISED on paper (0084) — its sections, the code each
// service prints under, and whose name appears beside it. Pure: it decides
// structure and knows nothing about fonts, money formatting or PDFs.
//
// The firm's own proposal (10X Global, "Proposal For Services", September 2026)
// is organised by the firm's DEPT, not by fee: "A. Financial Reporting &
// Compliance" holds "H3. Transfer pricing audit — Form 3CEB", "B. Transactions
// & Regulatory Compliance" holds "C2. TDS/TCS — quarterly returns", and the
// Summary of Fees has one row per service with both codes. Every rule below is
// one a client reads, which is why it is here and tested without a page — the
// argument `planAnnexure` makes for the letter.
//
// ── THE THREE RULES ─────────────────────────────────────────────────────────
//
// 1. A DEPT IS A SECTION, in the firm's own Dept order (`service_axis`'s
//    `sort_order`), lettered A, B, … by RANK among the Depts this proposal
//    uses — so a proposal with no FRC work starts at A, not at B. The Dept is
//    the PINNED catalogue version's: the document says what the catalogue said
//    when the service was quoted. A code the firm keeps no row for still prints
//    (a firm with no Depts on file is checked against nothing — G2.4), under
//    the code itself, after the named ones. A service naming no Dept goes last,
//    in "Other services" — or "Services" when it is the only section.
//
// 2. A SERVICE PRINTS UNDER ITS CATALOGUE CODE ("H3") — the firm's own name for
//    it, the one its price list and its staff use. One with no code is numbered
//    in its section (A1, A2), the letter's rule, counting only those.
//
// 3. A COMPANY IS NAMED WHEN IT TELLS THE READER SOMETHING. A proposal whose
//    lines are all for one company — or name none — names nobody beside its
//    services. Once they differ, every service that names its company says so,
//    because two "H3" rows for two companies are otherwise one row twice.
//
// NOT merged, unlike the letter: a quote prices each company's work on its
// own line, and two lines with two prices are two promises however alike their
// words are.
import type { Amount } from "../money/model";
import type { BillingFrequency, DocumentTerms, OutOfPocketEstimate } from "../document/model";
import { sectionCode } from "../engagement/model";

/** One live line of the proposal, with what it prints already resolved. */
export interface ProposalPlanLine {
  readonly id: string;
  readonly position: number;
  /** The pinned catalogue version's own code for the service — "H3" — or null. */
  readonly ref: string | null;
  /** The pinned catalogue version's Dept code — "FRC" — or null. */
  readonly deptCode: string | null;
  readonly description: string;
  /** The company the work is for, by name, or null when the line names none. */
  readonly subject: string | null;
  readonly terms: DocumentTerms;
  readonly billingFrequency: BillingFrequency | null;
  /** What the line costs after its discount, or null when it has no price. */
  readonly net: Amount | null;
  readonly pricingNote: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
}

/** One of the firm's Depts, as `tenancy.service_axis` holds it — retired rows
 *  included, because a quote pinned to a retired Dept still names it. */
export interface ProposalDept {
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface ProposalPlanInput {
  /** The proposal's LIVE lines; order is taken from `position`. */
  readonly lines: readonly ProposalPlanLine[];
  readonly depts: readonly ProposalDept[];
}

/** One service of a section — always exactly one line (see the header). */
export interface ProposalItem {
  /** "H3", or "A1" for a service with no code of its own. */
  readonly code: string;
  readonly description: string;
  /** The company, when the proposal should say so. Null means "do not print". */
  readonly subject: string | null;
  readonly terms: DocumentTerms;
  readonly billingFrequency: BillingFrequency | null;
  readonly net: Amount | null;
  readonly pricingNote: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
  readonly lineId: string;
}

export interface ProposalSection {
  /** "A". */
  readonly code: string;
  /** The Dept's name — "Financial Reporting & Compliance". */
  readonly title: string;
  readonly items: readonly ProposalItem[];
}

export interface ProposalPlan {
  readonly sections: readonly ProposalSection[];
}

/** The last section's title: the services whose catalogue names no Dept. */
export const NO_DEPT_SECTION_TITLE = { alone: "Services", afterDepts: "Other services" } as const;

export function planProposal(input: ProposalPlanInput): ProposalPlan {
  const lines = [...input.lines].sort((a, b) => a.position - b.position);

  // RULE 3, decided over the whole proposal: one subject (or none) is noise.
  const subjects = new Set(lines.map((l) => l.subject ?? ""));
  const nameSubjects = subjects.size > 1;

  // RULE 1: the Depts this proposal uses, in the firm's order; codes the firm
  // keeps no row for after them, by code; no Dept at all last.
  const known = new Map(input.depts.map((d) => [d.code, d]));
  const used = [...new Set(lines.map((l) => l.deptCode).filter((c): c is string => c !== null))];
  const named = used
    .filter((c) => known.has(c))
    .sort((a, b) => {
      const da = known.get(a);
      const db = known.get(b);
      if (da === undefined || db === undefined) return 0;
      return da.sortOrder - db.sortOrder || da.name.localeCompare(db.name) || a.localeCompare(b);
    });
  const unnamed = used.filter((c) => !known.has(c)).sort((a, b) => a.localeCompare(b));
  const order: (string | null)[] = [...named, ...unnamed];
  if (lines.some((l) => l.deptCode === null)) order.push(null);

  const sections = order.map((dept, index): ProposalSection => {
    const code = sectionCode(index);
    const title =
      dept === null
        ? order.length === 1
          ? NO_DEPT_SECTION_TITLE.alone
          : NO_DEPT_SECTION_TITLE.afterDepts
        : (known.get(dept)?.name ?? dept);
    let unnumbered = 0;
    const items = lines
      .filter((l) => l.deptCode === dept)
      .map((l): ProposalItem => {
        // RULE 2. Counted only among the services with no code, so "A1" is the
        // first of those whatever sits before it.
        let itemCode = l.ref;
        if (itemCode === null) {
          unnumbered += 1;
          itemCode = `${code}${String(unnumbered)}`;
        }
        return {
          code: itemCode,
          description: l.description,
          subject: nameSubjects ? l.subject : null,
          terms: l.terms,
          billingFrequency: l.billingFrequency,
          net: l.net,
          pricingNote: l.pricingNote,
          oopEstimate: l.oopEstimate,
          lineId: l.id,
        };
      });
    return { code, title, items };
  });

  return { sections };
}
