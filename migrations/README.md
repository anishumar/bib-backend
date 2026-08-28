# Migrations

`NNNN_snake_case.{up,down}.sql` — 4-digit, monotonic. Every `up` has a `down`.

## Numbering is split between the two developers — so there ARE gaps

This rule used to say "no gaps", and it was changed deliberately rather than quietly
broken. Two people adding schema at the same time collide on the next number, and a
migration is immutable once applied anywhere — so a collision is not a rename, it is one of
us redoing the work under a new number.

**`(A)` holds 0018–0039. `(B)` holds 0040+.** The board (`docs/MERGE_BUILD-PLAN.md`) is
where that split is agreed; revisit when either range runs low.

What this costs, stated rather than discovered later: the ranges fill unevenly, so `0040`
may be applied months before `0018` exists. The migrator sorts filenames and applies
whatever is unapplied — it does not require contiguity — so a later `0018` simply lands
after `0040`. **That is only safe while the two ranges stay independent**, which is a real
obligation on both of us: a migration must not depend on a lower number from the other
developer's range. If one ever does, it belongs in the range of whoever it depends on.

## The rules (inherited from the Zaap standard — non-negotiable)

- **Immutable once applied anywhere.** If `0001` has run on any environment, it is frozen.
  Never edit or renumber it — fix forward with a new migration. Editing an applied migration
  silently diverges environments that share a version number.
- **`SET ROLE bib_owner` … `RESET ROLE`** wraps object creation, so every table is owned by
  the owner role, not by whoever ran the migration.
- **Downs use `IF EXISTS`** (safe to run twice), run newest-first, and **never drop shared
  cluster resources** (roles, extensions) that another schema might depend on.
- **New business tables**: `tenant_id uuid NOT NULL` + `ENABLE ROW LEVEL SECURITY` + an
  isolation policy — or an explicit `-- GLOBAL:` comment justifying the exception. This is a
  CI/review gate, not a suggestion.
- **The `ledger` schema is append-only.** Its default privileges grant `bib_app` SELECT and
  INSERT and nothing else, so a table added there inherits immutability rather than relying
  on someone remembering. A table that needs UPDATE does not belong in that schema.

## Roles are ensured in code, not here

`bib_owner` and `bib_app` are cluster-level and need their password injected from config, so
`cmd/migrate` (`src/cmd/migrate.ts`) creates/alters them **before** applying SQL. `bib_app`
is `NOBYPASSRLS` — the tenant wall depends on it. This is a deliberate deviation from
"roles in 0001", documented so it isn't mistaken for an omission.

## Running

```bash
npm run migrate                 # applies pending *.up.sql in order, tracked in
                                # tenancy.schema_migrations, as the owner
```

Locally, `BIB_DATABASE_URL` points at a superuser (so it can create roles + extensions and
`SET ROLE bib_owner`). In prod, that connection is a `migration_runner` role and the job runs
once before new pods start.
