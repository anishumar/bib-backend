// Which mailer a process registers (T7.0), shared by the API and the worker.
//
// The worker held no mailer until 0322: the weekly summary of pending advances
// to a firm's administrators is the first letter a sweep sends, so it needs the
// same transport the API has, built the same way.
import type { Config } from "../config/config";
import type { Logger } from "../platform/log";
import { LoggingMailer } from "../infrastructure/mail/logging-mailer";
import { SmtpMailer } from "../infrastructure/mail/smtp-mailer";
import { NodemailerTransport } from "../infrastructure/mail/nodemailer-transport";
import type { Mailer } from "../usecase/identity/ports";
import type { ProposalMailer } from "../usecase/proposal/ports";
import type { BillingMailer } from "../usecase/billing/ports";
import type { NotificationMailer } from "../usecase/notify/ports";

/**
 * Which mailer is registered, and the ONLY place that decides.
 *
 * The honest registry's shape, applied to notifications: the stub says what it
 * is, `validateServer` refuses it in a public environment, and the real one is
 * a second adapter behind the same port. `logging-mailer.ts` predicted exactly
 * this — *"nothing in the use case changes when it arrives"* — and nothing did:
 * `IdentityService` is untouched by the swap.
 *
 * The config → adapter mapping happens HERE because an adapter never imports
 * the config module. `NodemailerTransport` declares the connection shape it
 * needs and this function fills it in, the same arrangement
 * `FilesystemBlobStore(cfg.storage.root)` already has.
 *
 * The null branches are unreachable by the time this runs — `validateServer`
 * has already refused `smtp` without a host or a From address, naming the
 * variable. They are here because the TYPE says nullable and a non-null
 * assertion would be a claim this file cannot make on its own.
 */
export function mailerFor(cfg: Config, log: Logger): Mailer & ProposalMailer & BillingMailer & NotificationMailer {
  if (cfg.auth.mailTransport === "log") return new LoggingMailer(log);
  const { smtp, from, fromName } = cfg.mail;
  if (smtp === null || from === null) {
    throw new Error(
      "BIB_MAIL_TRANSPORT=smtp without BIB_SMTP_HOST or BIB_MAIL_FROM. validateServer should " +
        "have refused this configuration before wiring — if you are seeing this, that check " +
        "was skipped or removed.",
    );
  }
  return new SmtpMailer(
    new NodemailerTransport(
      {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: smtp.user,
        password: smtp.password,
      },
      { address: from, name: fromName },
      log,
    ),
  );
}
