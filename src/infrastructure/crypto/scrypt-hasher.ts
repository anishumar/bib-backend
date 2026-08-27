// Password hashing, implemented with node's built-in scrypt. No dependency:
// the reference implementation reaches for bcryptjs, which is pure JavaScript
// (so slow in the wrong way — slow to run, not slow to attack) and silently
// truncates passwords past 72 bytes. scrypt is memory-hard, which is what
// actually costs a GPU attacker.
//
// The encoded form carries its own parameters:
//
//     scrypt$N$r$p$<salt base64>$<hash base64>
//
// so the cost can be raised later without invalidating a single existing
// password — an old hash still verifies with the parameters it was made with.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PasswordHasher } from "../../usecase/identity/ports";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// N=2^15 with r=8 costs ~32 MB and a few tens of milliseconds per hash. That is
// the honest middle of the range: OWASP's higher settings (2^17, ~128 MB) are
// better against an attacker and worse against a login stampede on a small box.
// Raise these when the deployment can afford it — old hashes keep working.
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const MAXMEM = 128 * 1024 * 1024; // node's 32 MB default is below what N=2^15 needs
const KEYLEN = 64;
const SALT_BYTES = 16;

/** A well-formed hash that no password matches. Used on the unknown-email path
 *  so that failing costs the same as succeeding — see PasswordHasher.dummyHash. */
const DUMMY =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "kUH4KHw1gkJlejeteiVa6cAWh4ycNFkpu9AO3ncO7t+EdGczqWNcH1brzMzXFq2eElv2cuXVITgq6YXAxwd7Ag==";

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scryptAsync(plain, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
    return [
      "scrypt",
      String(PARAMS.N),
      String(PARAMS.r),
      String(PARAMS.p),
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  /** Returns false for anything it cannot parse. A corrupt or hand-edited row
   *  must deny access, not crash the login route — the failure mode of a
   *  throwing verifier is a 500 that tells an attacker they found something. */
  async verify(plain: string, encoded: string): Promise<boolean> {
    const parsed = parse(encoded);
    if (!parsed) return false;
    try {
      const derived = await scryptAsync(plain, parsed.salt, parsed.hash.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: MAXMEM,
      });
      return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
    } catch {
      return false;
    }
  }

  dummyHash(): string {
    return DUMMY;
  }
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): Parsed | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, hash] = parts;
  if (n === undefined || r === undefined || p === undefined || salt === undefined || hash === undefined) {
    return null;
  }
  const parsed = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, "base64"),
    hash: Buffer.from(hash, "base64"),
  };
  const positiveInts = [parsed.N, parsed.r, parsed.p].every(
    (v) => Number.isInteger(v) && v > 0,
  );
  if (!positiveInts || parsed.salt.length === 0 || parsed.hash.length === 0) return null;
  return parsed;
}
