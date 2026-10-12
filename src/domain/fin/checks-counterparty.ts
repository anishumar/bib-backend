// Who a document is from or to, as a KEY two lines can be compared on
// (docs/FIN_BUILD_PLAN.md F4.3, and F3.2 reuses it). Pure.
//
// UEN first, then the GST registration number, then a normalised NAME, in that
// order because that is how sure each one is: a UEN names exactly one company
// in Singapore, a GST number one registrant, and a name is what a person typed
// on an invoice. Two lines are compared on the STRONGEST identifier both carry,
// and never on a weaker one when a stronger one disagrees: two different UENs
// are two companies, whatever their names say.
//
// An unknown counterparty is never guessed (F3.2: it goes to a person). These
// functions only say whether two lines name the same party; resolving a line
// to a master record is F3.2's.

export type CounterpartyKeyKind = "uen" | "gst" | "name";

export interface CounterpartyKey {
  readonly kind: CounterpartyKeyKind;
  readonly value: string;
}

export interface CounterpartyFields {
  readonly counterpartyUen: string | null;
  readonly counterpartyGstNo: string | null;
  readonly counterpartyName: string | null;
}

/** A registration number as printed, made comparable: upper case, and the
 *  spaces, dashes, dots and slashes printers put inside it removed.
 *  "m2-2407755-9" and "M2 2407755 9" are one number. Null when nothing is left. */
export function normaliseRegistration(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.toUpperCase().replace(/[\s\-./]/g, "");
  return value === "" ? null : value;
}

// Legal forms, in the order they are stripped from the END of a name, longest
// first so "pte ltd" goes before "ltd". A form inside a name ("Wei and Co
// Chartered Accountants") is never touched: only a trailing one is.
const LEGAL_FORMS: readonly string[] = [
  "private limited",
  "pte ltd",
  "pvt ltd",
  "sdn bhd",
  "co ltd",
  "limited",
  "incorporated",
  "corporation",
  "ltd",
  "llp",
  "llc",
  "plc",
  "inc",
  "corp",
  "gmbh",
  "pte",
];

/**
 * A counterparty's name made comparable. Lower case; accents removed; "&"
 * read as "and"; punctuation dropped; runs of spaces collapsed; and trailing
 * legal forms stripped, repeatedly, so "FreshPantry Supplies Pte. Ltd." and
 * "FRESHPANTRY SUPPLIES PTE LTD" and "Freshpantry Supplies" are one name.
 * Null for a name with nothing left in it.
 *
 * Deliberately conservative: no fuzzy matching and no dropped words. Two names
 * that differ after this are two names, and a person decides (F3.2).
 */
export function normaliseCounterpartyName(raw: string | null): string | null {
  if (raw === null) return null;
  let name = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      if (name === form) continue;
      if (name.endsWith(` ${form}`)) {
        name = name.slice(0, name.length - form.length - 1).trim();
        changed = true;
      }
    }
  }
  return name === "" ? null : name;
}

/** The strongest identifier a line carries, or null when it carries none. */
export function counterpartyKey(line: CounterpartyFields): CounterpartyKey | null {
  const uen = normaliseRegistration(line.counterpartyUen);
  if (uen !== null) return { kind: "uen", value: uen };
  const gst = normaliseRegistration(line.counterpartyGstNo);
  if (gst !== null) return { kind: "gst", value: gst };
  const name = normaliseCounterpartyName(line.counterpartyName);
  if (name !== null) return { kind: "name", value: name };
  return null;
}

/** `kind:value`, for grouping. */
export function counterpartyKeyText(key: CounterpartyKey): string {
  return `${key.kind}:${key.value}`;
}

/**
 * Whether two lines name the same counterparty: compared on the UEN when both
 * carry one, else on the GST number when both carry one, else on the name. A
 * disagreement on a stronger identifier is final; a weaker one is never asked.
 * False when the two share no identifier at all.
 */
export function sameCounterparty(a: CounterpartyFields, b: CounterpartyFields): boolean {
  const ua = normaliseRegistration(a.counterpartyUen);
  const ub = normaliseRegistration(b.counterpartyUen);
  if (ua !== null && ub !== null) return ua === ub;
  const ga = normaliseRegistration(a.counterpartyGstNo);
  const gb = normaliseRegistration(b.counterpartyGstNo);
  if (ga !== null && gb !== null) return ga === gb;
  const na = normaliseCounterpartyName(a.counterpartyName);
  const nb = normaliseCounterpartyName(b.counterpartyName);
  return na !== null && na === nb;
}

/** A document number made comparable: upper case, spaces removed.
 *  "inv 25 1006" and "INV25 1006" are one number; "INV-25-1006" stays itself,
 *  because a dash may be part of the number. Null when nothing is left. */
export function normaliseDocNumber(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.toUpperCase().replace(/\s+/g, "");
  return value === "" ? null : value;
}
