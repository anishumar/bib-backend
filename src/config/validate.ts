// Boot validators. Loading config is boring; refusing to boot is the valuable
// part. Each check crashes with an actionable message — the variable, the bad
// value, and what was expected — because crash-loop beats silent degradation.
import type { Config } from "./config";
import { isProductionLike } from "./config";
import { IDENTITY_GRANTING } from "../api/capabilities";

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

    // The committed example value is public. Booting a public environment with
    // it would leave the provisioning API — create tenants, grant memberships,
    // set any user's password — open to anyone who has read the repo.
    const exampleKeys = cfg.auth.internalClients.filter((c) => c.key === EXAMPLE_INTERNAL_KEY);
    if (exampleKeys.length > 0) {
      throw new Error(
        `BIB_INTERNAL_KEYS still uses the key from .env.example (client ` +
          `${exampleKeys.map((c) => JSON.stringify(c.name)).join(", ")}) while ` +
          `BIB_ENVIRONMENT=${cfg.environment} (production-like). That value is committed and ` +
          `public. Generate one per client: openssl rand -hex 32`,
      );
    }

    // Setting a password hands over a LOGIN AS somebody. Held next to
    // user.provision and membership.grant it completes an escalation path:
    // create a user, grant them partner in any firm, set their password, sign
    // in as them. Three calls with one key. So in a public environment it lives
    // on a key of its own, held by fewer systems and rotated on its own clock.
    const overloaded = cfg.auth.internalClients.filter(
      (c) => c.capabilities.includes(IDENTITY_GRANTING) && c.capabilities.length > 1,
    );
    if (overloaded.length > 0) {
      throw new Error(
        `BIB_INTERNAL_KEYS: client ${overloaded.map((c) => JSON.stringify(c.name)).join(", ")} ` +
          `holds ${IDENTITY_GRANTING} alongside other capabilities while ` +
          `BIB_ENVIRONMENT=${cfg.environment} (production-like). Setting a password grants a ` +
          `login as that person; combined with user.provision and membership.grant it is a full ` +
          `escalation path. Give ${IDENTITY_GRANTING} its own client and key.`,
      );
    }

    // CORS with credentials is the one place a wildcard is catastrophic rather
    // than merely sloppy: it would let ANY site make authenticated requests
    // with the user's session cookie and read the answers. Browsers refuse the
    // combination, so this would fail at runtime anyway — failing at boot with
    // the reason is better than a frontend that mysteriously cannot log in.
    if (cfg.cors.origins.includes("*")) {
      throw new Error(
        `BIB_CORS_ORIGINS contains "*" while BIB_ENVIRONMENT=${cfg.environment}. ` +
          `A wildcard cannot be combined with credentialed requests: list exact origins.`,
      );
    }
    if (cfg.cors.origins.length === 0) {
      throw new Error(
        `BIB_CORS_ORIGINS is empty while BIB_ENVIRONMENT=${cfg.environment}. No browser ` +
          `origin could call this API. Set it to the frontend's origin, e.g. https://app.example.com`,
      );
    }
    const insecure = cfg.cors.origins.filter(
      (o) => o.startsWith("http://") || o.includes("localhost"),
    );
    if (insecure.length > 0) {
      throw new Error(
        `BIB_CORS_ORIGINS contains ${insecure.join(", ")} while ` +
          `BIB_ENVIRONMENT=${cfg.environment} (production-like). A session cookie is Secure ` +
          `there and will not be sent to a plain-http origin, and a localhost origin in a ` +
          `public environment means someone's laptop can call this API with a real session.`,
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

    // The THIRD stub, and it gets the same treatment as the first two — which
    // is the rule CLAUDE.md's honest registry states, not a convention.
    //
    // `attested` records that a member of staff says the client signed. That is
    // a real product behaviour and it is how most firms in this market sign
    // today, but it is not a signature: nothing in it can be verified against
    // the client. An engagement letter creates obligations, so a public
    // environment must not rely on a colleague's word for one.
    if (cfg.auth.esignProvider === "attested") {
      throw new Error(
        `BIB_ESIGN_PROVIDER=attested while BIB_ENVIRONMENT=${cfg.environment} ` +
          `(production-like). The attested signer records that somebody at the firm SAYS the ` +
          `client signed; it cannot prove it, and an engagement letter creates obligations. ` +
          `Register a real provider (infrastructure/esign) and set BIB_ESIGN_PROVIDER to it ` +
          `before deploying.`,
      );
    }
  }
}

/** The value committed in .env.example — safe locally, never anywhere public. */
const EXAMPLE_INTERNAL_KEY = "local-dev-internal-key-not-for-any-real-environment";

function looksLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
