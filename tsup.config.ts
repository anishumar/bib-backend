import { defineConfig } from "tsup";

// Build with esbuild: no per-import .js extension tax, fast, one runnable
// output tree. tsc is typecheck-only (noEmit); tsup produces the artifact.
export default defineConfig({
  // Every process this repo ships. The worker (T2.6) is a SECOND deployable —
  // a build that omitted it would produce a dist nobody notices is incomplete
  // until the scheduler silently never runs in an environment.
  entry: [
    "src/cmd/server.ts",
    "src/cmd/migrate.ts",
    "src/cmd/worker.ts",
    "src/cmd/worker-once.ts",
  ],
  format: ["esm"],
  // Matches package.json engines. Raised from node20 with pg-boss, which needs
  // >=22.12 — and Node 20 left maintenance in April 2026.
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
