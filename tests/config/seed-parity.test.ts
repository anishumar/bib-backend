// One fact, written in two places that cannot import each other.
//
// A firm's role rows come from DEFAULT_ROLES (src/domain/authz/model.ts) when
// the tenant is created, and from a jsonb literal in migration 0005 for the
// firms that already existed when the registry landed. SQL cannot import
// TypeScript, so the duplication is unavoidable — but the DRIFT is not.
//
// Drift here is quiet and expensive: add a permission to a default role in the
// code and firms created before 0005 simply never get it, and nothing fails.
// So the migration marks its literal and this test reads it back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES } from "../../src/domain/authz/model";

const MIGRATION = "migrations/0005_config.up.sql";
const MARKER = "@default-roles-seed";

interface SeededRole {
  label: string;
  permissions: string[];
}

/** The jsonb literal the migration seeds, parsed. The marker line is a single
 *  SQL line ending in a comment, so the literal is everything between the first
 *  quote and the `'::jsonb` that closes it. */
function seededRoles(): Record<string, SeededRole> {
  const line = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .find((l) => l.includes(MARKER));
  if (line === undefined) {
    throw new Error(
      `${MIGRATION} no longer has a line marked ${MARKER}. It is what binds the migration's ` +
        `seeded roles to DEFAULT_ROLES; restore the marker rather than deleting this test.`,
    );
  }
  const start = line.indexOf("'");
  const end = line.indexOf("'::jsonb");
  if (start === -1 || end <= start) {
    throw new Error(`could not find the jsonb literal on the ${MARKER} line of ${MIGRATION}`);
  }
  return JSON.parse(line.slice(start + 1, end)) as Record<string, SeededRole>;
}

describe("the migration seeds exactly the roles the code does", () => {
  const seeded = seededRoles();

  it("seeds the same set of roles", () => {
    expect(Object.keys(seeded).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
  });

  it("gives each role the same permissions", () => {
    for (const [key, definition] of Object.entries(DEFAULT_ROLES)) {
      expect(seeded[key]?.permissions.slice().sort(), `permissions for ${key}`).toEqual(
        [...definition.permissions].sort(),
      );
    }
  });

  it("gives each role the same label", () => {
    for (const [key, definition] of Object.entries(DEFAULT_ROLES)) {
      expect(seeded[key]?.label, `label for ${key}`).toBe(definition.label);
    }
  });

  it("seeds a role that can administer the firm", () => {
    // Without one, every firm created before 0005 would come out of the
    // migration unable to change its own configuration, permanently.
    const admins = Object.entries(seeded).filter(([, r]) =>
      r.permissions.includes("tenant:admin"),
    );
    expect(admins.length).toBeGreaterThan(0);
  });
});
