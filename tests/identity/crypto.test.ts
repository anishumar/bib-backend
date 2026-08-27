// The real crypto adapters, exercised for real — the unit suite elsewhere uses
// a fake hasher, so this is the only place the actual scrypt path runs. It is
// the slowest file in the suite by a wide margin, and deliberately small.
import { describe, expect, it } from "vitest";
import { ScryptPasswordHasher } from "../../src/infrastructure/crypto/scrypt-hasher";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";

const hasher = new ScryptPasswordHasher();
const PASSWORD = "correct horse battery staple";

describe("ScryptPasswordHasher", () => {
  it("round-trips a password", async () => {
    const encoded = await hasher.hash(PASSWORD);
    expect(await hasher.verify(PASSWORD, encoded)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const encoded = await hasher.hash(PASSWORD);
    expect(await hasher.verify("Correct horse battery staple", encoded)).toBe(false);
  });

  it("salts — the same password hashes differently every time", async () => {
    expect(await hasher.hash(PASSWORD)).not.toBe(await hasher.hash(PASSWORD));
  });

  it("carries its parameters, so the cost can be raised later", async () => {
    const encoded = await hasher.hash(PASSWORD);
    const [algorithm, n, r, p] = encoded.split("$");
    expect(algorithm).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
  });

  it("does not use a 72-byte-truncating algorithm", async () => {
    // bcrypt silently ignores everything past 72 bytes, which quietly turns two
    // different long passphrases into the same credential.
    const long = "a".repeat(100);
    const encoded = await hasher.hash(long);
    expect(await hasher.verify(`${"a".repeat(72)}different`, encoded)).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    // A corrupt or hand-edited row must deny access, not 500 — a throwing
    // verifier tells an attacker they found something interesting.
    for (const bad of ["", "not-a-hash", "scrypt$$$$", "bcrypt$1$2$3$4$5", "scrypt$0$8$1$c2E=$aGk="]) {
      expect(await hasher.verify(PASSWORD, bad)).toBe(false);
    }
  });

  it("has a dummy hash that parses but matches nothing", async () => {
    // The login path verifies against this for an unknown email, so it must be
    // real work: if it failed to parse, verify would return early and the
    // timing difference would be the oracle it exists to remove.
    const dummy = hasher.dummyHash();
    expect(dummy.split("$")).toHaveLength(6);
    expect(await hasher.verify(PASSWORD, dummy)).toBe(false);
    expect(await hasher.verify("", dummy)).toBe(false);
  });
});

describe("RandomTokenFactory", () => {
  const tokens = new RandomTokenFactory();

  it("issues url-safe tokens that never repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => tokens.newToken()));
    expect(seen.size).toBe(200);
    for (const token of seen) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const token = tokens.newToken();
    expect(tokens.hash(token)).toBe(tokens.hash(token));
    expect(tokens.hash(token)).not.toBe(token);
    expect(tokens.hash(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
