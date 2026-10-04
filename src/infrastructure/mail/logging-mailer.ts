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
import type {
  DecisionNotice,
  ProposalLetter,
  ProposalMailer,
} from "../../usecase/proposal/ports";
import type { AdvanceDigestLetter, BillingMailer } from "../../usecase/billing/ports";

export class LoggingMailer implements Mailer, ProposalMailer, BillingMailer {
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

  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    this.log.warn(
      { to, url, expiresAt, firmName },
      "portal welcome NOT emailed — the logging mailer is registered. Open the url above to " +
        "sign in as them. This is the letter a client contact gets when the address already " +
        "has a login somewhere else on this product, so it hands over a SESSION and leaves " +
        "their existing password alone.",
    );
    return Promise.resolve();
  }

  sendPasswordReset(to: string, url: string, expiresAt: string): Promise<void> {
    this.log.warn(
      { to, url, expiresAt },
      "password reset NOT emailed — the logging mailer is registered. Open the url above to " +
        "choose a new password. NOTE: whoever opens it BECOMES that person — this link " +
        "replaces the credential, so a log this one lands in is a log that hands out " +
        "accounts. It is the third of the four that is never acceptable in public, and " +
        "`validateServer` refuses to boot a production-like environment with this mailer " +
        "wired for exactly that reason.",
    );
    return Promise.resolve();
  }

  sendProposal(letter: ProposalLetter): Promise<void> {
    this.log.warn(
      {
        to: letter.to,
        replyTo: letter.replyTo,
        ref: letter.ref,
        viewUrl: letter.viewUrl,
        acceptUrl: letter.acceptUrl,
        declineUrl: letter.declineUrl,
        pdf: `${letter.pdf.filename} (${String(letter.pdf.bytes.byteLength)} bytes)`,
      },
      "proposal NOT emailed — the logging mailer is registered. Open acceptUrl or declineUrl to " +
        "answer it as the client would. NOTE: the person on the other end of `to` is a CLIENT " +
        "who has been told nothing, and the page records this as sent to them.",
    );
    return Promise.resolve();
  }

  sendDecisionNotice(notice: DecisionNotice): Promise<void> {
    this.log.warn(
      { to: notice.to, ref: notice.ref, decision: notice.decision, proposalUrl: notice.proposalUrl },
      "proposal answer notice NOT emailed — the logging mailer is registered. The colleague " +
        "who prepared it will see the answer on the proposal's page, and nowhere else.",
    );
    return Promise.resolve();
  }

  sendAdvanceDigest(letter: AdvanceDigestLetter): Promise<void> {
    this.log.warn(
      { to: letter.to, weekOf: letter.weekOf, advances: letter.rows.length, advancesUrl: letter.advancesUrl },
      "weekly advance summary NOT emailed — the logging mailer is registered. The administrator " +
        "still sees each advance as escalated on My day.",
    );
    return Promise.resolve();
  }
}
