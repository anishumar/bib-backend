# The configuration registry (P2 / T2.5)

What a firm changes weekly is rows, not deploys: kinds, publishing and freezing, pinning, role
seeding, and who may write config.

## The configuration registry — data, not code

- `config.entry` is the thing configured (`tenant × kind × key`, e.g. "the GST filing service",
  "the partner role"); `config.version` is what it said at a point in time.
- **Twelve kinds** (`CONFIG_KINDS`, `src/domain/config/model.ts`): `service`, `role`, `policy`,
  `clause`, `dunning`, `workflow_template`, `confidence_tier`, `verification_policy`,
  `compliance_policy`, `escalation`, `chaser`, `nudge`. `rule_pack` is still not a kind — it joins
  when T4.3 actually reads it.
- Which task added which: `clause` 4th (T2.3), `dunning` 5th (T3.5), `workflow_template` 6th
  (T2.7, deferred at T2.5 because a body designed against no consumer ends up wrong),
  `confidence_tier` 7th (T2.8), `verification_policy` 8th (T2.9), `compliance_policy` 9th (T3.3),
  `escalation` 10th (T4.5), `chaser` (T4.4, 0065), `nudge` (T6.7, 0067).
- **Adding a kind is a code change:** a body validator in `domain/config/model.ts` (a kind without
  one accepts anything) and an entry in the `config.entry` kind CHECK (`entry_kind_check`).

**Publishing freezes.** A published version's body never changes — a trigger (0005), so it binds
the owner role and psql too. Publishing archives the version it replaces; archived versions stay
readable forever. That makes a PIN meaningful:
- A consumer that must not move stores a `version.id` and reads that row for life (editing a
  workflow never rewrites jobs already walking it).
- **The consumer decides**; the registry never pins on its behalf. Both reads are explicit:
  `list`/`describe` = in force now; `readPinned` = what it said then.
- **Roles read live** — a firm that removes a permission expects it gone that afternoon.
- Frozen bodies mean a new body field must be optional, absent = old behaviour (rule in CLAUDE.md;
  instances: `RoleBody.audience`, step `checklist`/`reviewPoints`).

**Every tenant owns a complete role set from creation.** `createTenant` seeds it via the
`RoleRegistrySeeder` port; 0005 backfilled older firms. **No read-time fallback to product
defaults**, deliberately: merging means a firm can never remove a permission; using defaults only
when a tenant has no rows means the first role a firm publishes locks out everyone holding another.
A tenant with no role rows is a real fault and gate 3 says so loudly.

**Changing a default role costs a migration.** `DEFAULT_ROLES` seeds only NEW tenants; existing firms
hold frozen rows. Adding a permission to a default role = a migration publishing a new version for
firms that have NOT customised that role (a firm that edited its role made a decision).
`tests/config/seed-parity.test.ts` holds the build red until the newest seed migration and
`DEFAULT_ROLES` agree. (Instances: 0012, 0045, 0056, 0060, 0064, 0317, 0321, 0335, 0364.)

**Writing config needs `tenant:admin`, not a `config:write`.** Whoever can publish a role version can
grant themselves everything, so the permission must say that when handed out. Reading is
`config:read` (an associate quotes from the catalogue). A publish that would leave no role carrying
`tenant:admin` is refused — unrecoverable from inside the product.

Deliberate non-registry tables (each with its reason in its doc): `tenancy.staff_grade` and
`tenancy.service_axis` (`firm-setup-and-structure.md`), obligation templates
(`compliance-calendar.md`), firm time zone / work split / request routing columns on
`tenancy.tenant`.
