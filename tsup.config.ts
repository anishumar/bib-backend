import { defineConfig } from "tsup";

// Build with esbuild: no per-import .js extension tax, fast, one runnable
// output tree. tsc is typecheck-only (noEmit); tsup produces the artifact.
export default defineConfig({
  // Every process this repo ships. The worker (T2.6) is a SECOND deployable —
  // a build that omitted it would produce a dist nobody notices is incomplete
  // until the scheduler silently never runs in an environment.
  // NAMED OUTPUTS, not a bare list. With an array, esbuild takes the common
  // ancestor of every entry as the outbase — all four live in src/cmd, so that
  // ancestor IS src/cmd and the build emitted a FLAT dist/server.js. Meanwhile
  // package.json's `start` and `worker:start` both say dist/cmd/, so `npm start`
  // has never worked against a real build; nothing caught it because dev runs
  // tsx and CI runs `check`, which never builds. The map states the output path
  // instead of deriving it, so the two cannot drift apart again.
  entry: {
    "cmd/server": "src/cmd/server.ts",
    "cmd/migrate": "src/cmd/migrate.ts",
    "cmd/worker": "src/cmd/worker.ts",
    "cmd/worker-once": "src/cmd/worker-once.ts",
  },
  format: ["esm"],
  // Matches package.json engines. Raised from node20 with pg-boss, which needs
  // >=22.12 — and Node 20 left maintenance in April 2026.
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
