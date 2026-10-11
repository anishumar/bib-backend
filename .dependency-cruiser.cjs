/**
 * The architecture wall — dependency-cruiser is our "archtest".
 *
 * The one rule of hexagonal design: imports point inward. This file makes that
 * rule executable. `npm run arch` (and the arch test in tests/architecture)
 * turns any violation into a red build that names the file and the rule — so
 * neither a developer nor their AI can quietly route around a boundary.
 *
 * Layers, most abstract to most concrete:
 *   domain  ->  usecase  ->  api / infrastructure  ->  setup  ->  cmd
 * A package may only depend on things above it. The db pool is a special case:
 * it is the tenant wall's single door, reachable only through the resolver.
 *
 * tsPreCompilationDeps:true means type-only imports count too — a boundary you
 * cross "just for a type" is still a crossed boundary.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies mean the two files are really one; split the shared piece out.",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "domain holds nouns + sentinel errors and imports NOTHING internal (stdlib only). It can never break for a reason unrelated to the business.",
      from: { path: "^src/domain" },
      to: { path: "^src", pathNot: "^src/domain" },
    },
    {
      name: "usecase-only-domain-and-platform",
      severity: "error",
      comment:
        "usecase orchestrates business rules against ports. It may import domain and platform only — never an adapter, transport, db, or config.",
      from: { path: "^src/usecase" },
      to: { path: "^src/(infrastructure|api|setup|db|config|cmd)" },
    },
    {
      name: "api-never-touches-infra-or-db",
      severity: "error",
      comment:
        "api is transport only: parse, call one usecase method, map the result. It imports usecase/domain — never an adapter or the db. Wiring lives in setup.",
      from: { path: "^src/api" },
      to: { path: "^src/(infrastructure|db)" },
    },
    {
      name: "db-pool-is-the-single-door",
      severity: "error",
      comment:
        "THE TENANT WALL. The raw pool is reachable only through the resolver (db), the repository adapters (infrastructure), and the composition root (setup). No usecase, domain, or handler may hold a connection that has not had SET LOCAL app.tenant_id applied.",
      from: { pathNot: "^src/(db|infrastructure|setup)" },
      to: { path: "^src/db/pool" },
    },
    {
      name: "infra-does-not-import-transport",
      severity: "error",
      comment: "A driven adapter (postgres, vendor SDK) never reaches back into the api layer.",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/api" },
    },
    {
      name: "core-never-imports-fin",
      severity: "error",
      comment:
        "FinCompliance can fail without BiB failing (docs/FIN_BUILD_PLAN.md, ground rule 4). Fin is domain/fin, usecase/fin, infrastructure/fin, api/handler/fin.ts and api/handler/fin-*.ts; fin may import core, core may not import fin. The only seams are the router (which mounts fin's routes when they are wired), the error mapper (api/domainerr.ts, which maps every family's codes to HTTP), setup/fin.ts and setup/server.ts (which wire them), cmd/fin-once.ts (fin's own process) and fin's test fakes (testfakes/fin.ts, testfakes/fin-*.ts).",
      from: {
        pathNot:
          "^src/((domain|usecase|infrastructure)/fin/|api/handler/fin(|-[a-z-]+)\\.ts$|api/(router|domainerr)\\.ts$|setup/(fin|server)\\.ts$|cmd/fin-once\\.ts$|testfakes/fin(|-[a-z-]+)\\.ts$)",
      },
      to: { path: "^src/((domain|usecase|infrastructure)/fin/|api/handler/fin(|-[a-z-]+)\\.ts$|testfakes/fin(|-[a-z-]+)\\.ts$)" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "A file nothing imports is usually dead or mis-wired.",
      from: { orphan: true, pathNot: "(\\.d\\.ts$)|(^src/cmd/)" },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
    },
  },
};
