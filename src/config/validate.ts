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
