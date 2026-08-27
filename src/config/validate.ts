// Boot validators. Loading config is boring; refusing to boot is the valuable
// part. Each check crashes with an actionable message — the variable, the bad
// value, and what was expected — because crash-loop beats silent degradation.
import type { Config } from "./config";
import { isProductionLike } from "./config";

/** Run before the server accepts traffic. Throws on any unbootable state. */
export function validateServer(cfg: Config): void {
  if (isProductionLike(cfg)) {
    if (looksLocal(cfg.db.appUrl)) {
      throw new Error(
        `BIB_APP_DATABASE_URL points at localhost while BIB_ENVIRONMENT=${cfg.environment} ` +
          `(production-like). A public environment must use real infrastructure.`,
      );
    }
    if (cfg.db.appPassword.length === 0) {
      throw new Error(
        `BIB_APP_DATABASE_URL has no password while BIB_ENVIRONMENT=${cfg.environment}. ` +
          `The app role must authenticate in a production-like environment.`,
      );
    }

    // THE HONEST REGISTRY, enforced. The dev resolver accepts an x-user-id
    // header as proof of identity — it is a hole with a lock on it, and the
    // lock is this check. A public environment that boots with it is one header
    // away from anyone being anyone.
    if (cfg.auth.devAuthEnabled) {
      throw new Error(
        `BIB_DEV_AUTH_ENABLED is true while BIB_ENVIRONMENT=${cfg.environment} ` +
          `(production-like). The dev resolver trusts an x-user-id header as proof of ` +
          `identity, which is not authentication. Set BIB_DEV_AUTH_ENABLED=false.`,
      );
    }

    // Same rule, applied to notifications: the only registered mailer writes
    // magic links to the log instead of sending them. Booting with it in a
    // public environment would mean sign-in links appear in log aggregation
    // and never reach the user.
    if (cfg.auth.mailTransport === "log") {
      throw new Error(
        `BIB_MAIL_TRANSPORT=log while BIB_ENVIRONMENT=${cfg.environment} (production-like). ` +
          `The logging mailer does not send email — it prints the sign-in link. Register a real ` +
          `transport (infrastructure/mail) and set BIB_MAIL_TRANSPORT to it before deploying.`,
      );
    }
  }
}

function looksLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
