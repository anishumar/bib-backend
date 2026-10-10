# bib-backend

The backend for BiB (Business in a Box) — a multi-tenant B2B2C SaaS for professional-services
firms. Node + TypeScript, Postgres + RLS, hexagonal architecture.

**Start here:** `CLAUDE.md` (the architecture, enforced) · `../bib-docs/backend/HANDOFF.md` (the decisions and why) ·
`bib-docs/backend/MERGE_BUILD-PLAN.md` (the live task board; `bib-docs/backend/BUILD-PLAN.md` is superseded history).

## Local setup

Needs **Node 22** (`.nvmrc` pins it; `package.json` `engines` requires it) and a Postgres
17/18 with `pgcrypto` and `citext`. No Docker required if you have a native Postgres on
`:5432`.

Node 22 is not advisory. `pg-boss` — the delivery engine's queue (T2.6) — declares
`node >= 22.12.0`, and npm installs it as an EMPTY DIRECTORY under an older Node rather than
failing: the package resolves, so nothing errors, and the first symptom is
`TS2307: Cannot find module 'pg-boss'` from `npm run typecheck`, which reads like a missing
dependency and is not one. `nvm use` before `npm install`, and if you have already hit it,
re-run `npm install` under Node 22 to replace the empty directory.

```bash
nvm use                       # Node 22, per .nvmrc
cp .env.example .env          # adjust BIB_DATABASE_URL to a superuser locally
npm install
createdb bib                  # or: psql -c 'create database bib'
npm run migrate               # ensures roles, applies migrations, enables the RLS wall
npm run dev                   # http://localhost:8080/health
```

`BIB_DATABASE_URL` (the migrator) must be a role that can create roles + extensions and
`SET ROLE bib_owner` — locally, a superuser. `BIB_APP_DATABASE_URL` is the `bib_app` login
(`NOBYPASSRLS`) that serves every request.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | run the server (watch) |
| `npm run migrate` | apply pending migrations |
| `npm run check` | typecheck + lint + arch + test — **the gate** |
| `npm test` | unit tests + the architecture test |
| `npm run arch` | the import wall on its own |
| `npm run build` | bundle to `dist/` (tsup) |

## Layout

```
src/
  cmd/            process shells (server, migrate)
  config/         the env adapter (only process.env reader)
  platform/       tiny primitives (ids, call context)
  db/             pool + tenant resolver + fail-closed boot check
  domain/<agg>/   pure nouns + sentinel errors
  usecase/<area>/ services + ports.ts (the seams)
  infrastructure/ driven adapters (postgres, vendor SDKs)
  api/            router (all routes), handlers, error envelope
  setup/          composition root — the only wiring
  testfakes/      in-memory port fakes
migrations/       NNNN_name.{up,down}.sql — immutable, fix-forward
tests/            unit tests + tests/architecture (the arch-as-test)
```
