// Deleting credentials that have stopped being credentials.
//
// ── WHY THIS IS ITS OWN MODULE AND NOT A METHOD ON IdentityService ──────────
//
// Because of who calls it. Every other thing `IdentityService` does happens
// inside a request — signing in, proving a session, switching org — and it is
// wired with a mailer, a password hasher, a token factory, a rate limiter and a
// ledger to do them. This runs on the WORKER, on a cron, with nobody waiting,
// and it needs exactly one repository. Building the whole service there to
// reach one method would make the sweep depend on a mail relay being
// configured.
//
// ── AND WHY DELETING IS RIGHT HERE, WHERE THE SCHEMA FORBIDS IT ELSEWHERE ───
//
// `bib_app` holds no DELETE grant on anything else, deliberately: a business
// fact that has been recorded is not the application's to remove. These two
// tables are not business facts. A session row is a live capability and a magic
// link is a key in an inbox; once expired, revoked or spent, neither is a
// record of anything — it is a key that no longer turns. The record of who
// signed in and when is `ledger.event`'s `session.started`, which has SELECT
// and INSERT and nothing else, checked at boot.
//
// Until migration 0075 there was no grant and therefore no sweep, and both
// tables grew forever.
import type { Clock } from "../../platform/clock";
import type { SessionRepository } from "./ports";

/**
 * How long a DEAD session or magic-link row is kept before this takes it.
 *
 * Not zero, and the reason is a support call rather than a rule: "why was I
 * signed out on Tuesday" is a real question, and the row is the only thing that
 * answers it — whether the session hit its absolute expiry, was revoked, or
 * simply sat unused past the idle timeout. Thirty days is long enough to have
 * that conversation and short enough that the table does not become an archive
 * of every key ever cut.
 */
export const CREDENTIAL_RETENTION_DAYS = 30;

export interface CredentialSweeperDeps {
  /** Only the sweep. Narrowed on purpose: this module has no business opening
   *  a session or revoking one. */
  readonly sessions: Pick<SessionRepository, "purgeExpired">;
  readonly clock: Clock;
}

export interface SweptCredentials {
  readonly sessions: number;
  readonly magicLinks: number;
}

export class CredentialSweeper {
  constructor(private readonly deps: CredentialSweeperDeps) {}

  /**
   * Remove everything that has been dead longer than the retention window.
   *
   * PLATFORM-WIDE and not per firm, which makes it unlike every other sweep on
   * the worker: sessions and magic links are global rows, because identity is
   * above tenant. So there is no per-firm loop and no one firm's failure to
   * isolate from another's.
   */
  async run(): Promise<SweptCredentials> {
    const before = new Date(
      this.deps.clock.now().getTime() - CREDENTIAL_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.deps.sessions.purgeExpired(before);
  }
}
