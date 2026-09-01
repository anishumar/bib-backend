// One fact, written in two places that cannot import each other.
//
// A firm's role rows come from DEFAULT_ROLES (src/domain/authz/model.ts) when
// the tenant is created, and from a jsonb literal in a migration for the firms
// that already existed. SQL cannot import TypeScript, so the duplication is
// unavoidable — but the DRIFT is not.
//
// Drift here is quiet and expensive: add a permission to a default role in the
// code and firms created before that change simply never get it, and nothing
// fails. So a migration marks its literal and this test reads it back.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES } from "../../src/domain/authz/model";

const MIGRATIONS = "migrations";
const MARKER = "@default-roles-seed";

interface SeededRole {
  label: string;
  permissions: string[];
  audience?: string;
}

/**
 * The role seed from the NEWEST migration that carries one.
 *
 * Newest, not 0005 — and that distinction is the point. Changing a default role
 * is not only a code edit: every existing tenant already holds its roles as
 * rows, and a published config version is frozen, so bringing those firms
 * forward means a NEW migration publishing a new version. A test pinned to 0005
 * would make that correct fix look like a regression, and the tempting way out
 * of a red build would be to edit an applied migration.
 *
 * The rule enforced here is therefore: **the latest seed and DEFAULT_ROLES
 * agree**. Add a permission to a default role and the build stays red until a
 * migration carries it to the firms that already exist.
 */
function newestSeed(): { file: string; roles: Record<string, SeededRole> } {
  const carriers = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".up.sql"))
    .filter((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8").includes(MARKER))
    .sort(); // NNNN_ prefixes are zero-padded, so lexicographic IS numeric

  const file = carriers.at(-1);
  if (file === undefined) {
    throw new Error(
      `no migration in ${MIGRATIONS}/ carries a line marked ${MARKER}. It is what binds the ` +
        `seeded roles to DEFAULT_ROLES; restore the marker rather than deleting this test.`,
    );
  }

  // The marker line is a single SQL line ending in a comment, so the literal is
  // everything between the first quote and the `'::jsonb` that closes it.
  const line = readFileSync(`${MIGRATIONS}/${file}`, "utf8")
    .split("\n")
    .find((l) => l.includes(MARKER));
  if (line === undefined) throw new Error(`${file} lost its ${MARKER} line mid-read`);
  const start = line.indexOf("'");
  const end = line.indexOf("'::jsonb");
  if (start === -1 || end <= start) {
    throw new Error(`could not find the jsonb literal on the ${MARKER} line of ${file}`);
  }
  return { file, roles: JSON.parse(line.slice(start + 1, end)) as Record<string, SeededRole> };
}

describe("the newest role-seed migration matches the roles the code defines", () => {
  const { file, roles: seeded } = newestSeed();

  it("has a migration that is currently authoritative", () => {
    // Asserted so a failure below has already named the file that must change,
    // rather than leaving someone to go and find it.
    expect(file, "the newest migration carrying a role seed").toMatch(/^\d{4}_.*\.up\.sql$/);
  });

  it("seeds the same set of roles", () => {
    expect(Object.keys(seeded).sort(), `roles in ${file}`).toEqual(
      Object.keys(DEFAULT_ROLES).sort(),
    );
  });

  it("gives each role the same permissions", () => {
    for (const [key, definition] of Object.entries(DEFAULT_ROLES)) {
      expect(seeded[key]?.permissions.slice().sort(), `permissions for ${key} in ${file}`).toEqual(
        [...definition.permissions].sort(),
      );
    }
  });

  it("gives each role the same label", () => {
    for (const [key, definition] of Object.entries(DEFAULT_ROLES)) {
      expect(seeded[key]?.label, `label for ${key} in ${file}`).toBe(definition.label);
    }
  });

  it("gives each role the same AUDIENCE, absence included", () => {
    // T6.6's field, and the ABSENCE is asserted as hard as the value. A staff
    // role's body has no `audience` key at all — `readRoleAudience` reads that as
    // STAFF — and writing one in would change the body of every staff role, which
    // is exactly what the role-upgrade migrations compare against to tell a firm
    // that has never edited a role from one that has. Seeding `"audience":
    // "STAFF"` would make every firm on earth look like it had made a decision.
    for (const [key, definition] of Object.entries(DEFAULT_ROLES)) {
      expect(seeded[key]?.audience, `audience for ${key} in ${file}`).toBe(definition.audience);
    }
  });

  it("seeds a role that can administer the firm", () => {
    // Without one, a firm comes out of the migration unable to change its own
    // configuration, permanently.
    const admins = Object.entries(seeded).filter(([, r]) =>
      r.permissions.includes("tenant:admin"),
    );
    expect(admins.length, `roles carrying tenant:admin in ${file}`).toBeGreaterThan(0);
  });
});
