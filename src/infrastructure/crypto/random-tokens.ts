// Bearer tokens for sessions and magic links.
//
// 32 bytes from the OS CSPRNG — 256 bits, which is not guessable and not worth
// discussing further. What is worth discussing is that only the SHA-256 DIGEST
// is ever stored: a leaked database (or a query log, or a backup on a laptop)
// then contains no token anyone can present. That is why this is a token
// factory and not a uuid.
//
// SHA-256 is correct here and would be wrong for a password: these tokens are
// already full-entropy random, so there is nothing for a slow hash to protect
// against — no dictionary, no reuse across sites, nothing to guess.
import { createHash, randomBytes } from "node:crypto";
import type { TokenFactory } from "../../usecase/identity/ports";
import type { ContentHasher } from "../../usecase/engagement/ports";

const TOKEN_BYTES = 32;

/**
 * SHA-256 over arbitrary content — the engagement letter's canonical rendering.
 *
 * Its own class rather than a method on the token factory, because the two want
 * different things: a token digest protects a secret, this one commits to a
 * document. Same primitive, different contract, and a shared class would
 * eventually tempt somebody to "improve" one and break the other.
 */
export class Sha256ContentHasher implements ContentHasher {
  hash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }
}

export class RandomTokenFactory implements TokenFactory {
  newToken(): string {
    return randomBytes(TOKEN_BYTES).toString("base64url");
  }

  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
