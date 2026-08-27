import { defineConfig } from "tsup";

// Build with esbuild: no per-import .js extension tax, fast, one runnable
// output tree. tsc is typecheck-only (noEmit); tsup produces the artifact.
export default defineConfig({
  entry: ["src/cmd/server.ts", "src/cmd/migrate.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
