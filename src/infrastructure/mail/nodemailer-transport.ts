// The only file in this product that knows what SMTP is.
//
// ── WHY SMTP AND NOT A VENDOR SDK ────────────────────────────────────────────
//
// Google Workspace, Microsoft 365, Amazon SES and Postmark all speak it. A firm
// in this market already has one of those and already has a mailbox, so plain
// SMTP means the transport is a handful of environment variables rather than an
// integration — and changing provider later changes `.env`, not this file. A
// vendor SDK would have bought nothing except a rewrite the first time somebody
// switched.
//
// What it deliberately does NOT do: templates, tracking pixels, open rates,
// suppression lists, retries. A letter here is a sign-in link or an invite —
// both are transactional, both are useless if late, and there is nothing to
// analyse. When bulk sending arrives (P10 transport, the chaser and the nudge)
// it will want a different adapter with a queue behind it, and it should be a
// second implementation of `MailTransport` rather than complexity added here.
import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Logger } from "../../platform/log";
import type { Letter, MailTransport } from "./smtp-mailer";

/** What this adapter needs to reach a relay. Mirrors `SmtpConfig` in
 *  `config/config.ts` and is declared HERE on purpose: an adapter never imports
 *  the config module — `setup/` maps one to the other, the way it already does
 *  for the blob store's root path. */
export interface SmtpConnection {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (465). False means STARTTLS, which
   *  nodemailer still negotiates on 587 — it is not "no encryption". */
  readonly secure: boolean;
  readonly user: string | null;
  readonly password: string | null;
}

export interface Sender {
  readonly address: string;
  readonly name: string | null;
}

export class NodemailerTransport implements MailTransport {
  private readonly mailer: Transporter;

  constructor(
    connection: SmtpConnection,
    private readonly from: Sender,
    private readonly log: Logger,
  ) {
    this.mailer = createTransport({
      host: connection.host,
      port: connection.port,
      secure: connection.secure,
      // Null is a real answer, not a missing value: a relay inside a private
      // network may accept mail from this host with no login at all. Passing
      // `auth: { user: null }` would make nodemailer try to authenticate with
      // nothing and be rejected, so the key is absent instead of empty.
      ...(connection.user === null || connection.password === null
        ? {}
        : { auth: { user: connection.user, pass: connection.password } }),
    });
  }

  /**
   * Hand the letter over, and SAY SO LOUDLY if the relay would not take it.
   *
   * The log line is here rather than in a caller because this is the only place
   * that knows a send failed at all: `IdentityService.requestMagicLink`
   * deliberately swallows the rejection so that "no such account" and "the mail
   * server is down" answer identically, and without this line that swallow
   * would make a broken relay completely silent — a user told to check their
   * email, forever, and nobody at the firm any the wiser.
   *
   * It still rethrows. The invite path is entitled to fail loudly: a member of
   * the firm is watching a screen and needs to know the client was not written
   * to.
   */
  async send(letter: Letter): Promise<void> {
    try {
      await this.sendOrThrow(letter);
    } catch (err) {
      this.log.error(
        // The recipient and the subject, never the body — a magic link in an
        // operator's log is a sign-in anybody with log access can complete.
        { to: letter.to, subject: letter.subject, err },
        "mail was NOT sent — the SMTP relay rejected it or was unreachable",
      );
      throw err;
    }
  }

  private async sendOrThrow(letter: Letter): Promise<void> {
    // A letter may send under its own display name — a proposal goes out as
    // the FIRM (0085) — but never from its own address: the address is the
    // one this relay authenticates.
    const name = letter.fromName ?? this.from.name;
    await this.mailer.sendMail({
      // The name is optional and the address never is. nodemailer quotes the
      // display name itself, which is what keeps a comma or a quote in a firm's
      // name from breaking the header.
      from: name === null ? this.from.address : { name, address: this.from.address },
      to: letter.to,
      ...(letter.replyTo === undefined ? {} : { replyTo: letter.replyTo }),
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
      ...(letter.attachments === undefined
        ? {}
        : {
            attachments: letter.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              content: Buffer.from(a.content),
            })),
          }),
    });
  }
}
