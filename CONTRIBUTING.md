# Contributing — the review gate

We are a small team and mostly pair with Claude. The rules in `CLAUDE.md` are loaded into
every AI session and enforced by `npm run check`. A PR merges only when the gate is green and
the checklist below holds. If the gate is red, the work is not finished.

## The gate (CI + local pre-push both run this)

```bash
npm run check     # typecheck + lint + arch + test
```

## PR checklist

**Boundaries**
- [ ] No `process.env` outside `src/config`; no `console` outside `src/cmd`.
- [ ] `domain` imports only stdlib; `usecase` imports no adapter/transport/db.
- [ ] New external system is an adapter in `infrastructure/`, `implements` its port, wired in `setup/`.
- [ ] No vendor type crossed into domain/usecase; no vendor value added to a domain enum.

**Tenancy (every new business table)**
- [ ] `tenant_id uuid NOT NULL` + `ENABLE ROW LEVEL SECURITY` + isolation policy — or an
      explicit `-- GLOBAL:` comment justifying the exception.
- [ ] Tenant-scoped access goes through `withTenant` / `withIdentity`, never the raw pool.
- [ ] The DML role stays `NOBYPASSRLS`.

**Migrations**
- [ ] New file `NNNN_name.{up,down}.sql`; existing applied migrations untouched (fix forward).
- [ ] Every `up` has a matching `down` using `IF EXISTS`; the down drops nothing shared.
- [ ] Each unique constraint's scope (global / per-tenant / per-entity) stated in a comment.

**Domain correctness**
- [ ] Money carries currency + FX-rate + date; no float money.
- [ ] External callbacks are idempotent (derived id).
- [ ] No TODO/FIXME/placeholder; unfinished work is an explicit honest stub.

## Adding a config key

Two edits, nowhere else: the zod schema in `src/config/config.ts` **and** `.env.example`.
Decide whether it belongs in `validate.ts` (if the service silently no-ops without it, it is
required in production-like environments).

## When a rule seems wrong

Say so in the PR. Changing a rule is a design conversation and lands as its own commit with
the reasoning written down — never a silent `eslint-disable`, an arch exception, or an import
moved to dodge the matcher.
