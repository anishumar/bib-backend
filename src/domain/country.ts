// Countries, as this product stores them: ISO 3166-1 alpha-2, CURRENT codes.
//
// ── WHY A LIST AND NOT A TWO-LETTER PATTERN (audit 2026-10-03, F04 / CA#44) ──
//
// Every country field took any two capital letters. The screens' picker was
// built from the browser's own names for AA..ZZ, which also names RETIRED and
// reserved codes, so "Germany" appeared twice and the first one saved DD (East
// Germany), and "United Kingdom" could save UK, which no rule keyed on GB ever
// matches. A lead, a territory rule or a filing rule holding a dead code is
// silently matched by nothing. So the codes are the 249 officially assigned in
// ISO 3166-1 today, and a retired or made-up one is refused in words.
//
// Kept in the domain because many modules hold a country (lead, territory,
// proposal and letter lines, firm companies, documents, filing rules, a
// client's registration, the import). `domain/document/model.ts`'s
// `isJurisdiction` is the shared check and reads this one.

const ASSIGNED = [
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ",
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ",
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ",
  "DE DJ DK DM DO DZ",
  "EC EE EG EH ER ES ET",
  "FI FJ FK FM FO FR",
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY",
  "HK HM HN HR HT HU",
  "ID IE IL IM IN IO IQ IR IS IT",
  "JE JM JO JP",
  "KE KG KH KI KM KN KP KR KW KY KZ",
  "LA LB LC LI LK LR LS LT LU LV LY",
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ",
  "NA NC NE NF NG NI NL NO NP NR NU NZ",
  "OM",
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY",
  "QA",
  "RE RO RS RU RW",
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ",
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ",
  "UA UG UM US UY UZ",
  "VA VC VE VG VI VN VU",
  "WF WS",
  "YE YT",
  "ZA ZM ZW",
].join(" ");

/** The 249 codes ISO 3166-1 assigns today. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(ASSIGNED.split(" "));

/** Is this exactly a current ISO 3166-1 alpha-2 code, in upper case? */
export function isCountryCode(code: string): boolean {
  return COUNTRY_CODES.has(code);
}

/**
 * Codes people still type, or that older pickers saved, with the country they
 * meant. Retired codes, and "UK", which ISO reserves rather than assigns.
 */
const MEANT: Readonly<Record<string, { code: string; name: string }>> = {
  UK: { code: "GB", name: "the United Kingdom" },
  DD: { code: "DE", name: "Germany" },
  SU: { code: "RU", name: "Russia" },
  YU: { code: "RS", name: "Serbia" },
  CS: { code: "RS", name: "Serbia" },
  BU: { code: "MM", name: "Myanmar" },
  AN: { code: "CW", name: "Curaçao" },
  RH: { code: "ZW", name: "Zimbabwe" },
  NH: { code: "VU", name: "Vanuatu" },
  VD: { code: "VN", name: "Vietnam" },
  YD: { code: "YE", name: "Yemen" },
  FX: { code: "FR", name: "France" },
  DY: { code: "BJ", name: "Benin" },
  HV: { code: "BF", name: "Burkina Faso" },
  ZR: { code: "CD", name: "Congo (Kinshasa)" },
  TP: { code: "TL", name: "Timor-Leste" },
};

/**
 * The refusal, in words: what was given, and what to do instead. Used by every
 * module's own error so the sentence is the same wherever a country is typed.
 */
export function countryCodeProblem(raw: string): string {
  const given = raw.trim().toUpperCase();
  const meant = MEANT[given];
  if (given === "UK") return `"UK" is not the code for the United Kingdom. Use GB.`;
  if (meant !== undefined) {
    return `"${given}" is no longer a country code. For ${meant.name}, use ${meant.code}.`;
  }
  return (
    `"${raw.trim()}" is not a country code. Pick the country from the list, ` +
    `or use its two-letter code, such as IN, AE or GB.`
  );
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** A country's English name for a sentence ("India"), or the code when the
 *  runtime has none. */
export function countryWords(code: string): string {
  const upper = code.trim().toUpperCase();
  return (isCountryCode(upper) ? REGION_NAMES.of(upper) : undefined) ?? upper;
}

/**
 * What KIND of company a code names, in words for a sentence (CA#39). The same
 * list the screens offer when registering a client (`lib/entity-kind.ts` in
 * the frontend). A firm's own word that is not on the list is read as words:
 * "family_office" is "family office".
 */
const ENTITY_KIND_WORDS: Readonly<Record<string, string>> = {
  private_limited: "private limited company",
  public_limited: "public limited company",
  opc: "one person company",
  section_8: "section 8 company",
  llp: "limited liability partnership (LLP)",
  partnership: "partnership firm",
  proprietorship: "sole proprietorship",
  individual: "individual",
  huf: "Hindu undivided family (HUF)",
  trust: "trust",
  society: "society",
  aop: "association of persons",
  pte_ltd: "private limited company (Singapore)",
  fzco: "free zone company (FZCO)",
  fze: "free zone establishment (FZE)",
  llc: "LLC",
  c_corp: "C corporation",
};

export function entityKindWords(code: string): string {
  const key = code.trim();
  return ENTITY_KIND_WORDS[key] ?? key.replace(/[_-]+/g, " ").trim().toLowerCase();
}

/** "a" or "an" before a word, by its first sound as far as letters tell. */
export function withArticle(words: string): string {
  return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
}
