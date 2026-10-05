# The database on Cloud SQL

How this product's Postgres comes up on Google Cloud, what is different there from the
laptop it was written on, and the two changes to `src/cmd/migrate.ts` it cannot come up
without. Production only — one instance, `BIB_ENVIRONMENT=production`, and therefore the
whole boot gate in `src/config/validate.ts` live from the first deploy with no staging box
to find anything on.

The short version, because most of this document is the argument behind it:

- **Cloud SQL for PostgreSQL 17, private IP only, reached over TCP.** The Cloud SQL
  connector and the Auth Proxy sidecar are both unusable here, for two independent
  reasons, both measured. That decides the network topology for every other workstream.
- **`bib_owner` and `bib_app` are created by SQL and never through Terraform.** A
  `google_sql_user` is granted `cloudsqlsuperuser` automatically, which is the exact
  attribute set `ensureRoles` exists to strip — and neither boot check would notice.
- **`migrate` runs as a built-in Cloud SQL user** (`bib_migrator`), a member of
  `cloudsqlsuperuser`. The server and the worker never get that credential.
- **One secret drives both sides.** `BIB_APP_DATABASE_URL` is simultaneously the
  connection string the services use and the source of the password `migrate` writes into
  the cluster, so the two cannot disagree — as long as the password is drawn from an
  alphabet that needs no percent-encoding.
- **Both boot assertions pass on Cloud SQL unchanged.** Nothing in `src/db/boot-check.ts`
  moves and nothing in `validate.ts` is relaxed for the database.

## 1. The two prerequisites in `src/cmd/migrate.ts`

This section is first because nothing else in this document matters until it lands. The
migrate job as written **cannot run on Cloud SQL**, for two reasons, and neither is fixable
from outside that file.

### 1a. `ALTER ROLE bib_app … NOBYPASSRLS NOSUPERUSER …` is refused

`ensureRoles` asserts the load-bearing attribute by setting it every run:

```ts
// NOBYPASSRLS is the load-bearing attribute — assert it every run.
await sql.unsafe(
  `ALTER ROLE bib_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword.replace(/'/g, "''")}'`,
);
```

PostgreSQL refuses that statement from a non-superuser, twice over. In PG17's
`src/backend/commands/user.c`, `AlterRole`:

```c
    if (!superuser() && dissuper)                                        /* line 762 */
        ereport(ERROR, (errcode(ERRCODE_INSUFFICIENT_PRIVILEGE),
                 errmsg("permission denied to alter role"),
                 errdetail("Only roles with the %s attribute may change the %s attribute.",
                           "SUPERUSER", "SUPERUSER")));
...
        if (dbypassRLS && !has_bypassrls_privilege(currentUserId))       /* line 812 */
            ereport(ERROR, (errcode(ERRCODE_INSUFFICIENT_PRIVILEGE),
                     errmsg("permission denied to alter role"),
                     errdetail("Only roles with the %s attribute may change the %s attribute.",
                               "BYPASSRLS", "BYPASSRLS")));
```

**`dissuper` and `dbypassRLS` are `DefElem *` — parse nodes, not values.** The guard fires
on the clause having been WRITTEN, not on what it asked for, so `NOSUPERUSER` is refused
exactly as `SUPERUSER` would be and `NOBYPASSRLS` exactly as `BYPASSRLS` would be. The
documentation says the same thing in one sentence: *"Non-superusers cannot change the
SUPERUSER property and can change the CREATEDB, REPLICATION, and BYPASSRLS properties only
if they possess the corresponding property themselves"*
(<https://www.postgresql.org/docs/17/sql-alterrole.html>).

No Cloud SQL role satisfies either guard. The default `postgres` user *"has the following
attributes (privileges): CREATEROLE, CREATEDB, and LOGIN. It does not have the SUPERUSER or
REPLICATION attributes"*, and *"customers cannot create or have access to users with
superuser attributes"* (<https://docs.cloud.google.com/sql/docs/postgres/users>). There is
nothing to escalate to; the statement is unreachable on the platform.

**The fix is to assert the two attributes rather than set them**, which is strictly as
strong and portable. `NOBYPASSRLS` is what `CREATE ROLE` produces — *"NOBYPASSRLS is the
default. Only superuser roles or roles with BYPASSRLS can specify BYPASSRLS"*
(<https://www.postgresql.org/docs/17/sql-createrole.html>) — so in a cluster with no
superuser there is nobody who could ever move it, and the same is true of `SUPERUSER`. The
`NOCREATEDB NOCREATEROLE LOGIN PASSWORD` half is fine as it stands: the migrate identity
holds CREATEDB and CREATEROLE, and gets ADMIN OPTION on any role it creates.

Replace the `ALTER` above with:

```ts
  // NOBYPASSRLS and NOSUPERUSER are ASSERTED here rather than SET, because a
  // managed cluster has no superuser to set them with. Postgres refuses either
  // clause from a caller that does not already hold the attribute — the guard
  // tests whether the clause was WRITTEN, not what it asked for, so NOBYPASSRLS
  // is refused exactly as BYPASSRLS would be. Asserting costs nothing where the
  // attributes are already right — they are the CREATE ROLE defaults, and a role
  // in a cluster with no superuser can never be granted BYPASSRLS by anyone —
  // and it still fails loudly where they are wrong, which is the whole of what
  // the ALTER was there for.
  await sql.unsafe(
    `ALTER ROLE bib_app WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD '${appPassword.replace(/'/g, "''")}'`,
  );
  const [app] = await sql<{ bypass: boolean; superuser: boolean }[]>`
    SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = 'bib_app'
  `;
  if (!app) {
    throw new Error("ensureRoles: bib_app is missing from pg_roles immediately after being ensured");
  }
  if (app.bypass || app.superuser) {
    throw new Error(
      `ensureRoles: bib_app holds ${app.bypass ? "BYPASSRLS" : ""}${app.bypass && app.superuser ? " and " : ""}` +
        `${app.superuser ? "SUPERUSER" : ""}. Either makes RLS decorative and every tenant able to read every ` +
        `other. It must be NOBYPASSRLS NOSUPERUSER. On a cluster with a superuser: ALTER ROLE bib_app ` +
        `NOBYPASSRLS NOSUPERUSER; on Cloud SQL, where no superuser exists to run that, drop the role and let ` +
        `this command recreate it.`,
    );
  }
```

### 1b. Migration 0042 needs the migrator to hold `bib_app`'s privileges

0042 ends with:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE bib_app IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bib_app;
```

`ALTER DEFAULT PRIVILEGES FOR ROLE x` requires the running role to have **the privileges
of** `x`, not merely admin of it — PG17 `src/backend/catalog/aclchk.c:1145`,
`if (!has_privs_of_role(GetUserId(), iacls.roleid))`. `ensureRoles` grants itself
`bib_owner` and never `bib_app`, so this statement passes locally for one reason only: the
local migrate runs as a superuser, and a superuser has everybody's privileges.

It fails on Cloud SQL because of how a CREATEROLE user's self-grant works. PG17
`CreateRole`, under the comment *"If the current user isn't a superuser, make them an admin
of the new role"*:

```c
        poptself.specified = GRANT_ROLE_SPECIFIED_ADMIN
            | GRANT_ROLE_SPECIFIED_INHERIT
            | GRANT_ROLE_SPECIFIED_SET;
        poptself.admin = true;
        poptself.inherit = false;
        poptself.set = false;
```

**Admin, and deliberately not inherit and not set.** Which is also why `SET ROLE bib_owner`
— the line that opens the DDL block of nearly every migration in this repo — works on a
managed cluster at all: only because of the explicit `GRANT bib_owner TO CURRENT_USER` at
the end of `ensureRoles`. Migration 0001's own header already states the production
expectation: *"Applied by cmd/migrate as a role that can SET ROLE bib_owner (superuser
locally; a migration_runner member of bib_owner in prod)."*

One line beside the existing grant:

```ts
  // Two grants, for two different statements. bib_owner is what `SET ROLE bib_owner`
  // in every migration needs; bib_app is what 0042's `ALTER DEFAULT PRIVILEGES FOR
  // ROLE bib_app` needs, which asks for that role's PRIVILEGES and not merely admin
  // of it. Both are free on a superuser cluster and neither is on a managed one,
  // where CREATE ROLE hands its creator ADMIN OPTION and withholds INHERIT and SET.
  await sql.unsafe(`GRANT bib_owner TO CURRENT_USER`);
  await sql.unsafe(`GRANT bib_app TO CURRENT_USER`);
```

`infra/sql/0000_cloudsql_bootstrap.sql` makes both grants too, so a bootstrapped instance
comes up whether or not this change has landed. That is a belt, not a substitute: an
instance created by somebody who skips the bootstrap would still fail on 0042, and the
one-line version is the fix that travels with the code.

## 2. The instance

| Setting | Value | Why |
|---|---|---|
| `database_version` | `POSTGRES_17` | Pinned, not "latest". Every claim in this document about role attributes and privilege checks is read off the PG17 source. |
| IP configuration | **private IP only**, `ipv4_enabled = false` | Section 3. Public IP would also be reachable, and a database whose isolation is a row policy on a role is not one to leave an open port on. |
| `ssl_mode` | `ENCRYPTED_ONLY` | *"only allows connections encrypted with SSL/TLS. The client certificate isn't verified for SSL connections"* (<https://docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance>). This is the strongest mode reachable through a postgres.js URL — section 3c. |
| `max_connections` | set the flag explicitly | The default *"depends on the amount of memory of the largest instance in the chain of primaries"* (<https://docs.cloud.google.com/sql/docs/postgres/flags>), from 25 upward. Section 7 has the arithmetic. |
| Database | one, named `bib` | Created through Terraform, therefore owned by `cloudsqlsuperuser`. |
| Deletion protection | on | It holds signed engagement letters and a ledger that is append-only by design. |

**Private IP has a prerequisite on the VPC** and it is one-way: private services access
means *"allocate an IP address range"* and establish a VPC peering connection, and *"after
you assign a range to an instance, you can't modify the range"*
(<https://docs.cloud.google.com/sql/docs/postgres/configure-private-ip>). Size it once.

## 3. The connection

### 3a. The Cloud SQL connector is not available to this product

Cloud Run can mount a Cloud SQL instance as a Unix socket at
`/cloudsql/INSTANCE_CONNECTION_NAME`. **postgres.js cannot be told about a Unix socket
through a connection URL**, and `src/db/pool.ts` passes nothing but a URL string:

```ts
const app = postgres(cfg.appUrl, { max: cfg.appPoolSize });
```

All three spellings people write were measured against the installed driver (postgres
3.4.9), and all three fail:

| URL | What postgres.js does with it |
|---|---|
| `postgres://bib_app:pw@/bib?host=/cloudsql/p:r:i` | `ERR Invalid URL` — not a valid URL at all |
| `postgres://bib_app:pw@%2Fcloudsql%2Fp%3Ar%3Ai/bib` | `{ host: ["%2Fcloudsql%2Fp%3Ar%3Ai"], path: false }` — a TCP hostname |
| `postgres:///bib?host=/cloudsql/p:r:i&user=bib_app&password=pw` | `{ host: ["localhost"], user: "anishumar", connection: { host: "/cloudsql/p:r:i", … } }` — connects to loopback and ships `host` as a **startup parameter** the server rejects |

The cause is in the driver, `node_modules/postgres/src/index.js`:

```js
host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || 'localhost'   // :438
path: o.path || host.indexOf('/') > -1 && host + '/.s.PGSQL.' + port                     // :468
```

A socket path only ever arrives through the `host` **option**, never through the URL. Using
the connector would therefore mean changing `createPools` to take an options object —
which is a real change to the one module that holds a live connection, made for a
deployment convenience, and it is not this deployment's change to make.

### 3b. The Auth Proxy sidecar is not available either

The other way to the connector is a proxy on `127.0.0.1`. The production boot gate refuses
it:

```ts
if (looksLocal(cfg.db.appUrl)) { throw new Error(…) }   // validate.ts:11
function looksLocal(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
```

That check has a specific argument behind it — *"a public environment must use real
infrastructure"* — and relaxing a boot gate to make a deployment convenient is the thing
this repo says not to do.

**So the topology is decided, and the other workstreams need it: Cloud SQL private IP, and
Direct VPC egress on both Cloud Run services and the migrate job.** Google's own guidance
agrees that this is a supported path: *"Direct VPC egress and connectors use private IP
addresses to handle communication to your VPC network"*, and *"connect using your
instance's private IP address and port 5432"*
(<https://docs.cloud.google.com/sql/docs/postgres/connect-run>).

### 3c. What the URLs look like

Measured, same driver:

```
postgres://bib_app:pw@10.20.0.3:5432/bib
  → { host: ["10.20.0.3"], port: [5432], path: false, user: "bib_app", db: "bib" }

postgres://bib_app:pw@10.20.0.3:5432/bib?sslmode=require
  → { …, ssl: "require" }
```

`sslmode=require` is understood and turns TLS on. **`sslrootcert` is not**, and that
matters: it is forwarded as a Postgres startup parameter, which the server rejects.

```
postgres://…/bib?sslmode=verify-full&sslrootcert=/etc/ssl/server-ca.pem
  → { ssl: "verify-full", connection: { sslrootcert: "/etc/ssl/server-ca.pem" } }
                                        ^ a startup parameter, not a TLS setting
```

So `ENCRYPTED_ONLY` + `?sslmode=require` is the pairing the code can actually express:
encryption on, server certificate not verified. Note what `require` means in this driver —
`connection.js:282`, `if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
options.rejectUnauthorized = false`. Getting `verify-full` would mean a change to
`src/db/pool.ts` to pass a `ssl: { ca }` object; it is not blocking, the traffic never
leaves the VPC, and it is written down here rather than left to be discovered.

**The two URLs:**

```
# the migrate job only
BIB_DATABASE_URL=postgres://bib_migrator:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require

# the server, the worker, and migrate (which parses the password out of it)
BIB_APP_DATABASE_URL=postgres://bib_app:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require
```

**The server and the worker get a THIRD string for `BIB_DATABASE_URL`, and it is a
credential that cannot authenticate:**

```
# the server and the worker only — required by config, dialled by nothing
BIB_DATABASE_URL=postgres://bib_owner@PRIVATE_IP:5432/bib?sslmode=require
```

`BIB_DATABASE_URL` is required by the config schema, and since B37 (audit 2026-10-03)
nothing in the server or the worker builds a connection from it: `createPools` opens the
`bib_app` pool only, and `tests/architecture/owner-pool.test.ts` holds that the owner URL is
read by `cmd/migrate.ts` and nothing else. It is a credential that is loaded, redacted into
the boot log line, and never dialled.

Handing the services the migrator credential instead would put a live
`bib_owner`-inheriting login inside the request process, and **`bib_owner` owns every table
while no table in this database uses `FORCE ROW LEVEL SECURITY`** — a table's owner is not
subject to its own row policies, so that credential is a tenant-wall bypass by itself.
Naming `bib_owner` with no password is better than naming `bib_app`, and the reason is the
same one that makes the role `NOLOGIN` in the first place: if something ever does reach for
`pools.owner`, it fails closed, immediately, with a message naming the role, rather than
quietly succeeding as the application and failing later on a missing privilege. (Agreed with
`docs/deploy/runbook.md` §2.3, which arrived at this independently; the two documents must
not drift on it.)

## 4. Roles and ownership

```
cloudsqlsuperuser            the platform's ceiling. Owns the database. CREATEROLE,
  └── bib_migrator           CREATEDB, LOGIN — and no SUPERUSER, ever.
        ├── bib_owner        NOLOGIN. Owns every schema, table, view and function.
        └── bib_app          LOGIN, NOBYPASSRLS. The only role the product serves with.
```

**`bib_migrator` is a built-in Cloud SQL user**, created through Terraform, and it is the
only Cloud SQL user in this design. *"When you create a built-in PostgreSQL user in Cloud
SQL for PostgreSQL and don't assign any database roles, the user is granted the
cloudsqlsuperuser role automatically"* (<https://docs.cloud.google.com/sql/docs/postgres/users>),
and that membership is what it needs: the four `CREATE EXTENSION` statements in migrations
0001, 0002 and 0049 run as the connecting role, and *"in Cloud SQL, extensions can only be
created by users that are part of the cloudsqlsuperuser role"*
(<https://docs.cloud.google.com/sql/docs/postgres/extensions>). All four — `pgcrypto`,
`citext`, `pg_trgm`, `btree_gist` — are on the supported list. Every one of those statements
sits **before** its file's `SET ROLE bib_owner` line, and 0049's own comment says so
explicitly: *"BEFORE `SET ROLE`, like `pgcrypto` and `citext` in 0001 and `pg_trgm` in
0002"*. The existing ordering is what makes this work; do not tidy an extension inside a
`SET ROLE` block.

**`bib_owner` is `NOLOGIN` and stays that way.** `.env.example` puts `bib_owner` in
`BIB_DATABASE_URL` locally, which works only because the local cluster's `bib_owner` is a
superuser account; `ensureRoles` creates it `NOLOGIN`, so in production `BIB_DATABASE_URL`
can never literally be `bib_owner`. It is reached by `SET ROLE`, from a session that already
authenticated as something else.

**`bib_app` is created by SQL and never as a `google_sql_user`.** This is the one mistake in
this whole document that fails silently. A built-in Cloud SQL user carries
`cloudsqlsuperuser` — hence CREATEROLE and CREATEDB, the exact attributes `ensureRoles`
means to strip — and, worse, membership of the role that OWNS this database, which reaches
every table as its owner and is exempt from every row policy on it. **Neither boot check
would notice**: `assertTenantWall` reads `rolbypassrls` and `assertLedgerAppendOnly` reads
table privileges, and both would still be correct. `infra/sql/verify_wall.sql` section 5 is
the check that catches it, and it is the reason that file exists on top of the boot checks.

### Schema and object ownership

Every schema is created `AUTHORIZATION bib_owner` and every DDL block is wrapped in
`SET ROLE bib_owner … RESET ROLE`, so tables are owned by `bib_owner` regardless of who ran
the migration — `migrations/README.md`: *"so every table is owned by the owner role, not by
whoever ran the migration"*.

**Does `CREATE SCHEMA … AUTHORIZATION bib_owner` succeed as the Cloud SQL user?** Yes, for
two reasons that both have to hold. CREATE on a database is an owner privilege, and
`bib_migrator` has it through `cloudsqlsuperuser`, which owns the database. And creating a
schema owned by another role requires membership of that role, which `ensureRoles` arranges
for itself on its first run — `GRANT bib_owner TO CURRENT_USER`, ordered before the first
`CREATE SCHEMA` at `migrate.ts:29`. Note the direction this is written in: the `CREATE
SCHEMA` is issued as the connecting role and the `SET ROLE` comes after it. That is correct
and not incidental — `bib_owner` has no CREATE on the database and could not create a schema
at all.

**One object escapes the rule, and the bootstrap fixes it.** `tenancy.schema_migrations` is
created in `migrate.ts` outside any `SET ROLE`, so it ends up owned by whichever login first
ran the job. Locally that is invisible; here it would pin the record of what has been applied
to one named Cloud SQL user, so rotating or changing the migrate identity would leave a table
nobody can `ALTER`. `0000_cloudsql_bootstrap.sql` creates it as `bib_owner` first, and
migrate's `CREATE TABLE IF NOT EXISTS` then finds it and does nothing.

## 5. The two boot assertions, on Cloud SQL

Both pass as written. Nothing in `src/db/boot-check.ts` moves.

**`assertTenantWall`** asks two questions. The first reads the attribute rather than setting
it — `SELECT rolbypassrls AS bypass, current_user AS who FROM pg_roles WHERE rolname =
current_user` — and on Cloud SQL the answer is structurally false: `NOBYPASSRLS` is the
`CREATE ROLE` default, granting `BYPASSRLS` requires a superuser or an existing `BYPASSRLS`
holder, and the platform has neither. **The attribute the tenant wall depends on is
guaranteed there; it simply cannot be written**, which is the whole of section 1a. The
second reads `relrowsecurity` on `tenancy.membership`, which migration 0001 enables. Nothing
in Cloud SQL changes RLS semantics: a policy is enforced against everything except a
`BYPASSRLS` role and the table's owner, and `bib_app` is neither.

**`assertLedgerAppendOnly`** asks three things: RLS enabled on `ledger.event` (0003:100),
and the app role holding SELECT and INSERT but not UPDATE or DELETE (0003:111, plus default
privileges at 0003:113 so a later table in that schema inherits immutability). All three are
migration facts. Nothing on the Cloud SQL platform adds table privileges to a role, so there
is nothing there to interfere.

`infra/sql/verify_wall.sql` asks all of it from psql, before a container has ever been
launched — which is worth having precisely because this is production-only and a crash loop
is the alternative way to find the answer.

## 6. The password, and the one trap in it

**One secret, not two.** There is no separate password variable: config parses the password
out of the app URL so that migrate can write it into the cluster.

```ts
/** Parsed out of appUrl so cmd/migrate can set the role's password. */
readonly appPassword: string;            // config.ts:170
appPassword = new URL(env.BIB_APP_DATABASE_URL).password;   // config.ts:285
await ensureRoles(sql, cfg.db.appPassword);                 // migrate.ts:26
```

So the two sides stay in sync by construction: migrate writes into the cluster exactly what
the services will later read out of the same secret. Nothing to reconcile and nothing to
forget.

**The trap, measured:** `new URL().password` returns the value still percent-encoded, while
postgres.js decodes it.

```
postgres://bib_app:p%40ss%2Fword@10.20.0.3:5432/bib
  config  new URL(url).password  →  "p%40ss%2Fword"      (config.ts:285)
  driver  sql.options.pass       →  "p@ss/word"          (index.js:550, decodeURIComponent)
```

A password containing any character that must be escaped in a URL therefore makes **migrate
set a different password from the one the pools authenticate with**, and the failure does not
land on migrate — migrate succeeds. It lands at the services' first connection, as an
authentication error, in a revision that has just been deployed.

**So: generate both passwords from `[A-Za-z0-9]` and nothing else.**

```bash
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40
```

Forty characters of that alphabet is about 238 bits. There is no security argument for
punctuation here and there is a concrete correctness argument against it.

## 7. Connection budget

Every app connection starts with Postgres's own limits (F-06-2, S7): `statement_timeout`
`BIB_DB_STATEMENT_TIMEOUT_MS` (default 30000) and `idle_in_transaction_session_timeout`
`BIB_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default 60000), sent as connection parameters, so a stuck
statement or a transaction left idle is ended by the server and its pool slot returns; connecting
gives up after `BIB_DB_CONNECT_TIMEOUT_S` (default 10). The migrator's own connection does not
carry them.

Each API or worker instance opens up to `BIB_DB_POOL_APP` (default 10) app connections and
nothing else: the owner pool it used to build and never dial is gone (B37, section 3c), and
`BIB_DB_POOL_OWNER` is no longer read. Budget 12 per instance anyway, for headroom.

```
max_connections  ≥  (server max_instances + worker max_instances) × 12
                    + 5 for the migrate job and an operator's psql
                    + Cloud SQL's own reserved connections
```

Cap `max_instances` on both Cloud Run services and set the `max_connections` flag explicitly
rather than inheriting the memory-derived default, which ranges from 25 upward
(<https://docs.cloud.google.com/sql/docs/postgres/flags>). A pool that cannot open a
connection is an outage that looks like a slow database.

The worker is the one to think about: it is a long-running process with an internal cron and
a pg-boss queue, not a request handler, and running more than one instance of it means more
than one of every sweep. Sizing it at one instance is a scheduling decision as much as a
connection one.

## 8. The procedure

Order matters at every step, and each step proves something the next one assumes.

**0. Terraform stands up the instance, the database, the VPC peering and `bib_migrator`.**
No `google_sql_user` named `bib_app` — section 4. The secrets exist in Secret Manager with
their first version, passwords drawn from `[A-Za-z0-9]`: `bib-app-database-url` holds the
`bib_app` URL and `bib-owner-database-url` holds the `bib_migrator` URL for the job, the two
names `docs/deploy/runbook.md` §2.3 uses. **Both carry `?sslmode=require`** — the instance is
`ENCRYPTED_ONLY`, postgres.js does not negotiate TLS unless the URL asks it to, and a DSN
without it is refused by the server at connection time.

**1. Bootstrap, once, by hand, as `bib_migrator`.**

```bash
psql "postgres://bib_migrator:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require" \
     -v ON_ERROR_STOP=1 -f infra/sql/0000_cloudsql_bootstrap.sql
```

Creates `bib_owner` and `bib_app`, grants both to `bib_migrator` with INHERIT and SET,
asserts `bib_app`'s attributes, creates `tenancy.schema_migrations` owned by `bib_owner`, and
closes PUBLIC's access to the database. It prints the role it granted to — **read that line**,
because a grant that landed on the wrong login is this procedure's one silent failure.

Run it from a machine with a route into the VPC. Idempotent, so running it again later costs
nothing.

**2. The migrate job.** It needs four variables, because `load()` hard-requires them and
migrate calls `load()` before it opens a connection: `BIB_ENVIRONMENT`, `BIB_DATABASE_URL`,
`BIB_APP_DATABASE_URL` and — although migrate never uses it — a well-formed
`BIB_INTERNAL_KEYS`. A migrate job deployed with only the two database URLs crashes on
config. Migrate does **not** run `validateServer`, so nothing else from the boot gate applies
to it.

**3. Verify, as `bib_app`.**

```bash
psql "$BIB_APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/sql/verify_wall.sql
```

Writes nothing. Five checks, and the fifth is the one the boot checks cannot make.

**4. Deploy the server and the worker.** Both run `assertTenantWall` and
`assertLedgerAppendOnly` at boot against the database step 3 just proved, so the interesting
failures left are the rest of the boot gate — CORS origins, internal keys, the mail transport,
the e-sign provider, the storage backend — which are other workstreams' variables.

**A migrate job runs before every deploy from then on**, and the order stays: migrate, then
new revisions.

## 9. Rotating the `bib_app` password

Because one secret drives both sides, rotation is three steps and no reconciliation:

1. Write a new version of the `BIB_APP_DATABASE_URL` secret, with a new password from the
   same alphabet.
2. Run the migrate job. `ensureRoles` sets the role's password to the one in the new secret.
3. Deploy new revisions of the server and the worker.

**The honest gap: this is not zero-downtime, as the code stands.** Between steps 2 and 3 the
running instances hold pools authenticated with the old password. Existing connections keep
working — Postgres does not re-authenticate an open session — but any new connection those
instances open fails, so the failure arrives at whatever moment the pool next grows or a
connection drops. The window is however long step 3 takes.

Closing it properly means the role holding two valid passwords at once, which PostgreSQL does
not support, or a connection-level retry that re-reads config, which is a change to
`src/db/pool.ts`. Neither is in scope here. What makes the gap survivable is that it is
short, bounded, and begins at a moment somebody chose.

Rotating `bib_migrator` is easier and separate: it appears in one secret, is read by one job,
and nothing long-running holds it.

## 10. What is deliberately not here

- **No IAM database authentication.** It would replace the password in
  `BIB_APP_DATABASE_URL` with a token that expires, and the password in that URL is the
  source of the password migrate writes into the cluster — so the one-secret design in
  section 6 would have to be replaced first. Worth doing; it is a code change, not a config
  one.
- **No read replica.** Nothing in this product routes a read anywhere but `pools.app`, and a
  replica nothing reads from is a cost with a failover story attached.
- **No PgBouncer.** The connection budget in section 7 is arithmetic that closes at this
  product's size, and a pooler in front of a database whose tenant isolation relies on
  `SET LOCAL app.tenant_id` inside a transaction needs its pooling mode chosen very
  carefully — transaction mode is correct here, but that is a decision to take with
  `src/db/tenant.ts` open, not one to inherit by accident.
- **No `verify-full` TLS.** Section 3c: unreachable through the URL, and reaching it means
  changing the one module that holds a live connection.
