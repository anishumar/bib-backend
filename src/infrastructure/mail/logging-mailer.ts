// The only registered Mailer, and it does not send email — it writes the link
// to the log so a developer can click it.
//
// HONEST REGISTRY (the same rule as the dev principal resolver): a fake that
// pretends to be real is worse than no implementation, so this one says what it
// is, and `validateServer` refuses to boot a production-like environment that
// has it wired. The real transport (platform notifications / SES / Postmark) is
// a second adapter behind this same port; nothing in the use case changes when
// it arrives.
import type { Logger } from "../../platform/log";
import type { Mailer } from "../../usecase/identity/ports";

export class LoggingMailer implements Mailer {
  constructor(private readonly log: Logger) {}

  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void> {
    this.log.warn(
      { to, url, expiresAt },
      "magic link NOT emailed — the logging mailer is registered. Open the url above to sign in.",
    );
    return Promise.resolve();
  }

  sendPortalInvite(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    this.log.warn(
      { to, url, expiresAt, firmName },
      "portal invite NOT emailed — the logging mailer is registered. Open the url above to " +
        "set the password. NOTE: the person on the other end of `to` is a CLIENT, not a " +
        "colleague, so this one silently not arriving is a client who cannot get in.",
    );
    return Promise.resolve();
  }

  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    this.log.warn(
      { to, url, expiresAt, firmName },
      "staff welcome NOT emailed — the logging mailer is registered. Open the url above to " +
        "sign in as them. This is the LEAST damaging of the three to lose: a colleague can " +
        "still get a fresh link from the login page, which is what they had to do before this " +
        "letter existed.",
    );
    return Promise.resolve();
  }
}
