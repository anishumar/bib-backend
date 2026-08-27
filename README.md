# bib-backend

The backend for BiB (Business in a Box) — a multi-tenant B2B2C SaaS for professional-services
firms. Node + TypeScript, Postgres + RLS, hexagonal architecture.

**Start here:** `CLAUDE.md` (the architecture, enforced) · `HANDOFF.md` (the decisions and why).

## Local setup

Needs a Postgres 17/18 with `pgcrypto` and `citext`. No Docker required if you have a native
Postgres on `:5432`.

```bash
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
