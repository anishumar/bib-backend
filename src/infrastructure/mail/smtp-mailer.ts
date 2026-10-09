// The real Mailer: the letters, and nothing about how they travel. `nodemailer-transport.ts` is
// the only file that knows SMTP, so a test reads exactly what a client receives without a socket.
// An UNASKED letter (portal invite, staff welcome, proposal) is a phishing email feature for
// feature, so it names the firm in the subject and first line, says why it arrived and what it
// allows, and what to do if unexpected. That is why `sendPortalInvite` takes `firmName`.
import type { Mailer, StaffWelcomeExtras } from "../../usecase/identity/ports";
import type {
  DecisionNotice,
  ProposalLetter,
  ProposalMailer,
} from "../../usecase/proposal/ports";
import type { AdvanceDigestLetter, AdvanceDigestRow, BillingMailer } from "../../usecase/billing/ports";
import type { NotificationLetter, NotificationMailer } from "../../usecase/notify/ports";
import { longDay } from "../../domain/day";
import { displayMoney } from "../../domain/money/model";
import { senderDisplayName } from "../../domain/mail/model";
import type { ClientSender } from "../../domain/mail/model";

/** A rendered letter. Both bodies always: screen readers, plain-text clients and spam filters read `text`. */
export interface Letter {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Display name to send as, e.g. the firm's (0085). Name only: the address is the one the relay authenticates. */
  readonly fromName?: string | undefined;
  /** From address (Q059): only a client email whose SPOC's domain the firm listed for the relay (SPF/DKIM). */
  readonly fromAddress?: string | undefined;
  /** Where a reply goes: the client's SPOC (Q059) or the proposal's preparer, so it reaches a person. */
  readonly replyTo?: string | { readonly name: string; readonly address: string } | undefined;
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
  /** Rejects if not accepted; `requestMagicLink` must not change its answer on that, `invitePortalContact` must. */
  send(letter: Letter): Promise<void>;
}

/** The product's name; one server serves every tenant, so the firm is named in the letter text. */
const PRODUCT = "BiB";

export class SmtpMailer implements Mailer, ProposalMailer, BillingMailer, NotificationMailer {
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
      `message: the link is the only way in and nobody else has it.`,
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
          `If you did not ask for this, nothing has happened and you can ignore this message: ` +
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
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<void> {
    // Null firm (tenant did not resolve): the wording degrades, the send does not fail.
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work with";
    const subject =
      firm === null
        ? `You have been invited to a client portal`
        : `${firm} has invited you to their client portal`;
    const when = readableInstant(expiresAt, timeZone);

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
      ...checkWithText(who, sender ?? null),
    ].join("\n");

    return this.transport.send({
      to,
      // From the firm by name (CA#12, CA#40), or the client's Key Manager (Q059); see clientHeaders.
      ...clientHeaders(firm, sender ?? null),
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
        paragraph(checkWithHtml(who, sender ?? null)),
        fallback(url),
      ]),
    });
  }

  /**
   * The letter a new colleague gets: unasked, so written like the portal invite. Saying an
   * expired link is not a dead end (ask the sign-in page) is what makes the 72-hour life
   * affordable; a client's link lasts a week because a client has no login page to fall back on.
   */
  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    timeZone?: string | null,
    extra?: StaffWelcomeExtras,
  ): Promise<void> {
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work at";
    const subject =
      firm === null ? `You have been given access to ${PRODUCT}` : `${firm} has added you to ${PRODUCT}`;
    const when = readableInstant(expiresAt, timeZone);
    // Who added them (CA#50); header-safe because it is data like the firm's name.
    const adder = headerSafe(extra?.addedBy ?? null);
    const opening =
      adder === null
        ? { text: `${who} runs its practice on ${PRODUCT}, and has given you access with this`, html: `<strong>${esc(who)}</strong> runs its practice on ${esc(PRODUCT)}, and has given you access with this email address.` }
        : { text: `${adder} at ${firm ?? "your firm"} has given you access to ${PRODUCT} with this`, html: `<strong>${esc(adder)}</strong> at <strong>${esc(firm ?? "your firm")}</strong> has given you access to ${esc(PRODUCT)} with this email address.` };
    // The first password is chosen on this link (CA#38).
    const choose = extra?.choosePassword === true;
    const action = choose
      ? { line: `Open this link to choose your password and sign in:`, button: "Choose your password" }
      : { line: `Open this link to sign in:`, button: "Sign in" };

    const text = [
      opening.text,
      `email address.`,
      ``,
      action.line,
      url,
      ``,
      `Inside you will find the work that is yours, what is due and when, and the`,
      `clients you look after.`,
      ``,
      `The link works ONCE and stops working at ${when}. If it has expired by the`,
      `time you read this, nothing is lost: go to the sign-in page and ask for a`,
      `new link with this same address.`,
      ``,
      `If you were not expecting this, please check with your contact at`,
      `${who} rather than replying to this message.`,
    ].join("\n");

    return this.transport.send({
      to,
      // From the firm by name (CA#12); no firm known, the deployment's name.
      ...(firm === null ? {} : { fromName: firm }),
      subject,
      fromName: firm ?? undefined,
      text,
      html: page([
        paragraph(opening.html),
        button(url, action.button),
        paragraph(
          `Inside you will find the work that is yours, what is due and when, and the clients ` +
            `you look after.`,
        ),
        paragraph(
          `The link works <strong>once</strong> and stops working at ${esc(when)}. If it has ` +
            `expired by the time you read this, nothing is lost: go to the sign-in page and ` +
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
   * The portal letter when the address ALREADY HAS A LOGIN. Accounts are global (ADR-02), so a
   * set-password link would replace the password they use everywhere; this hands over a session
   * and says their password has not changed. Otherwise written like the invite.
   */
  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<void> {
    const firm = headerSafe(firmName);
    const who = firm ?? "The firm you work with";
    const subject =
      firm === null
        ? `You have been given access to a client portal`
        : `${firm} has given you access to their client portal`;
    const when = readableInstant(expiresAt, timeZone);

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
      `time you read this, nothing is lost: sign in as you normally do.`,
      ``,
      ...checkWithText(who, sender ?? null),
    ].join("\n");

    return this.transport.send({
      to,
      // As the invitation (CA#12, Q059).
      ...clientHeaders(firm, sender ?? null),
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
            `expired by the time you read this, nothing is lost: sign in as you normally do.`,
        ),
        paragraph(checkWithHtml(who, sender ?? null)),
        fallback(url),
      ]),
    });
  }

  /**
   * The password reset letter. Its last paragraph differs from sign-in's: a reader who did not
   * ask must learn their password still works while the link is left alone. Names no firm: the
   * account is global (ADR-02), so any one firm's name would mislead.
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
      `will happen as long as you leave this link alone: simply ignore this`,
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
            `nothing will happen as long as you leave this link alone: simply ignore this ` +
            `message. Nobody can read the link but you.`,
        ),
        fallback(url),
      ]),
    });
  }

  /**
   * The proposal (0085): PDF attached, firm named, replies to a person. The buttons do NOT
   * answer: mail filters open every link to scan it, so each opens the proposal's page with the
   * answer ready, confirmed there with a name.
   */
  sendProposal(letter: ProposalLetter): Promise<void> {
    const firm = headerSafe(letter.firmName) ?? "Your adviser";
    const ref = headerSafe(letter.ref) ?? letter.ref;
    const greeting = letter.greetingName === null ? "Hello," : `Dear ${letter.greetingName},`;
    const validity =
      letter.validUntil === null ? null : `It is valid until ${longDay(letter.validUntil)}.`;
    // Q059: from the SPOC (else the Key Manager), replies to them; else to the preparer.
    const sender = letter.sender;
    const replyTo = sender !== null ? (headerSafe(sender.name) ?? sender.email) : (letter.preparedBy ?? firm);
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
      ...(sender !== null
        ? clientHeaders(firm, sender)
        : { fromName: firm, ...(letter.replyTo === null ? {} : { replyTo: letter.replyTo }) }),
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

  /** Tells the proposal's preparer the client answered on its link (0085): who, which way, when, why. */
  sendDecisionNotice(notice: DecisionNotice): Promise<void> {
    const accepted = notice.decision === "accepted";
    const verb = accepted ? "accepted" : "declined";
    const client = headerSafe(notice.clientName) ?? "The client";
    const ref = headerSafe(notice.ref) ?? notice.ref;
    const when = readableInstant(notice.decidedAt, notice.timeZone);
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

    const firm = headerSafe(notice.firmName ?? null);
    return this.transport.send({
      to: notice.to,
      // From the firm (CA#12), not the deployment's name.
      ...(firm === null ? {} : { fromName: firm }),
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
   * Weekly advances summary to a firm's administrator (0322; Ashish: "once every week it should
   * escalate to ceo coo"). Firm in the subject (one person may administer two firms). Amounts
   * only for a fee-seeing reader; no client data beyond the Advances list.
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
      // From the firm (CA#12).
      ...(firm === null ? {} : { fromName: firm }),
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

  sendNotifications(letter: NotificationLetter): Promise<void> {
    const { subject, text, html } = notificationLetter(letter);
    return this.transport.send({ to: letter.to, subject, text, html });
  }
}

/**
 * Notifications by email (0324): urgent at once, the rest in a daily email. The words are the
 * bell's, already fee-redacted for this reader; this adds the frame, including the required
 * switch-off link.
 */
function notificationLetter(letter: NotificationLetter): { subject: string; text: string; html: string } {
  const firm = headerSafe(letter.firmName);
  const hello = headerSafe(letter.recipientName);
  const n = letter.items.length;
  const first = letter.items[0];
  const subjectCore =
    letter.mode === "instant"
      ? n === 1 && first !== undefined
        ? headerSafe(first.title) ?? "Urgent"
        : `${String(n)} urgent notifications`
      : n === 1
        ? "1 unread notification"
        : `${String(n)} unread notifications`;
  const intro =
    letter.mode === "instant"
      ? n === 1
        ? "This needs your attention:"
        : "These need your attention:"
      : n === 1
        ? "You have 1 unread notification:"
        : `You have ${String(n)} unread notifications:`;
  const footer =
    letter.mode === "instant"
      ? `You get these at once because they are urgent${firm === null ? "" : ` at ${firm}`}.`
      : `You get this once a day${firm === null ? "" : ` from ${firm}`} on ${PRODUCT}.`;

  const text = [
    hello === null ? "Hello," : `Hello ${hello},`,
    ``,
    intro,
    ``,
    ...letter.items.flatMap((i) => [`- ${i.title}${i.detail === null ? "" : ` (${i.detail})`}`, `  ${i.url}`]),
    ``,
    `All your notifications: ${letter.inboxUrl}`,
    ``,
    footer,
    `Choose which emails you get: ${letter.settingsUrl}`,
  ].join("\n");

  const html = page([
    paragraph(esc(hello === null ? "Hello," : `Hello ${hello},`)),
    paragraph(esc(intro)),
    `<ul style="margin:0 0 16px;padding-left:20px">` +
      letter.items
        .map(
          (i) =>
            `<li style="margin:0 0 10px"><a href="${esc(i.url)}" style="color:#7a1c2e;font-weight:600">${esc(i.title)}</a>` +
            (i.detail === null ? "" : `<br><span style="color:#555">${esc(i.detail)}</span>`) +
            `</li>`,
        )
        .join("") +
      `</ul>`,
    button(letter.inboxUrl, "Open your notifications"),
    paragraph(
      `<span style="font-size:13px;color:#666">${esc(footer)} ` +
        `<a href="${esc(letter.settingsUrl)}" style="color:#666">Choose which emails you get</a>.</span>`,
    ),
  ]);

  return { subject: `${subjectCore}${firm === null ? "" : ` · ${firm}`}`, text, html };
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
 * An ISO instant as words with the zone named; an email has no browser to ask the reader's zone.
 * A firm's letter uses the firm's zone, named in words ("19:35 India Standard Time", CA#50);
 * without one, or for UTC, it is UTC. Sign-in and reset letters (global account) pass none.
 */
function readableInstant(iso: string, timeZone?: string | null): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  if (timeZone !== undefined && timeZone !== null && timeZone !== "UTC" && timeZone !== "Etc/UTC") {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "long",
      }).formatToParts(at);
      const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
      return `${read("day")} ${read("month")} ${read("year")}, ${read("hour")}:${read("minute")} ${read("timeZoneName")}`;
    } catch {
      // A zone this runtime does not know: UTC, named, rather than no letter.
    }
  }
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
 * From name, From address and Reply-To of a letter to a CLIENT (Q059). With a sender:
 * "Priya Sharma, 10x Global", Reply-To Priya, her own From address only when her domain is on
 * the firm's list. Without one: the firm's name.
 */
function clientHeaders(
  firm: string | null,
  sender: ClientSender | null,
): Pick<Letter, "fromName" | "fromAddress" | "replyTo"> {
  if (sender === null) return firm === null ? {} : { fromName: firm };
  const person = headerSafe(sender.name);
  const name = headerSafe(senderDisplayName({ ...sender, name: person }, firm));
  return {
    ...(name === null ? {} : { fromName: name }),
    ...(sender.ownAddress ? { fromAddress: sender.email } : {}),
    replyTo: { name: person ?? sender.email, address: sender.email },
  };
}

/** The phishing guard at the foot of an unasked letter: check with the named person (Q059) on a channel already known, never via the letter. */
function checkWithText(who: string, sender: ClientSender | null): string[] {
  if (sender === null) {
    return [`If you were not expecting this, please check with your contact at`, `${who} before opening it, rather than replying to this message.`];
  }
  const person = headerSafe(sender.name) ?? sender.email;
  return [
    `If you were not expecting this, please check with ${person} at ${who},`,
    `on a number or address you already have, before opening it.`,
  ];
}

function checkWithHtml(who: string, sender: ClientSender | null): string {
  if (sender === null) {
    return (
      `If you were not expecting this, please check with your contact at ` +
      `${esc(who)} before opening it, rather than replying to this message.`
    );
  }
  const person = headerSafe(sender.name) ?? sender.email;
  return (
    `If you were not expecting this, please check with ${esc(person)} at ${esc(who)}, ` +
    `on a number or address you already have, before opening it.`
  );
}

/** Safe for a header: a newline in a tenant-supplied name could inject headers (a `Bcc:`). Blank means absent. */
function headerSafe(name: string | null): string | null {
  if (name === null) return null;
  const flat = name.replace(/[\r\n]+/g, " ").trim();
  return flat === "" ? null : flat;
}

/** HTML-escaped: an ampersand in a real company name must not become markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// HTML: inline styles only. No `<style>` (most clients drop it), no image (blocked by default),
// no web font, no script; it must survive Outlook, which renders with Word.

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

/** Two buttons on one line; the secondary is outlined, visible but not the obvious step. */
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

/** The link in full: a button is not copyable and some clients do not render one. */
function fallback(url: string): string {
  return (
    `<p style="margin:24px 0 0;font-size:13px;color:#666">` +
    `If the button does not work, copy this into your browser:<br>` +
    `<span style="word-break:break-all">${esc(url)}</span></p>`
  );
}
