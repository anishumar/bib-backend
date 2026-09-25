# Migrations

`NNNN_snake_case.{up,down}.sql` — 4-digit, and each developer's own numbers ascend. Every
`up` has a `down`. The number is NOT contiguous and is NOT the order the file is applied
in; both of those are stated below rather than left to be discovered.

## Numbering is split between the two developers — so there ARE gaps

This rule used to say "no gaps", and it was changed deliberately rather than quietly
broken. Two people adding schema at the same time collide on the next number, and a
migration is immutable once applied anywhere — so a collision is not a rename, it is one of
us redoing the work under a new number.

**`(A)` holds 0080–0299. `(B)` holds 0300–0400** (settled 2026-09-16: `(B)` ran out at 0079,
and an open-ended `0080+` would have included `(B)`'s new block). The board (`docs/MERGE_BUILD-PLAN.md`) is where that
split is agreed; revisit when either range runs low.

**The first split ran out, which is the thing to learn from.** `(A)` originally held 0018–0039
and reached 0038 — one number left — while `(B)` was at 0056. A range sized by guess fills at
whatever rate the work happens to need, so **a range is a block to be re-issued, not a
territory**. 0018–0056 stay exactly where they are: applied migrations are immutable and
renumbering them would be the one thing this file forbids.

What this costs, stated rather than discovered later: the ranges fill unevenly, so `0040`
may be applied months before `0018` exists. The migrator sorts filenames and applies
whatever is unapplied — it does not require contiguity — so a later `0018` simply lands
after `0040`. **That is only safe while the two ranges stay independent**, which is a real
obligation on both of us: a migration must not depend on a lower number from the other
developer's range. If one ever does, it belongs in the range of whoever it depends on.

## The number is not the order — and the obligation that follows

The line above understates it, so here is the whole of it. The migrator applies whatever
is UNAPPLIED, in filename order. A database that already exists therefore applies each new
file at the moment that file reaches it, and files reach different databases in different
orders because they arrive on different branches at different times. So on an existing
database a LOWER number routinely lands after a HIGHER one — and not only across the two
ranges. It happens inside one developer's range too, whenever two branches merge in an
order the numbers do not agree with.

That has already happened here. The local dev database applied `0035`, `0036`, `0030`,
`0040` — in that order — while a database created from zero today applies `0030`, `0035`,
`0036`, `0040`. Same files, same migrator, two different orders, and both are correct.

**So a migration must be independent of every migration it does not explicitly depend on,
because it may be applied before OR after any of them.** Concretely: depend only on
numbers BELOW yours that you know are already there, never on one that merely happens to
have run first on your laptop; do not assume the state another in-flight migration leaves
behind; and if you need one, take a number above it — a dependency is what the ordering
guarantee is FOR, and the only way to state one is the number.

Worth checking rather than trusting, and cheap:

```bash
psql -d postgres -c "DROP DATABASE IF EXISTS bib_order_audit" -c "CREATE DATABASE bib_order_audit"
# a copy of .env with BOTH BIB_DATABASE_URL and BIB_APP_DATABASE_URL repointed at it
set -a; . /tmp/env.audit; set +a; npm run migrate
pg_dump --schema-only -d bib             | grep -v '^\\restrict\|^\\unrestrict' > /tmp/dev.sql
pg_dump --schema-only -d bib_order_audit | grep -v '^\\restrict\|^\\unrestrict' > /tmp/fresh.sql
diff /tmp/dev.sql /tmp/fresh.sql
```

Empty on 28 Aug 2026, at `0001`–`0018`, `0030`, `0035`, `0036`, `0040`: the two orders
above produce byte-identical schemas, grants, owners, constraints, indexes, triggers and
function bodies included. `--schema-only` because the dev database carries smoke data. A
non-empty diff is not a patch — it means the schema depends on the order the files
happened to arrive in, which is the one thing a migration system exists to prevent, and
what to do about it is a decision.

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
