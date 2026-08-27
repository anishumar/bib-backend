// Flat ESLint config. Typed linting is on: the rules that actually catch bugs
// (no-floating-promises) need type information, so this is not optional.
//
// Three house rules encode conventions from CLAUDE.md that a reviewer would
// otherwise have to remember:
//   1. process.env is readable ONLY inside src/config — config is an adapter.
//   2. No TODO/FIXME/placeholder comments — finished code or an explicit stub.
//   3. console is banned outside the process shell (src/cmd) — use the logger.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // App code is linted with full type information. The root tooling configs
  // (build/test/lint/arch) are not app code and are excluded from typed linting.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
      ".dependency-cruiser.cjs",
      "*.config.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // No bandaids. An `any` is an unchecked hole in the type wall.
      "@typescript-eslint/no-explicit-any": "error",
      // An unawaited promise is a silent failure — the exact 3 a.m. bug.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // verbatimModuleSyntax needs type-only imports marked as such.
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The no-TODO merge gate, mechanically enforced.
      "no-warning-comments": [
        "error",
        { terms: ["todo", "fixme", "xxx", "hack", "placeholder"], location: "anywhere" },
      ],
      // The environment is an external system; only its adapter may read it.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "process.env is read only in src/config — config is an adapter. Inject typed values instead.",
        },
      ],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // config is the one place the environment is allowed to be touched.
  {
    files: ["src/config/**/*.ts"],
    rules: { "no-restricted-properties": "off" },
  },

  // The process shell and scripts may print and read env directly.
  {
    files: ["src/cmd/**/*.ts"],
    rules: { "no-console": "off" },
  },

  // Tests may print and may use loose types in fixtures.
  {
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
