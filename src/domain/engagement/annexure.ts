// How an Annexure letter's first annexure is ORGANISED (0083) — sections,
// numbered services, and the Summary of Fees. Pure: it decides structure and
// knows nothing about fonts, money formatting or PDFs.
//
// ── WHY THIS IS A FUNCTION IN THE DOMAIN ────────────────────────────────────
//
// It is the one part of the new letter with rules in it, and every rule is one
// a client reads: which services are "B1", what the "B" row of the fee table
// covers, when a company's name is printed beside a service and when it would be
// noise. Getting any of these wrong is invisible in a byte comparison and obvious
// on the page — the same argument `wrapParagraph` makes for living outside the
// renderer. Here it is tested without drawing anything.
//
// ── THE THREE RULES ─────────────────────────────────────────────────────────
//
// 1. A FEE GROUP IS A SECTION. Groups print in their order and take the
//    letters A, B, …; the services they cover are numbered within them (B1,
//    B2). Lines priced on their own come last, as one more section, because a
//    letter mixing the two still has to put every service somewhere.
//
// 2. ONE SERVICE FOR FOUR COMPANIES IS ONE ITEM. G0.1 makes "accounting for the
//    group" four lines — one per legal entity — and printing the same scope four
//    times is not a letter anybody would send. Lines of one section that say the
//    same thing (the same service, the same wording, the same scope blocks, the
//    same start) print ONCE, naming the companies. Lines that differ in any of
//    those print separately, because then they are different promises.
//
// 3. A COMPANY'S NAME IS PRINTED WHEN IT TELLS THE READER SOMETHING. A letter
//    for one company names nobody beside its services. A section whose every
//    service covers the same companies names them once, under its heading. Only
//    a section that mixes names them per service.
import type { Amount } from "../money/model";
import type { BillingFrequency, DocumentTerms, OutOfPocketEstimate } from "../document/model";
import type { FeeGroup } from "./model";
import { sectionCode } from "./model";

/** One live line of the letter, with what the letter prints for it already
 *  resolved — its company by name, and its four scope blocks. */
export interface PlanLine {
  readonly id: string;
  readonly position: number;
  readonly feeGroupId: string | null;
  readonly entityPartyId: string;
  readonly entityName: string;
  readonly serviceVersionId: string;
  readonly description: string;
  readonly terms: DocumentTerms;
  readonly billingFrequency: BillingFrequency | null;
  /** The LINE's own start, or null for "with the letter". */
  readonly effectiveFrom: string | null;
  /** What the line costs, or null when it has no price of its own — grouped,
   *  or "as mutually agreed". */
  readonly net: Amount | null;
  readonly pricingNote: string | null;
  readonly oopEstimate: OutOfPocketEstimate | null;
}

export interface PlanInput {
  /** When the letter's work begins, or null for the signature date. */
  readonly letterEffectiveFrom: string | null;
  /** The letter's LIVE groups; order is taken from `position`. */
  readonly feeGroups: readonly FeeGroup[];
  /** The letter's LIVE lines; order is taken from `position`. */
  readonly lines: readonly PlanLine[];
}

/** One numbered service of a section — possibly several lines, one per company. */
export interface AnnexureItem {
  /** "B1". */
  readonly code: string;
  readonly description: string;
  /** The companies this service is for, when the letter should say so here
   *  rather than under the section heading. Null means "do not print". */
  readonly entityNames: readonly string[] | null;
  readonly terms: DocumentTerms;
  readonly oopEstimate: OutOfPocketEstimate | null;
  /** Printed only when this service starts on a day of its own. */
  readonly beginsOn: string | null;
  readonly lineIds: readonly string[];
}

export interface AnnexureSection {
  /** "B". */
  readonly code: string;
  readonly title: string;
  /** The group this section IS, or null for the section of lines priced on
   *  their own. */
  readonly group: FeeGroup | null;
  /** Every company the section's services cover, when they all cover the same
   *  ones and the letter covers more than one. */
  readonly entityNames: readonly string[] | null;
  readonly items: readonly AnnexureItem[];
}

/** One row of the Summary of Fees: a whole group, or one line priced on its own. */
export interface FeeRow {
  /** "B" for a group, "C1" for a line. */
  readonly code: string;
  readonly description: string;
  readonly billingFrequency: BillingFrequency | null;
  /** When the fee starts, when every service it covers starts together and
   *  the day is known. Null otherwise. */
  readonly startsOn: string | null;
  /** Null for a line with no price of its own — `pricingNote` says why. */
  readonly amount: Amount | null;
  readonly pricingNote: string | null;
  readonly paymentTerms: string | null;
}

export interface AnnexurePlan {
  readonly sections: readonly AnnexureSection[];
  readonly fees: readonly FeeRow[];
}

/** The heading of the section that holds lines priced on their own. */
export const OWN_PRICE_SECTION_TITLE = { alone: "Services", afterGroups: "Other services" } as const;

export function planAnnexure(input: PlanInput): AnnexurePlan {
  const groups = [...input.feeGroups].sort((a, b) => a.position - b.position);
  const known = new Set(groups.map((g) => g.id));
  const lines = [...input.lines].sort((a, b) => a.position - b.position);
  // A line naming a group that is not live is priced by nothing the letter
  // prints. The database refuses that state (`trg_el_line_group_is_live`), so
  // this is the safe reading of an impossible row rather than a feature: it
  // prints with the lines priced on their own, where its missing price shows.
  const inGroup = (l: PlanLine): string | null =>
    l.feeGroupId !== null && known.has(l.feeGroupId) ? l.feeGroupId : null;

  const companies = new Set(lines.map((l) => l.entityPartyId));
  const namesCompanies = companies.size > 1;

  const sections: AnnexureSection[] = groups.map((group, i) =>
    section(
      sectionCode(i),
      group.title,
      group,
      lines.filter((l) => inGroup(l) === group.id),
      input.letterEffectiveFrom,
      namesCompanies,
    ),
  );
  const ownPriced = lines.filter((l) => inGroup(l) === null);
  if (ownPriced.length > 0) {
    sections.push(
      section(
        sectionCode(groups.length),
        groups.length === 0 ? OWN_PRICE_SECTION_TITLE.alone : OWN_PRICE_SECTION_TITLE.afterGroups,
        null,
        ownPriced,
        input.letterEffectiveFrom,
        namesCompanies,
      ),
    );
  }

  const fees: FeeRow[] = [];
  for (const s of sections) {
    const group = s.group;
    if (group !== null) {
      const members = lines.filter((l) => inGroup(l) === group.id);
      fees.push({
        code: s.code,
        description:
          group.feeDescription ??
          (s.items.length === 0
            ? group.title
            : `${group.title}: ${s.items.map((item) => item.description).join(", ")}`),
        billingFrequency: group.billingFrequency,
        startsOn: commonStart(members, input.letterEffectiveFrom),
        amount: group.amount,
        pricingNote: null,
        paymentTerms: group.paymentTerms,
      });
      continue;
    }
    for (const item of s.items) {
      for (const lineId of item.lineIds) {
        const line = lines.find((l) => l.id === lineId);
        if (line === undefined) continue;
        fees.push({
          code: item.code,
          // The company, when the letter covers several: one service for four
          // companies is four fees here, and four identical rows would read as
          // a mistake.
          description: namesCompanies ? `${line.description} (${line.entityName})` : line.description,
          billingFrequency: line.billingFrequency,
          startsOn: line.effectiveFrom ?? input.letterEffectiveFrom,
          amount: line.net,
          pricingNote: line.pricingNote,
          paymentTerms: null,
        });
      }
    }
  }

  return { sections, fees };
}

function section(
  code: string,
  title: string,
  group: FeeGroup | null,
  lines: readonly PlanLine[],
  letterEffectiveFrom: string | null,
  namesCompanies: boolean,
): AnnexureSection {
  // Rule 2: lines that say the same thing are one item, in the order the first
  // of them appears.
  const merged: { key: string; head: PlanLine; lines: PlanLine[] }[] = [];
  for (const line of lines) {
    const key = sameness(line);
    const existing = merged.find((m) => m.key === key);
    if (existing !== undefined) existing.lines.push(line);
    else merged.push({ key, head: line, lines: [line] });
  }

  // Rule 3: name the companies once for the section when every item covers
  // the same ones, and per item otherwise.
  const sets = merged.map((m) => companiesOf(m.lines));
  const first = sets[0];
  const shared =
    first !== undefined && sets.every((s) => s.ids.join("\u0000") === first.ids.join("\u0000"));
  const sectionNames = namesCompanies && shared && first !== undefined ? first.names : null;

  const items = merged.map((m, i): AnnexureItem => {
    const own = m.head.effectiveFrom;
    return {
      code: `${code}${String(i + 1)}`,
      description: m.head.description,
      entityNames: namesCompanies && !shared ? (sets[i]?.names ?? null) : null,
      terms: m.head.terms,
      oopEstimate: m.head.oopEstimate,
      beginsOn: own !== null && own !== letterEffectiveFrom ? own : null,
      lineIds: m.lines.map((l) => l.id),
    };
  });

  return { code, title, group, entityNames: sectionNames, items };
}

/** What two lines must share to be printed as one item. Everything the item
 *  prints — so two lines that would print differently never merge. */
function sameness(l: PlanLine): string {
  return [
    l.serviceVersionId,
    l.description,
    l.terms.scope.text ?? "",
    l.terms.clientObligations.text ?? "",
    l.terms.volumeLimits.text ?? "",
    l.terms.exclusions.text ?? "",
    l.effectiveFrom ?? "",
    l.oopEstimate === null ? "" : `${l.oopEstimate.currency} ${l.oopEstimate.min} ${l.oopEstimate.max}`,
  ].join("\u0000");
}

/** The distinct companies of some lines, in the order they first appear. */
function companiesOf(lines: readonly PlanLine[]): { ids: string[]; names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  for (const l of lines) {
    if (ids.includes(l.entityPartyId)) continue;
    ids.push(l.entityPartyId);
    names.push(l.entityName);
  }
  return { ids, names };
}

/** The day every one of these lines starts, or null when they differ or when
 *  it is the signature date nobody knows yet. */
function commonStart(lines: readonly PlanLine[], letterEffectiveFrom: string | null): string | null {
  const days = new Set(lines.map((l) => l.effectiveFrom ?? letterEffectiveFrom));
  if (days.size !== 1) return lines.length === 0 ? letterEffectiveFrom : null;
  const [only] = [...days];
  return only ?? null;
}
