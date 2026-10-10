# infra/sql

Two SQL files that are **not migrations**. They are not numbered into
`tenancy.schema_migrations`, `npm run migrate` never looks in this directory, and neither
file has a `down`. That distinction is worth stating at the top, because a directory of
numbered `.sql` files sitting next to `migrations/` reads as one.

| File | Run as | When | Writes |
|---|---|---|---|
| `0000_cloudsql_bootstrap.sql` | the migrate identity (`bib_migrator`) | once, on a fresh Cloud SQL instance, **before** the first migrate job | roles, grants, `tenancy.schema_migrations`, database ACL |
| `verify_wall.sql` | `bib_app` | after every migrate, before every deploy, and any time somebody is worried | nothing |

**Why the bootstrap exists at all.** On a cluster with a superuser, `ensureRoles` in
`src/cmd/migrate.ts` does the whole job and this directory is unnecessary. Cloud SQL has no
superuser — the default user is a member of `cloudsqlsuperuser` and holds CREATEROLE,
CREATEDB and LOGIN and nothing else — so two statements the migrator issues need privileges
that platform cannot hand out. The bootstrap closes what can be closed from SQL; the rest is
two changes to `migrate.ts`, written out in full in `bib-docs/backend/deploy/database.md`.

**Why `verify_wall.sql` exists on top of `src/db/boot-check.ts`.** Two reasons. It asks the
same questions with no image, no revision and no crash loop involved, which matters because
this is a production-only deployment with no staging box to find an answer on. And its last
check is one the boot checks cannot make: whether `bib_app` was accidentally created as a
Cloud SQL user, which grants it `cloudsqlsuperuser` — membership of the role that OWNS this
database, and a table's owner is exempt from its own row policies. Both boot assertions pass
in that state and the tenant wall is open.

The `0000` prefix means "before `migrations/0001`". It is not a version number and nothing
sorts against it.

Read `bib-docs/backend/deploy/database.md` before running either. It carries the order, the URLs, the
role model and the argument behind each of them.
