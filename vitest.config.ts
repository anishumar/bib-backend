import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests use in-memory fakes and need no services. Integration tests
    // that need a real Postgres are named *.integration.test.ts and are run
    // explicitly (see package.json / CI), never mixed into the fast path.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
    environment: "node",
    globals: false,
  },
});
