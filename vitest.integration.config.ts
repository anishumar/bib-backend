import { defineConfig } from "vitest/config";

// Integration tests run against a REAL, migrated Postgres — they prove the
// properties no fake can: that RLS isolates, and that the audit ledger cannot
// be changed. They are a separate config (and a separate command) so the
// default `npm test` stays service-free and fast, and so a missing database
// fails loudly here rather than silently skipping the checks that matter.
//
// Run: npm run migrate && npm run test:integration
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    environment: "node",
    globals: false,
    // One database, shared state, DDL-level assertions: these must not race.
    fileParallelism: false,
  },
});
