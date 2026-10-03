// The real Mailer — the letters, and nothing about how they travel.
//
// ── WHY THIS FILE HAS NO VENDOR IN IT ────────────────────────────────────────
//
// `MailTransport` below is the only thing this adapter needs from a mail
// server: take a rendered letter, hand it to somebody. `nodemailer-transport.ts`
// is the one file that knows what SMTP is, and it is the only file in the
// product that imports the driver. The split is not tidiness — it is what makes
// the LETTERS testable, and the letters are the part with judgement in them. A
// test can read exactly what a client will receive without a socket, a relay,
// or a mock of somebody else's API.
//
// ── AND THE INVITE IS THE ONE THAT HAS TO BE WRITTEN CAREFULLY ───────────────
//
// A sign-in link is expected: somebody pressed a button ten seconds ago. A
// portal invite is not. It arrives unasked, at a person who never signed up for
// anything, from an address they have no reason to recognise, and it asks them
// to click a link and type a password. That is, feature for feature, a phishing
// email — so the letter has to do the work of not being one: name the firm in
// the subject and the first line, say why they are receiving it, say what they
// will be able to do, and say what to do if it was not expected.
//
// `usecase/identity/ports.ts` says the same thing from the other side, which is
// why `sendPortalInvite` takes `firmName` at all.
import type { Mailer } from "../../usecase/identity/ports";
import type {
  DecisionNotice,
  ProposalLetter,
  ProposalMailer,
} from "../../usecase/proposal/ports";
import type { AdvanceDigestLetter, AdvanceDigestRow, BillingMailer } from "../../usecase/billing/ports";
import { longDay } from "../../domain/day";
import { displayMoney } from "../../domain/money/model";

/**
 * A rendered letter, ready to hand over.
 *
 * Both bodies, always. `text` is not a fallback nobody reads — it is what a
 * screen reader, a plain-text client and every spam filter actually look at,
 * and an HTML-only letter scores worse for it.
 */
export interface Letter {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * The display name to send AS, in place of the deployment's (0085). A
   * proposal goes out under the FIRM's name, because that is who is offering
   * the work. Only the name: the address is the one the relay authenticates,
   * and a letter claiming another would be refused or, worse, delivered.
   */
  readonly fromName?: string | undefined;
  /** Where a reply goes, when not to the sender — the colleague who prepared
   *  a proposal, so the client's question reaches a person. */
  readonly replyTo?: string | undefined;
  readonly attachments?: readonly Attachment[] | undefined;
}

/** A file carried with a letter — the proposal's PDF of record. */
export interface Attachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

/** The one thing this adapter needs from a mail server. */
export interface MailTransport {
  /** Rejects if the letter was not accepted. The caller decides what that
   *  means — see `IdentityService.requestMagicLink`, where it must NOT change
   *  the answer, and `invitePortalContact`, where it must. */
  send(letter: Letter): Promise<void>;
}

/** The product's name in a subject line. Not a firm's — one server serves every
 *  tenant, and the FIRM is named in the invite's own text. */
const PRODUCT = "BiB";

export class SmtpMailer implements Mailer, ProposalMailer, BillingMailer {
  constructor(private readonly transport: MailTransport) {}

  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void> {
    const when = readableInstant(expiresAt);
    const text = [
      `Someone asked to sign in to ${PRODUCT} with this email address.`,
      ``,
      `Open this link to sign in:`,
      url,
      ``,
      `The link works ONCE and stops working at ${when}.`,
      ``,
      `If you did not ask for this, nothing has happened and you can ignore this`,
      `message — the link is the only way in and nobody else has it.`,
    ].join("\n");

    return this.transport.send({
      to,
      subject: `Your ${PRODUCT} sign-in link`,
      text,
      html: page([
        paragraph(`Someone asked to sign in to ${esc(PRODUCT)} with this email address.`),
        button(url, "Sign in"),
        paragraph(`The link works <strong>once</strong> and stops working at ${esc(when)}.`),
        paragraph(
          `If you did not ask for this, nothing has happened and you can ignore this message — ` +
            `the link is the only way in and nobody else has it.`,
        ),
        fallback(url),
      ]),
    });
  }

  sendPortalInvite(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    // Null is a real state — `PortalInviteService` passes it when the tenant row
    // does not resolve, and its comment is explicit that the letter should go
    // anyway rather than trapping a client outside. So the wording degrades
    // instead of the send failing: "the firm you work with" says less, and says
    // nothing untrue.
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work with";
    const subject =
      firm === null
        ? `You have been invited to a client portal`
        : `${firm} has invited you to their client portal`;
    const when = readableInstant(expiresAt);

    const text = [
      `${who} uses ${PRODUCT} to work with its clients, and has invited you to`,
      `their client portal.`,
      ``,
      `Choose a password and get in here:`,
      url,
      ``,
      `Once you are in you can see what they are working on for you, send them`,
      `documents they have asked for, find things they have filed, and see what`,
      `you have been invoiced.`,
      ``,
      `The link works ONCE and stops working at ${when}.`,
      ``,
      `If you were not expecting this, please check with your contact at`,
      `${who} before opening it, rather than replying to this message.`,
    ].join("\n");

    return this.transport.send({
      to,
      subject,
      text,
      html: page([
        paragraph(
          `<strong>${esc(who)}</strong> uses ${esc(PRODUCT)} to work with its clients, and has ` +
            `invited you to their client portal.`,
        ),
        button(url, "Choose a password"),
        paragraph(
          `Once you are in you can see what they are working on for you, send them documents ` +
            `they have asked for, find things they have filed, and see what you have been ` +
            `invoiced.`,
        ),
        paragraph(`The link works <strong>once</strong> and stops working at ${esc(when)}.`),
        paragraph(
          `If you were not expecting this, please check with your contact at ` +
            `${esc(who)} before opening it, rather than replying to this message.`,
        ),
        fallback(url),
      ]),
    });
  }

  /**
   * The letter a new colleague gets.
   *
   * ── IT IS THE PORTAL INVITE'S PROBLEM, NOT THE SIGN-IN LINK'S ────────────
   *
   * Unasked-for, from an address the reader has no reason to recognise, with a
   * link in it that logs somebody in. So it does the same work of not being a
   * phishing email: the firm is named in the subject and the first line, the
   * reason it arrived is stated, and there is a sentence about what to do if it
   * was not expected. The one thing it must NOT copy from the invite is the
   * password step — staff have no password to set, and telling them to choose
   * one would send them looking for a screen that does not exist.
   *
   * The line that matters most is the last one. A colleague who lets this
   * expire is not stuck, and saying so here is what makes the seventy-two hour
   * life affordable — otherwise the letter would have to be a week long like
   * the client's, for a person who has a login page.
   */
  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work at";
    const subject =
      firm === null ? `You have been given access to ${PRODUCT}` : `${firm} has added you to ${PRODUCT}`;
    const when = readableInstant(expiresAt);

    const text = [
      `${who} runs its practice on ${PRODUCT}, and somebody there has given you`,
      `access with this email address.`,
      ``,
      `Open this link to sign in:`,
      url,
      ``,
      `Inside you will find the work that is yours, what is due and when, and the`,
      `clients you look after.`,
      ``,
      `The link works ONCE and stops working at ${when}. If it has expired by the`,
      `time you read this, nothing is lost — go to the sign-in page and ask for a`,
      `new link with this same address.`,
      ``,
      `If you were not expecting this, please check with your contact at`,
      `${who} rather than replying to this message.`,
    ].join("\n");

    return this.transport.send({
      to,
      subject,
      text,
      html: page([
        paragraph(
          `<strong>${esc(who)}</strong> runs its practice on ${esc(PRODUCT)}, and somebody ` +
            `there has given you access with this email address.`,
        ),
        button(url, "Sign in"),
        paragraph(
          `Inside you will find the work that is yours, what is due and when, and the clients ` +
            `you look after.`,
        ),
        paragraph(
          `The link works <strong>once</strong> and stops working at ${esc(when)}. If it has ` +
            `expired by the time you read this, nothing is lost — go to the sign-in page and ` +
            `ask for a new link with this same address.`,
        ),
        paragraph(
          `If you were not expecting this, please check with your contact at ` +
            `${esc(who)} rather than replying to this message.`,
        ),
        fallback(url),
      ]),
    });
  }

  /**
   * The letter a client contact gets when the address ALREADY HAS A LOGIN.
   *
   * ── WHY THIS IS NOT THE PORTAL INVITE WITH A DIFFERENT BUTTON ────────────
   *
   * Because the invite's button says "Choose a password", and this reader has
   * one. Accounts are global here: the CFO being invited may be staff at
   * another firm on this same product, or a contact somebody else invited last
   * year. Sending them the password-setting link would replace the password
   * they use everywhere and sign them out of everything, on a letter they had
   * every reason to open. So this one hands over a session instead.
   *
   * Everything else it copies from the invitation deliberately: it arrives
   * unasked from a firm the reader may not expect mail from, so it names that
   * firm in the subject and the first line, says what the portal is for, and
   * ends with what to do if it was not expected. The one sentence it adds is
   * the reassuring half of the difference — nothing about their existing
   * password has changed, which is the first thing a person wonders when a
   * second firm emails them about an account they already have.
   */
  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work with";
    const subject =
      firm === null
        ? `You have been given access to a client portal`
        : `${firm} has given you access to their client portal`;
    const when = readableInstant(expiresAt);

    const text = [
      `${who} uses ${PRODUCT} to work with its clients, and has given you access`,
      `to their client portal.`,
      ``,
      `You already have a ${PRODUCT} login with this email address, so there is`,
      `nothing to set up and your password has not changed. Open this link to`,
      `sign in:`,
      url,
      ``,
      `Once you are in you can see what they are working on for you, send them`,
      `documents they have asked for, find things they have filed, and see what`,
      `you have been invoiced.`,
      ``,
      `The link works ONCE and stops working at ${when}. If it has expired by the`,
      `time you read this, nothing is lost — sign in as you normally do.`,
      ``,
      `If you were not expecting this, please check with your contact at`,
      `${who} before opening it, rather than replying to this message.`,
    ].join("\n");

    return this.transport.send({
      to,
      subject,
      text,
      html: page([
        paragraph(
          `<strong>${esc(who)}</strong> uses ${esc(PRODUCT)} to work with its clients, and ` +
            `has given you access to their client portal.`,
        ),
        paragraph(
          `You already have a ${esc(PRODUCT)} login with this email address, so there is ` +
            `nothing to set up and <strong>your password has not changed</strong>.`,
        ),
        button(url, "Sign in"),
        paragraph(
          `Once you are in you can see what they are working on for you, send them documents ` +
            `they have asked for, find things they have filed, and see what you have been ` +
            `invoiced.`,
        ),
        paragraph(
          `The link works <strong>once</strong> and stops working at ${esc(when)}. If it has ` +
            `expired by the time you read this, nothing is lost — sign in as you normally do.`,
        ),
        paragraph(
          `If you were not expecting this, please check with your contact at ` +
            `${esc(who)} before opening it, rather than replying to this message.`,
        ),
        fallback(url),
      ]),
    });
  }

  /**
   * The letter that replaces a forgotten password.
   *
   * ── WHY IT IS NOT THE SIGN-IN LETTER WITH A DIFFERENT URL ────────────────
   *
   * Because of its last paragraph, which has to say the opposite of the
   * sign-in link's. That one closes with *"if you did not ask for this, nothing
   * has happened and you can ignore this message"* — true there, and the wrong
   * thing to tell somebody holding a link that REPLACES their credential. A
   * reader who did not ask for this needs two facts in order to do nothing
   * safely: their password still works, and it goes on working for as long as
   * the link is left alone. That is the whole difference, and it is the reason
   * for the method.
   *
   * ── AND IT NAMES NO FIRM, WHERE THREE OF ITS NEIGHBOURS DO ───────────────
   *
   * The unasked-for letters name the firm because that is what stops them
   * reading as phishing. This one was asked for seconds ago, and the account it
   * belongs to is GLOBAL (ADR-02) — one login, however many firms — so there is
   * no single firm it could name without telling the reader something false
   * about which password is being reset.
   */
  sendPasswordReset(to: string, url: string, expiresAt: string): Promise<void> {
    const when = readableInstant(expiresAt);
    const text = [
      `Someone asked to reset the ${PRODUCT} password for this email address.`,
      ``,
      `Choose a new password here:`,
      url,
      ``,
      `The link works ONCE and stops working at ${when}. Asking for another one`,
      `cancels this.`,
      ``,
      `If you did not ask for this, your password has NOT changed and nothing`,
      `will happen as long as you leave this link alone — simply ignore this`,
      `message. Nobody can read the link but you.`,
    ].join("\n");

    return this.transport.send({
      to,
      subject: `Reset your ${PRODUCT} password`,
      text,
      html: page([
        paragraph(
          `Someone asked to reset the ${esc(PRODUCT)} password for this email address.`,
        ),
        button(url, "Choose a new password"),
        paragraph(
          `The link works <strong>once</strong> and stops working at ${esc(when)}. Asking ` +
            `for another one cancels this.`,
        ),
        paragraph(
          `If you did not ask for this, <strong>your password has not changed</strong> and ` +
            `nothing will happen as long as you leave this link alone — simply ignore this ` +
            `message. Nobody can read the link but you.`,
        ),
        fallback(url),
      ]),
    });
  }

  /**
   * THE PROPOSAL ITSELF (0085) — the PDF attached, and two buttons.
   *
   * ── IT IS AN UNASKED LETTER WITH LINKS IN IT, SO IT HAS TO LOOK LIKE ONE ─
   *
   * The portal invite's problem, and the same answer: the FIRM is named in the
   * From name, the subject and the first line; the reader is told why they got
   * it; and every link says what it does before anybody presses it. A reply
   * goes to the colleague who prepared it, never into a no-reply box.
   *
   * ── WHY THE BUTTONS DO NOT ANSWER ───────────────────────────────────────
   *
   * Company mail filters open every link in a message to scan it. A button that
   * accepted on opening would be pressed by the filter before the client read
   * the proposal. So each opens the proposal's page with that answer READY, and
   * the answer is given there — with a name, and for an acceptance a statement
   * ticked. The letter says so, because "I only opened it" should never be a
   * worry anybody has to have.
   */
  sendProposal(letter: ProposalLetter): Promise<void> {
    const firm = headerSafe(letter.firmName) ?? "Your adviser";
    const ref = headerSafe(letter.ref) ?? letter.ref;
    const greeting = letter.greetingName === null ? "Hello," : `Dear ${letter.greetingName},`;
    const validity =
      letter.validUntil === null ? null : `It is valid until ${longDay(letter.validUntil)}.`;
    const replyTo = letter.preparedBy ?? firm;
    const intro =
      `${firm} has sent you a proposal for ${letter.clientName}: ${letter.title} (${letter.ref}). ` +
      `The PDF is attached.`;

    const text = [
      greeting,
      ``,
      ...(letter.note === null ? [] : [letter.note, ``]),
      intro + (validity === null ? "" : ` ${validity}`),
      ``,
      `To accept it, open:`,
      letter.acceptUrl,
      ``,
      `To decline it, open:`,
      letter.declineUrl,
      ``,
      `Each link opens the proposal in your browser and asks you to confirm with your`,
      `name. Nothing is decided by opening it.`,
      ``,
      `Questions? Reply to this email and it reaches ${replyTo}.`,
      ``,
      ...(letter.preparedBy === null ? [] : [letter.preparedBy]),
      firm,
    ].join("\n");

    return this.transport.send({
      to: letter.to,
      fromName: firm,
      ...(letter.replyTo === null ? {} : { replyTo: letter.replyTo }),
      subject: `Proposal ${ref} from ${firm}`,
      text,
      html: page([
        paragraph(esc(greeting)),
        ...(letter.note === null ? [] : [paragraph(multiline(letter.note))]),
        paragraph(
          `<strong>${esc(firm)}</strong> has sent you a proposal for ${esc(letter.clientName)}: ` +
            `${esc(letter.title)} (${esc(letter.ref)}). <strong>The PDF is attached.</strong>` +
            (validity === null ? "" : ` ${esc(validity)}`),
        ),
        buttons([
          { url: letter.acceptUrl, label: "Accept proposal", primary: true },
          { url: letter.declineUrl, label: "Decline", primary: false },
        ]),
        paragraph(
          `Each button opens the proposal in your browser and asks you to confirm with your ` +
            `name. <strong>Nothing is decided by opening it.</strong>`,
        ),
        paragraph(`Questions? Reply to this email and it reaches ${esc(replyTo)}.`),
        paragraph(
          (letter.preparedBy === null ? "" : `${esc(letter.preparedBy)}<br>`) + esc(firm),
        ),
        fallback(letter.viewUrl),
      ]),
      attachments: [
        {
          filename: letter.pdf.filename,
          contentType: "application/pdf",
          content: letter.pdf.bytes,
        },
      ],
    });
  }

  /**
   * The colleague who prepared a proposal hears the moment the client answers
   * on its link (0085) — who, which way, when, and why on a decline. It goes to
   * somebody at the firm, so it names the product rather than the firm.
   */
  sendDecisionNotice(notice: DecisionNotice): Promise<void> {
    const accepted = notice.decision === "accepted";
    const verb = accepted ? "accepted" : "declined";
    const client = headerSafe(notice.clientName) ?? "The client";
    const ref = headerSafe(notice.ref) ?? notice.ref;
    const when = readableInstant(notice.decidedAt);
    const headline =
      `${notice.signerName} ${verb} proposal ${notice.ref} (${notice.title}) for ` +
      `${notice.clientName}, on the proposal's link, at ${when}.`;
    const reason = accepted
      ? null
      : notice.declinedReason === null
        ? "They gave no reason."
        : `The reason they gave: "${notice.declinedReason}"`;
    const next = accepted
      ? "The next step is the engagement letter: the proposal's page writes one up from this quote."
      : null;

    const text = [
      headline,
      ...(reason === null ? [] : [``, reason]),
      ``,
      `Open the proposal:`,
      notice.proposalUrl,
      ...(next === null ? [] : [``, next]),
    ].join("\n");

    return this.transport.send({
      to: notice.to,
      subject: `${client} ${verb} ${ref}`,
      text,
      html: page([
        paragraph(esc(headline)),
        ...(reason === null ? [] : [paragraph(esc(reason))]),
        button(notice.proposalUrl, "Open the proposal"),
        ...(next === null ? [] : [paragraph(esc(next))]),
        fallback(notice.proposalUrl),
      ]),
    });
  }

  /**
   * The weekly summary of advances to a firm's administrator (0322).
   *
   * Ashish: "once every week it should escalate to ceo coo ... through system
   * notification/email". It goes to a COLLEAGUE about the firm's own money, so
   * it names the firm in the subject (one person may administer two firms) and
   * says plainly that the work has started: the summary exists because the
   * advance no longer holds it. Amounts only where the reader may see fees (the
   * use case leaves them out otherwise). No client data beyond what the
   * administrator already sees on the Advances list.
   */
  sendAdvanceDigest(letter: AdvanceDigestLetter): Promise<void> {
    const firm = headerSafe(letter.firmName);
    const count = letter.rows.length;
    const what = count === 1 ? "1 advance" : `${String(count)} advances`;
    const hello = headerSafe(letter.recipientName);
    const intro =
      `${count === 1 ? "This advance was" : "These advances were"} signed a week or more ago and ` +
      `${count === 1 ? "is" : "are"} not paid yet. The work has started.`;
    const lines = letter.rows.map(digestLine);

    const text = [
      hello === null ? "Hello," : `Hello ${hello},`,
      ``,
      intro,
      ``,
      ...lines.map((l) => `- ${l}`),
      ``,
      `Open the advances:`,
      letter.advancesUrl,
      ``,
      `You get this every week as an administrator${firm === null ? "" : ` of ${firm}`} on ${PRODUCT}.`,
    ].join("\n");

    return this.transport.send({
      to: letter.to,
      subject: `${what} not paid yet${firm === null ? "" : ` · ${firm}`}`,
      text,
      html: page([
        paragraph(esc(hello === null ? "Hello," : `Hello ${hello},`)),
        paragraph(esc(intro)),
        `<ul style="margin:0 0 16px;padding-left:20px">` +
          lines.map((l) => `<li style="margin:0 0 6px">${esc(l)}</li>`).join("") +
          `</ul>`,
        button(letter.advancesUrl, "Open the advances"),
        paragraph(
          `<span style="font-size:13px;color:#666">` +
            esc(`You get this every week as an administrator${firm === null ? "" : ` of ${firm}`} on ${PRODUCT}.`) +
            `</span>`,
        ),
        fallback(letter.advancesUrl),
      ]),
    });
  }
}

/** One advance as a line: whose, which letter, where it stands, for how long. */
function digestLine(r: AdvanceDigestRow): string {
  const stage =
    r.stage === "on_draft"
      ? "invoice is a draft, not issued yet"
      : r.stage === "unpaid"
        ? `${r.invoiceNumber ?? "invoice"} issued, not paid`
        : r.stage === "part_paid"
          ? `${r.invoiceNumber ?? "invoice"} part paid`
          : r.stage === "not_raised"
            ? "no invoice yet"
            : "paid";
  const owed = r.amount === null ? "" : `, ${displayMoney(r.amount, r.currency)} ${r.stage === "on_draft" || r.stage === "not_raised" ? "before tax" : "still owed"}`;
  const days = r.daysSinceSigned === 1 ? "1 day" : `${String(r.daysSinceSigned)} days`;
  return `${r.clientName}, ${r.letterRef} (${r.serviceName}): ${stage}${owed}. Signed ${days} ago.`;
}

/**
 * An ISO instant as words, in UTC, WITH the zone said out loud.
 *
 * The reader's own zone would be better and this server does not know it: an
 * email has no browser to ask. So the choice is between a zone nobody chose and
 * a zone that is named, and naming it is the same rule `instant.ts` applies to
 * every date this product renders — "2 September 2026, 14:05 UTC" is
 * unambiguous everywhere, and a bare "14:05" is wrong for most of the planet.
 */
function readableInstant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = at.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm} UTC`;
}

/**
 * A tenant's name, made safe to put in a Subject header.
 *
 * A header ends at a newline, so a name carrying one could append headers of
 * its own — a `Bcc:` among them. A firm's name is written by whoever provisioned
 * the tenant, which is not the same as being trustworthy input, and the cost of
 * assuming otherwise is silent. Blank after stripping is the same as absent.
 */
function headerSafe(name: string | null): string | null {
  if (name === null) return null;
  const flat = name.replace(/[\r\n]+/g, " ").trim();
  return flat === "" ? null : flat;
}

/** HTML-escaped. The firm's name reaches the body, and an apostrophe or an
 *  ampersand in a real company name must not become markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── The HTML, deliberately from 2005 ────────────────────────────────────────
//
// Inline styles and nothing else: no stylesheet (most clients drop `<style>`),
// no image (they are blocked by default, so a logo-shaped hole is worse than no
// logo), no web font, no script. Everything below has to survive Outlook, which
// renders with Word.

function page(blocks: readonly string[]): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`,
    `font-size:15px;line-height:1.55;color:#1a1a1a;max-width:520px">`,
    blocks.join(""),
    `</div>`,
  ].join("");
}

function paragraph(html: string): string {
  return `<p style="margin:0 0 16px">${html}</p>`;
}

function button(url: string, label: string): string {
  return (
    `<p style="margin:0 0 16px">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#7a1c2e;` +
    `color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${esc(label)}</a>` +
    `</p>`
  );
}

/**
 * Two buttons on one line — Accept and Decline. The second is outlined rather
 * than filled, so the letter has one obvious next step and a second that is
 * plainly there, never hidden.
 */
function buttons(
  items: readonly { readonly url: string; readonly label: string; readonly primary: boolean }[],
): string {
  const one = (b: { url: string; label: string; primary: boolean }): string =>
    `<a href="${esc(b.url)}" style="display:inline-block;padding:10px 18px;margin:0 8px 8px 0;` +
    (b.primary
      ? `background:#7a1c2e;color:#ffffff;border:1px solid #7a1c2e;`
      : `background:#ffffff;color:#7a1c2e;border:1px solid #7a1c2e;`) +
    `text-decoration:none;border-radius:6px;font-weight:600">${esc(b.label)}</a>`;
  return `<p style="margin:0 0 8px">${items.map(one).join("")}</p>`;
}

/** A colleague's own words, escaped, with their line breaks kept. */
function multiline(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

/** The link in full, because a button is not copyable and some clients do not
 *  render one at all. */
function fallback(url: string): string {
  return (
    `<p style="margin:24px 0 0;font-size:13px;color:#666">` +
    `If the button does not work, copy this into your browser:<br>` +
    `<span style="word-break:break-all">${esc(url)}</span></p>`
  );
}
