// Who a CLIENT email is from (Q059, 2026-10-05).
//
// Sid: client emails should come "preferably from the email of SPOC". Two
// halves, and only one of them needs anything from the firm:
//
//   1. EVERY client email names the person: the display name is "Priya
//      Sharma, 10x Global" and Reply-To is Priya, so the client's answer
//      reaches her and not a no-reply box. Nothing to set up.
//   2. The FROM ADDRESS is Priya's own only when her mail domain is on the
//      firm's list of domains it may send from. A From the relay is not
//      authorised for (no SPF/DKIM for that domain) is refused or filed as
//      spam, so the firm adds a domain once its mail provider allows it, and
//      until then the deployment's sender carries the letter.
//
// Staff emails are unchanged: this is about the firm writing to its client.
//
// PURE: the rules. Which colleague is the SPOC for a letter is the adapter's
// read (`client-senders.ts`): the SPOC of the document's one Dept, else the
// client's Key Manager (Shrestha, 2026-10-05).

/** The colleague a client email is from. */
export interface ClientSender {
  /** Their display name; null when the account has none (the email stands in). */
  readonly name: string | null;
  readonly email: string;
  /** Their domain is on the firm's list: the letter goes FROM this address. */
  readonly ownAddress: boolean;
}

/** The most domains one firm may list. A firm has one or two; twenty is a typo's ceiling. */
export const MAX_SEND_DOMAINS = 20;

/** The part after the last @, lower case; null when there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/** What a person typed, as it is stored: trimmed, lower case, no leading @. */
export function normalizeSendDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Why a (normalised) domain cannot be listed, in words; null when it can. */
export function sendDomainProblem(domain: string): string | null {
  if (domain === "") return "A domain cannot be blank.";
  if (domain.includes("@")) return `"${domain}" is an email address. Give only the part after the @, e.g. 10xglobal.in.`;
  if (!DOMAIN.test(domain)) return `"${domain}" is not a mail domain. Give it like 10xglobal.in.`;
  return null;
}

/** Whether a colleague's own address may be the From, by its domain. */
export function mayUseOwnAddress(email: string, domains: readonly string[]): boolean {
  const domain = emailDomain(email);
  return domain !== null && domains.includes(domain);
}

/**
 * The display name a client email goes out under: "Priya Sharma, 10x Global".
 * No sender: the firm's name alone, as before. No firm name known: the person
 * alone. The caller makes both header-safe.
 */
export function senderDisplayName(sender: ClientSender | null, firm: string | null): string | null {
  if (sender === null) return firm;
  const person = sender.name !== null && sender.name.trim() !== "" ? sender.name.trim() : sender.email;
  return firm === null ? person : `${person}, ${firm}`;
}
